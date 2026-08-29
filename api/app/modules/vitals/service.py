"""Recording a vital and deciding whether it should wake somebody (spec §16).

The spec's architecture, in order:

    input -> validate reading -> save vital -> threshold engine
                                                    |
                                       normal ------+------ abnormal
                                         |                     |
                                       save              create alert
                                                               |
                                                    notify assigned doctor

Two properties matter more than the rest.

**The reading is saved before it is judged.** Storage and alerting are separate
concerns, and a fault in the threshold configuration must never be able to lose
a measurement. A vital that alerts on nothing is still part of the trend a
clinician reads tomorrow.

**An ongoing problem is one alert, not one per reading.** A patient whose
saturation sits below its floor produces a breach on every measurement. Opening
a new alert each time would bury the ward in duplicates of a situation somebody
is already handling, so an open alert for the same patient and vital suppresses
new ones — while still recording every reading, and still escalating if the
severity gets worse.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import logger
from app.db.base import new_id, utcnow
from app.db.enums import (
    AlertSeverity,
    AlertStatus,
    AppointmentStatus,
    NotificationType,
    VitalType,
)
from app.db.models import (
    Alert,
    Appointment,
    Doctor,
    DoctorPatientAssignment,
    Vital,
    VitalThreshold,
)
from app.modules.notifications.service import notify
from app.modules.vitals import stream
from app.modules.vitals.thresholds import Breach, Threshold, evaluate

#: Which column on ``Vital`` holds each measurement. One mapping, used by
#: everything that has to walk a reading's parts, so a new vital type cannot be
#: half-added.
COLUMNS: dict[VitalType, str] = {
    VitalType.HEART_RATE: "heart_rate",
    VitalType.SYSTOLIC_BP: "systolic_bp",
    VitalType.DIASTOLIC_BP: "diastolic_bp",
    VitalType.OXYGEN_SATURATION: "oxygen_saturation",
    VitalType.TEMPERATURE: "temperature",
    VitalType.RESPIRATORY_RATE: "respiratory_rate",
}

#: How far back to look for the consecutive readings a sustained rule needs.
#: Generous, since a rule may ask for several and the query is bounded anyway.
HISTORY_DEPTH = 20

_SEVERITY_ORDER = {AlertSeverity.INFO: 0, AlertSeverity.WARNING: 1, AlertSeverity.CRITICAL: 2}


def measurements(vital: Vital) -> dict[VitalType, float]:
    """The readings actually present. A vital may carry any subset."""
    present: dict[VitalType, float] = {}
    for vital_type, column in COLUMNS.items():
        value = getattr(vital, column)
        if value is not None:
            present[vital_type] = float(value)
    return present


async def thresholds_for(db: AsyncSession, patient_id: str) -> list[Threshold]:
    """Every rule that could apply to this patient: their own and the hospital's.

    Both are fetched and the engine picks; resolving in SQL would need a query
    per vital type, and the whole set is a handful of rows.
    """
    rows = (
        (
            await db.execute(
                select(VitalThreshold).where(
                    VitalThreshold.enabled.is_(True),
                    # `IN (x, NULL)` never matches NULL in SQL, so the hospital
                    # default has to be asked for explicitly.
                    (VitalThreshold.patient_id == patient_id)
                    | VitalThreshold.patient_id.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    return [
        Threshold(
            vital_type=row.vital_type,
            min_value=row.min_value,
            max_value=row.max_value,
            severity=row.severity,
            sustained_readings=row.sustained_readings,
            patient_specific=row.patient_id is not None,
        )
        for row in rows
    ]


async def recent_values(
    db: AsyncSession, patient_id: str, vital_type: VitalType, before_id: str
) -> list[float]:
    """Readings of one vital, newest first, excluding the one just written.

    Excluded by id rather than by timestamp: ``recordedAt`` is caller-supplied
    for backdated entry, so two readings can share a moment, and a time filter
    would either drop a legitimate prior reading or count the new one twice.
    """
    column = getattr(Vital, COLUMNS[vital_type])
    rows = (
        (
            await db.execute(
                select(column)
                .where(
                    Vital.patient_id == patient_id,
                    Vital.id != before_id,
                    column.is_not(None),
                )
                .order_by(Vital.recorded_at.desc(), Vital.created_at.desc())
                .limit(HISTORY_DEPTH)
            )
        )
        .scalars()
        .all()
    )
    return [float(value) for value in rows]


async def assigned_doctor(db: AsyncSession, patient_id: str) -> Doctor | None:
    """Who to tell. A standing assignment first, then whoever is treating them.

    Falling back to the treating doctor matters: a patient admitted without a
    standing assignment still has somebody responsible for them, and an alert
    with nobody attached is an alert nobody reads.
    """
    doctor = (
        await db.execute(
            select(Doctor)
            .join(DoctorPatientAssignment, DoctorPatientAssignment.doctor_id == Doctor.id)
            .where(
                DoctorPatientAssignment.patient_id == patient_id,
                DoctorPatientAssignment.ended_at.is_(None),
            )
            # The primary doctor first — that is what `isPrimary` is for — then
            # the most recent assignment among equals.
            .order_by(
                DoctorPatientAssignment.is_primary.desc(),
                DoctorPatientAssignment.assigned_at.desc(),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if doctor is not None:
        return doctor

    return (
        await db.execute(
            select(Doctor)
            .join(Appointment, Appointment.doctor_id == Doctor.id)
            .where(
                Appointment.patient_id == patient_id,
                Appointment.status.in_(
                    [
                        AppointmentStatus.CONFIRMED,
                        AppointmentStatus.CHECKED_IN,
                        AppointmentStatus.IN_PROGRESS,
                        AppointmentStatus.COMPLETED,
                    ]
                ),
            )
            .order_by(Appointment.start_time.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def open_alert_for(
    db: AsyncSession, patient_id: str, vital_type: VitalType
) -> Alert | None:
    """An unresolved alert already covering this patient and vital."""
    return (
        await db.execute(
            select(Alert)
            .where(
                Alert.patient_id == patient_id,
                Alert.vital_type == vital_type,
                Alert.status.in_([AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED, AlertStatus.ESCALATED]),
            )
            .order_by(Alert.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def raise_alert(
    db: AsyncSession, *, vital: Vital, breach: Breach, doctor: Doctor | None
) -> Alert | None:
    """Create an alert unless one is already open for the same problem.

    Returns ``None`` when suppressed as a duplicate. The one exception is a
    deterioration: if the same vital breaches at a higher severity than the
    open alert, the existing alert is escalated rather than left showing the
    milder picture — the reason nobody has acted yet might be that it did not
    look urgent.
    """
    existing = await open_alert_for(db, vital.patient_id, breach.vital_type)
    if existing is not None:
        if _SEVERITY_ORDER[breach.severity] > _SEVERITY_ORDER[existing.severity]:
            existing.severity = breach.severity
            existing.measured_value = breach.value
            existing.message = breach.message()
            existing.status = AlertStatus.ESCALATED
            existing.escalated_at = utcnow()
            existing.escalation_level += 1
            await db.flush()
            logger.info(
                "vital_alert_escalated",
                alert_id=existing.id,
                vital_type=str(breach.vital_type),
                severity=str(breach.severity),
            )
            return existing
        return None

    alert = Alert(
        id=new_id(),
        patient_id=vital.patient_id,
        vital_id=vital.id,
        doctor_id=doctor.id if doctor else None,
        vital_type=breach.vital_type,
        measured_value=breach.value,
        threshold_min=breach.threshold.min_value,
        threshold_max=breach.threshold.max_value,
        severity=breach.severity,
        status=AlertStatus.OPEN,
        message=breach.message(),
    )
    db.add(alert)
    await db.flush()
    return alert


async def notify_doctor(db: AsyncSession, alert: Alert, doctor: Doctor | None) -> None:
    """Tell the responsible doctor. Absence of one is worth a log line."""
    if doctor is None:
        logger.warning(
            "vital_alert_unassigned",
            alert_id=alert.id,
            severity=str(alert.severity),
            detail="no assigned or treating doctor to notify",
        )
        return

    await notify(
        db,
        user_id=doctor.user_id,
        notification_type=NotificationType.VITAL_ALERT,
        title=f"{alert.severity} vital alert",
        # The measured value belongs here: a notification that says "a vital is
        # abnormal" makes the reader open the app to learn whether it can wait.
        body=alert.message,
        link="/doctor/alerts",
        metadata={"alertId": alert.id, "vitalType": str(alert.vital_type)},
        priority=2 if alert.severity == AlertSeverity.CRITICAL else 1,
    )


async def evaluate_vital(db: AsyncSession, vital: Vital) -> list[Alert]:
    """Run the engine over a saved reading and act on what it finds.

    Called after the vital is persisted, so a failure here cannot cost the
    measurement.
    """
    rules = await thresholds_for(db, vital.patient_id)
    if not rules:
        # Nothing configured is a configuration gap, not a clean bill of health,
        # and it must be visible rather than silent.
        logger.warning("vital_thresholds_missing", patient_id=vital.patient_id)
        return []

    doctor = await assigned_doctor(db, vital.patient_id)
    raised: list[Alert] = []

    for vital_type, value in measurements(vital).items():
        history = await recent_values(db, vital.patient_id, vital_type, vital.id)
        breach = evaluate(vital_type, [value, *history], rules)
        if breach is None:
            continue

        alert = await raise_alert(db, vital=vital, breach=breach, doctor=doctor)
        if alert is None:
            continue  # already open; the ward is on it

        await notify_doctor(db, alert, doctor)
        raised.append(alert)

    return raised


def serialize_vital(vital: Vital) -> dict[str, Any]:
    return {
        "id": vital.id,
        "patientId": vital.patient_id,
        "recordedById": vital.recorded_by_id,
        "source": str(vital.source),
        "deviceId": vital.device_id,
        "heartRate": vital.heart_rate,
        "systolicBp": vital.systolic_bp,
        "diastolicBp": vital.diastolic_bp,
        "oxygenSaturation": vital.oxygen_saturation,
        "temperature": vital.temperature,
        "respiratoryRate": vital.respiratory_rate,
        "recordedAt": vital.recorded_at.isoformat() + "Z",
    }


def serialize_alert(alert: Alert) -> dict[str, Any]:
    return {
        "id": alert.id,
        "patientId": alert.patient_id,
        "vitalId": alert.vital_id,
        "doctorId": alert.doctor_id,
        "vitalType": str(alert.vital_type),
        "measuredValue": alert.measured_value,
        "thresholdMin": alert.threshold_min,
        "thresholdMax": alert.threshold_max,
        "severity": str(alert.severity),
        "status": str(alert.status),
        "message": alert.message,
        "acknowledgedById": alert.acknowledged_by_id,
        "acknowledgedAt": (
            alert.acknowledged_at.isoformat() + "Z" if alert.acknowledged_at else None
        ),
        "resolvedAt": alert.resolved_at.isoformat() + "Z" if alert.resolved_at else None,
        "escalationLevel": alert.escalation_level,
        "createdAt": alert.created_at.isoformat() + "Z",
    }


def broadcast(vital: Vital, alerts: list[Alert]) -> None:
    """Push the reading and any alerts to connected dashboards."""
    stream.publish("vital", vital.patient_id, serialize_vital(vital))
    for alert in alerts:
        stream.publish("alert", alert.patient_id, serialize_alert(alert))

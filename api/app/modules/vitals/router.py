"""Vital readings and their thresholds (spec §16-17).

**Recording a vital is not reading a chart, and the permissions say so.** A
nurse holds ``vital:write`` and no standing clinical access at all (conflict
C1): they can record what they just measured on the patient in front of them,
and still cannot open that patient's history. Writes therefore check the
permission, not ``require_clinical_access`` — gating them on the clinical
relationship would make the nurse role unable to do the one clinical task it
has. Every write is audited with the patient it was recorded against.

**Reading vitals is reading a chart**, so it goes through the same clinical gate
as records and prescriptions: own data, an assigned or treating doctor, or an
active break-glass grant. An administrator is refused here exactly as they are
on a diagnosis.

Thresholds are configuration rather than clinical content, so they sit behind
``threshold:manage`` — held by administrators and doctors, not by patients.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.errors import bad_request, not_found
from app.db.base import new_id
from app.db.enums import (
    AlertSeverity,
    AuditAction,
    AuditSeverity,
    DataSource,
    VitalType,
)
from app.db.models import Patient, Vital, VitalThreshold
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.records.access import require_clinical_access
from app.modules.vitals import service
from app.modules.vitals.thresholds import LABELS, PLAUSIBLE, UNITS, is_plausible

router = APIRouter(prefix="/vitals", tags=["vitals"])

RequireVitalWrite = Annotated[object, Depends(require_permission(Permission.VITAL_WRITE))]
RequireThresholdManage = Annotated[
    object, Depends(require_permission(Permission.THRESHOLD_MANAGE))
]


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(UTC).replace(tzinfo=None)
    return value.replace(microsecond=0)


class VitalCreate(BaseModel):
    """One set of observations. Every measurement is optional; at least one is
    required, because a reading with nothing in it is not a reading."""

    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    patient_id: str = Field(alias="patientId", min_length=1, max_length=64)
    heart_rate: int | None = Field(default=None, alias="heartRate")
    systolic_bp: int | None = Field(default=None, alias="systolicBp")
    diastolic_bp: int | None = Field(default=None, alias="diastolicBp")
    oxygen_saturation: float | None = Field(default=None, alias="oxygenSaturation")
    temperature: float | None = None
    respiratory_rate: int | None = Field(default=None, alias="respiratoryRate")
    #: Backdating is allowed — obs are often written up after the round — but a
    #: future reading is a clock or entry error, and it would corrupt the
    #: "consecutive readings" history the threshold engine walks.
    recorded_at: datetime | None = Field(default=None, alias="recordedAt")
    source: DataSource = DataSource.DEVICE
    device_id: Annotated[str, Field(max_length=128)] | None = Field(
        default=None, alias="deviceId"
    )

    @model_validator(mode="after")
    def check_readings(self) -> VitalCreate:
        present = {
            VitalType.HEART_RATE: self.heart_rate,
            VitalType.SYSTOLIC_BP: self.systolic_bp,
            VitalType.DIASTOLIC_BP: self.diastolic_bp,
            VitalType.OXYGEN_SATURATION: self.oxygen_saturation,
            VitalType.TEMPERATURE: self.temperature,
            VitalType.RESPIRATORY_RATE: self.respiratory_rate,
        }
        supplied = {key: value for key, value in present.items() if value is not None}
        if not supplied:
            raise ValueError("Provide at least one measurement.")

        # The spec's "validate reading" step. These bounds reject device and
        # entry faults, not clinical extremes: a heart rate of 250 is stored and
        # alerted on, 900 is refused.
        for vital_type, value in supplied.items():
            if not is_plausible(vital_type, float(value)):
                low, high = PLAUSIBLE[vital_type]
                raise ValueError(
                    f"{LABELS[vital_type]} of {value} {UNITS[vital_type]} is outside the "
                    f"possible range {low} to {high}. Check the device or the entry."
                )

        if (
            self.systolic_bp is not None
            and self.diastolic_bp is not None
            and self.diastolic_bp >= self.systolic_bp
        ):
            raise ValueError("Diastolic pressure must be lower than systolic.")

        return self


class ThresholdWrite(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    vital_type: VitalType = Field(alias="vitalType")
    #: NULL means the hospital default. A value scopes the rule to one patient,
    #: which is how a COPD patient avoids alarming on their ordinary saturation.
    patient_id: str | None = Field(default=None, alias="patientId", max_length=64)
    min_value: float | None = Field(default=None, alias="minValue")
    max_value: float | None = Field(default=None, alias="maxValue")
    severity: AlertSeverity = AlertSeverity.WARNING
    enabled: bool = True
    sustained_readings: int = Field(default=1, alias="sustainedReadings", ge=1, le=10)

    @model_validator(mode="after")
    def check_bounds(self) -> ThresholdWrite:
        if self.min_value is None and self.max_value is None:
            raise ValueError("A threshold needs a minimum, a maximum, or both.")
        if (
            self.min_value is not None
            and self.max_value is not None
            and self.min_value >= self.max_value
        ):
            raise ValueError("The minimum must be below the maximum.")
        return self


def _serialize_threshold(row: VitalThreshold) -> dict[str, Any]:
    return {
        "id": row.id,
        "vitalType": str(row.vital_type),
        "patientId": row.patient_id,
        "scope": "PATIENT" if row.patient_id else "HOSPITAL",
        "minValue": row.min_value,
        "maxValue": row.max_value,
        "severity": str(row.severity),
        "enabled": row.enabled,
        "sustainedReadings": row.sustained_readings,
        "unit": UNITS[row.vital_type],
        "label": LABELS[row.vital_type],
    }


@router.post("", status_code=201)
async def record_vital(
    payload: VitalCreate,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireVitalWrite,
) -> dict[str, Any]:
    """Save a reading, then judge it.

    The order is the point: the measurement is persisted first, so a fault in
    the threshold configuration can cost an alert but never a data point.
    """
    patient = (
        await db.execute(select(Patient.id).where(Patient.id == payload.patient_id))
    ).scalar_one_or_none()
    if patient is None:
        raise not_found("No such patient.")

    recorded_at = _naive_utc(payload.recorded_at)
    if recorded_at and recorded_at > datetime.now(UTC).replace(tzinfo=None):
        raise bad_request("A reading cannot be recorded in the future.")

    vital = Vital(
        id=new_id(),
        patient_id=payload.patient_id,
        recorded_by_id=auth.user_id,
        source=payload.source,
        device_id=payload.device_id,
        heart_rate=payload.heart_rate,
        systolic_bp=payload.systolic_bp,
        diastolic_bp=payload.diastolic_bp,
        oxygen_saturation=payload.oxygen_saturation,
        temperature=payload.temperature,
        respiratory_rate=payload.respiratory_rate,
        **({"recorded_at": recorded_at} if recorded_at else {}),
    )
    db.add(vital)
    await db.flush()

    alerts = await service.evaluate_vital(db, vital)

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.VITAL_RECORDED,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=vital.patient_id,
            entity_type="Vital",
            entity_id=vital.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            # Which vitals were taken, never the values — the measurements live
            # in `vitals`, and copying clinical values into the audit log would
            # duplicate them into a table with a different audience (C5).
            metadata={
                "measured": sorted(str(key) for key in service.measurements(vital)),
                "source": str(vital.source),
                "alertsRaised": len(alerts),
            },
        ),
    )

    for alert in alerts:
        await record_audit(
            db,
            AuditEntry(
                action=AuditAction.VITAL_ALERT,
                # AuditSeverity has no CRITICAL tier — WARNING is its top
                # non-security level, and a clinical alert is not a security
                # event. The alert's own severity carries the clinical urgency.
                severity=AuditSeverity.WARNING,
                user_id=auth.user_id,
                actor_role=auth.role,
                patient_id=alert.patient_id,
                entity_type="Alert",
                entity_id=alert.id,
                ip_address=client_ip(request),
                request_id=getattr(request.state, "request_id", None),
                metadata={
                    "vitalType": str(alert.vital_type),
                    "severity": str(alert.severity),
                    "notifiedDoctorId": alert.doctor_id,
                },
            ),
        )

    # Published after the writes are staged so a dashboard cannot be told about
    # a reading the transaction then rolls back.
    service.broadcast(vital, alerts)

    return ok(
        {
            **service.serialize_vital(vital),
            "alerts": [service.serialize_alert(alert) for alert in alerts],
        }
    )


@router.get("/{patient_id}")
async def list_vitals(
    patient_id: str,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
) -> dict[str, Any]:
    """One patient's readings, newest first."""
    await require_clinical_access(db, auth, request, patient_id, what="Vital")

    total = (
        await db.execute(
            select(func.count()).select_from(Vital).where(Vital.patient_id == patient_id)
        )
    ).scalar_one()

    rows = (
        (
            await db.execute(
                select(Vital)
                .where(Vital.patient_id == patient_id)
                .order_by(Vital.recorded_at.desc())
                .limit(page.limit)
                .offset(page.offset)
            )
        )
        .scalars()
        .all()
    )

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.PATIENT_RECORD_VIEW,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=patient_id,
            entity_type="Vital",
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"count": len(rows)},
        ),
    )

    return ok([service.serialize_vital(row) for row in rows], page.meta(total))


@router.get("/{patient_id}/thresholds")
async def list_thresholds(
    patient_id: str,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
) -> dict[str, Any]:
    """The rules that actually govern this patient, and where each came from.

    Returned resolved rather than raw so a reader can see at a glance which
    vitals are covered by a personal rule, which fall back to the hospital
    default, and which are not configured at all — that last case being a gap
    where no alert will ever fire.
    """
    await require_clinical_access(db, auth, request, patient_id, what="VitalThreshold")

    rows = (
        (
            await db.execute(
                select(VitalThreshold).where(
                    VitalThreshold.enabled.is_(True),
                    (VitalThreshold.patient_id == patient_id)
                    | VitalThreshold.patient_id.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )

    by_type: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = str(row.vital_type)
        # A patient's own rule wins; without one the hospital default stands.
        if key not in by_type or row.patient_id is not None:
            by_type[key] = _serialize_threshold(row)

    return ok(
        {
            "thresholds": [by_type[key] for key in sorted(by_type)],
            "unconfigured": sorted(
                str(vital_type) for vital_type in VitalType if str(vital_type) not in by_type
            ),
        }
    )


@router.put("/thresholds")
async def upsert_threshold(
    payload: ThresholdWrite,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireThresholdManage,
) -> dict[str, Any]:
    """Create or update one rule.

    Idempotent on (vital type, scope), which is what the unique indexes enforce:
    one hospital default per vital, one override per patient per vital.
    """
    if payload.patient_id is not None:
        exists = (
            await db.execute(select(Patient.id).where(Patient.id == payload.patient_id))
        ).scalar_one_or_none()
        if exists is None:
            raise not_found("No such patient.")

    existing = (
        await db.execute(
            select(VitalThreshold).where(
                VitalThreshold.vital_type == payload.vital_type,
                VitalThreshold.patient_id == payload.patient_id
                if payload.patient_id is not None
                else VitalThreshold.patient_id.is_(None),
            )
        )
    ).scalar_one_or_none()

    before = _serialize_threshold(existing) if existing else None

    if existing is None:
        existing = VitalThreshold(
            id=new_id(),
            vital_type=payload.vital_type,
            patient_id=payload.patient_id,
            created_by_id=auth.user_id,
        )
        db.add(existing)

    existing.min_value = payload.min_value
    existing.max_value = payload.max_value
    existing.severity = payload.severity
    existing.enabled = payload.enabled
    existing.sustained_readings = payload.sustained_readings
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.CONFIG_CHANGED,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=payload.patient_id,
            entity_type="VitalThreshold",
            entity_id=existing.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            # Threshold values are configuration, not clinical content about a
            # person, so recording what changed is safe and useful: "why did
            # nobody get alerted" is answerable afterwards.
            metadata={
                "vitalType": str(payload.vital_type),
                "scope": "PATIENT" if payload.patient_id else "HOSPITAL",
                "before": before,
                "after": _serialize_threshold(existing),
            },
        ),
    )

    return ok(_serialize_threshold(existing))

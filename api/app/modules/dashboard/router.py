"""Dashboard summaries.

One endpoint per role, each returning only what that role is entitled to see.
Keeping them separate means the patient overview cannot accidentally grow an
admin field, and each query is scoped at the database rather than filtered after
the fact.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Request
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip
from app.api.responses import ok
from app.core.errors import forbidden
from app.db.base import utcnow
from app.db.enums import (
    AlertStatus,
    AppointmentStatus,
    AuditAction,
    AuditSeverity,
    EmergencyAccessStatus,
    InvoiceStatus,
    Role,
    UserStatus,
)
from app.db.models import (
    Alert,
    Appointment,
    AuditLog,
    Department,
    Doctor,
    DoctorPatientAssignment,
    EmergencyAccess,
    Invoice,
    MedicalDocument,
    Notification,
    Patient,
    Prescription,
    User,
)
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

ACTIVE_APPOINTMENT_STATUSES = [
    AppointmentStatus.REQUESTED,
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.CHECKED_IN,
]


async def _count(db: DbSession, stmt: Any) -> int:
    return (await db.execute(stmt)).scalar_one() or 0


@router.get("/patient")
async def patient_dashboard(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    """Overview for the patient portal (R7)."""
    if auth.role != Role.PATIENT or not auth.patient_id:
        raise forbidden("This dashboard is for patients.")

    pid = auth.patient_id
    now = utcnow()

    upcoming = (
        await db.execute(
            select(Appointment, Doctor, User)
            .join(Doctor, Doctor.id == Appointment.doctor_id)
            .join(User, User.id == Doctor.user_id)
            .where(
                Appointment.patient_id == pid,
                Appointment.start_time >= now,
                Appointment.status.in_(ACTIVE_APPOINTMENT_STATUSES),
            )
            .order_by(Appointment.start_time)
            .limit(5)
        )
    ).all()

    active_prescriptions = (
        await db.execute(
            select(Prescription, Doctor, User)
            .join(Doctor, Doctor.id == Prescription.doctor_id)
            .join(User, User.id == Doctor.user_id)
            .where(Prescription.patient_id == pid, Prescription.active.is_(True))
            .order_by(Prescription.created_at.desc())
            .limit(5)
        )
    ).all()

    return ok(
        {
            "counts": {
                "upcomingAppointments": await _count(
                    db,
                    select(func.count(Appointment.id)).where(
                        Appointment.patient_id == pid,
                        Appointment.start_time >= now,
                        Appointment.status.in_(ACTIVE_APPOINTMENT_STATUSES),
                    ),
                ),
                "activePrescriptions": await _count(
                    db,
                    select(func.count(Prescription.id)).where(
                        Prescription.patient_id == pid, Prescription.active.is_(True)
                    ),
                ),
                "documents": await _count(
                    db,
                    select(func.count(MedicalDocument.id)).where(
                        MedicalDocument.patient_id == pid, MedicalDocument.deleted_at.is_(None)
                    ),
                ),
                "unpaidInvoices": await _count(
                    db,
                    select(func.count(Invoice.id)).where(
                        Invoice.patient_id == pid,
                        Invoice.status.in_([InvoiceStatus.ISSUED, InvoiceStatus.OVERDUE]),
                    ),
                ),
                "unreadNotifications": await _count(
                    db,
                    select(func.count(Notification.id)).where(
                        Notification.user_id == auth.user_id, Notification.read_at.is_(None)
                    ),
                ),
            },
            "upcomingAppointments": [
                {
                    "id": appointment.id,
                    "startTime": appointment.start_time.isoformat(),
                    "status": str(appointment.status),
                    "reason": appointment.reason,
                    "doctor": {"id": doctor.id, "name": user.name, "specialization": doctor.specialization},
                }
                for appointment, doctor, user in upcoming
            ],
            "activePrescriptions": [
                {
                    "id": prescription.id,
                    "medication": prescription.medication,
                    "dosage": prescription.dosage,
                    "frequency": prescription.frequency,
                    "duration": prescription.duration,
                    "prescribedBy": user.name,
                }
                for prescription, _doctor, user in active_prescriptions
            ],
        }
    )


@router.get("/doctor")
async def doctor_dashboard(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    if auth.role != Role.DOCTOR or not auth.doctor_id:
        raise forbidden("This dashboard is for doctors.")

    did = auth.doctor_id
    now = utcnow()
    day_end = now + timedelta(days=1)

    today = (
        await db.execute(
            select(Appointment, Patient, User)
            .join(Patient, Patient.id == Appointment.patient_id)
            .join(User, User.id == Patient.user_id)
            .where(
                Appointment.doctor_id == did,
                Appointment.start_time >= now,
                Appointment.start_time < day_end,
                Appointment.status.in_(ACTIVE_APPOINTMENT_STATUSES),
            )
            .order_by(Appointment.start_time)
            .limit(10)
        )
    ).all()

    # Open alerts on this doctor's patients (R1). Ordered newest first so the
    # most recent breach is at the top of the list.
    alerts = (
        await db.execute(
            select(Alert, Patient, User)
            .join(Patient, Patient.id == Alert.patient_id)
            .join(User, User.id == Patient.user_id)
            .where(Alert.doctor_id == did, Alert.status == AlertStatus.OPEN)
            .order_by(Alert.created_at.desc())
            .limit(10)
        )
    ).all()

    return ok(
        {
            "counts": {
                "assignedPatients": await _count(
                    db,
                    select(func.count(DoctorPatientAssignment.id)).where(
                        DoctorPatientAssignment.doctor_id == did,
                        DoctorPatientAssignment.ended_at.is_(None),
                    ),
                ),
                "appointmentsToday": await _count(
                    db,
                    select(func.count(Appointment.id)).where(
                        Appointment.doctor_id == did,
                        Appointment.start_time >= now,
                        Appointment.start_time < day_end,
                        Appointment.status.in_(ACTIVE_APPOINTMENT_STATUSES),
                    ),
                ),
                "openAlerts": await _count(
                    db,
                    select(func.count(Alert.id)).where(
                        Alert.doctor_id == did, Alert.status == AlertStatus.OPEN
                    ),
                ),
                "pendingConsultations": await _count(
                    db,
                    select(func.count(Appointment.id)).where(
                        Appointment.doctor_id == did,
                        Appointment.status == AppointmentStatus.IN_PROGRESS,
                    ),
                ),
            },
            "todaysAppointments": [
                {
                    "id": appointment.id,
                    "startTime": appointment.start_time.isoformat(),
                    "status": str(appointment.status),
                    "reason": appointment.reason,
                    "patient": {
                        "id": patient.id,
                        "name": user.name,
                        "medicalRecordNumber": patient.medical_record_number,
                    },
                }
                for appointment, patient, user in today
            ],
            "openAlerts": [
                {
                    "id": alert.id,
                    "severity": str(alert.severity),
                    "vitalType": str(alert.vital_type),
                    "measuredValue": alert.measured_value,
                    "message": alert.message,
                    "createdAt": alert.created_at.isoformat(),
                    "patient": {"id": patient.id, "name": user.name},
                }
                for alert, patient, user in alerts
            ],
        }
    )


@router.get("/admin")
async def admin_dashboard(request: Request, auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    if not auth.has(Permission.ANALYTICS_READ):
        raise forbidden("This dashboard is for administrators.")

    now = utcnow()
    week_ago = now - timedelta(days=7)

    # Break-glass grants awaiting compliance review. This is the deterrent that
    # makes emergency override safe to offer at all (conflict C1).
    unreviewed = await _count(
        db,
        select(func.count(EmergencyAccess.id)).where(EmergencyAccess.reviewed_at.is_(None)),
    )

    recent_security = (
        await db.execute(
            select(AuditLog)
            .where(
                AuditLog.severity.in_([AuditSeverity.SECURITY, AuditSeverity.BREAK_GLASS]),
                AuditLog.timestamp >= week_ago,
            )
            .order_by(AuditLog.timestamp.desc())
            .limit(10)
        )
    ).scalars().all()

    # Reading security events is itself privileged and is therefore logged.
    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.CONFIG_CHANGED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="AuditLog",
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"operation": "read_security_summary"},
        ),
    )

    return ok(
        {
            "counts": {
                "patients": await _count(db, select(func.count(Patient.id))),
                "doctors": await _count(db, select(func.count(Doctor.id))),
                "departments": await _count(
                    db, select(func.count(Department.id)).where(Department.active.is_(True))
                ),
                "suspendedAccounts": await _count(
                    db,
                    select(func.count(User.id)).where(User.status != UserStatus.ACTIVE),
                ),
                "appointmentsThisWeek": await _count(
                    db,
                    select(func.count(Appointment.id)).where(Appointment.created_at >= week_ago),
                ),
                "unpaidInvoices": await _count(
                    db,
                    select(func.count(Invoice.id)).where(
                        Invoice.status.in_([InvoiceStatus.ISSUED, InvoiceStatus.OVERDUE])
                    ),
                ),
                "activeEmergencyGrants": await _count(
                    db,
                    select(func.count(EmergencyAccess.id)).where(
                        EmergencyAccess.status == EmergencyAccessStatus.ACTIVE,
                        EmergencyAccess.expires_at > now,
                    ),
                ),
                "unreviewedEmergencyGrants": unreviewed,
                "failedLoginsThisWeek": await _count(
                    db,
                    select(func.count(AuditLog.id)).where(
                        AuditLog.action == AuditAction.LOGIN_FAILED,
                        AuditLog.timestamp >= week_ago,
                    ),
                ),
            },
            "recentSecurityEvents": [
                {
                    "id": entry.id,
                    "action": str(entry.action),
                    "severity": str(entry.severity),
                    "timestamp": entry.timestamp.isoformat(),
                    "userId": entry.user_id,
                    "ipAddress": entry.ip_address,
                }
                for entry in recent_security
            ],
        }
    )

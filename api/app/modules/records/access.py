"""Who may read and write clinical content.

This is a *narrower* gate than ``require_patient_access``, and the difference is
the whole of R2. ``resolve_patient_access`` answers "may this caller touch this
patient's file at all", and an administrator passes it — they hold
``patient:read:any`` so they can run the hospital, correct a misspelled name,
and see who is booked tomorrow. None of that is a reason to read a diagnosis.

So clinical reads accept only four of the five access reasons. ``ADMIN`` is
deliberately absent, which is why every record and prescription endpoint refuses
an administrator outright rather than quietly returning a redacted record.

Break-glass is the other half. A nurse holds no standing clinical permission, so
a permission check alone would make emergency access useless for the one thing
it exists for — reading a chart when it matters (R3). Access is therefore
decided by the *relationship*, not by the role, and an active grant for exactly
this patient is one of the relationships that qualifies.
"""

from __future__ import annotations

from typing import Any

from fastapi import Request
from sqlalchemy import select, union, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext, DbSession, PatientAccess, client_ip, resolve_patient_access
from app.core.errors import forbidden_resource
from app.db.enums import (
    ENCOUNTER_STATUSES,
    AuditAction,
    AuditSeverity,
    Role,
)
from app.db.models import Appointment, DoctorPatientAssignment, EmergencyAccess
from app.modules.audit.service import AuditEntry, record_audit

#: Relationships that authorize reading clinical content. "ADMIN" is absent on
#: purpose — see the module docstring.
CLINICAL_ACCESS_REASONS = frozenset(
    {"SELF", "ASSIGNED_DOCTOR", "TREATING_DOCTOR", "EMERGENCY_ACCESS"}
)


def is_clinical(access: PatientAccess) -> bool:
    return access.allowed and access.reason in CLINICAL_ACCESS_REASONS


async def audit_denial(
    db: AsyncSession, auth: AuthContext, request: Request, patient_id: str, what: str
) -> None:
    """Record a refused clinical read as a security event, and keep it.

    The explicit commit is not optional: ``get_db`` rolls back on exception and
    every caller raises immediately after, so without it the evidence would be
    discarded by the very error it describes.
    """
    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.ACCESS_DENIED,
            severity=AuditSeverity.SECURITY,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=patient_id,
            entity_type=what,
            ip_address=client_ip(request),
            user_agent=request.headers.get("user-agent"),
            request_id=getattr(request.state, "request_id", None),
            metadata={"path": request.url.path, "method": request.method},
        ),
    )
    await db.commit()


async def require_clinical_access(
    db: DbSession, auth: AuthContext, request: Request, patient_id: str, what: str = "MedicalRecord"
) -> PatientAccess:
    """Gate one patient's clinical content, auditing refusals and break-glass use."""
    access = await resolve_patient_access(db, auth, patient_id)

    if not is_clinical(access):
        await audit_denial(db, auth, request, patient_id, what)
        raise forbidden_resource(
            "You do not have clinical access to this patient's records."
            if access.allowed
            else "You do not have access to this patient's data."
        )

    if access.reason == "EMERGENCY_ACCESS" and auth.emergency_access_id:
        # Every read under a grant is counted and recorded; the grant is not a
        # key that stops being interesting once used.
        await db.execute(
            update(EmergencyAccess)
            .where(EmergencyAccess.id == auth.emergency_access_id)
            .values(access_count=EmergencyAccess.access_count + 1)
        )
        await record_audit(
            db,
            AuditEntry(
                action=AuditAction.EMERGENCY_ACCESS_USED,
                severity=AuditSeverity.BREAK_GLASS,
                user_id=auth.user_id,
                actor_role=auth.role,
                patient_id=patient_id,
                entity_type=what,
                emergency_access_id=auth.emergency_access_id,
                ip_address=client_ip(request),
                user_agent=request.headers.get("user-agent"),
                request_id=getattr(request.state, "request_id", None),
                metadata={"path": request.url.path, "method": request.method},
            ),
        )

    return access


def caseload_patient_ids(doctor_id: str) -> Any:
    """Patients a doctor has a care relationship with, as a subquery.

    The same two relationships ``resolve_patient_access`` checks one patient at
    a time — a standing assignment, or an encounter they are or were consulting
    on — expressed set-wise so a listing can be scoped in the database instead
    of filtered afterwards.
    """
    assigned = select(DoctorPatientAssignment.patient_id).where(
        DoctorPatientAssignment.doctor_id == doctor_id,
        DoctorPatientAssignment.ended_at.is_(None),
    )
    treating = select(Appointment.patient_id).where(
        Appointment.doctor_id == doctor_id,
        Appointment.status.in_(ENCOUNTER_STATUSES),
    )
    return union(assigned, treating).subquery()


def clinical_scope(auth: AuthContext, patient_column: Any) -> Any:
    """The rows this caller may list, as a SQL condition.

    Returned as a filter rather than checked afterwards so out-of-scope rows are
    never loaded and paging totals stay honest. Callers who reach here without a
    scope get 403 — never an unfiltered query.
    """
    if auth.role == Role.PATIENT and auth.patient_id:
        return patient_column == auth.patient_id
    if auth.role == Role.DOCTOR and auth.doctor_id:
        return patient_column.in_(select(caseload_patient_ids(auth.doctor_id)))
    raise forbidden_resource("You do not have access to clinical records.")

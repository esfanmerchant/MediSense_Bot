"""Administrative user management.

Creating staff accounts lives here rather than in /auth for a reason: public
registration always produces a PATIENT, so the only way a DOCTOR, NURSE or
ADMIN account comes into existence is through an authenticated administrator,
and every creation is audited with the role that was granted.
"""

from __future__ import annotations

import secrets
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy import func, or_, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.errors import AppError, ErrorCode, conflict, forbidden, not_found
from app.core.security import check_password_policy, generate_opaque_token, hash_password
from app.db.base import new_id, utcnow
from app.db.enums import AuditAction, AuditSeverity, Role, UserStatus
from app.db.models import Doctor, DoctorPatientAssignment, Patient, Session, User
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission, permissions_for

router = APIRouter(prefix="/users", tags=["users"])

RequireUserAdmin = Annotated[object, Depends(require_permission(Permission.USER_MANAGE))]


class StaffCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True)

    name: Annotated[str, Field(min_length=2, max_length=120)]
    email: EmailStr
    role: Role
    phone: str | None = None
    #: Optional. When omitted a temporary password is generated and returned
    #: once, so an administrator never has to invent one.
    password: Annotated[str, Field(min_length=10, max_length=200)] | None = None

    # Doctor-only fields.
    specialization: str | None = None
    license_number: str | None = Field(default=None, alias="licenseNumber")
    department_id: str | None = Field(default=None, alias="departmentId")
    consultation_fee: float | None = Field(default=None, alias="consultationFee", ge=0)

    @field_validator("email")
    @classmethod
    def _normalise(cls, value: EmailStr) -> str:
        return str(value).strip().lower()

    @field_validator("role")
    @classmethod
    def _staff_only(cls, value: Role) -> Role:
        if value == Role.PATIENT:
            # Patients self-register; creating one here would bypass the
            # consent and profile flow the portal depends on.
            raise ValueError("Patients register themselves — use /auth/register.")
        return value


class StatusUpdate(BaseModel):
    status: UserStatus
    reason: Annotated[str, Field(min_length=3, max_length=300)] | None = None


class AssignmentCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    doctor_id: str = Field(alias="doctorId")
    patient_id: str = Field(alias="patientId")
    is_primary: bool = Field(default=False, alias="isPrimary")


def _serialize(user: User, doctor_id: str | None = None, patient_id: str | None = None) -> dict[str, Any]:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "role": str(user.role),
        "phone": user.phone,
        "status": str(user.status),
        "lastLoginAt": user.last_login_at.isoformat() if user.last_login_at else None,
        "createdAt": user.created_at.isoformat(),
        "doctorId": doctor_id,
        "patientId": patient_id,
    }


@router.get("")
async def list_users(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    _: Annotated[object, Depends(require_permission(Permission.USER_READ_ANY))],
    role: Role | None = None,
    status: UserStatus | None = None,
    search: str | None = Query(default=None, max_length=100),
) -> dict[str, Any]:
    filters = []
    if role:
        filters.append(User.role == role)
    if status:
        filters.append(User.status == status)
    if search:
        filters.append(or_(User.name.ilike(f"%{search}%"), User.email.ilike(f"%{search}%")))

    total = (await db.execute(select(func.count(User.id)).where(*filters))).scalar_one()
    rows = (
        await db.execute(
            select(User, Doctor.id, Patient.id)
            .outerjoin(Doctor, Doctor.user_id == User.id)
            .outerjoin(Patient, Patient.user_id == User.id)
            .where(*filters)
            .order_by(User.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()

    return ok([_serialize(u, d, p) for u, d, p in rows], page.meta(total))


@router.post("", status_code=201)
async def create_staff_user(
    payload: StaffCreate,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireUserAdmin,
) -> dict[str, Any]:
    existing = (
        await db.execute(select(User.id).where(User.email == str(payload.email)))
    ).scalar_one_or_none()
    if existing:
        raise conflict("An account with that email already exists.")

    if payload.role == Role.DOCTOR and not (payload.specialization and payload.license_number):
        raise AppError(
            422,
            ErrorCode.VALIDATION_ERROR,
            "A doctor needs a specialization and a licence number.",
            [
                {"field": "specialization", "message": "Required for a doctor."},
                {"field": "licenseNumber", "message": "Required for a doctor."},
            ],
        )

    # A generated temporary password is shown once and never stored in clear.
    temporary_password = payload.password or f"Ms{generate_opaque_token(9)}9"
    policy = check_password_policy(temporary_password, str(payload.email))
    if not policy.valid:
        raise AppError(
            422,
            ErrorCode.VALIDATION_ERROR,
            "Choose a stronger password.",
            [{"field": "password", "message": m} for m in policy.problems],
        )

    user = User(
        id=new_id(),
        name=payload.name,
        email=str(payload.email),
        password_hash=hash_password(temporary_password),
        role=payload.role,
        phone=payload.phone,
        status=UserStatus.ACTIVE,
        # Stamped here, because login refuses an account whose address has not
        # been proved and nothing in this path ever emails a code. An
        # administrator creating a colleague *is* the verification — the same
        # judgement the 0006 backfill recorded for every account that predated
        # the check. Without this, staff created today can never sign in.
        email_verified_at=utcnow(),
    )
    db.add(user)
    await db.flush()

    doctor_id: str | None = None
    if payload.role == Role.DOCTOR:
        doctor = Doctor(
            id=new_id(),
            user_id=user.id,
            specialization=payload.specialization or "General Medicine",
            license_number=payload.license_number or f"TEMP-{secrets.randbelow(10**8):08d}",
            department_id=payload.department_id,
            consultation_fee=payload.consultation_fee or 0,
            availability=[],
        )
        db.add(doctor)
        await db.flush()
        doctor_id = doctor.id

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.USER_CREATED,
            severity=AuditSeverity.NOTICE,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="User",
            entity_id=user.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            # The granted role is the security-relevant fact worth recording.
            metadata={"createdRole": str(payload.role), "createdUserId": user.id},
        ),
    )

    body = _serialize(user, doctor_id)
    if payload.password is None:
        body["temporaryPassword"] = temporary_password
        body["note"] = "Shown once. Ask the user to change it after first sign-in."
    return ok(body)


@router.patch("/{user_id}/status")
async def set_user_status(
    user_id: str,
    payload: StatusUpdate,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireUserAdmin,
) -> dict[str, Any]:
    """Suspend or reactivate an account.

    Suspension revokes every live session immediately — otherwise a suspended
    user keeps working until their token happens to expire.
    """
    if user_id == auth.user_id:
        raise forbidden("You cannot change your own account status.")

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise not_found("User")

    previous = user.status
    user.status = payload.status

    if payload.status != UserStatus.ACTIVE:
        now = datetime.utcnow().replace(microsecond=0)
        for session in (
            (
                await db.execute(
                    select(Session).where(Session.user_id == user_id, Session.revoked_at.is_(None))
                )
            )
            .scalars()
            .all()
        ):
            session.revoked_at = now
            session.revoked_reason = "ACCOUNT_STATUS_CHANGED"

    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.USER_STATUS_CHANGED,
            severity=AuditSeverity.SECURITY,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="User",
            entity_id=user_id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"from": str(previous), "to": str(payload.status), "reason": payload.reason},
        ),
    )
    return ok(_serialize(user))


@router.post("/assignments", status_code=201)
async def assign_doctor_to_patient(
    payload: AssignmentCreate,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: Annotated[object, Depends(require_permission(Permission.PATIENT_MANAGE))],
) -> dict[str, Any]:
    """Create the care relationship.

    This row is what later authorizes a doctor to open a patient's chart, so
    creating one is a security-relevant act and is audited as such.
    """
    doctor = (await db.execute(select(Doctor).where(Doctor.id == payload.doctor_id))).scalar_one_or_none()
    if doctor is None:
        raise not_found("Doctor")
    patient = (
        await db.execute(select(Patient).where(Patient.id == payload.patient_id))
    ).scalar_one_or_none()
    if patient is None:
        raise not_found("Patient")

    existing = (
        await db.execute(
            select(DoctorPatientAssignment).where(
                DoctorPatientAssignment.doctor_id == payload.doctor_id,
                DoctorPatientAssignment.patient_id == payload.patient_id,
            )
        )
    ).scalar_one_or_none()

    if existing:
        # Re-assigning a previously ended relationship reopens it rather than
        # creating a duplicate row.
        existing.ended_at = None
        existing.is_primary = payload.is_primary
        assignment = existing
    else:
        assignment = DoctorPatientAssignment(
            id=new_id(),
            doctor_id=payload.doctor_id,
            patient_id=payload.patient_id,
            is_primary=payload.is_primary,
            assigned_by=auth.user_id,
        )
        db.add(assignment)
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.CONFIG_CHANGED,
            severity=AuditSeverity.NOTICE,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=payload.patient_id,
            entity_type="DoctorPatientAssignment",
            entity_id=assignment.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"doctorId": payload.doctor_id, "isPrimary": payload.is_primary},
        ),
    )
    return ok(
        {
            "id": assignment.id,
            "doctorId": assignment.doctor_id,
            "patientId": assignment.patient_id,
            "isPrimary": assignment.is_primary,
        }
    )


@router.delete("/assignments/{assignment_id}")
async def end_assignment(
    assignment_id: str,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: Annotated[object, Depends(require_permission(Permission.PATIENT_MANAGE))],
) -> dict[str, Any]:
    """End a care relationship.

    Marked ended rather than deleted: the fact that a doctor once treated this
    patient is part of the record, and deleting the row would also erase why
    their historical access was legitimate.
    """
    assignment = (
        await db.execute(
            select(DoctorPatientAssignment).where(DoctorPatientAssignment.id == assignment_id)
        )
    ).scalar_one_or_none()
    if assignment is None:
        raise not_found("Assignment")

    assignment.ended_at = datetime.utcnow().replace(microsecond=0)
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.CONFIG_CHANGED,
            severity=AuditSeverity.NOTICE,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=assignment.patient_id,
            entity_type="DoctorPatientAssignment",
            entity_id=assignment.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"operation": "end"},
        ),
    )
    return ok({"id": assignment.id, "ended": True})


@router.get("/permissions")
async def my_permissions(auth: CurrentAuth) -> dict[str, Any]:
    """What the signed-in user may do.

    The client uses this to decide what to render. It is never authorization —
    every endpoint re-checks server-side (spec §34).
    """
    return ok(
        {
            "role": str(auth.role),
            "permissions": sorted(str(p) for p in permissions_for(auth.role)),
        }
    )

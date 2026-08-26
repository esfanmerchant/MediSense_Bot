"""Doctor directory and caseload.

Two audiences with different needs from the same table: a patient browsing for
someone to book with, and a doctor looking at their own assigned patients. The
directory exposes professional details only — never anything about who a doctor
treats, which would leak the care relationship itself.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.errors import forbidden, not_found
from app.db.enums import AuditAction, Role, UserStatus
from app.db.models import Department, Doctor, DoctorPatientAssignment, Patient, User
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission

router = APIRouter(prefix="/doctors", tags=["doctors"])


class DoctorProfileUpdate(BaseModel):
    specialization: Annotated[str, Field(min_length=2, max_length=120)] | None = None
    qualifications: Annotated[str, Field(max_length=500)] | None = None
    years_experience: Annotated[int, Field(ge=0, le=70)] | None = Field(
        default=None, alias="yearsExperience"
    )
    accepting_patients: bool | None = Field(default=None, alias="acceptingPatients")
    availability: list[dict[str, Any]] | None = None

    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True)


def _serialize(doctor: Doctor, user: User, department: Department | None) -> dict[str, Any]:
    return {
        "id": doctor.id,
        "name": user.name,
        "specialization": doctor.specialization,
        "qualifications": doctor.qualifications,
        "yearsExperience": doctor.years_experience,
        "consultationFee": float(doctor.consultation_fee),
        "acceptingPatients": doctor.accepting_patients,
        "availability": doctor.availability,
        "department": (
            {"id": department.id, "name": department.name, "code": department.code}
            if department
            else None
        ),
    }


@router.get("")
async def list_doctors(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    department_id: str | None = Query(default=None, alias="departmentId"),
    specialization: str | None = None,
    search: str | None = Query(default=None, max_length=100),
    accepting_only: bool = Query(default=False, alias="acceptingOnly"),
) -> dict[str, Any]:
    """Directory for booking. Deliberately contains no patient information."""
    filters = []
    if department_id:
        filters.append(Doctor.department_id == department_id)
    if specialization:
        filters.append(Doctor.specialization.ilike(f"%{specialization}%"))
    if accepting_only:
        filters.append(Doctor.accepting_patients.is_(True))
    if search:
        filters.append(
            or_(User.name.ilike(f"%{search}%"), Doctor.specialization.ilike(f"%{search}%"))
        )
    # A deactivated account must not appear as bookable.
    filters.append(User.status == UserStatus.ACTIVE)

    base = (
        select(Doctor, User, Department)
        .join(User, User.id == Doctor.user_id)
        .outerjoin(Department, Department.id == Doctor.department_id)
        .where(*filters)
    )

    total = (
        await db.execute(
            select(func.count(Doctor.id)).join(User, User.id == Doctor.user_id).where(*filters)
        )
    ).scalar_one()

    rows = (
        await db.execute(base.order_by(User.name).limit(page.limit).offset(page.offset))
    ).all()

    return ok([_serialize(d, u, dept) for d, u, dept in rows], page.meta(total))


@router.get("/me")
async def my_doctor_profile(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    if auth.role != Role.DOCTOR or not auth.doctor_id:
        raise forbidden("This endpoint is for doctors.")
    return await _get_doctor(db, auth.doctor_id)


@router.patch("/me")
async def update_my_profile(
    payload: DoctorProfileUpdate, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """A doctor edits their own professional details.

    Notably absent: licence number and department. Those are credentialing
    facts an administrator sets, not self-service fields.
    """
    if auth.role != Role.DOCTOR or not auth.doctor_id:
        raise forbidden("This endpoint is for doctors.")

    doctor = (
        await db.execute(select(Doctor).where(Doctor.id == auth.doctor_id))
    ).scalar_one_or_none()
    if doctor is None:
        raise not_found("Doctor")

    changed = payload.model_dump(exclude_none=True, by_alias=False)
    for field, value in changed.items():
        setattr(doctor, field, value)
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.USER_UPDATED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="Doctor",
            entity_id=doctor.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"fields": sorted(changed)},
        ),
    )
    return await _get_doctor(db, doctor.id)


@router.get("/me/patients")
async def my_patients(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    _: Annotated[object, Depends(require_permission(Permission.PATIENT_READ_ASSIGNED))],
) -> dict[str, Any]:
    """The doctor's caseload — patients they hold a care relationship with.

    Scoped by assignment rather than by role: "DOCTOR" alone never means "every
    patient in the hospital".
    """
    if not auth.doctor_id:
        raise forbidden("This endpoint is for doctors.")

    filters = [
        DoctorPatientAssignment.doctor_id == auth.doctor_id,
        DoctorPatientAssignment.ended_at.is_(None),
    ]

    total = (
        await db.execute(select(func.count(DoctorPatientAssignment.id)).where(*filters))
    ).scalar_one()

    rows = (
        await db.execute(
            select(Patient, User, DoctorPatientAssignment.is_primary)
            .join(DoctorPatientAssignment, DoctorPatientAssignment.patient_id == Patient.id)
            .join(User, User.id == Patient.user_id)
            .where(*filters)
            .order_by(User.name)
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()

    return ok(
        [
            {
                "id": patient.id,
                "name": user.name,
                "medicalRecordNumber": patient.medical_record_number,
                "dateOfBirth": patient.date_of_birth.date().isoformat()
                if patient.date_of_birth
                else None,
                "gender": str(patient.gender),
                "bloodGroup": patient.blood_group,
                "allergies": patient.allergies,
                "chronicConditions": patient.chronic_conditions,
                "isPrimary": is_primary,
            }
            for patient, user, is_primary in rows
        ],
        page.meta(total),
    )


@router.get("/{doctor_id}")
async def get_doctor(doctor_id: str, auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    return await _get_doctor(db, doctor_id)


async def _get_doctor(db: DbSession, doctor_id: str) -> dict[str, Any]:
    row = (
        await db.execute(
            select(Doctor, User, Department)
            .join(User, User.id == Doctor.user_id)
            .outerjoin(Department, Department.id == Doctor.department_id)
            .where(Doctor.id == doctor_id)
        )
    ).first()
    if row is None:
        raise not_found("Doctor")
    doctor, user, department = row
    return ok(_serialize(doctor, user, department))

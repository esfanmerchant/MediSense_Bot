"""Doctor directory and caseload.

Two audiences with different needs from the same table: a patient browsing for
someone to book with, and a doctor looking at their own assigned patients. The
directory exposes professional details only — never anything about who a doctor
treats, which would leak the care relationship itself.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import func, or_, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.errors import bad_request, conflict, forbidden, not_found
from app.db.base import new_id, utcnow
from app.db.enums import AuditAction, Role, UserStatus
from app.db.models import (
    Appointment,
    Department,
    Doctor,
    DoctorPatientAssignment,
    DoctorTimeOff,
    Patient,
    User,
)
from app.modules.appointments.schedule import AvailabilityWindow, iso_utc, validate_windows
from app.modules.appointments.service import holds_a_slot
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission

router = APIRouter(prefix="/doctors", tags=["doctors"])

#: A single block of leave longer than this is almost certainly a typo in a
#: date; a real sabbatical is entered as several.
MAX_TIME_OFF_DAYS = 90


class DoctorProfileUpdate(BaseModel):
    specialization: Annotated[str, Field(min_length=2, max_length=120)] | None = None
    qualifications: Annotated[str, Field(max_length=500)] | None = None
    years_experience: Annotated[int, Field(ge=0, le=70)] | None = Field(
        default=None, alias="yearsExperience"
    )
    accepting_patients: bool | None = Field(default=None, alias="acceptingPatients")
    #: Validated rather than stored as free-form JSON: these windows generate
    #: the slot grid patients book against, so a malformed entry here is a
    #: calendar that silently produces no appointments.
    availability: Annotated[list[AvailabilityWindow], Field(max_length=40)] | None = None

    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True)


class TimeOffCreate(BaseModel):
    """A block of leave, in UTC.

    Unlike weekly availability, leave is an absolute interval rather than a
    wall-clock pattern, so it is submitted and stored as UTC directly.
    """

    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    starts_at: datetime = Field(alias="startsAt")
    ends_at: datetime = Field(alias="endsAt")
    reason: Annotated[str, Field(max_length=200)] | None = None

    @field_validator("starts_at", "ends_at")
    @classmethod
    def _to_naive_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is not None:
            value = value.astimezone(UTC).replace(tzinfo=None)
        return value.replace(second=0, microsecond=0)

    @model_validator(mode="after")
    def _interval_is_sane(self) -> TimeOffCreate:
        if self.ends_at <= self.starts_at:
            raise ValueError("endsAt must be later than startsAt")
        if (self.ends_at - self.starts_at) > timedelta(days=MAX_TIME_OFF_DAYS):
            raise ValueError(f"a single block of leave cannot exceed {MAX_TIME_OFF_DAYS} days")
        return self


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

    if payload.availability is not None:
        # Overlapping windows would generate the same slot time twice, and the
        # two patients who booked "09:00" would then collide on the unique slot
        # key with no way to explain which one was wrong.
        try:
            validate_windows(payload.availability)
        except ValueError as exc:
            raise bad_request(str(exc)) from exc
        changed["availability"] = [window.as_stored() for window in payload.availability]

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


# ---------------------------------------------------------------------------
# Time off
# ---------------------------------------------------------------------------


def _require_doctor(auth: CurrentAuth) -> str:
    if auth.role != Role.DOCTOR or not auth.doctor_id:
        raise forbidden("This endpoint is for doctors.")
    return auth.doctor_id


def _serialize_time_off(row: DoctorTimeOff) -> dict[str, Any]:
    return {
        "id": row.id,
        "startsAt": iso_utc(row.starts_at),
        "endsAt": iso_utc(row.ends_at),
        "reason": row.reason,
    }


@router.get("/me/time-off")
async def my_time_off(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    """Leave that has not finished yet.

    Past leave is not returned: it no longer affects any booking, and a calendar
    that accumulates every holiday a doctor has ever taken is harder to read for
    no benefit.
    """
    doctor_id = _require_doctor(auth)
    rows = (
        (
            await db.execute(
                select(DoctorTimeOff)
                .where(DoctorTimeOff.doctor_id == doctor_id, DoctorTimeOff.ends_at > utcnow())
                .order_by(DoctorTimeOff.starts_at)
            )
        )
        .scalars()
        .all()
    )
    return ok([_serialize_time_off(row) for row in rows])


@router.post("/me/time-off", status_code=201)
async def add_time_off(
    payload: TimeOffCreate, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Block out time, provided no one is already booked into it.

    Leave that would strand booked patients is refused rather than applied.
    Silently making an appointment unattendable is worse than making the doctor
    deal with it: they know which of those patients needs a call, and the system
    does not.
    """
    doctor_id = _require_doctor(auth)

    if payload.ends_at <= utcnow():
        raise bad_request("Leave must end in the future.")

    clashes = (
        await db.execute(
            select(func.count(DoctorTimeOff.id)).where(
                DoctorTimeOff.doctor_id == doctor_id,
                DoctorTimeOff.starts_at < payload.ends_at,
                DoctorTimeOff.ends_at > payload.starts_at,
            )
        )
    ).scalar_one()
    if clashes:
        raise conflict("That overlaps leave you have already booked.")

    booked = (
        await db.execute(
            select(func.count(Appointment.id)).where(
                Appointment.doctor_id == doctor_id,
                holds_a_slot(),
                Appointment.start_time < payload.ends_at,
                Appointment.end_time > payload.starts_at,
            )
        )
    ).scalar_one()
    if booked:
        raise conflict(
            f"You have {booked} appointment{'s' if booked > 1 else ''} booked in that period. "
            "Cancel or move them first."
        )

    time_off = DoctorTimeOff(
        id=new_id(),
        doctor_id=doctor_id,
        starts_at=payload.starts_at,
        ends_at=payload.ends_at,
        reason=payload.reason,
    )
    db.add(time_off)
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.CONFIG_CHANGED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="DoctorTimeOff",
            entity_id=time_off.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={
                "operation": "create",
                "startsAt": iso_utc(time_off.starts_at),
                "endsAt": iso_utc(time_off.ends_at),
            },
        ),
    )
    return ok(_serialize_time_off(time_off))


@router.delete("/me/time-off/{time_off_id}")
async def remove_time_off(
    time_off_id: str, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Cancel leave, making those slots bookable again."""
    doctor_id = _require_doctor(auth)

    # Scoped to the caller's own row, so another doctor's id simply is not found.
    time_off = (
        await db.execute(
            select(DoctorTimeOff).where(
                DoctorTimeOff.id == time_off_id, DoctorTimeOff.doctor_id == doctor_id
            )
        )
    ).scalar_one_or_none()
    if time_off is None:
        raise not_found("Time off")

    await db.delete(time_off)
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.CONFIG_CHANGED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="DoctorTimeOff",
            entity_id=time_off_id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"operation": "delete"},
        ),
    )
    return ok({"id": time_off_id, "removed": True})


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

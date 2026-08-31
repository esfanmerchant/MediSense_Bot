"""Doctor directory and caseload.

Two audiences with different needs from the same table: a patient browsing for
someone to book with, and a doctor looking at their own assigned patients. The
directory exposes professional details only — never anything about who a doctor
treats, which would leak the care relationship itself.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import func, or_, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.errors import bad_request, conflict, forbidden, not_found
from app.db.base import new_id, utcnow
from app.db.enums import ENCOUNTER_STATUSES, AuditAction, Role, UserStatus
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
from app.services import avatars

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

    #: Where they sit. Self-service, unlike the licence number and department:
    #: a doctor moving to a different clinic is an ordinary Tuesday, not a
    #: credentialing event, and making them wait on an administrator to correct
    #: their own address is how a directory ends up full of stale ones.
    clinic_name: Annotated[str, Field(max_length=160)] | None = Field(
        default=None, alias="clinicName"
    )
    city: Annotated[str, Field(max_length=80)] | None = None
    address_line: Annotated[str, Field(max_length=300)] | None = Field(
        default=None, alias="addressLine"
    )
    #: Bounded to the only values a coordinate can legally take, so a
    #: transposed pair or a stray digit is refused here rather than dropping a
    #: pin in the sea.
    latitude: Annotated[Decimal, Field(ge=-90, le=90)] | None = None
    longitude: Annotated[Decimal, Field(ge=-180, le=180)] | None = None

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


async def _sign_avatars(users: Sequence[User]) -> list[str | None]:
    """Sign every doctor's picture at once rather than one after another.

    A link to a private object costs one round-trip to storage, so a page of
    twenty-five doctors costs twenty-five of them. In sequence that is the
    difference between a directory that opens and one that visibly stalls;
    issued together they overlap and the page waits for the slowest, not the
    sum. ``signed_url_for`` never raises, so one unreachable picture returns
    ``None`` and the rest still arrive.
    """
    return list(await asyncio.gather(*(avatars.signed_url_for(u.avatar_path) for u in users)))


def _serialize(
    doctor: Doctor,
    user: User,
    department: Department | None,
    avatar_url: str | None = None,
) -> dict[str, Any]:
    return {
        "id": doctor.id,
        "name": user.name,
        # A face on the card a patient chooses from. Signed per response and
        # short-lived like every other link to this bucket, so it is handed out
        # with the directory rather than stored anywhere.
        "avatarUrl": avatar_url,
        "specialization": doctor.specialization,
        "qualifications": doctor.qualifications,
        "yearsExperience": doctor.years_experience,
        "consultationFee": float(doctor.consultation_fee),
        "acceptingPatients": doctor.accepting_patients,
        "availability": doctor.availability,
        # Null throughout when a doctor has never been asked — the directory
        # renders that as "not stated" rather than as an empty address.
        "clinicName": doctor.clinic_name,
        "city": doctor.city,
        "addressLine": doctor.address_line,
        "latitude": float(doctor.latitude) if doctor.latitude is not None else None,
        "longitude": float(doctor.longitude) if doctor.longitude is not None else None,
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
    city: str | None = Query(default=None, max_length=80),
    search: str | None = Query(default=None, max_length=100),
    accepting_only: bool = Query(default=False, alias="acceptingOnly"),
) -> dict[str, Any]:
    """Directory for booking. Deliberately contains no patient information."""
    filters = []
    if department_id:
        filters.append(Doctor.department_id == department_id)
    if specialization:
        filters.append(Doctor.specialization.ilike(f"%{specialization}%"))
    if city:
        # Exact on the lowered column rather than a substring: "Lahore" must not
        # also return doctors in "Lahore Cantt"'s neighbouring entries by
        # accident, and this is the expression `ix_doctors_city_lower` indexes.
        filters.append(func.lower(Doctor.city) == city.strip().lower())
    if accepting_only:
        filters.append(Doctor.accepting_patients.is_(True))
    if search:
        filters.append(
            or_(
                User.name.ilike(f"%{search}%"),
                Doctor.specialization.ilike(f"%{search}%"),
                Doctor.clinic_name.ilike(f"%{search}%"),
                Doctor.city.ilike(f"%{search}%"),
            )
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

    urls = await _sign_avatars([u for _, u, _ in rows])
    return ok(
        [
            _serialize(d, u, dept, url)
            for (d, u, dept), url in zip(rows, urls, strict=True)
        ],
        page.meta(total),
    )


@router.get("/cities")
async def list_cities(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    """The cities that actually have a bookable doctor in them.

    Built from the data rather than from a list of Pakistani cities, for two
    reasons that point the same way: a filter offering "Quetta" when no doctor
    practises there is a dead end a patient has to discover by trying it, and a
    hard-coded list is a thing somebody must remember to edit the first time a
    doctor registers somewhere new.

    Deactivated accounts are excluded on the same principle as the directory
    itself — if you cannot book them, their city is not a choice.
    """
    rows = (
        await db.execute(
            select(Doctor.city, func.count(Doctor.id))
            .join(User, User.id == Doctor.user_id)
            .where(Doctor.city.is_not(None), Doctor.city != "", User.status == UserStatus.ACTIVE)
            .group_by(Doctor.city)
            .order_by(func.count(Doctor.id).desc(), Doctor.city)
        )
    ).all()

    return ok([{"city": city, "doctors": count} for city, count in rows])


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
    search: str | None = Query(default=None, max_length=100),
) -> dict[str, Any]:
    """Everyone this doctor may open a record for.

    **The list is built from the same rule that grants access**, and that is the
    whole fix. It used to show standing assignments only, while
    ``resolve_patient_access`` has always also allowed a doctor to open a
    patient they have an encounter with — so a doctor who had actually treated
    somebody could read their record but could not find them in their own
    caseload, and the page said "No patients assigned" to a doctor with a full
    clinic. A list narrower than the permission is a list that lies.

    So: a standing assignment, **or** an appointment in an encounter status —
    confirmed, checked in, in progress, or completed. The last of those is what
    makes past patients appear, which is what a doctor needs when somebody comes
    back six months later.

    Scoped by relationship rather than by role either way: "DOCTOR" alone never
    means "every patient in the hospital".
    """
    if not auth.doctor_id:
        raise forbidden("This endpoint is for doctors.")

    assigned = select(DoctorPatientAssignment.patient_id).where(
        DoctorPatientAssignment.doctor_id == auth.doctor_id,
        DoctorPatientAssignment.ended_at.is_(None),
    )
    treated = select(Appointment.patient_id).where(
        Appointment.doctor_id == auth.doctor_id,
        Appointment.status.in_(ENCOUNTER_STATUSES),
    )
    # Two membership tests rather than a union subquery: a union renames its
    # columns after the first select's *database* name, which is a detail this
    # query would then depend on silently.
    filters: list[Any] = [or_(Patient.id.in_(assigned), Patient.id.in_(treated))]
    if search:
        filters.append(
            or_(
                User.name.ilike(f"%{search}%"),
                Patient.medical_record_number.ilike(f"%{search}%"),
            )
        )

    total = (
        await db.execute(
            select(func.count(Patient.id))
            .join(User, User.id == Patient.user_id)
            .where(*filters)
        )
    ).scalar_one()

    # Whether the relationship is a standing one, and when they were last seen.
    # Both are what a doctor scans a caseload by — "who is mine" and "who have I
    # not seen in a while" — and neither is derivable from a name.
    is_primary = (
        select(DoctorPatientAssignment.is_primary)
        .where(
            DoctorPatientAssignment.doctor_id == auth.doctor_id,
            DoctorPatientAssignment.patient_id == Patient.id,
            DoctorPatientAssignment.ended_at.is_(None),
        )
        .limit(1)
        .scalar_subquery()
    )
    last_seen = (
        select(func.max(Appointment.start_time))
        .where(
            Appointment.doctor_id == auth.doctor_id,
            Appointment.patient_id == Patient.id,
            Appointment.status.in_(ENCOUNTER_STATUSES),
        )
        .scalar_subquery()
    )

    rows = (
        await db.execute(
            select(Patient, User, is_primary, last_seen)
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
                # Null rather than false when there is no assignment: "not my
                # primary" and "no standing relationship at all" are different
                # facts, and the caseload distinguishes them.
                "isPrimary": primary,
                "lastSeenAt": iso_utc(seen) if seen else None,
            }
            for patient, user, primary, seen in rows
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
    return ok(_serialize(doctor, user, department, await avatars.signed_url_for(user.avatar_path)))

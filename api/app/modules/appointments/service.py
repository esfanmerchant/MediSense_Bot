"""Appointment booking, rescheduling, cancellation and the consultation lifecycle.

Two rules shape everything here.

**Double booking is prevented by the database, not by a check.** Every
appointment holding a slot carries ``slotKey = "<doctorId>|<ISO start>"`` under a
unique index. Two concurrent bookings for one slot cannot both commit however
they interleave — the loser raises ``IntegrityError``, which the application's
handler turns into ``SLOT_UNAVAILABLE``. A read-then-write availability check
alone would leave exactly the race the requirement names (spec §14). The column
is nullable and Postgres allows many NULLs in a unique index, so cancelling
releases the slot by clearing the key.

**Status moves along a declared machine.** ``ALLOWED_TRANSITIONS`` is the whole
truth about which changes are legal, and each target names who may make it, so a
patient cannot mark their own consultation complete and a doctor cannot confirm
an appointment that was already cancelled.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import Select, and_, func, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext
from app.core.errors import AppError, ErrorCode, bad_request, conflict, forbidden, not_found
from app.db.base import new_id, utcnow
from app.db.enums import AppointmentStatus, NotificationType, Role, UserStatus
from app.db.models import (
    Appointment,
    Doctor,
    DoctorTimeOff,
    Patient,
    User,
)
from app.modules.appointments.schedule import (
    MAX_ADVANCE_DAYS,
    AvailabilityWindow,
    Slot,
    find_slot,
    iso_utc,
    parse_windows,
    slots_for_range,
    to_clinic,
    to_utc,
)
from app.modules.auth.rbac import Permission

#: Still going to happen: the patient is expected and the appointment can still
#: move. Used to decide whether a patient is already committed at a time.
ACTIVE_STATUSES = (
    AppointmentStatus.REQUESTED,
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.CHECKED_IN,
    AppointmentStatus.IN_PROGRESS,
)

#: Reached the end of the line; nothing may follow.
TERMINAL_STATUSES = (
    AppointmentStatus.COMPLETED,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
)


def holds_a_slot() -> Any:
    """The condition for "this appointment occupies the doctor's time".

    Cancellation is the *only* release. A completed consultation used the slot;
    a no-show held it and wasted it. Both leave the doctor booked, so neither
    frees the time.

    This must stay the exact complement of when ``release_slot`` is called. If
    availability counted a status free while the row still held its slot key, a
    patient would be shown a time they could not book and would be told it "has
    just been taken" — by an appointment that finished last week.
    """
    return Appointment.status != AppointmentStatus.CANCELLED


@dataclass(frozen=True)
class Transition:
    """One legal status change and who is allowed to make it.

    ``by_treating_doctor`` means the doctor on this specific appointment — never
    any doctor. ``permission``, where set, is required on top of the role.
    """

    to: AppointmentStatus
    by_treating_doctor: bool = False
    by_admin: bool = False
    permission: Permission | None = None


#: Cancellation is deliberately absent: it has bookkeeping of its own (freeing
#: the slot, recording who and why) and lives behind ``cancel_appointment``.
ALLOWED_TRANSITIONS: dict[AppointmentStatus, tuple[Transition, ...]] = {
    AppointmentStatus.REQUESTED: (
        Transition(AppointmentStatus.CONFIRMED, by_treating_doctor=True, by_admin=True),
        Transition(AppointmentStatus.NO_SHOW, by_treating_doctor=True, by_admin=True),
    ),
    AppointmentStatus.CONFIRMED: (
        Transition(AppointmentStatus.CHECKED_IN, by_treating_doctor=True, by_admin=True),
        Transition(AppointmentStatus.NO_SHOW, by_treating_doctor=True, by_admin=True),
    ),
    AppointmentStatus.CHECKED_IN: (
        Transition(AppointmentStatus.IN_PROGRESS, by_treating_doctor=True),
        Transition(AppointmentStatus.NO_SHOW, by_treating_doctor=True, by_admin=True),
    ),
    AppointmentStatus.IN_PROGRESS: (
        Transition(
            AppointmentStatus.COMPLETED,
            by_treating_doctor=True,
            permission=Permission.CONSULTATION_COMPLETE,
        ),
    ),
    AppointmentStatus.COMPLETED: (),
    AppointmentStatus.CANCELLED: (),
    AppointmentStatus.NO_SHOW: (),
}


def find_transition(
    current: AppointmentStatus, target: AppointmentStatus
) -> Transition | None:
    for transition in ALLOWED_TRANSITIONS.get(current, ()):
        if transition.to == target:
            return transition
    return None


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def serialize(
    appointment: Appointment,
    *,
    doctor_name: str | None = None,
    specialization: str | None = None,
    patient_name: str | None = None,
    medical_record_number: str | None = None,
) -> dict[str, Any]:
    """Shape an appointment for the wire.

    Times go out as UTC with an explicit ``Z`` plus a pre-formatted clinic-local
    label, so a client that does nothing clever still shows the right hour.
    Counterparty names are passed in by the caller rather than lazy-loaded, so a
    list endpoint cannot silently issue a query per row.
    """
    local_start = to_clinic(appointment.start_time)
    return {
        "id": appointment.id,
        "patientId": appointment.patient_id,
        "doctorId": appointment.doctor_id,
        "status": str(appointment.status),
        "startTime": iso_utc(appointment.start_time),
        "endTime": iso_utc(appointment.end_time),
        "localDate": local_start.date().isoformat(),
        "localTime": local_start.strftime("%H:%M"),
        "durationMinutes": int(
            (appointment.end_time - appointment.start_time).total_seconds() // 60
        ),
        "reason": appointment.reason,
        "notes": appointment.notes,
        "doctorName": doctor_name,
        "specialization": specialization,
        "patientName": patient_name,
        "medicalRecordNumber": medical_record_number,
        "cancelledAt": iso_utc(appointment.cancelled_at) if appointment.cancelled_at else None,
        "cancelReason": appointment.cancel_reason,
        "rescheduledFromId": appointment.rescheduled_from_id,
        "completedAt": iso_utc(appointment.completed_at) if appointment.completed_at else None,
        "createdAt": iso_utc(appointment.created_at),
    }


def visible_columns() -> Select[Any]:
    """The join every appointment read uses.

    Both counterparties come back in one statement. The doctor's name is not
    confidential — the directory already publishes it — while the patient's name
    only ever reaches a caller who has already passed the scoping in
    ``scope_for``.
    """
    doctor_user = User.__table__.alias("doctor_user")
    patient_user = User.__table__.alias("patient_user")
    return (
        select(
            Appointment,
            doctor_user.c.name,
            Doctor.specialization,
            patient_user.c.name,
            Patient.medical_record_number,
        )
        .join(Doctor, Doctor.id == Appointment.doctor_id)
        .join(doctor_user, doctor_user.c.id == Doctor.user_id)
        .join(Patient, Patient.id == Appointment.patient_id)
        .join(patient_user, patient_user.c.id == Patient.user_id)
    )


def serialize_row(row: Any) -> dict[str, Any]:
    appointment, doctor_name, specialization, patient_name, mrn = row
    return serialize(
        appointment,
        doctor_name=doctor_name,
        specialization=specialization,
        patient_name=patient_name,
        medical_record_number=mrn,
    )


# ---------------------------------------------------------------------------
# Scoping
# ---------------------------------------------------------------------------


def scope_for(auth: AuthContext) -> Any:
    """The row filter this caller is allowed to see, as a SQL condition.

    Returned as a filter rather than checked after the fact, so an appointment
    outside the caller's scope is never loaded in the first place and paging
    counts stay honest. A role that reaches here without a scope gets 403 —
    never an unfiltered query.
    """
    if auth.role == Role.PATIENT and auth.patient_id:
        return Appointment.patient_id == auth.patient_id
    if auth.role == Role.DOCTOR and auth.doctor_id:
        return Appointment.doctor_id == auth.doctor_id
    if auth.has(Permission.APPOINTMENT_MANAGE_ANY):
        return true()
    raise forbidden("You do not have access to appointments.")


async def load_for(db: AsyncSession, auth: AuthContext, appointment_id: str) -> Any:
    """Fetch one appointment already narrowed to the caller's scope.

    Out-of-scope ids come back as 404 rather than 403: telling a patient that
    appointment X exists but is not theirs confirms another patient's booking.
    """
    row = (
        await db.execute(
            visible_columns().where(Appointment.id == appointment_id, scope_for(auth))
        )
    ).first()
    if row is None:
        raise not_found("Appointment")
    return row


def may_cancel(auth: AuthContext, appointment: Appointment) -> bool:
    """Either party to the appointment, or an administrator."""
    if auth.role == Role.PATIENT:
        return auth.patient_id == appointment.patient_id
    if auth.role == Role.DOCTOR:
        return auth.doctor_id == appointment.doctor_id
    return auth.has(Permission.APPOINTMENT_MANAGE_ANY)


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BookableDoctor:
    doctor: Doctor
    windows: list[AvailabilityWindow]


async def load_bookable_doctor(db: AsyncSession, doctor_id: str) -> BookableDoctor:
    """Load a doctor who may currently be booked with.

    A deactivated account or one that has stopped accepting patients must not be
    bookable, and the check belongs here rather than in the directory filter:
    the directory is a convenience, this is the gate.
    """
    row = (
        await db.execute(
            select(Doctor, User.status).join(User, User.id == Doctor.user_id).where(Doctor.id == doctor_id)
        )
    ).first()
    if row is None:
        raise not_found("Doctor")

    doctor, status = row
    if status != UserStatus.ACTIVE:
        raise conflict("That doctor is not currently available for appointments.")
    if not doctor.accepting_patients:
        raise conflict("That doctor is not accepting new appointments.")

    windows = parse_windows(doctor.availability)
    if not windows:
        raise conflict("That doctor has not published any availability yet.")
    return BookableDoctor(doctor=doctor, windows=windows)


async def _time_off(
    db: AsyncSession, doctor_id: str, first: datetime, last: datetime
) -> list[tuple[datetime, datetime]]:
    """Leave blocks overlapping the window, as (start, end) pairs."""
    rows = (
        await db.execute(
            select(DoctorTimeOff.starts_at, DoctorTimeOff.ends_at).where(
                DoctorTimeOff.doctor_id == doctor_id,
                DoctorTimeOff.starts_at < last,
                DoctorTimeOff.ends_at > first,
            )
        )
    ).all()
    return [(start, end) for start, end in rows]


async def _taken_slot_starts(
    db: AsyncSession, doctor_id: str, first: datetime, last: datetime
) -> set[datetime]:
    rows = (
        await db.execute(
            select(Appointment.start_time).where(
                Appointment.doctor_id == doctor_id,
                holds_a_slot(),
                Appointment.start_time >= first,
                Appointment.start_time < last,
            )
        )
    ).scalars()
    return set(rows)


async def availability(
    db: AsyncSession, doctor_id: str, first_day: date, last_day: date
) -> list[dict[str, Any]]:
    """The doctor's slot grid over a date range, each slot marked free or taken.

    Deliberately free/busy only. A caller learns that 10:00 is unavailable and
    nothing whatsoever about who holds it — which is what lets a patient browse
    for a slot without browsing another patient's care.
    """
    bookable = await load_bookable_doctor(db, doctor_id)
    slots = slots_for_range(bookable.windows, first_day, last_day)
    if not slots:
        return []

    window_start, window_end = slots[0].start, slots[-1].end
    taken = await _taken_slot_starts(db, doctor_id, window_start, window_end)
    time_off = await _time_off(db, doctor_id, window_start, window_end)
    now = utcnow()

    by_day: dict[str, list[dict[str, Any]]] = {}
    for slot in slots:
        blocked = any(slot.start < off_end and off_start < slot.end for off_start, off_end in time_off)
        by_day.setdefault(slot.local_date.isoformat(), []).append(
            {
                "startTime": iso_utc(slot.start),
                "endTime": iso_utc(slot.end),
                "label": slot.label,
                "available": slot.start > now and slot.start not in taken and not blocked,
            }
        )

    return [
        {
            "date": day,
            "slots": day_slots,
            "availableCount": sum(1 for s in day_slots if s["available"]),
        }
        for day, day_slots in sorted(by_day.items())
    ]


# ---------------------------------------------------------------------------
# Booking
# ---------------------------------------------------------------------------


async def _assert_slot_is_offered(
    db: AsyncSession, bookable: BookableDoctor, start: datetime
) -> Slot:
    """Resolve a requested time to a real published slot, or refuse.

    Every constraint that does not depend on other bookings is checked here: the
    time is on the doctor's grid, it is in the future, it is not absurdly far
    out, and the doctor is not away. Contention is left to the unique index.
    """
    now = utcnow()
    if start <= now:
        raise bad_request("Choose a time in the future.")
    if start > now + timedelta(days=MAX_ADVANCE_DAYS):
        raise bad_request(f"Appointments can be booked at most {MAX_ADVANCE_DAYS} days ahead.")

    slot = find_slot(bookable.windows, start)
    if slot is None:
        raise bad_request(
            "That time is not one of the doctor's appointment slots. "
            "Pick a slot from their availability."
        )

    for off_start, off_end in await _time_off(db, bookable.doctor.id, slot.start, slot.end):
        if slot.start < off_end and off_start < slot.end:
            raise conflict("The doctor is unavailable at that time.")

    return slot


async def _assert_patient_is_free(
    db: AsyncSession, patient_id: str, slot: Slot, excluding_id: str | None = None
) -> None:
    """No patient may hold two appointments at once.

    The unique slot key stops two patients taking one doctor's slot; it says
    nothing about one patient booking two doctors for the same hour, which is
    just as impossible to attend.
    """
    filters = [
        Appointment.patient_id == patient_id,
        Appointment.status.in_(ACTIVE_STATUSES),
        Appointment.start_time < slot.end,
        Appointment.end_time > slot.start,
    ]
    if excluding_id:
        filters.append(Appointment.id != excluding_id)

    clash = (await db.execute(select(Appointment.id).where(*filters).limit(1))).first()
    if clash:
        raise conflict("You already have an appointment at that time.")


async def resolve_booking_patient(
    db: AsyncSession, auth: AuthContext, requested_patient_id: str | None
) -> str:
    """Decide whose appointment this is.

    A patient books for themselves and the id comes from their session — a
    ``patientId`` in the body is ignored outright rather than compared, because
    the only correct value is the one the client cannot influence (spec §8). An
    administrator books on someone's behalf and must name them.
    """
    if auth.role == Role.PATIENT:
        if not auth.patient_id:
            raise forbidden("This account has no patient record.")
        return auth.patient_id

    if not auth.has(Permission.APPOINTMENT_MANAGE_ANY):
        raise forbidden("You are not allowed to book appointments.")
    if not requested_patient_id:
        raise bad_request("patientId is required when booking on a patient's behalf.")

    exists = (
        await db.execute(select(Patient.id).where(Patient.id == requested_patient_id))
    ).first()
    if not exists:
        raise not_found("Patient")
    return requested_patient_id


async def create_appointment(
    db: AsyncSession,
    *,
    patient_id: str,
    bookable: BookableDoctor,
    slot: Slot,
    reason: str | None,
    rescheduled_from_id: str | None = None,
) -> Appointment:
    """Insert the row that claims the slot.

    The flush is not incidental: it forces the INSERT now so a unique-key clash
    surfaces as ``SLOT_UNAVAILABLE`` from this request, rather than at commit
    after the caller has already written an audit entry saying the booking
    succeeded.
    """
    appointment = Appointment(
        id=new_id(),
        patient_id=patient_id,
        doctor_id=bookable.doctor.id,
        appointment_date=to_utc(
            slot.local_start.replace(hour=0, minute=0, second=0, microsecond=0)
        ),
        start_time=slot.start,
        end_time=slot.end,
        status=AppointmentStatus.REQUESTED,
        reason=reason,
        slot_key=Appointment.build_slot_key(bookable.doctor.id, slot.start),
        rescheduled_from_id=rescheduled_from_id,
    )
    db.add(appointment)
    await db.flush()
    return appointment


async def book(
    db: AsyncSession,
    auth: AuthContext,
    *,
    doctor_id: str,
    start: datetime,
    reason: str | None,
    requested_patient_id: str | None,
) -> Appointment:
    patient_id = await resolve_booking_patient(db, auth, requested_patient_id)
    bookable = await load_bookable_doctor(db, doctor_id)
    slot = await _assert_slot_is_offered(db, bookable, start)
    await _assert_patient_is_free(db, patient_id, slot)
    return await create_appointment(
        db, patient_id=patient_id, bookable=bookable, slot=slot, reason=reason
    )


# ---------------------------------------------------------------------------
# Cancellation and rescheduling
# ---------------------------------------------------------------------------


def release_slot(appointment: Appointment) -> None:
    """Clear the slot key so the time becomes bookable again.

    Postgres permits any number of NULLs in a unique index, which is exactly why
    the key is nullable: releasing a slot needs no separate free/busy table and
    no cleanup job.

    Called on cancellation only — see ``holds_a_slot``, which must remain its
    exact complement.
    """
    appointment.slot_key = None


async def cancel_appointment(
    db: AsyncSession,
    auth: AuthContext,
    appointment: Appointment,
    reason: str | None,
) -> Appointment:
    if not may_cancel(auth, appointment):
        raise forbidden("You cannot cancel this appointment.")
    if appointment.status in TERMINAL_STATUSES:
        raise conflict(
            f"This appointment is already {str(appointment.status).lower().replace('_', ' ')}."
        )

    appointment.status = AppointmentStatus.CANCELLED
    appointment.cancelled_at = utcnow()
    appointment.cancelled_by = auth.user_id
    appointment.cancel_reason = reason
    release_slot(appointment)
    await db.flush()
    return appointment


async def reschedule_appointment(
    db: AsyncSession,
    auth: AuthContext,
    appointment: Appointment,
    *,
    start: datetime,
    reason: str | None,
) -> Appointment:
    """Move an appointment by cancelling it and booking its replacement.

    A new row rather than an edit in place: ``rescheduledFromId`` then preserves
    the original time as a fact rather than as an audit-log reconstruction,
    which matters when a patient asks why they were seen a week later than
    booked. The old slot is released and flushed before the new one is claimed,
    so moving within the same doctor's calendar cannot collide with itself.
    """
    if auth.role == Role.DOCTOR:
        raise forbidden(
            "Doctors cannot reschedule on a patient's behalf. Cancel the appointment instead."
        )
    if not may_cancel(auth, appointment):
        raise forbidden("You cannot reschedule this appointment.")
    if appointment.status not in (AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED):
        raise conflict("Only a requested or confirmed appointment can be rescheduled.")
    if start.replace(microsecond=0) == appointment.start_time.replace(microsecond=0):
        raise bad_request("That is the appointment's current time.")

    bookable = await load_bookable_doctor(db, appointment.doctor_id)
    slot = await _assert_slot_is_offered(db, bookable, start)
    await _assert_patient_is_free(db, appointment.patient_id, slot, excluding_id=appointment.id)

    appointment.status = AppointmentStatus.CANCELLED
    appointment.cancelled_at = utcnow()
    appointment.cancelled_by = auth.user_id
    appointment.cancel_reason = reason or "Rescheduled"
    release_slot(appointment)
    await db.flush()

    return await create_appointment(
        db,
        patient_id=appointment.patient_id,
        bookable=bookable,
        slot=slot,
        reason=appointment.reason,
        rescheduled_from_id=appointment.id,
    )


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------


async def change_status(
    db: AsyncSession,
    auth: AuthContext,
    appointment: Appointment,
    target: AppointmentStatus,
) -> Appointment:
    """Advance an appointment along the declared machine.

    Refusals are specific on purpose. "You cannot confirm a cancelled
    appointment" tells a receptionist what happened; a bare 403 sends them to
    support.
    """
    if target == AppointmentStatus.CANCELLED:
        raise bad_request("Use the cancel endpoint to cancel an appointment.")
    if target == appointment.status:
        raise conflict("The appointment is already in that state.")

    transition = find_transition(appointment.status, target)
    if transition is None:
        current = str(appointment.status).lower().replace("_", " ")
        raise conflict(
            f"An appointment that is {current} cannot become "
            f"{str(target).lower().replace('_', ' ')}."
        )

    is_treating_doctor = auth.role == Role.DOCTOR and auth.doctor_id == appointment.doctor_id
    is_admin = auth.has(Permission.APPOINTMENT_MANAGE_ANY)
    allowed = (transition.by_treating_doctor and is_treating_doctor) or (
        transition.by_admin and is_admin
    )
    if not allowed:
        raise forbidden("You are not allowed to make that change.")
    if transition.permission and not auth.has(transition.permission):
        raise forbidden("You are not allowed to make that change.")

    appointment.status = target
    if target == AppointmentStatus.COMPLETED:
        appointment.completed_at = utcnow()
        # Invoice generation hangs off this transition (R4) and is done by the
        # router, in the same transaction. It is deliberately not done here:
        # this function is the state machine, and billing is a consequence of a
        # state change rather than part of deciding whether one is legal.

    # The slot is deliberately *not* released here. Completing or marking a
    # no-show still leaves the doctor's time spent, and releasing it would let a
    # mistimed status change hand the same slot to a second patient.

    await db.flush()
    return appointment


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


def list_filters(
    auth: AuthContext,
    *,
    status: AppointmentStatus | None,
    from_date: date | None,
    to_date: date | None,
    doctor_id: str | None,
    patient_id: str | None,
    upcoming_only: bool,
) -> list[Any]:
    """Build the WHERE clause for a listing.

    The caller's scope is applied first and is not optional; the query
    parameters can only narrow it further. An administrator's ``doctorId``
    filter is a convenience, and a patient's is powerless to widen anything.
    """
    filters: list[Any] = [scope_for(auth)]

    if status:
        filters.append(Appointment.status == status)
    if doctor_id:
        filters.append(Appointment.doctor_id == doctor_id)
    if patient_id:
        filters.append(Appointment.patient_id == patient_id)
    if from_date:
        filters.append(Appointment.start_time >= to_utc(datetime.combine(from_date, datetime.min.time())))
    if to_date:
        filters.append(
            Appointment.start_time
            < to_utc(datetime.combine(to_date + timedelta(days=1), datetime.min.time()))
        )
    if upcoming_only:
        filters.append(
            and_(
                Appointment.start_time >= utcnow(),
                Appointment.status.in_(ACTIVE_STATUSES),
            )
        )
    return filters


async def count_appointments(db: AsyncSession, filters: list[Any]) -> int:
    return (
        await db.execute(
            select(func.count(Appointment.id))
            .join(Doctor, Doctor.id == Appointment.doctor_id)
            .join(Patient, Patient.id == Appointment.patient_id)
            .where(*filters)
        )
    ).scalar_one()


def counterparty_user_ids(appointment: Appointment) -> Any:
    """Both users involved, for notification fan-out."""
    return or_(
        User.id.in_(select(Patient.user_id).where(Patient.id == appointment.patient_id)),
        User.id.in_(select(Doctor.user_id).where(Doctor.id == appointment.doctor_id)),
    )


NOTIFICATION_FOR_STATUS = {
    AppointmentStatus.CONFIRMED: NotificationType.APPOINTMENT_BOOKED,
    AppointmentStatus.CANCELLED: NotificationType.APPOINTMENT_CANCELLED,
}


def slot_unavailable() -> AppError:
    return AppError(
        409,
        ErrorCode.SLOT_UNAVAILABLE,
        "That time slot has just been taken. Choose another.",
    )

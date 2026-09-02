"""Medication reminders.

A prescription says *what* to take and, in prose, roughly how often — "twice a
day", "after meals", "SOS". None of that is a clock time. Turning "twice a day"
into 08:00 and 20:00 would be a guess, and a push notification that says *take
your Metformin now* at a time nobody chose is a confidently wrong instruction
about medicine. So the times come from the patient, and only from the patient.

That gives the endpoints below their shape:

* **The patient sets their own.** A doctor prescribes; they do not know when
  somebody eats. There is no path here for one user to set another's times.
* **A whole day at once.** Setting times replaces the set for that
  prescription, because "I take it at 8 and at 8" is one decision, not two —
  and replacing makes the request idempotent, which matters when a phone with a
  flaky connection retries it.
* **Times are clinic-local minutes past midnight**, not timestamps. A reminder
  is a fact about someone's day; storing an instant would make it drift the
  first time the schedule was read on a different date.
"""

from __future__ import annotations

from typing import Annotated, Any, cast

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import CursorResult, delete, select

from app.api.deps import CurrentAuth, DbSession
from app.api.responses import ok
from app.core.config import settings
from app.core.errors import forbidden, not_found
from app.db.enums import Role
from app.db.models import MedicationReminder, Prescription

router = APIRouter(prefix="/medication-reminders", tags=["prescriptions"])

#: One reminder every waking hour is already more than anybody wants; past that
#: it is a mistake or an attempt to make the dispatcher do unbounded work.
MAX_TIMES = 12


def _clock(at_minutes: int) -> str:
    return f"{at_minutes // 60:02d}:{at_minutes % 60:02d}"


class ReminderTimes(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: "HH:MM" in the clinic's timezone. Sent as text because that is what a
    #: time input produces, and parsing it here keeps the browser from having
    #: to know how the server stores it.
    times: Annotated[list[str], Field(max_length=MAX_TIMES)]

    @field_validator("times")
    @classmethod
    def _valid_clock_times(cls, values: list[str]) -> list[str]:
        seen: set[int] = set()
        out: list[str] = []
        for raw in values:
            value = raw.strip()
            parts = value.split(":")
            if len(parts) != 2 or not all(p.isdigit() for p in parts):
                raise ValueError(f"{raw!r} is not a time in HH:MM form")
            hour, minute = int(parts[0]), int(parts[1])
            if not (0 <= hour < 24 and 0 <= minute < 60):
                raise ValueError(f"{raw!r} is not a real time of day")
            minutes = hour * 60 + minute
            # Two identical times would be one notification anyway; silently
            # keeping one is kinder than an error about a duplicate.
            if minutes not in seen:
                seen.add(minutes)
                out.append(f"{hour:02d}:{minute:02d}")
        return out


async def require_own_prescription(db: DbSession, auth: CurrentAuth, prescription_id: str) -> Prescription:
    """Load a prescription the caller is entitled to set reminders on.

    Deliberately narrower than the read rules for prescriptions: a clinician
    may *see* this prescription, but a reminder is an alarm on someone's phone,
    and only its owner sets that.

    Everything that is not the owner's own active prescription is a 404 —
    including a real prescription belonging to somebody else. There is no state
    here that distinguishes "not yours" from "not there", because the
    difference between those two answers is a way to test whether an id exists.
    """
    if auth.role != Role.PATIENT or not auth.patient_id:
        raise not_found("Prescription")

    # Ownership is part of the lookup, not a check after it. Asking separately
    # would answer two questions: "is it yours" and, by the difference between
    # 403 and 404, "does it exist at all" — and the second is not something a
    # stranger gets to learn by guessing ids.
    row = (
        await db.execute(
            select(Prescription).where(
                Prescription.id == prescription_id,
                Prescription.patient_id == auth.patient_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise not_found("Prescription")
    return row


@router.get("")
async def list_reminders(
    auth: CurrentAuth,
    db: DbSession,
    prescription_id: Annotated[str | None, Query(alias="prescriptionId", max_length=64)] = None,
) -> dict[str, Any]:
    """Every reminder the caller has set, or those for one prescription.

    Scoped by the session's patient id, so there is no id here that can be
    pointed at somebody else's schedule.
    """
    if auth.role != Role.PATIENT or not auth.patient_id:
        return ok([], {"timezone": settings.CLINIC_TIMEZONE})

    filters: list[Any] = [MedicationReminder.patient_id == auth.patient_id]
    if prescription_id:
        filters.append(MedicationReminder.prescription_id == prescription_id)

    rows = (
        (
            await db.execute(
                select(MedicationReminder, Prescription.medication, Prescription.dosage)
                .join(Prescription, Prescription.id == MedicationReminder.prescription_id)
                .where(*filters)
                .order_by(MedicationReminder.at_minutes)
            )
        )
        .tuples()
        .all()
    )

    return ok(
        [
            {
                "id": reminder.id,
                "prescriptionId": reminder.prescription_id,
                "medication": medication,
                "dosage": dosage,
                "time": _clock(reminder.at_minutes),
                "active": reminder.active,
            }
            for reminder, medication, dosage in rows
        ],
        {"timezone": settings.CLINIC_TIMEZONE},
    )


@router.put("/{prescription_id}")
async def set_reminders(
    prescription_id: str, payload: ReminderTimes, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Replace the reminder times for one prescription.

    An empty list turns them off, which is the same operation as DELETE and is
    what a UI naturally sends when the last time is removed.
    """
    prescription = await require_own_prescription(db, auth, prescription_id)
    if not prescription.active:
        # Reminding somebody to take a medicine they have been told to stop is
        # the one failure mode here that could do harm.
        raise forbidden("This medication has been discontinued")

    await db.execute(
        delete(MedicationReminder).where(
            MedicationReminder.prescription_id == prescription_id,
            MedicationReminder.patient_id == prescription.patient_id,
        )
    )
    for value in payload.times:
        hour, minute = value.split(":")
        db.add(
            MedicationReminder(
                prescription_id=prescription_id,
                patient_id=prescription.patient_id,
                at_minutes=int(hour) * 60 + int(minute),
            )
        )
    await db.flush()

    return ok(
        {
            "prescriptionId": prescription_id,
            "medication": prescription.medication,
            "times": payload.times,
            "timezone": settings.CLINIC_TIMEZONE,
        }
    )


@router.delete("/{prescription_id}")
async def clear_reminders(
    prescription_id: str, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    prescription = await require_own_prescription(db, auth, prescription_id)
    result = await db.execute(
        delete(MedicationReminder).where(
            MedicationReminder.prescription_id == prescription_id,
            MedicationReminder.patient_id == prescription.patient_id,
        )
    )
    # `execute` is typed as returning `Result`, but a DML statement returns a
    # `CursorResult`, which is where `rowcount` lives.
    removed = cast("CursorResult[Any]", result).rowcount
    return ok({"prescriptionId": prescription_id, "removed": removed})

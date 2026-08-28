"""Doctor availability windows and the slot grid derived from them.

Pure logic — no database, no request context — so the rules that decide whether
a time is bookable can be tested exhaustively without a Postgres round trip.

**Time zones.** Appointment columns are ``timestamp`` without a zone and every
stored value is UTC (see ``db.base.utcnow``). A doctor's availability, though,
is wall-clock time at the clinic: "09:00-17:00" means nine in the morning where
the patient walks in, not 09:00 UTC. Storing that literally would show an Indian
clinic's morning list as a 14:30 afternoon. So windows are interpreted in
``settings.CLINIC_TIMEZONE`` and converted to UTC at the boundary; UTC is the
only form that ever reaches the database, and the clinic zone is the only form
ever shown to a person.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from itertools import pairwise
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.config import settings

#: Anything finer invites a slot grid nobody can staff; anything coarser than an
#: hour is better modelled as two windows.
ALLOWED_SLOT_MINUTES = frozenset({10, 15, 20, 30, 45, 60})

#: ISO weekday numbering, matching ``date.isoweekday()``: Monday is 1.
WEEKDAY_NAMES = {
    1: "Monday",
    2: "Tuesday",
    3: "Wednesday",
    4: "Thursday",
    5: "Friday",
    6: "Saturday",
    7: "Sunday",
}

_TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"

#: A booking further out than this is almost always a typo in the year.
MAX_ADVANCE_DAYS = 120

#: Widest window the availability endpoint will compute in one call.
MAX_RANGE_DAYS = 31


def clinic_timezone() -> ZoneInfo:
    """The clinic's wall-clock zone.

    Falls back to UTC rather than failing the request: a misconfigured zone
    should degrade to a defensible default, not take booking offline.
    """
    try:
        return ZoneInfo(settings.CLINIC_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def to_utc(local: datetime) -> datetime:
    """Clinic wall time -> naive UTC, the storage form.

    During a DST transition an ambiguous local time resolves to the first of the
    two instants (``fold=0``) and a nonexistent one shifts forward, which is
    what ``ZoneInfo`` does by default. The clinic zone in use has no DST, but the
    conversion stays correct for deployments that do.
    """
    aware = local.replace(tzinfo=clinic_timezone())
    return aware.astimezone(UTC).replace(tzinfo=None, microsecond=0)


def to_clinic(stored: datetime) -> datetime:
    """Naive UTC -> clinic wall time, the display form."""
    return stored.replace(tzinfo=UTC).astimezone(clinic_timezone()).replace(tzinfo=None)


def iso_utc(stored: datetime) -> str:
    """Serialize a stored timestamp with an explicit ``Z``.

    Without the suffix a browser parses the string as local time and every
    appointment silently shifts by the viewer's offset.
    """
    return stored.replace(microsecond=0).isoformat() + "Z"


class AvailabilityWindow(BaseModel):
    """One recurring weekly window, e.g. Tuesdays 09:00-17:00 in 30-minute slots."""

    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    day_of_week: int = Field(alias="dayOfWeek", ge=1, le=7)
    start_time: str = Field(alias="startTime", pattern=_TIME_PATTERN)
    end_time: str = Field(alias="endTime", pattern=_TIME_PATTERN)
    slot_minutes: int = Field(default=30, alias="slotMinutes")

    @field_validator("slot_minutes")
    @classmethod
    def _known_slot_length(cls, value: int) -> int:
        if value not in ALLOWED_SLOT_MINUTES:
            allowed = ", ".join(str(m) for m in sorted(ALLOWED_SLOT_MINUTES))
            raise ValueError(f"slotMinutes must be one of: {allowed}")
        return value

    @model_validator(mode="after")
    def _window_is_forward(self) -> AvailabilityWindow:
        if self.end_minutes <= self.start_minutes:
            raise ValueError("endTime must be later than startTime")
        if self.end_minutes - self.start_minutes < self.slot_minutes:
            raise ValueError("the window is shorter than one slot")
        return self

    @property
    def start_minutes(self) -> int:
        return _minutes(self.start_time)

    @property
    def end_minutes(self) -> int:
        return _minutes(self.end_time)

    def as_stored(self) -> dict[str, Any]:
        """The JSONB shape held on ``Doctor.availability``."""
        return {
            "dayOfWeek": self.day_of_week,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "slotMinutes": self.slot_minutes,
        }


def _minutes(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def parse_windows(raw: Any) -> list[AvailabilityWindow]:
    """Read stored availability, skipping anything malformed.

    Reads must be forgiving. ``Doctor.availability`` is JSONB, so a row written
    before this validation existed — or by hand in the database — can hold
    entries that no longer parse. One bad entry should cost that window, not the
    doctor's whole calendar.
    """
    if not isinstance(raw, list):
        return []
    windows: list[AvailabilityWindow] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        try:
            windows.append(AvailabilityWindow.model_validate(entry))
        except ValueError:
            continue
    return windows


def validate_windows(windows: list[AvailabilityWindow]) -> list[AvailabilityWindow]:
    """Check a proposed set before it is stored.

    Writes are strict where reads are forgiving. Overlapping windows on one day
    would generate duplicate slot times, and two patients booking "the same"
    09:00 from different windows would then collide on the unique slot key with
    no way to explain why.
    """
    by_day: dict[int, list[AvailabilityWindow]] = {}
    for window in windows:
        by_day.setdefault(window.day_of_week, []).append(window)

    for day, day_windows in by_day.items():
        ordered = sorted(day_windows, key=lambda w: w.start_minutes)
        for earlier, later in pairwise(ordered):
            if later.start_minutes < earlier.end_minutes:
                raise ValueError(
                    f"{WEEKDAY_NAMES[day]} has overlapping windows "
                    f"({earlier.start_time}-{earlier.end_time} and "
                    f"{later.start_time}-{later.end_time})"
                )
    return windows


@dataclass(frozen=True)
class Slot:
    """One bookable interval, carried in both forms so neither is recomputed.

    ``start``/``end`` are naive UTC — what the database stores and what the slot
    key is built from. ``local_start``/``local_end`` are clinic wall time, used
    for display and for deciding which calendar day a slot belongs to.
    """

    start: datetime
    end: datetime
    local_start: datetime
    local_end: datetime

    @property
    def local_date(self) -> date:
        return self.local_start.date()

    @property
    def label(self) -> str:
        return self.local_start.strftime("%H:%M")


def _slot(local_start: datetime, minutes: int) -> Slot:
    local_end = local_start + timedelta(minutes=minutes)
    return Slot(
        start=to_utc(local_start),
        end=to_utc(local_end),
        local_start=local_start,
        local_end=local_end,
    )


def slots_for_day(windows: list[AvailabilityWindow], day: date) -> list[Slot]:
    """Every slot a doctor's windows produce on one clinic-local date.

    A trailing partial slot is dropped: a 09:00-17:20 window in 30-minute slots
    ends at 17:00, because a 20-minute consultation is not the appointment the
    doctor published.
    """
    slots: list[Slot] = []
    for window in windows:
        if window.day_of_week != day.isoweekday():
            continue
        cursor = window.start_minutes
        while cursor + window.slot_minutes <= window.end_minutes:
            local_start = datetime.combine(day, time(cursor // 60, cursor % 60))
            slots.append(_slot(local_start, window.slot_minutes))
            cursor += window.slot_minutes
    return sorted(slots, key=lambda s: s.start)


def slots_for_range(
    windows: list[AvailabilityWindow], first_day: date, last_day: date
) -> list[Slot]:
    """Slots across an inclusive clinic-local date range."""
    slots: list[Slot] = []
    day = first_day
    while day <= last_day:
        slots.extend(slots_for_day(windows, day))
        day += timedelta(days=1)
    return slots


def find_slot(windows: list[AvailabilityWindow], start: datetime) -> Slot | None:
    """The published slot starting at this UTC instant, if there is one.

    Booking resolves the requested time back to the doctor's own grid rather
    than trusting the client's idea of when a slot starts and how long it runs.
    That is what stops a caller from inventing a 03:00 appointment, a
    four-hour one, or one that starts two minutes off the grid and overlaps
    the slots on either side.
    """
    local = to_clinic(start)
    for slot in slots_for_day(windows, local.date()):
        if slot.start == start.replace(microsecond=0):
            return slot
    return None


def overlaps(
    start: datetime, end: datetime, other_start: datetime, other_end: datetime
) -> bool:
    """Half-open interval overlap: an appointment ending at 09:30 does not
    collide with one starting at 09:30."""
    return start < other_end and other_start < end

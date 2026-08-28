"""Availability windows, the slot grid, and the appointment state machine.

No database. Every rule that decides whether a time is bookable — and whether a
status change is legal — is pure logic, so it can be checked exhaustively here
rather than one case at a time through HTTP.
"""

from __future__ import annotations

from datetime import date, datetime

import pytest
from pydantic import ValidationError

from app.core.config import settings
from app.db.enums import AppointmentStatus, Role
from app.modules.appointments.schedule import (
    AvailabilityWindow,
    find_slot,
    iso_utc,
    parse_windows,
    slots_for_day,
    slots_for_range,
    to_clinic,
    to_utc,
    validate_windows,
)
from app.modules.appointments.service import (
    ALLOWED_TRANSITIONS,
    TERMINAL_STATUSES,
    find_transition,
)
from app.modules.auth.rbac import Permission

# 2026-09-07 is a Monday; every date below is chosen relative to it so the
# weekday arithmetic is visible rather than implied.
MONDAY = date(2026, 9, 7)
SATURDAY = date(2026, 9, 12)


def window(day: int = 1, start: str = "09:00", end: str = "17:00", minutes: int = 30) -> AvailabilityWindow:
    return AvailabilityWindow(
        dayOfWeek=day, startTime=start, endTime=end, slotMinutes=minutes
    )


@pytest.fixture(autouse=True)
def kolkata(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the clinic zone so these tests do not depend on deployment config."""
    monkeypatch.setattr(settings, "CLINIC_TIMEZONE", "Asia/Kolkata")


class TestAvailabilityWindowValidation:
    def test_it_accepts_the_stored_camel_case_shape(self) -> None:
        parsed = AvailabilityWindow.model_validate(
            {"dayOfWeek": 3, "startTime": "09:00", "endTime": "17:00", "slotMinutes": 30}
        )
        assert parsed.day_of_week == 3
        assert parsed.as_stored()["startTime"] == "09:00"

    def test_it_rejects_a_window_that_ends_before_it_starts(self) -> None:
        with pytest.raises(ValidationError):
            window(start="17:00", end="09:00")

    def test_it_rejects_a_zero_length_window(self) -> None:
        with pytest.raises(ValidationError):
            window(start="09:00", end="09:00")

    def test_it_rejects_a_window_shorter_than_one_slot(self) -> None:
        # 20 minutes cannot hold a 30-minute consultation.
        with pytest.raises(ValidationError):
            window(start="09:00", end="09:20", minutes=30)

    def test_it_rejects_an_unlisted_slot_length(self) -> None:
        with pytest.raises(ValidationError):
            window(minutes=7)

    @pytest.mark.parametrize("day", [0, 8, -1])
    def test_it_rejects_a_day_outside_the_week(self, day: int) -> None:
        with pytest.raises(ValidationError):
            window(day=day)

    @pytest.mark.parametrize("bad", ["9:00", "24:00", "09:60", "0900", "morning"])
    def test_it_rejects_malformed_times(self, bad: str) -> None:
        with pytest.raises(ValidationError):
            window(start=bad)


class TestParsingStoredAvailability:
    """Reads are forgiving; a bad row must not cost a doctor their calendar."""

    def test_it_skips_malformed_entries_and_keeps_the_rest(self) -> None:
        parsed = parse_windows(
            [
                {"dayOfWeek": 1, "startTime": "09:00", "endTime": "17:00", "slotMinutes": 30},
                {"dayOfWeek": 99, "startTime": "09:00", "endTime": "17:00"},  # junk
                "not a dict",
                {"dayOfWeek": 2, "startTime": "10:00", "endTime": "13:00", "slotMinutes": 15},
            ]
        )
        assert [w.day_of_week for w in parsed] == [1, 2]

    @pytest.mark.parametrize("junk", [None, {}, "", 42, [{"nope": True}]])
    def test_it_returns_nothing_for_unusable_input(self, junk: object) -> None:
        assert parse_windows(junk) == []

    def test_slot_minutes_defaults_when_absent(self) -> None:
        parsed = parse_windows([{"dayOfWeek": 1, "startTime": "09:00", "endTime": "10:00"}])
        assert parsed[0].slot_minutes == 30


class TestOverlapRejection:
    """Writes are strict: overlapping windows would mint duplicate slot times."""

    def test_it_rejects_overlapping_windows_on_one_day(self) -> None:
        with pytest.raises(ValueError, match="Monday"):
            validate_windows([window(1, "09:00", "13:00"), window(1, "12:00", "17:00")])

    def test_it_allows_windows_that_touch_but_do_not_overlap(self) -> None:
        # A morning clinic ending exactly when the afternoon one starts is fine.
        validate_windows([window(1, "09:00", "12:00"), window(1, "12:00", "17:00")])

    def test_it_allows_the_same_hours_on_different_days(self) -> None:
        validate_windows([window(1), window(2), window(3)])

    def test_it_reports_which_day_is_wrong(self) -> None:
        with pytest.raises(ValueError, match="Thursday"):
            validate_windows([window(4, "09:00", "13:00"), window(4, "10:00", "11:00")])


class TestTimeZoneConversion:
    def test_clinic_morning_maps_to_the_expected_utc_instant(self) -> None:
        # Asia/Kolkata is UTC+05:30, so a 09:00 clinic slot is 03:30 UTC.
        assert to_utc(datetime(2026, 9, 7, 9, 0)) == datetime(2026, 9, 7, 3, 30)

    def test_the_conversion_round_trips(self) -> None:
        local = datetime(2026, 9, 7, 14, 30)
        assert to_clinic(to_utc(local)) == local

    def test_serialized_times_are_marked_as_utc(self) -> None:
        # Without the Z a browser reads the string as local time and every
        # appointment silently shifts by the viewer's offset.
        assert iso_utc(datetime(2026, 9, 7, 3, 30)).endswith("Z")


class TestSlotGeneration:
    def test_a_full_day_produces_the_expected_grid(self) -> None:
        slots = slots_for_day([window(1, "09:00", "17:00", 30)], MONDAY)
        assert len(slots) == 16  # eight hours in half-hour slots
        assert slots[0].label == "09:00"
        assert slots[-1].label == "16:30"

    def test_slots_are_generated_in_clinic_time_not_utc(self) -> None:
        first = slots_for_day([window(1, "09:00", "17:00")], MONDAY)[0]
        assert first.local_start == datetime(2026, 9, 7, 9, 0)
        assert first.start == datetime(2026, 9, 7, 3, 30)

    def test_a_trailing_partial_slot_is_dropped(self) -> None:
        # 09:00-10:20 in 30-minute slots yields 09:00 and 09:30; the leftover
        # 20 minutes is not the appointment the doctor published.
        slots = slots_for_day([window(1, "09:00", "10:20", 30)], MONDAY)
        assert [s.label for s in slots] == ["09:00", "09:30"]

    def test_a_day_the_doctor_does_not_work_has_no_slots(self) -> None:
        assert slots_for_day([window(1)], SATURDAY) == []

    def test_two_windows_on_one_day_are_merged_in_order(self) -> None:
        slots = slots_for_day(
            [window(1, "14:00", "16:00", 60), window(1, "09:00", "11:00", 60)], MONDAY
        )
        assert [s.label for s in slots] == ["09:00", "10:00", "14:00", "15:00"]

    def test_a_range_covers_only_the_working_days_inside_it(self) -> None:
        # Monday to Sunday with a Monday-only window yields one day of slots.
        slots = slots_for_range([window(1, "09:00", "11:00", 60)], MONDAY, date(2026, 9, 13))
        assert {s.local_date for s in slots} == {MONDAY}
        assert len(slots) == 2


class TestFindSlot:
    """Booking resolves a requested time against the doctor's own grid."""

    def test_it_finds_a_published_slot(self) -> None:
        found = find_slot([window(1, "09:00", "17:00")], datetime(2026, 9, 7, 3, 30))
        assert found is not None
        assert found.label == "09:00"

    def test_it_rejects_a_time_between_slots(self) -> None:
        # 09:05 clinic time is 03:35 UTC — inside the window, off the grid. A
        # booking here would overlap the slots on either side of it.
        assert find_slot([window(1, "09:00", "17:00")], datetime(2026, 9, 7, 3, 35)) is None

    def test_it_rejects_a_time_outside_the_published_hours(self) -> None:
        # 03:00 clinic time — the middle of the night.
        assert find_slot([window(1, "09:00", "17:00")], datetime(2026, 9, 6, 21, 30)) is None

    def test_it_rejects_a_slot_time_on_a_non_working_day(self) -> None:
        # Same hour, but Saturday.
        assert find_slot([window(1, "09:00", "17:00")], datetime(2026, 9, 12, 3, 30)) is None

    def test_a_doctor_with_no_windows_offers_nothing(self) -> None:
        assert find_slot([], datetime(2026, 9, 7, 3, 30)) is None


class TestStatusMachine:
    def test_every_status_is_declared(self) -> None:
        # A status missing from the table would be an appointment that can never
        # move again, silently.
        assert set(ALLOWED_TRANSITIONS) == set(AppointmentStatus)

    @pytest.mark.parametrize("status", TERMINAL_STATUSES)
    def test_terminal_statuses_lead_nowhere(self, status: AppointmentStatus) -> None:
        assert ALLOWED_TRANSITIONS[status] == ()

    @pytest.mark.parametrize(
        ("current", "target"),
        [
            (AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED),
            (AppointmentStatus.CONFIRMED, AppointmentStatus.CHECKED_IN),
            (AppointmentStatus.CHECKED_IN, AppointmentStatus.IN_PROGRESS),
            (AppointmentStatus.IN_PROGRESS, AppointmentStatus.COMPLETED),
        ],
    )
    def test_the_consultation_path_is_walkable(
        self, current: AppointmentStatus, target: AppointmentStatus
    ) -> None:
        assert find_transition(current, target) is not None

    @pytest.mark.parametrize(
        ("current", "target"),
        [
            # No skipping ahead to a completed consultation.
            (AppointmentStatus.REQUESTED, AppointmentStatus.COMPLETED),
            (AppointmentStatus.CONFIRMED, AppointmentStatus.COMPLETED),
            # No going back.
            (AppointmentStatus.COMPLETED, AppointmentStatus.IN_PROGRESS),
            (AppointmentStatus.CHECKED_IN, AppointmentStatus.CONFIRMED),
            # A cancelled appointment stays cancelled.
            (AppointmentStatus.CANCELLED, AppointmentStatus.CONFIRMED),
            (AppointmentStatus.NO_SHOW, AppointmentStatus.CHECKED_IN),
        ],
    )
    def test_illegal_moves_have_no_transition(
        self, current: AppointmentStatus, target: AppointmentStatus
    ) -> None:
        assert find_transition(current, target) is None

    def test_cancellation_is_not_in_the_machine(self) -> None:
        # Cancelling frees the slot and records who and why, so it lives behind
        # its own endpoint rather than as a status change.
        for transitions in ALLOWED_TRANSITIONS.values():
            assert all(t.to != AppointmentStatus.CANCELLED for t in transitions)

    def test_completing_a_consultation_is_the_treating_doctors_alone(self) -> None:
        transition = find_transition(AppointmentStatus.IN_PROGRESS, AppointmentStatus.COMPLETED)
        assert transition is not None
        assert transition.by_treating_doctor is True
        assert transition.by_admin is False
        assert transition.permission == Permission.CONSULTATION_COMPLETE

    def test_no_transition_is_available_to_a_patient(self) -> None:
        # Patients book and cancel; they never move a consultation forward.
        for transitions in ALLOWED_TRANSITIONS.values():
            for transition in transitions:
                assert transition.by_treating_doctor or transition.by_admin

    def test_only_a_doctor_may_start_a_consultation(self) -> None:
        transition = find_transition(AppointmentStatus.CHECKED_IN, AppointmentStatus.IN_PROGRESS)
        assert transition is not None
        assert transition.by_admin is False

    def test_the_permission_gate_matches_the_role_catalogue(self) -> None:
        from app.modules.auth.rbac import permissions_for

        assert Permission.CONSULTATION_COMPLETE in permissions_for(Role.DOCTOR)
        assert Permission.CONSULTATION_COMPLETE not in permissions_for(Role.ADMIN)

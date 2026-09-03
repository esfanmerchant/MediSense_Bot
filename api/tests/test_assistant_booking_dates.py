"""The assistant must not offer appointments that cannot exist.

Two failures, both seen in the running product:

* It offered **02 September 2025** when the date was 03 September 2026. The
  patient had written "2nd september" with no year and the model filled one in
  from wherever its training stopped, because nothing had ever told it what
  today was.
* It said it had **found a time** on a day the doctor does not hold a clinic.
  The model wrote that sentence before anything read the diary; the check then
  failed, the offer was dropped, and the sentence was left standing on its own.
  A patient was told a time existed and shown none.

Both are fixed in two places, and both places are tested here: the prompt tells
the model, and the resolver refuses regardless of what the model sends. The
prompt is guidance to something that may ignore it; the resolver is the rule.
"""

from __future__ import annotations

import inspect
from datetime import date, timedelta

import pytest

from app.modules.assistant import router as assistant_router
from app.services import assistant


class TestTheModelIsToldWhatDayItIs:
    def test_the_context_carries_today(self) -> None:
        context = assistant.build_context(
            active_medications=[],
            upcoming_appointments=[],
            specialities=[],
            today="Thursday, 03 September 2026",
        )
        assert "Today's date: Thursday, 03 September 2026" in context

    def test_it_says_what_that_means_for_earlier_dates(self) -> None:
        # Stating the date is not enough on its own — the model has to be told
        # that everything before it is out of bounds.
        context = assistant.build_context(
            active_medications=[],
            upcoming_appointments=[],
            specialities=[],
            today="Thursday, 03 September 2026",
        )
        assert "in the past" in context

    def test_a_context_without_it_simply_omits_it(self) -> None:
        context = assistant.build_context(
            active_medications=[], upcoming_appointments=[], specialities=[]
        )
        assert "Today's date" not in context

    def test_the_router_reads_the_clinic_day_not_the_server_day(self) -> None:
        # They differ for five hours of every day in Asia/Karachi, and the day
        # a patient means is the one at the clinic.
        assert "clinic_timezone()" in inspect.getsource(assistant_router._clinic_today)


class TestThePromptForbidsTheTwoMistakes:
    @staticmethod
    def _prompt() -> str:
        return assistant.SYSTEM_INSTRUCTION

    def test_it_refuses_dates_that_have_gone(self) -> None:
        assert "Never propose a date that has already passed" in self._prompt()

    def test_a_bare_date_means_the_next_one(self) -> None:
        assert "never a past one" in self._prompt()

    def test_it_must_check_the_doctor_works_that_day(self) -> None:
        prompt = self._prompt()
        assert "which weekdays they see patients" in prompt
        assert "Only propose a date that falls on one of those days" in prompt

    def test_it_must_not_claim_a_time_was_found(self) -> None:
        # This is the sentence that made the bug visible: it was written before
        # anything looked, and survived the lookup failing.
        assert "Do not say you have found a time" in self._prompt()

    def test_it_still_never_claims_to_have_booked(self) -> None:
        assert "Never say you have booked anything" in self._prompt()


class TestWorkingDaysReadBackInWords:
    def test_the_days_a_doctor_sits(self) -> None:
        windows = [
            {"dayOfWeek": 6, "startTime": "09:00", "endTime": "13:00", "slotMinutes": 30},
            {"dayOfWeek": 7, "startTime": "09:00", "endTime": "13:00", "slotMinutes": 30},
        ]
        assert assistant_router._working_days(windows) == "Saturday, Sunday"

    def test_they_come_back_in_week_order(self) -> None:
        windows = [
            {"dayOfWeek": 5, "startTime": "09:00", "endTime": "13:00", "slotMinutes": 30},
            {"dayOfWeek": 1, "startTime": "09:00", "endTime": "13:00", "slotMinutes": 30},
        ]
        assert assistant_router._working_days(windows) == "Monday, Friday"

    def test_a_doctor_with_no_hours_says_so(self) -> None:
        # Silence would read as "any day", which is the opposite of the truth.
        assert assistant_router._working_days([]) == "no published hours yet"
        assert assistant_router._working_days(None) == "no published hours yet"

    def test_a_malformed_window_does_not_take_the_others_with_it(self) -> None:
        windows = [
            {"dayOfWeek": 6, "startTime": "09:00", "endTime": "13:00", "slotMinutes": 30},
            {"nonsense": True},
        ]
        assert assistant_router._working_days(windows) == "Saturday"


class TestTheResolverRefusesThePast:
    """Whatever the model sends, a date that has gone is not an offer."""

    @staticmethod
    def _db():
        class Session:
            def __init__(self) -> None:
                self.queries = 0

            async def execute(self, _statement: object) -> object:
                self.queries += 1
                raise AssertionError("the past should be refused before any lookup")

        return Session()

    @pytest.mark.anyio
    async def test_yesterday_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        today = date(2026, 9, 3)
        monkeypatch.setattr(assistant_router, "_clinic_today", lambda: today)
        db = self._db()
        offer, problem = await assistant_router._resolve_booking(
            db,  # type: ignore[arg-type]
            "abdulrafay",
            (today - timedelta(days=1)).isoformat(),
        )
        assert offer is None
        assert problem == {
            "reason": "past",
            "date": "2026-09-02",
            "today": "2026-09-03",
        }

    @pytest.mark.anyio
    async def test_last_year_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # The exact case that shipped: today 03 Sep 2026, offered 02 Sep 2025.
        monkeypatch.setattr(assistant_router, "_clinic_today", lambda: date(2026, 9, 3))
        offer, problem = await assistant_router._resolve_booking(
            self._db(),  # type: ignore[arg-type]
            "abdulrafay",
            "2025-09-02",
        )
        assert offer is None
        assert problem is not None and problem["reason"] == "past"

    @pytest.mark.anyio
    async def test_it_does_not_even_ask_the_database(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The stub raises on any query; reaching the doctor lookup for a date
        # that cannot be booked is work done to reach a foregone answer.
        monkeypatch.setattr(assistant_router, "_clinic_today", lambda: date(2026, 9, 3))
        db = self._db()
        await assistant_router._resolve_booking(db, "anyone", "2020-01-01")  # type: ignore[arg-type]
        assert db.queries == 0

    @pytest.mark.anyio
    async def test_today_itself_is_not_the_past(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A same-day appointment is a normal thing to want; only the resolver's
        # own bound decides, and it must not be off by one.
        today = date(2026, 9, 3)
        monkeypatch.setattr(assistant_router, "_clinic_today", lambda: today)

        class Empty:
            def all(self) -> list[object]:
                return []

        class Session:
            async def execute(self, _statement: object) -> Empty:
                return Empty()

        offer, problem = await assistant_router._resolve_booking(
            Session(),  # type: ignore[arg-type]
            "someone",
            today.isoformat(),
        )
        # It got past the date check and on to looking for the doctor, which is
        # the thing being asserted; who it found is another test's business.
        assert offer is None
        assert problem is not None and problem["reason"] == "unknown_doctor"


class TestAFailedLookupComesBackWithAReason:
    """The silence is the bug. Every failure now has something to say."""

    @staticmethod
    def _rows(rows: list[object]):
        class Result:
            def all(self) -> list[object]:
                return rows

        class Session:
            async def execute(self, _statement: object) -> Result:
                return Result()

        return Session()

    @pytest.mark.anyio
    async def test_an_unknown_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(assistant_router, "_clinic_today", lambda: date(2026, 9, 3))
        offer, problem = await assistant_router._resolve_booking(
            self._rows([]),  # type: ignore[arg-type]
            "Dr Nobody",
            "2026-09-05",
        )
        assert offer is None
        assert problem == {"reason": "unknown_doctor", "doctorName": "Nobody"}

    @pytest.mark.anyio
    async def test_two_doctors_matching_one_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(assistant_router, "_clinic_today", lambda: date(2026, 9, 3))
        offer, problem = await assistant_router._resolve_booking(
            self._rows([object(), object()]),  # type: ignore[arg-type]
            "Khan",
            "2026-09-05",
        )
        assert offer is None
        # Guessing between two doctors is the mistake this whole path avoids.
        assert problem == {"reason": "ambiguous_doctor", "doctorName": "Khan"}

    @pytest.mark.anyio
    async def test_a_day_the_doctor_does_not_work(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(assistant_router, "_clinic_today", lambda: date(2026, 9, 3))
        # Saturdays and Sundays only — the shape of the doctor in the report.
        weekend = [
            {"dayOfWeek": 6, "startTime": "09:00", "endTime": "13:00", "slotMinutes": 30},
            {"dayOfWeek": 7, "startTime": "09:00", "endTime": "13:00", "slotMinutes": 30},
        ]
        monkeypatch.setattr(
            assistant_router.appointments_service,
            "availability",
            _async_returning([]),
        )
        monkeypatch.setattr(assistant_router, "_next_free_dates", _async_returning(["2026-09-05"]))

        offer, problem = await assistant_router._resolve_booking(
            self._rows([("d1", "abdulrafay", "General Physician", 1200, weekend)]),  # type: ignore[arg-type]
            "abdulrafay",
            "2026-09-09",  # a Wednesday
        )
        assert offer is None
        assert problem is not None
        assert problem["reason"] == "not_working"
        assert problem["worksOn"] == "Saturday, Sunday"
        assert problem["nextFree"] == ["2026-09-05"]

    @pytest.mark.anyio
    async def test_a_day_they_work_that_is_full_says_so_instead(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Told apart from the above on purpose: "they sit on Saturdays" sends
        # somebody to try another Saturday, and "that Saturday is taken" does
        # not. The wrong one wastes their next attempt.
        monkeypatch.setattr(assistant_router, "_clinic_today", lambda: date(2026, 9, 3))
        weekend = [
            {"dayOfWeek": 6, "startTime": "09:00", "endTime": "13:00", "slotMinutes": 30}
        ]
        monkeypatch.setattr(
            assistant_router.appointments_service,
            "availability",
            _async_returning([{"date": "2026-09-05", "slots": [{"available": False}]}]),
        )
        monkeypatch.setattr(assistant_router, "_next_free_dates", _async_returning(["2026-09-12"]))

        offer, problem = await assistant_router._resolve_booking(
            self._rows([("d1", "abdulrafay", "General Physician", 1200, weekend)]),  # type: ignore[arg-type]
            "abdulrafay",
            "2026-09-05",  # a Saturday, which they do work
        )
        assert offer is None
        assert problem is not None and problem["reason"] == "day_full"

    @pytest.mark.anyio
    async def test_a_real_free_slot_still_becomes_an_offer(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(assistant_router, "_clinic_today", lambda: date(2026, 9, 3))
        weekend = [
            {"dayOfWeek": 6, "startTime": "09:00", "endTime": "13:00", "slotMinutes": 30}
        ]
        monkeypatch.setattr(
            assistant_router.appointments_service,
            "availability",
            _async_returning(
                [
                    {
                        "date": "2026-09-05",
                        "slots": [
                            {"available": True, "startTime": "09:00", "endTime": "09:30"},
                            {"available": True, "startTime": "09:30", "endTime": "10:00"},
                        ],
                    }
                ]
            ),
        )

        offer, problem = await assistant_router._resolve_booking(
            self._rows([("d1", "abdulrafay", "General Physician", 1200, weekend)]),  # type: ignore[arg-type]
            "abdulrafay",
            "2026-09-05",
        )
        assert problem is None
        assert offer is not None
        assert offer["date"] == "2026-09-05"
        assert offer["startTime"] == "09:00"
        assert offer["alternatives"] == [{"startTime": "09:30", "endTime": "10:00"}]


class TestTheAnswerCarriesOneOrTheOther:
    def test_the_router_attaches_a_problem_when_there_is_no_offer(self) -> None:
        source = inspect.getsource(assistant_router._answer)
        assert 'payload["booking"] = proposal' in source
        assert 'payload["bookingProblem"] = problem' in source

    def test_the_machine_line_is_stripped_either_way(self) -> None:
        # A patient must never see `BOOK: doctor=...`, offer or no offer.
        cleaned, intent = assistant.extract_booking(
            "Main dekh raha hoon.\nBOOK: doctor=abdulrafay; date=2026-09-05"
        )
        assert "BOOK:" not in cleaned
        assert intent == ("abdulrafay", "2026-09-05")


def _async_returning(value: object):
    async def call(*_args: object, **_kwargs: object) -> object:
        return value

    return call

"""A CNIC on every account, who gets told how, and the day's medication list.

Three things arrived together and each has one rule that matters:

* **A CNIC identifies; it never authenticates.** It is printed on a card people
  hand over daily, so a system that let it open an account would be one whose
  accounts open with something everybody already has.
* **A preference cannot silence a break-glass notice.** Turning email off says
  "stop telling me about appointments". It does not say "do not tell me if
  somebody opened my medical record in an emergency" — and the person who would
  want that silenced is not the patient.
* **The day's list resets by having a date in the key, not by a job at
  midnight.** Nothing runs at 00:00; tomorrow simply has no rows yet.
"""

from __future__ import annotations

import inspect
from types import SimpleNamespace

import pytest

from app.core.errors import AppError
from app.db.enums import NotificationType, Role
from app.modules.auth.schemas import RegisterRequest
from app.modules.notifications.service import allowed_channels
from app.modules.notifications.templates import ALWAYS_SENT, EMAILED_TYPES, PUSHED_TYPES
from app.modules.prescriptions import reminders

VALID = {
    "name": "Priya Sharma",
    "email": "priya@example.com",
    "password": "Str0ng!Passphrase9",
}


class TestTheCnicIsRequiredAndNormalised:
    def test_a_dashed_cnic_is_stored_as_digits(self) -> None:
        # Two people who typed it differently must be one value in the column,
        # or a search for either finds only one of the accounts.
        assert RegisterRequest(**VALID, cnic="42101-7536622-3").cnic == "4210175366223"

    def test_an_undashed_cnic_is_accepted_too(self) -> None:
        assert RegisterRequest(**VALID, cnic="4210175366223").cnic == "4210175366223"

    def test_registration_without_one_is_refused(self) -> None:
        with pytest.raises(ValueError):
            RegisterRequest(**VALID)

    @pytest.mark.parametrize(
        "bad",
        [
            "42101-753662-3",  # twelve digits
            "42101-75366223-3",  # fourteen
            "42101 7536622 3",  # spaces are not the separator people type
            "abcde-fghijkl-m",
            "",
        ],
    )
    def test_something_that_is_not_a_cnic_is_refused(self, bad: str) -> None:
        with pytest.raises(ValueError):
            RegisterRequest(**VALID, cnic=bad)

    def test_it_is_not_a_credential(self) -> None:
        # Sign-in takes an email and a password, and nothing else. If a CNIC
        # ever appears here, accounts open with a number printed on a card.
        from app.modules.auth.schemas import LoginRequest

        assert "cnic" not in LoginRequest.model_fields


class TestWhoGetsToldHow:
    """Push for everything, email for the short list, two exceptions to both."""

    @staticmethod
    def _db(email: bool, push: bool):
        class Result:
            def first(self) -> tuple[bool, bool]:
                return (email, push)

        class Session:
            async def execute(self, _statement: object) -> Result:
                return Result()

        return Session()

    @pytest.mark.anyio
    async def test_switching_email_off_stops_an_appointment_email(self) -> None:
        channels = await allowed_channels(
            self._db(email=False, push=True),  # type: ignore[arg-type]
            "u1",
            NotificationType.APPOINTMENT_BOOKED,
        )
        assert not channels.email
        assert channels.push

    @pytest.mark.anyio
    async def test_switching_push_off_stops_a_dose_reminder(self) -> None:
        channels = await allowed_channels(
            self._db(email=True, push=False),  # type: ignore[arg-type]
            "u1",
            NotificationType.MEDICATION_REMINDER,
        )
        assert not channels.push

    @pytest.mark.anyio
    @pytest.mark.parametrize("kind", sorted(ALWAYS_SENT, key=str))
    async def test_nothing_silences_a_break_glass_or_security_notice(
        self, kind: NotificationType
    ) -> None:
        channels = await allowed_channels(
            self._db(email=False, push=False),  # type: ignore[arg-type]
            "u1",
            kind,
        )
        assert channels.email
        assert channels.push

    @pytest.mark.anyio
    async def test_an_unknown_user_is_told_rather_than_silently_dropped(self) -> None:
        class Empty:
            def first(self) -> None:
                return None

        class Session:
            async def execute(self, _statement: object) -> Empty:
                return Empty()

        channels = await allowed_channels(
            Session(),  # type: ignore[arg-type]
            "nobody",
            NotificationType.APPOINTMENT_BOOKED,
        )
        # The row is about to be written for them either way; dropping the
        # delivery because a lookup missed would be a failure nobody can see.
        assert channels.email and channels.push

    def test_a_welcome_is_emailed(self) -> None:
        assert NotificationType.ACCOUNT_REGISTERED in EMAILED_TYPES
        assert NotificationType.ACCOUNT_REGISTERED in PUSHED_TYPES

    def test_the_two_exceptions_are_both_emailed_anyway(self) -> None:
        # A type that is never in EMAILED_TYPES cannot be rescued by ALWAYS_SENT
        # — the exception lifts the preference, not the policy.
        assert ALWAYS_SENT <= EMAILED_TYPES


class TestTheDayResetsByItself:
    """Midnight is a change of key, not a job."""

    def test_the_list_is_keyed_on_the_clinic_date(self) -> None:
        source = inspect.getsource(reminders.todays_medication)
        assert "_today()" in source
        assert "MedicationDose.on == on" in source

    def test_the_clinic_day_is_not_the_server_day(self) -> None:
        # They differ for five hours of every day in Asia/Karachi; a dose
        # ticked at 02:00 would otherwise land on yesterday's list.
        assert "clinic_timezone()" in inspect.getsource(reminders._today)

    def test_nothing_is_scheduled_to_clear_anything(self) -> None:
        from app.modules.notifications import dispatcher

        # A nightly reset is a job that can fail overnight and leave somebody
        # looking at yesterday. There must not be one.
        assert "medication_doses" not in inspect.getsource(dispatcher)

    def test_a_discontinued_medicine_leaves_the_list(self) -> None:
        source = inspect.getsource(reminders.todays_medication)
        assert "Prescription.active.is_(True)" in source
        assert "MedicationReminder.active.is_(True)" in source

    def test_ticking_twice_is_one_row(self) -> None:
        source = inspect.getsource(reminders.mark_taken)
        # Looked up before inserting, and the unique index behind it, so a
        # double tap on a slow connection is one tick and not an error.
        assert "scalar_one_or_none()" in source
        assert "if existing is None:" in source

    def test_yesterday_cannot_be_edited(self) -> None:
        source = inspect.getsource(reminders.unmark_taken)
        assert "MedicationDose.on == on" in source
        assert "_today()" in source


class TestWhoMayTickADose:
    """The same scoping the reminders themselves use, one level down."""

    @staticmethod
    def _db(row: object | None):
        class Result:
            def scalar_one_or_none(self) -> object | None:
                return row

        class Session:
            def __init__(self) -> None:
                self.statements: list[str] = []

            async def execute(self, statement: object) -> Result:
                self.statements.append(str(statement))
                return Result()

        return Session()

    @pytest.mark.anyio
    async def test_the_owner_gets_their_reminder(self) -> None:
        mine = SimpleNamespace(id="r1", patient_id="p1")
        db = self._db(mine)
        auth = SimpleNamespace(role=Role.PATIENT, patient_id="p1", user_id="u1")
        assert await reminders.require_own_reminder(db, auth, "r1") is mine  # type: ignore[arg-type]

    @pytest.mark.anyio
    async def test_the_query_is_scoped_to_the_caller(self) -> None:
        db = self._db(None)
        auth = SimpleNamespace(role=Role.PATIENT, patient_id="p1", user_id="u1")
        with pytest.raises(AppError):
            await reminders.require_own_reminder(db, auth, "r1")  # type: ignore[arg-type]
        assert 'medication_reminders."patientId" =' in db.statements[0]

    @pytest.mark.anyio
    @pytest.mark.parametrize(
        "auth",
        [
            SimpleNamespace(role=Role.DOCTOR, patient_id=None, user_id="u2"),
            SimpleNamespace(role=Role.ADMIN, patient_id=None, user_id="u3"),
            SimpleNamespace(role=Role.PATIENT, patient_id=None, user_id="u4"),
        ],
    )
    async def test_nobody_else_may_tick_somebody_elses_dose(self, auth: object) -> None:
        db = self._db(SimpleNamespace(id="r1", patient_id="p1"))
        with pytest.raises(AppError) as raised:
            await reminders.require_own_reminder(db, auth, "r1")  # type: ignore[arg-type]
        assert raised.value.status_code == 404
        assert db.statements == []

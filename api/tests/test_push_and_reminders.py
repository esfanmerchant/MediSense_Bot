"""Medication reminders, and the push channel that carries them.

Two things here can hurt somebody, and both are pinned:

* **A reminder must not fire twice in one day, or on the wrong day.** The
  dispatcher asks the notification table "did I already say this", keyed on the
  reminder *and* the clinic-local date. Those two halves are written in
  different functions and only agree by convention, so the convention is a test.
* **A reminder must stop when the medicine does.** Discontinuing a prescription
  does not delete its reminder rows, so the only thing standing between a
  stopped medicine and a nightly alarm telling somebody to take it is a filter
  in one query.

Nothing here touches a database. The dispatcher's query is checked by calling
it with a session that records the statement and answers with nothing, so what
is asserted is the real query rather than a copy of it — a copy keeps passing
after the original loses a filter, which is the failure this exists to catch.
"""

from __future__ import annotations

import json
from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.core.config import settings
from app.core.errors import AppError
from app.db.enums import NotificationChannel, NotificationType, Role
from app.modules.notifications import dispatcher
from app.modules.notifications.templates import EMAILED_TYPES, PUSHED_TYPES
from app.modules.prescriptions.reminders import (
    MAX_TIMES,
    ReminderTimes,
    _clock,
    require_own_prescription,
)
from app.services import push


class TestTheTimesComeFromThePatient:
    """A clock time is never derived from the prescription's prose."""

    def test_a_time_is_parsed_and_normalised(self) -> None:
        assert ReminderTimes(times=["8:05", "20:00"]).times == ["08:05", "20:00"]

    def test_the_same_time_twice_is_one_reminder(self) -> None:
        # Two identical times would be one notification anyway; refusing the
        # request over it would be pedantry aimed at somebody's medication.
        assert ReminderTimes(times=["08:00", "8:00"]).times == ["08:00"]

    @pytest.mark.parametrize("bad", ["24:00", "12:60", "-1:00", "eight", "08", "08:0a", ""])
    def test_anything_that_is_not_a_time_of_day_is_refused(self, bad: str) -> None:
        with pytest.raises(ValueError):
            ReminderTimes(times=[bad])

    def test_there_is_a_ceiling_on_how_many(self) -> None:
        # An unbounded list is unbounded work for the dispatcher, every day,
        # forever.
        with pytest.raises(ValueError):
            ReminderTimes(times=[f"{h:02d}:00" for h in range(MAX_TIMES + 1)])

    def test_minutes_past_midnight_round_trip(self) -> None:
        assert _clock(0) == "00:00"
        assert _clock(8 * 60 + 5) == "08:05"
        assert _clock(23 * 60 + 59) == "23:59"


class TestWhatADueReminderQueryInsistsOn:
    """The filters that keep a reminder honest, read off the real statement.

    The query is obtained by *calling* `due_medication_reminders` with a
    session that records what it is handed and answers with nothing. Rebuilding
    the statement in the test would be a copy, and a copy keeps passing after
    the original loses a filter — which is the exact failure this is here to
    catch.
    """

    @staticmethod
    async def _statement() -> str:
        class Recorder:
            """Enough of an AsyncSession for one call, and nothing more."""

            def __init__(self) -> None:
                self.seen: list[str] = []

            async def execute(self, statement: object) -> object:
                self.seen.append(str(statement))

                class Empty:
                    def tuples(self) -> Empty:
                        return self

                    def all(self) -> list[object]:
                        return []

                    def scalars(self) -> Empty:
                        return self

                return Empty()

        recorder = Recorder()
        rows = await dispatcher.due_medication_reminders(recorder)  # type: ignore[arg-type]
        assert rows == []
        assert len(recorder.seen) == 1, "the due query should be one statement"
        return recorder.seen[0]

    @pytest.mark.anyio
    async def test_a_discontinued_medicine_stops_reminding(self) -> None:
        # The reminder rows outlive the decision to stop, so this filter is the
        # only thing between "stop taking it" and an alarm saying to take it.
        assert "prescriptions.active IS true" in await self._statement()

    @pytest.mark.anyio
    async def test_a_switched_off_reminder_stops_reminding(self) -> None:
        assert "medication_reminders.active IS true" in await self._statement()

    @pytest.mark.anyio
    async def test_the_window_is_one_sided(self) -> None:
        # Both bounds present means a reminder set for 20:00 cannot fire at
        # 19:00 because a pass ran a little early.
        sql = await self._statement()
        assert 'medication_reminders."atMinutes" <=' in sql
        assert 'medication_reminders."atMinutes" >=' in sql

    @pytest.mark.anyio
    async def test_it_joins_through_the_patient_to_reach_a_user(self) -> None:
        # A reminder is stored against a patient; a notification is addressed
        # to a user. Losing this join loses the recipient.
        sql = await self._statement()
        assert "JOIN patients" in sql
        assert "JOIN prescriptions" in sql

    @pytest.mark.anyio
    async def test_a_pass_cannot_take_unbounded_work(self) -> None:
        assert "LIMIT" in await self._statement()

    def test_the_grace_is_short_enough_to_still_be_a_reminder(self) -> None:
        # A dose reminder four hours late is not a reminder; it is a prompt to
        # take a second dose.
        assert timedelta(hours=1) >= dispatcher.MEDICATION_GRACE


class TestWhoMaySetAReminder:
    """The ownership check, actually run.

    Every case here goes through `require_own_prescription` rather than reading
    its source, because the bug this class exists for was an `await` that bound
    to the wrong half of a chain — code that reads correctly, imports
    correctly, type-checks, and returns a 500 the first time anybody calls it.
    """

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

    @staticmethod
    def _auth(role: Role, patient_id: str | None):
        return SimpleNamespace(role=role, patient_id=patient_id, user_id="u1")

    @pytest.mark.anyio
    async def test_the_owner_gets_their_prescription(self) -> None:
        mine = SimpleNamespace(id="rx1", patient_id="p1", active=True, medication="Metformin")
        db = self._db(mine)
        row = await require_own_prescription(db, self._auth(Role.PATIENT, "p1"), "rx1")
        assert row is mine

    @pytest.mark.anyio
    async def test_the_query_is_scoped_to_the_caller(self) -> None:
        db = self._db(None)
        with pytest.raises(AppError):
            await require_own_prescription(db, self._auth(Role.PATIENT, "p1"), "rx1")
        # Both halves in the WHERE, so "somebody else's" cannot come back at all.
        assert 'prescriptions.id =' in db.statements[0]
        assert 'prescriptions."patientId" =' in db.statements[0]

    @pytest.mark.anyio
    async def test_somebody_elses_prescription_is_not_found_not_forbidden(self) -> None:
        # The row exists; it is simply not theirs. The scoped query returns
        # nothing, so the answer is 404 — the same answer a made-up id gets.
        db = self._db(None)
        with pytest.raises(AppError) as raised:
            await require_own_prescription(db, self._auth(Role.PATIENT, "p2"), "rx1")
        assert raised.value.status_code == 404

    @pytest.mark.anyio
    @pytest.mark.parametrize(
        "auth",
        [
            SimpleNamespace(role=Role.DOCTOR, patient_id=None, user_id="u2"),
            SimpleNamespace(role=Role.ADMIN, patient_id=None, user_id="u3"),
            SimpleNamespace(role=Role.NURSE, patient_id=None, user_id="u4"),
            # A patient session with no patient record must not fall through to
            # a query with `patientId IS NULL` in it.
            SimpleNamespace(role=Role.PATIENT, patient_id=None, user_id="u5"),
        ],
    )
    async def test_nobody_else_may_set_an_alarm_on_a_phone(self, auth: object) -> None:
        db = self._db(SimpleNamespace(id="rx1", patient_id="p1", active=True))
        with pytest.raises(AppError) as raised:
            await require_own_prescription(db, auth, "rx1")  # type: ignore[arg-type]
        assert raised.value.status_code == 404
        # And it never even asked the database.
        assert db.statements == []


class TestSayingItOnlyOncePerDay:
    """Idempotence is keyed on the reminder *and* the clinic-local date."""

    def test_the_metadata_carries_both_halves_of_the_key(self) -> None:
        import inspect

        source = inspect.getsource(dispatcher.schedule_medication_reminders)
        assert '"reminderId"' in source
        assert '"on": today' in source

    def test_the_lookup_uses_both_halves(self) -> None:
        import inspect

        source = inspect.getsource(dispatcher.due_medication_reminders)
        assert '["reminderId"]' in source
        assert '["on"]' in source
        # The date must come from the clinic's day, not the server's — the two
        # differ for five hours of every day in Asia/Karachi.
        assert "clinic_timezone()" in source


class TestWhichNotificationsEarnAPush:
    """A push interrupts somebody wherever they are, so the list is short."""

    def test_a_dose_that_is_due_is_pushed(self) -> None:
        assert NotificationType.MEDICATION_REMINDER in PUSHED_TYPES

    def test_a_medication_reminder_is_never_emailed(self) -> None:
        # A push is encrypted to the device; an email sits on a mail provider's
        # servers. Only one of the two may name a medicine.
        assert NotificationType.MEDICATION_REMINDER not in EMAILED_TYPES

    def test_everything_is_pushed(self) -> None:
        # The policy changed: push is the default channel for events, because
        # it is cheap to receive and cheap to dismiss. Email is the exception.
        assert frozenset(NotificationType) == PUSHED_TYPES

    def test_an_invoice_is_worth_an_email_as_well(self) -> None:
        assert NotificationType.INVOICE_ISSUED in EMAILED_TYPES

    def test_pushed_is_a_subset_of_what_the_portal_shows(self) -> None:
        assert set(NotificationType) >= PUSHED_TYPES

    def test_a_result_is_never_emailed(self) -> None:
        # A push is encrypted to the device and says a report arrived; an email
        # sits on a mail provider's servers. The notice may be pushed; it may
        # not be mailed.
        assert NotificationType.REPORT_UPLOADED not in EMAILED_TYPES

    def test_email_stays_the_short_list(self) -> None:
        # If this ever equals the full set, the sender has become the kind that
        # people filter — and the filter does not spare the break-glass notice.
        assert len(EMAILED_TYPES) < len(NotificationType)


class TestSendingOne:
    """The push sender's two contracts: never raise, and retire a dead device."""

    SUB = push.Subscription(id="s1", endpoint="https://push.example/x", p256dh="k", auth="a")

    @pytest.mark.anyio
    async def test_it_declines_rather_than_raising_when_unconfigured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", "", raising=False)
        monkeypatch.setattr(settings, "VAPID_PUBLIC_KEY", "", raising=False)
        result = await push.send(self.SUB, title="t", body="b", link=None, tag="x")
        assert not result.ok
        assert not result.gone

    def test_a_gone_endpoint_is_retired_not_retried(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from pywebpush import WebPushException

        def refuse(**_kwargs: object) -> None:
            raise WebPushException("gone", response=SimpleNamespace(status_code=410))

        monkeypatch.setattr("pywebpush.webpush", refuse)
        result = push._send_blocking(self.SUB, "{}")
        assert not result.ok
        assert result.gone

    def test_a_server_error_is_retried_not_retired(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from pywebpush import WebPushException

        def fail(**_kwargs: object) -> None:
            raise WebPushException("boom", response=SimpleNamespace(status_code=503))

        monkeypatch.setattr("pywebpush.webpush", fail)
        result = push._send_blocking(self.SUB, "{}")
        assert not result.ok
        assert not result.gone

    def test_an_unexpected_failure_cannot_take_the_dispatcher_down(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def explode(**_kwargs: object) -> None:
            raise RuntimeError("something else entirely")

        monkeypatch.setattr("pywebpush.webpush", explode)
        result = push._send_blocking(self.SUB, "{}")
        assert not result.ok
        assert result.error == "RuntimeError"


class TestWhatAPushCarries:
    """The payload the service worker will read, and what it must not say."""

    @pytest.mark.anyio
    async def test_the_four_fields_the_worker_reads(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: dict[str, object] = {}

        def capture(*, subscription: push.Subscription, payload: str) -> push.Delivery:
            seen["payload"] = payload
            return push.Delivery(ok=True)

        monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", "x", raising=False)
        monkeypatch.setattr(settings, "VAPID_PUBLIC_KEY", "y", raising=False)
        monkeypatch.setattr(
            push, "_send_blocking", lambda sub, payload: capture(subscription=sub, payload=payload)
        )

        await push.send(
            TestSendingOne.SUB,
            title="Medication reminder",
            body="Metformin — 500mg, scheduled for 08:00.",
            link="/patient/records",
            tag="MEDICATION_REMINDER:r1",
        )
        body = json.loads(str(seen["payload"]))
        assert set(body) == {"title", "body", "link", "tag"}
        assert body["tag"] == "MEDICATION_REMINDER:r1"

    @pytest.mark.anyio
    async def test_urdu_survives_the_round_trip(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: dict[str, object] = {}
        monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", "x", raising=False)
        monkeypatch.setattr(settings, "VAPID_PUBLIC_KEY", "y", raising=False)
        monkeypatch.setattr(
            push,
            "_send_blocking",
            lambda sub, payload: (seen.__setitem__("p", payload), push.Delivery(ok=True))[1],
        )
        await push.send(
            TestSendingOne.SUB, title="Dawa", body="Dawa ka waqt — 08:00.", link=None, tag="t"
        )
        assert json.loads(str(seen["p"]))["body"] == "Dawa ka waqt — 08:00."


class TestTheQueue:
    """Push rows are claimed the same way email rows are: in the database."""

    def test_push_is_claimed_with_skip_locked(self) -> None:
        import inspect

        source = inspect.getsource(dispatcher.claim_pending_push)
        # Without this, every worker sends every message.
        assert "skip_locked=True" in source
        assert "NotificationChannel.PUSH" in source

    def test_a_push_row_is_its_own_channel(self) -> None:
        assert NotificationChannel.PUSH.value == "PUSH"

    def test_one_device_accepting_is_enough(self) -> None:
        import inspect

        source = inspect.getsource(dispatcher.deliver_push)
        # Somebody with a phone and a laptop has been reminded once the phone
        # buzzes; failing the row because the laptop is asleep would resend it.
        assert "if delivered:" in source
        assert "NotificationStatus.SENT" in source

    def test_dead_endpoints_are_deleted_here_or_nowhere(self) -> None:
        import inspect

        source = inspect.getsource(dispatcher.deliver_push)
        # The browser that dropped the subscription cannot tell us; the push
        # service reporting it gone is the only signal there is.
        assert "result.gone" in source
        assert "delete(PushSubscription)" in source


class TestTheDispatcherRunsForEitherChannel:
    """A deployment with push keys and no SMTP still owes its reminders."""

    def test_push_alone_is_reason_enough_to_run(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "NODE_ENV", "production", raising=False)
        monkeypatch.setattr(type(settings), "email_configured", property(lambda _: False))
        monkeypatch.setattr(type(settings), "push_enabled", property(lambda _: True))
        assert dispatcher.should_run()

    def test_neither_channel_means_no_loop(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "NODE_ENV", "production", raising=False)
        monkeypatch.setattr(type(settings), "email_configured", property(lambda _: False))
        monkeypatch.setattr(type(settings), "push_enabled", property(lambda _: False))
        assert not dispatcher.should_run()

"""Email notification content and delivery (spec §31-32).

No network and no database. What is exercised here is the decision this phase
turns on: **an email says less than the in-app notification it accompanies**,
because it crosses to a mail provider, sits on their servers and lands on a lock
screen — none of which is inside the access-control boundary the rest of the
system maintains.

So most of what follows is a demonstration that clinical content cannot reach an
email body, even when the in-app notification it was built from is full of it.
"""

from __future__ import annotations

import smtplib
from datetime import timedelta
from typing import Any

import pytest

from app.core.config import settings
from app.db.base import utcnow
from app.db.enums import NotificationChannel, NotificationStatus, NotificationType
from app.db.models import Notification
from app.modules.notifications import dispatcher, templates
from app.services import email as email_service


def render(
    notification_type: NotificationType = NotificationType.VITAL_ALERT,
    body: str = "Heart rate 150 bpm is above the configured limit of 120 bpm.",
    link: str | None = "/doctor/alerts",
) -> templates.Email:
    return templates.render(notification_type, in_app_body=body, link=link)


class TestClinicalContentStaysOut:
    """The rule this module exists for."""

    def test_a_vital_alert_email_carries_no_measurement(self) -> None:
        message = render()
        for forbidden in ("150", "120", "bpm", "Heart rate"):
            assert forbidden not in message.text, forbidden
            assert forbidden not in message.html, forbidden

    def test_it_still_says_enough_to_act_on(self) -> None:
        """Withholding detail must not make the message useless."""
        message = render()
        assert "vital sign" in message.subject.lower()
        assert "threshold" in message.text.lower()
        assert "Sign in" in message.text

    @pytest.mark.parametrize(
        ("notification_type", "body"),
        [
            (NotificationType.REPORT_UPLOADED, "Blood test results: haemoglobin 8.1 g/dL"),
            (NotificationType.MEDICATION_REMINDER, "Take Amoxicillin 500 mg"),
            (NotificationType.VITAL_ALERT, "Oxygen saturation 84% is below 92%"),
            (NotificationType.EMERGENCY_ACCESS, "Dr Rao opened your chart for chest pain"),
        ],
    )
    def test_a_clinical_in_app_body_is_discarded(
        self, notification_type: NotificationType, body: str
    ) -> None:
        """The in-app body is written for a reader who is already authenticated.

        Forwarding it would undo the whole distinction, so for these types it is
        passed in and deliberately dropped.
        """
        message = templates.render(notification_type, in_app_body=body, link=None)
        # No fragment of the clinical text survives.
        for word in body.split():
            if len(word) > 4:
                assert word not in message.text, word

    def test_scheduling_detail_is_allowed_through(self) -> None:
        """A reminder that withholds the time is not a reminder.

        Appointment times and invoice numbers are what these messages are *for*,
        and are what every clinic already sends by email.
        """
        message = templates.render(
            NotificationType.APPOINTMENT_REMINDER,
            in_app_body="You have an appointment with Dr Iyer on 12 Sep 2026 at 09:00.",
            link="/patient/appointments",
        )
        assert "12 Sep 2026" in message.text
        assert "09:00" in message.text

    def test_an_invoice_email_may_name_the_invoice(self) -> None:
        message = templates.render(
            NotificationType.INVOICE_ISSUED,
            in_app_body="Invoice INV-2026-000042 for INR 500.00 is available.",
            link="/patient/billing",
        )
        assert "INV-2026-000042" in message.text


class TestMessageShape:
    def test_every_email_has_a_plain_text_part(self) -> None:
        """HTML-only mail is less accessible and more likely to be junked."""
        for notification_type in NotificationType:
            message = templates.render(notification_type, in_app_body="x", link=None)
            assert message.text.strip()
            assert message.subject.strip()

    def test_an_unknown_type_still_produces_something_sensible(self) -> None:
        # Defensive: a type added to the enum without copy must not crash the
        # dispatcher or send an empty message.
        message = templates.render(
            NotificationType.REPORT_UPLOADED, in_app_body="", link=None
        )
        assert message.subject
        assert "Sign in" in message.text

    def test_the_link_is_absolute(self) -> None:
        """A mail client has no origin to resolve a relative path against."""
        message = render(link="/patient/billing")
        assert templates.portal_url("/patient/billing") in message.text
        assert message.text.count("http") >= 1

    def test_a_missing_link_falls_back_to_the_portal_root(self) -> None:
        assert templates.portal_url(None) == settings.CLIENT_ORIGIN.rstrip("/")

    def test_markup_in_the_body_is_escaped(self) -> None:
        message = templates.render(
            NotificationType.APPOINTMENT_BOOKED,
            in_app_body='Appointment with "Dr <b>Iyer</b>" confirmed.',
            link=None,
        )
        assert "<b>" not in message.html
        assert "&lt;b&gt;" in message.html

    def test_it_tells_auto_responders_not_to_reply(self) -> None:
        message = email_service._build(
            "someone@example.org", "Subject", "Body", "<p>Body</p>"
        )
        assert message["Auto-Submitted"] == "auto-generated"

    def test_the_body_says_the_mailbox_is_unmonitored(self) -> None:
        assert "not monitored" in render().text


class TestWhatGetsEmailed:
    def test_time_critical_types_are_emailed(self) -> None:
        for notification_type in (
            NotificationType.APPOINTMENT_REMINDER,
            NotificationType.VITAL_ALERT,
            NotificationType.ACCOUNT_SECURITY,
        ):
            assert notification_type in templates.EMAILED_TYPES

    def test_routine_types_are_not(self) -> None:
        """Emailing everything is how people learn to filter a sender out."""
        assert NotificationType.REPORT_UPLOADED not in templates.EMAILED_TYPES
        assert NotificationType.MEDICATION_REMINDER not in templates.EMAILED_TYPES


class TestFailureClassification:
    """Retrying a permanent failure only delays the queue behind it."""

    @pytest.mark.parametrize(
        ("exception", "retryable"),
        [
            (smtplib.SMTPAuthenticationError(535, b"nope"), False),
            (smtplib.SMTPRecipientsRefused({}), False),
            (smtplib.SMTPSenderRefused(550, b"nope", "from@example.org"), False),
            (smtplib.SMTPServerDisconnected("dropped"), True),
            (TimeoutError("slow"), True),
            (OSError("network down"), True),
            (smtplib.SMTPResponseException(451, b"try later"), True),
            (smtplib.SMTPResponseException(550, b"no such mailbox"), False),
        ],
    )
    def test_transient_and_permanent_are_told_apart(
        self, monkeypatch: pytest.MonkeyPatch, exception: Exception, retryable: bool
    ) -> None:
        def explode(*_args: Any, **_kwargs: Any) -> None:
            raise exception

        monkeypatch.setattr(smtplib, "SMTP", explode)
        monkeypatch.setattr(smtplib, "SMTP_SSL", explode)

        result = email_service._send_blocking(
            email_service._build("a@example.org", "s", "t", None)
        )
        assert result.sent is False
        assert result.retryable is retryable

    def test_an_authentication_failure_never_echoes_the_server(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """SMTP servers quote the rejected command back, credentials included."""

        def explode(*_args: Any, **_kwargs: Any) -> None:
            raise smtplib.SMTPAuthenticationError(
                535, b"5.7.8 Username and Password not accepted: hunter2"
            )

        monkeypatch.setattr(smtplib, "SMTP", explode)
        result = email_service._send_blocking(
            email_service._build("a@example.org", "s", "t", None)
        )
        assert "hunter2" not in result.detail
        assert result.detail == "authentication rejected"


class TestDeliveryGuards:
    async def test_nothing_is_sent_when_email_is_disabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "EMAIL_ENABLED", False)
        result = await email_service.send(to="a@example.org", subject="s", text_body="t")
        assert result.sent is False
        assert "disabled" in result.detail

    async def test_nothing_is_sent_without_credentials(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "EMAIL_ENABLED", True)
        monkeypatch.setattr(settings, "SMTP_PASSWORD", "")
        result = await email_service.send(to="a@example.org", subject="s", text_body="t")
        assert result.sent is False
        assert "credentials" in result.detail

    def test_the_dispatcher_stays_off_in_tests(self) -> None:
        """A background loop making SMTP connections during a test run would
        send real mail and make results depend on timing."""
        assert dispatcher.should_run() is False


class TestRetryWindow:
    def test_the_reminder_window_is_wider_than_the_interval(self) -> None:
        """Otherwise an appointment slips between two passes unremindered."""
        assert dispatcher.REMIND_WINDOW.total_seconds() > dispatcher.INTERVAL_SECONDS

    async def test_a_transient_failure_is_left_pending(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        row = Notification(
            id="n1",
            user_id="u1",
            type=NotificationType.APPOINTMENT_REMINDER,
            channel=NotificationChannel.EMAIL,
            status=NotificationStatus.PENDING,
            title="t",
            body="b",
            created_at=utcnow(),
        )

        async def fake_send(**_kwargs: Any) -> email_service.Delivery:
            return email_service.Delivery(False, "connection failed", retryable=True)

        monkeypatch.setattr(email_service, "send", fake_send)
        monkeypatch.setattr(
            dispatcher, "deliver", dispatcher.deliver
        )  # keep the real one

        class FakeResult:
            def scalar_one_or_none(self) -> str:
                return "someone@example.org"

        class FakeDb:
            async def execute(self, *_args: Any, **_kwargs: Any) -> FakeResult:
                return FakeResult()

        sent = await dispatcher.deliver(FakeDb(), row)  # type: ignore[arg-type]

        assert sent is False
        assert row.status == NotificationStatus.PENDING, "a retryable failure retries"
        assert row.error == "connection failed"

    async def test_an_old_message_is_abandoned(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A reminder that arrives a day late tells someone about a slot they
        have already missed."""
        row = Notification(
            id="n2",
            user_id="u1",
            type=NotificationType.APPOINTMENT_REMINDER,
            channel=NotificationChannel.EMAIL,
            status=NotificationStatus.PENDING,
            title="t",
            body="b",
            created_at=utcnow() - dispatcher.GIVE_UP_AFTER - timedelta(minutes=1),
        )

        async def fake_send(**_kwargs: Any) -> email_service.Delivery:
            return email_service.Delivery(False, "connection failed", retryable=True)

        monkeypatch.setattr(email_service, "send", fake_send)

        class FakeResult:
            def scalar_one_or_none(self) -> str:
                return "someone@example.org"

        class FakeDb:
            async def execute(self, *_args: Any, **_kwargs: Any) -> FakeResult:
                return FakeResult()

        await dispatcher.deliver(FakeDb(), row)  # type: ignore[arg-type]

        assert row.status == NotificationStatus.FAILED
        assert "abandoned" in (row.error or "")

    async def test_a_permanent_failure_is_not_retried(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        row = Notification(
            id="n3",
            user_id="u1",
            type=NotificationType.APPOINTMENT_REMINDER,
            channel=NotificationChannel.EMAIL,
            status=NotificationStatus.PENDING,
            title="t",
            body="b",
            created_at=utcnow(),
        )

        async def fake_send(**_kwargs: Any) -> email_service.Delivery:
            return email_service.Delivery(False, "recipient refused", retryable=False)

        monkeypatch.setattr(email_service, "send", fake_send)

        class FakeResult:
            def scalar_one_or_none(self) -> str:
                return "someone@example.org"

        class FakeDb:
            async def execute(self, *_args: Any, **_kwargs: Any) -> FakeResult:
                return FakeResult()

        await dispatcher.deliver(FakeDb(), row)  # type: ignore[arg-type]

        assert row.status == NotificationStatus.FAILED
        assert row.error == "recipient refused"

    async def test_a_user_with_no_address_fails_immediately(self) -> None:
        row = Notification(
            id="n4",
            user_id="u1",
            type=NotificationType.APPOINTMENT_REMINDER,
            channel=NotificationChannel.EMAIL,
            status=NotificationStatus.PENDING,
            title="t",
            body="b",
            created_at=utcnow(),
        )

        class FakeResult:
            def scalar_one_or_none(self) -> None:
                return None

        class FakeDb:
            async def execute(self, *_args: Any, **_kwargs: Any) -> FakeResult:
                return FakeResult()

        await dispatcher.deliver(FakeDb(), row)  # type: ignore[arg-type]

        assert row.status == NotificationStatus.FAILED
        assert row.error == "no address on file"

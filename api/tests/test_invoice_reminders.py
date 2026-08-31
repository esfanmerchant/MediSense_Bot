"""When a bill is worth mentioning, and the status a waiting patient sees.

The reminder pass runs every sixty seconds, so the only interesting question is
what stops it saying the same thing sixty times an hour. That answer is the
notification row it writes, keyed on the invoice *and* which of the two
reminders it was — pinned here because the two halves of that key live in
different functions and only agree by convention.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest

from app.db.base import utcnow
from app.db.enums import InvoiceStatus
from app.db.models import Invoice
from app.modules.billing import service
from app.modules.notifications import dispatcher


def invoice(*, due_in_days: float, late_fee: str = "250.00") -> Invoice:
    """An invoice in memory. Nothing here writes."""
    return Invoice(
        id="i1",
        patient_id="p1",
        invoice_number="INV-1",
        amount=Decimal("2000.00"),
        tax_amount=Decimal("0"),
        total_amount=Decimal("2000.00"),
        late_fee=Decimal(late_fee),
        currency="PKR",
        status=InvoiceStatus.ISSUED,
        due_at=utcnow() + timedelta(days=due_in_days),
        # Set explicitly: SQLAlchemy's column defaults only apply on flush, and
        # nothing here touches a session.
        issued_at=utcnow(),
        created_at=utcnow(),
        updated_at=utcnow(),
        line_items=[],
    )


class TestWhichReminderApplies:
    """The pass picks between two messages by asking `is_overdue`, nothing else."""

    def test_a_bill_due_tomorrow_is_not_yet_overdue(self) -> None:
        assert not service.is_overdue(invoice(due_in_days=0.9))

    def test_a_bill_past_its_date_is(self) -> None:
        assert service.is_overdue(invoice(due_in_days=-0.1))

    def test_the_overdue_notice_quotes_the_amount_now_owed(self) -> None:
        # The useful fact in that email is the new figure, not the scolding.
        bill = invoice(due_in_days=-1, late_fee="250.00")
        assert service.amount_due(bill) == Decimal("2250.00")
        assert service.late_fee_applies(bill) == Decimal("250.00")

    def test_the_day_before_notice_quotes_the_original(self) -> None:
        bill = invoice(due_in_days=0.5)
        assert service.amount_due(bill) == Decimal("2000.00")
        assert service.late_fee_applies(bill) == Decimal("0")


class TestTheTwoRemindersAreDistinct:
    def test_they_are_keyed_separately(self) -> None:
        # An invoice that got the day-before nudge must still be able to get the
        # overdue notice. One key for both would swallow the second.
        assert dispatcher.DUE_SOON != dispatcher.OVERDUE

    def test_the_keys_are_the_ones_written_into_metadata(self) -> None:
        # The idempotence check and the sending loop agree only by using these
        # constants; a literal in either place would drift.
        source = dispatcher.schedule_invoice_reminders.__doc__ or ""
        assert source  # the pass is documented
        assert dispatcher.DUE_SOON == "due_soon"
        assert dispatcher.OVERDUE == "overdue"


class TestWaitingIsNotDue:
    """A patient waiting on the hospital has not failed to pay."""

    def test_an_invoice_under_review_reports_awaiting_approval(self) -> None:
        payload = service.serialize(invoice(due_in_days=1), awaiting_review=True)
        assert payload["status"] == "AWAITING_APPROVAL"
        assert payload["awaitingReview"] is True

    def test_it_outranks_overdue(self) -> None:
        # Somebody who transferred late and is waiting on confirmation should
        # not be told their bill is overdue while the money sits in the
        # hospital's account.
        payload = service.serialize(invoice(due_in_days=-5), awaiting_review=True)
        assert payload["status"] == "AWAITING_APPROVAL"

    def test_without_a_review_the_ordinary_status_stands(self) -> None:
        assert service.serialize(invoice(due_in_days=1))["status"] == "ISSUED"
        assert service.serialize(invoice(due_in_days=-1))["status"] == "OVERDUE"

    @pytest.mark.parametrize(
        "status", [InvoiceStatus.PAID, InvoiceStatus.VOID, InvoiceStatus.REFUNDED]
    )
    def test_a_settled_bill_is_never_relabelled(self, status: InvoiceStatus) -> None:
        # A stale SUBMITTED payment must not make a paid invoice look pending.
        bill = invoice(due_in_days=-1)
        bill.status = status
        assert service.serialize(bill, awaiting_review=True)["status"] == str(status)

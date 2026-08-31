"""Reading a payment screenshot, and where it is allowed to disagree.

Every assertion here is about a flag a reviewer will see. That makes the failure
mode specific: a flag raised on a genuine payment is not a small bug, it is the
thing that teaches a reviewer to click past flags, and after that the real
mismatch goes through with everything else.

So the rules being pinned down are as much about *silence* as about warnings.
Unknown is not a mismatch. A reference typed with spaces is not a different
reference. A receipt whose date could not be read is not stale.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.db.enums import PaymentMethod, PaymentStatus
from app.db.models import Payment
from app.modules.billing import service
from app.services import receipt_ocr


class TestNormalizingAReference:
    """A bank reference is a number that people and receipts punctuate freely."""

    @pytest.mark.parametrize(
        "typed",
        ["123456789", "123 456 789", "123-456-789", "TID: 123456789", " 123456789 "],
    )
    def test_punctuation_and_labels_do_not_change_it(self, typed: str) -> None:
        assert receipt_ocr.normalize_reference(typed) == "123456789"

    def test_a_genuinely_different_number_stays_different(self) -> None:
        assert receipt_ocr.normalize_reference("123456789") != receipt_ocr.normalize_reference(
            "123456798"
        )

    def test_nothing_normalises_to_nothing(self) -> None:
        # Empty must not compare equal to a real reference further down.
        assert receipt_ocr.normalize_reference(None) == ""
        assert receipt_ocr.normalize_reference("no digits here") == ""


class TestStaleness:
    def test_a_recent_transfer_is_fine(self) -> None:
        now = datetime(2026, 9, 1, 12, 0)
        assert not receipt_ocr.is_stale(now - timedelta(days=2), now=now)

    def test_the_boundary_is_not_stale(self) -> None:
        """Exactly twelve days old passes.

        Somebody transferring on the first and uploading on the twelfth has done
        nothing wrong, and a boundary that catches them is a boundary set one
        day too tight.
        """
        now = datetime(2026, 9, 1, 12, 0)
        assert not receipt_ocr.is_stale(now - receipt_ocr.MAX_RECEIPT_AGE, now=now)

    def test_older_than_that_is_stale(self) -> None:
        now = datetime(2026, 9, 1, 12, 0)
        assert receipt_ocr.is_stale(now - timedelta(days=13), now=now)

    def test_a_date_that_could_not_be_read_is_not_stale(self) -> None:
        """Unknown is unknown.

        Answering "too old" to a question nobody could read would put a warning
        on the reviewer's screen with nothing behind it.
        """
        assert not receipt_ocr.is_stale(None)


class TestParsingWhatTheModelReturned:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("2500", Decimal("2500")),
            ("2,500.00", Decimal("2500.00")),
            ("Rs. 2500", Decimal("2500")),
            ("PKR 2500.50", Decimal("2500.50")),
        ],
    )
    def test_an_amount_survives_how_a_receipt_prints_it(
        self, raw: str, expected: Decimal
    ) -> None:
        assert receipt_ocr._decimal(raw) == expected

    @pytest.mark.parametrize("raw", [None, "", "not a number", "-500", "0", "1.2.3"])
    def test_nonsense_is_no_amount_rather_than_a_wrong_one(self, raw: object) -> None:
        assert receipt_ocr._decimal(raw) is None

    def test_a_timestamp_is_read(self) -> None:
        assert receipt_ocr._timestamp("2026-08-30T14:05:00") == datetime(2026, 8, 30, 14, 5)

    def test_a_bare_date_is_read(self) -> None:
        assert receipt_ocr._timestamp("2026-08-30") == datetime(2026, 8, 30, 0, 0)

    def test_a_receipt_dated_in_the_future_is_discarded(self) -> None:
        """Almost always a day/month swap on a printed date.

        Carrying it forward would make the staleness check answer "fresh" about
        a screenshot nobody has checked.
        """
        assert receipt_ocr._timestamp("2099-01-01T00:00:00") is None

    @pytest.mark.parametrize("raw", [None, "", "last Tuesday", "30/08/26"])
    def test_an_unparseable_date_is_no_date(self, raw: object) -> None:
        assert receipt_ocr._timestamp(raw) is None


def _payment(**overrides: object) -> Payment:
    payment = Payment(
        id="pay_1",
        invoice_id="inv_1",
        amount=Decimal("2500.00"),
        currency="PKR",
        method=PaymentMethod.NAYAPAY,
        status=PaymentStatus.SUBMITTED,
        reference="123456789",
        created_at=datetime(2026, 9, 1, 12, 0),
        receipt_read_at=datetime(2026, 9, 1, 12, 0),
        receipt_reference="123456789",
        receipt_amount=Decimal("2500.00"),
        receipt_paid_at=datetime(2026, 9, 1, 11, 0),
        receipt_looks_valid=True,
    )
    for key, value in overrides.items():
        setattr(payment, key, value)
    return payment


class TestConcerns:
    def test_a_payment_that_agrees_with_itself_raises_nothing(self) -> None:
        assert service.receipt_reading(_payment())["concerns"] == []

    def test_a_screenshot_that_was_never_read_has_no_reading(self) -> None:
        """Not read is not the same as read and found clean.

        A null here is what lets the reviewer's screen stay silent rather than
        showing an empty panel implying the picture was checked.
        """
        assert service.receipt_reading(_payment(receipt_read_at=None)) is None

    def test_a_different_reference_is_flagged(self) -> None:
        reading = service.receipt_reading(_payment(receipt_reference="987654321"))
        assert "REFERENCE_MISMATCH" in reading["concerns"]

    def test_the_same_reference_punctuated_differently_is_not(self) -> None:
        """The form strips everything but digits; a receipt does not.

        Flagging this would flag almost every payment, and a flag on almost
        every payment is not a flag.
        """
        reading = service.receipt_reading(_payment(receipt_reference="TID 123-456-789"))
        assert reading["concerns"] == []

    def test_an_unreadable_reference_is_not_a_mismatch(self) -> None:
        reading = service.receipt_reading(_payment(receipt_reference=None))
        assert "REFERENCE_MISMATCH" not in reading["concerns"]

    def test_a_short_amount_is_flagged(self) -> None:
        reading = service.receipt_reading(_payment(receipt_amount=Decimal("250.00")))
        assert "AMOUNT_MISMATCH" in reading["concerns"]

    def test_an_unreadable_amount_is_not_a_mismatch(self) -> None:
        reading = service.receipt_reading(_payment(receipt_amount=None))
        assert "AMOUNT_MISMATCH" not in reading["concerns"]

    def test_an_old_receipt_is_flagged_against_when_it_was_submitted(self) -> None:
        """Against submission, not against now.

        A payment confirmed weeks later must not grow a new warning while it sits
        in the ledger — the question is whether the receipt was old *when it was
        offered as evidence*.
        """
        reading = service.receipt_reading(
            _payment(receipt_paid_at=datetime(2026, 8, 1, 9, 0))
        )
        assert "STALE_RECEIPT" in reading["concerns"]

    def test_an_image_that_is_not_a_receipt_is_flagged(self) -> None:
        reading = service.receipt_reading(_payment(receipt_looks_valid=False))
        assert "NOT_A_RECEIPT" in reading["concerns"]

    def test_the_reading_never_decides_anything(self) -> None:
        """There is no verdict field, and there must not be.

        Every concern is a question for the reviewer. The moment this payload
        carries an "approved" or "safe" the queue starts being read as a
        recommendation, and a model that read "Rs. 2,500" off an image has not
        watched money arrive in anybody's account.
        """
        reading = service.receipt_reading(_payment())
        assert set(reading) == {
            "reference",
            "amount",
            "paidAt",
            "sender",
            "receiver",
            "receiverAccount",
            "looksLikeAReceipt",
            "readAt",
            "concerns",
            "maxAgeDays",
        }

    def test_the_age_limit_travels_with_the_reading(self) -> None:
        # So the reviewer's screen can say "older than 12 days" without a copy
        # of the number drifting away from this one.
        assert service.receipt_reading(_payment())["maxAgeDays"] == 12

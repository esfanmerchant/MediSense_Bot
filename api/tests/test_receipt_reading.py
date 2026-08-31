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
        payee_account="03443003108",
        created_at=datetime(2026, 9, 1, 12, 0),
        receipt_read_at=datetime(2026, 9, 1, 12, 0),
        receipt_reference="123456789",
        receipt_amount=Decimal("2500.00"),
        receipt_paid_at=datetime(2026, 9, 1, 11, 0),
        receipt_sender_account="03001234567",
        receipt_receiver_account="03443003108",
        receipt_wallet="EasyPaisa",
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
            "senderAccount",
            "receiver",
            "receiverAccount",
            "wallet",
            "looksLikeAReceipt",
            "readAt",
            "concerns",
            "maxAgeDays",
        }

    def test_the_age_limit_travels_with_the_reading(self) -> None:
        # So the reviewer's screen can say "older than 12 days" without a copy
        # of the number drifting away from this one.
        assert service.receipt_reading(_payment())["maxAgeDays"] == 12


HOSPITAL = ("03712044479", "03443003108")


class TestAccountNumbers:
    """The same account, spelled the way three different banks spell it."""

    @pytest.mark.parametrize(
        "written",
        ["03443003108", "+92 344 3003108", "0092-344-3003108", "92 344 300 3108", "3443003108"],
    )
    def test_one_account_in_many_spellings_is_one_account(self, written: str) -> None:
        assert receipt_ocr.accounts_match("03443003108", written)

    def test_a_different_number_is_a_different_account(self) -> None:
        # The row that prompted all of this: a receipt naming an account that is
        # not the hospital's, shown in the ledger as though it were.
        assert not receipt_ocr.accounts_match("03443003108", "03441729906")

    def test_the_two_hospital_wallets_are_not_each_other(self) -> None:
        assert not receipt_ocr.accounts_match("03443003108", "03712044479")

    def test_an_unknown_account_matches_nothing(self) -> None:
        """Including another unknown.

        Two blanks comparing equal would turn the destination check into one
        that passes precisely when it could not run.
        """
        assert not receipt_ocr.accounts_match(None, "03443003108")
        assert not receipt_ocr.accounts_match(None, None)
        assert not receipt_ocr.accounts_match("", "")


class TestWhereTheMoneyWent:
    def test_paying_the_right_account_raises_nothing(self) -> None:
        reading = service.receipt_reading(_payment(), platform_accounts=HOSPITAL)
        assert reading["concerns"] == []

    def test_the_destination_is_reported(self) -> None:
        # Both ends, so the ledger can say from whom and to where.
        reading = service.receipt_reading(_payment(), platform_accounts=HOSPITAL)
        assert reading["senderAccount"] == "03001234567"
        assert reading["receiverAccount"] == "03443003108"

    def test_money_sent_to_some_other_account_is_flagged(self) -> None:
        reading = service.receipt_reading(
            _payment(receipt_receiver_account="03441729906"), platform_accounts=HOSPITAL
        )
        assert "WRONG_DESTINATION" in reading["concerns"]

    def test_paying_the_other_hospital_wallet_is_still_wrong(self) -> None:
        """The check is against the account this patient was shown.

        Both numbers belong to the hospital, but the payment was raised against
        one of them, and a transfer into the other is money the reviewer will
        not find where they are looking for it.
        """
        reading = service.receipt_reading(
            _payment(receipt_receiver_account="03712044479"), platform_accounts=HOSPITAL
        )
        assert "WRONG_DESTINATION" in reading["concerns"]

    def test_a_destination_nobody_could_read_is_not_a_wrong_destination(self) -> None:
        reading = service.receipt_reading(
            _payment(receipt_receiver_account=None), platform_accounts=HOSPITAL
        )
        assert "WRONG_DESTINATION" not in reading["concerns"]

    def test_the_snapshot_is_what_is_compared_against(self) -> None:
        """Not today's settings.

        An administrator moving the clinic to a new wallet must not retroactively
        flag every transfer made into the old one, which was correct when it was
        made and is recorded on the payment for exactly this reason.
        """
        old_wallet = _payment(payee_account="03009999999", receipt_receiver_account="03009999999")
        reading = service.receipt_reading(old_wallet, platform_accounts=HOSPITAL)
        assert "WRONG_DESTINATION" not in reading["concerns"]

    def test_a_receipt_sent_from_a_hospital_account_is_flagged(self) -> None:
        """That is money leaving, offered as proof of money arriving.

        A payout screenshot — or a receipt read the wrong way round — and either
        way not evidence that this bill was paid.
        """
        reading = service.receipt_reading(
            _payment(receipt_sender_account="03712044479"), platform_accounts=HOSPITAL
        )
        assert "PAID_FROM_A_HOSPITAL_ACCOUNT" in reading["concerns"]

    def test_an_ordinary_payer_is_not(self) -> None:
        reading = service.receipt_reading(
            _payment(receipt_sender_account="03001234567"), platform_accounts=HOSPITAL
        )
        assert "PAID_FROM_A_HOSPITAL_ACCOUNT" not in reading["concerns"]


class TestRefusingASubmission:
    """The one check that stops a patient rather than flagging them.

    Everything else the reading finds is a question for a reviewer, because a
    model can be wrong about a blurry screenshot and somebody who really has
    paid must not be locked out by it. The transaction ID is different: it is
    the one field the patient also typed, so a difference is not the model
    disagreeing with a photograph — it is the screenshot disagreeing with the
    person about the same number.

    Which makes the shape of this condition the important part. Every test below
    that asserts `False` is a patient who would otherwise have been refused.
    """

    def test_a_different_number_conflicts(self) -> None:
        assert receipt_ocr.reference_conflict("123456789", "987654321")

    def test_one_digit_out_conflicts(self) -> None:
        # The realistic case: a mistyped receipt, not a forged one.
        assert receipt_ocr.reference_conflict("83762408296749", "83762408296748")

    @pytest.mark.parametrize(
        "on_receipt",
        ["123456789", "123 456 789", "TID: 123456789", "Trx ID 123-456-789"],
    )
    def test_the_same_number_written_differently_does_not(self, on_receipt: str) -> None:
        """Receipts label and space their references; the form strips both.

        Refusing on this would refuse nearly every honest submission, which is
        the worst possible failure for a check that blocks.
        """
        assert not receipt_ocr.reference_conflict("123456789", on_receipt)

    def test_an_unreadable_receipt_does_not_block_anybody(self) -> None:
        """The provider can be down, out of quota, or beaten by a blurry photo.

        None of that is evidence against the patient, and a check that turns "I
        could not tell" into "no" stops every payment in the country the day the
        provider has an outage.
        """
        assert not receipt_ocr.reference_conflict("123456789", None)
        assert not receipt_ocr.reference_conflict("123456789", "")

    def test_a_reference_with_no_digits_at_all_does_not_block(self) -> None:
        # Whatever the model returned, it was not a transaction ID.
        assert not receipt_ocr.reference_conflict("123456789", "see attached")

    def test_the_same_rule_is_what_the_reviewer_sees(self) -> None:
        """Submission and the review panel apply one function, not two.

        Two copies of this condition would drift, and the way they drift is that
        one starts refusing payments the other lets through.
        """
        reading = service.receipt_reading(_payment(receipt_reference="987654321"))
        assert "REFERENCE_MISMATCH" in reading["concerns"]
        assert receipt_ocr.reference_conflict("123456789", "987654321")


class TestTheServiceOnTheReceipt:
    def test_the_reading_carries_what_the_screenshot_calls_itself(self) -> None:
        """Not what the patient picked from a list of two.

        `method` records the option they were offered; a receipt can be from
        JazzCash or a bank app, which that list has no name for, and the ledger
        printing EASYPAISA over a JazzCash screenshot would be a confident
        answer to a question nobody asked it.
        """
        reading = service.receipt_reading(_payment(receipt_wallet="JazzCash"))
        assert reading["wallet"] == "JazzCash"

    def test_a_service_nobody_could_read_is_absent_rather_than_guessed(self) -> None:
        reading = service.receipt_reading(_payment(receipt_wallet=None))
        assert reading["wallet"] is None

"""What a bill comes to, and what a late bill comes to.

Pure arithmetic and one signature, so none of this needs a database. Money is
the thing in this system where a quiet rounding error is invisible until an
audit, so the cases here are the ones that would hide: tax charged on the wrong
base, a fee added twice, a late charge that compounds, and a forged callback.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest

from app.db.base import utcnow
from app.db.enums import FeeMode, InvoiceStatus
from app.db.models import Invoice
from app.modules.billing import service


def invoice(
    *,
    total: str = "1000.00",
    late_fee: str = "0.00",
    status: InvoiceStatus = InvoiceStatus.ISSUED,
    due_in_days: float | None = 3,
) -> Invoice:
    """An invoice in memory. Never added to a session — nothing here writes."""
    return Invoice(
        id="i1",
        patient_id="p1",
        invoice_number="INV-1",
        amount=Decimal(total),
        tax_amount=Decimal("0"),
        total_amount=Decimal(total),
        late_fee=Decimal(late_fee),
        status=status,
        due_at=None if due_in_days is None else utcnow() + timedelta(days=due_in_days),
    )


class TestTotals:
    def test_no_rates_configured_bills_the_fee_and_nothing_else(self) -> None:
        charges = service.totals(
            Decimal("2000"), platform_fee=Decimal("0"), tax_percent=Decimal("0")
        )
        assert charges.total == Decimal("2000.00")
        assert charges.tax == Decimal("0.00")

    def test_tax_is_charged_on_the_platform_fee_as_well_as_the_consultation(self) -> None:
        # The failure this catches is taxing only the consultation: it looks
        # right, is out by the tax on the fee, and nobody notices for months.
        charges = service.totals(
            Decimal("2000"), platform_fee=Decimal("500"), tax_percent=Decimal("10")
        )
        assert charges.subtotal == Decimal("2000.00")
        assert charges.platform_fee == Decimal("500.00")
        assert charges.tax == Decimal("250.00")  # 10% of 2500, not of 2000
        assert charges.total == Decimal("2750.00")

    def test_the_parts_always_sum_to_the_total(self) -> None:
        charges = service.totals(
            Decimal("1333.33"), platform_fee=Decimal("66.67"), tax_percent=Decimal("17")
        )
        assert charges.subtotal + charges.platform_fee + charges.tax == charges.total

    def test_money_keeps_two_places(self) -> None:
        charges = service.totals(
            Decimal("999.999"), platform_fee=Decimal("0.005"), tax_percent=Decimal("7.5")
        )
        for amount in (charges.subtotal, charges.platform_fee, charges.tax, charges.total):
            assert amount.as_tuple().exponent == -2


class TestPaymentTerms:
    def test_a_bill_is_due_in_three_days_not_a_month(self) -> None:
        # The number itself, because it is the requirement.
        assert service.PAYMENT_TERMS_DAYS == 3


class TestLateFee:
    def test_nothing_extra_before_the_due_date(self) -> None:
        bill = invoice(late_fee="200", due_in_days=3)
        assert service.late_fee_applies(bill) == Decimal("0")
        assert service.amount_due(bill) == Decimal("1000.00")

    def test_the_fee_lands_once_the_date_has_passed(self) -> None:
        bill = invoice(late_fee="200", due_in_days=-1)
        assert service.is_overdue(bill)
        assert service.late_fee_applies(bill) == Decimal("200")
        assert service.amount_due(bill) == Decimal("1200.00")

    def test_the_invoice_total_itself_is_never_rewritten(self) -> None:
        # A patient who was sent a bill for 1000 must still see 1000 on it. The
        # late charge is an addition shown beside it, not a silent edit to a
        # document they already have.
        bill = invoice(total="1000.00", late_fee="200", due_in_days=-5)
        service.amount_due(bill)
        assert bill.total_amount == Decimal("1000.00")

    @pytest.mark.parametrize("days_late", [1, 30, 365])
    def test_it_is_charged_once_however_late_the_bill_is(self, days_late: int) -> None:
        # Not per day. A daily charge compounds on somebody too ill to deal with
        # it, which is the circumstance this system exists inside.
        bill = invoice(late_fee="200", due_in_days=-days_late)
        assert service.late_fee_applies(bill) == Decimal("200")

    def test_a_bill_with_no_late_fee_set_never_grows(self) -> None:
        bill = invoice(late_fee="0", due_in_days=-10)
        assert service.amount_due(bill) == Decimal("1000.00")

    @pytest.mark.parametrize(
        "status", [InvoiceStatus.PAID, InvoiceStatus.VOID, InvoiceStatus.REFUNDED]
    )
    def test_a_settled_bill_owes_nothing_even_long_past_its_date(
        self, status: InvoiceStatus
    ) -> None:
        bill = invoice(late_fee="200", due_in_days=-90, status=status)
        assert service.amount_due(bill) == Decimal("0")

    def test_an_invoice_with_no_due_date_is_never_overdue(self) -> None:
        bill = invoice(late_fee="200", due_in_days=None)
        assert not service.is_overdue(bill)
        assert service.amount_due(bill) == Decimal("1000.00")


class TestFeeModes:
    """A fee is either a flat amount or a share, and the same field holds both."""

    def test_a_flat_platform_fee_ignores_the_consultation_price(self) -> None:
        cheap = service.totals(
            Decimal("500"),
            platform_fee=Decimal("200"),
            platform_fee_mode=FeeMode.FIXED,
            tax_percent=Decimal("0"),
        )
        dear = service.totals(
            Decimal("50000"),
            platform_fee=Decimal("200"),
            platform_fee_mode=FeeMode.FIXED,
            tax_percent=Decimal("0"),
        )
        assert cheap.platform_fee == dear.platform_fee == Decimal("200.00")

    def test_a_percentage_platform_fee_scales_with_it(self) -> None:
        charges = service.totals(
            Decimal("2000"),
            platform_fee=Decimal("2"),
            platform_fee_mode=FeeMode.PERCENT,
            tax_percent=Decimal("0"),
        )
        assert charges.platform_fee == Decimal("40.00")
        assert charges.total == Decimal("2040.00")

    def test_a_percentage_platform_fee_is_a_share_of_the_consultation_not_itself(
        self,
    ) -> None:
        # The alternative is circular: a fee that is a percentage of a total
        # that includes the fee.
        charges = service.totals(
            Decimal("1000"),
            platform_fee=Decimal("10"),
            platform_fee_mode=FeeMode.PERCENT,
            tax_percent=Decimal("0"),
        )
        assert charges.platform_fee == Decimal("100.00")  # not 111.11

    def test_a_flat_tax_is_added_whole(self) -> None:
        charges = service.totals(
            Decimal("1000"),
            platform_fee=Decimal("0"),
            tax_percent=Decimal("50"),
            tax_mode=FeeMode.FIXED,
        )
        assert charges.tax == Decimal("50.00")
        assert charges.total == Decimal("1050.00")

    def test_a_flat_tax_still_reports_the_rate_it_worked_out_to(self) -> None:
        # An invoice shows a percentage beside its tax. A flat charge has to
        # report the rate it amounted to, or an old bill cannot explain itself.
        charges = service.totals(
            Decimal("1000"),
            platform_fee=Decimal("0"),
            tax_percent=Decimal("150"),
            tax_mode=FeeMode.FIXED,
        )
        assert charges.tax_percent == Decimal("15.00")

    def test_a_percentage_tax_reports_the_rate_it_was_given(self) -> None:
        charges = service.totals(
            Decimal("2000"),
            platform_fee=Decimal("500"),
            tax_percent=Decimal("15"),
            tax_mode=FeeMode.PERCENT,
        )
        assert charges.tax == Decimal("375.00")
        assert charges.tax_percent == Decimal("15.00")

    def test_a_free_consultation_reports_no_rate_rather_than_dividing_by_zero(
        self,
    ) -> None:
        charges = service.totals(
            Decimal("0"), platform_fee=Decimal("0"), tax_percent=Decimal("15")
        )
        assert charges.total == Decimal("0.00")
        assert charges.tax_percent == Decimal("0.00")

    def test_both_modes_together(self) -> None:
        # 2% of 2000 = 40; 15% of 2040 = 306.
        charges = service.totals(
            Decimal("2000"),
            platform_fee=Decimal("2"),
            platform_fee_mode=FeeMode.PERCENT,
            tax_percent=Decimal("15"),
            tax_mode=FeeMode.PERCENT,
        )
        assert charges.platform_fee == Decimal("40.00")
        assert charges.tax == Decimal("306.00")
        assert charges.total == Decimal("2346.00")


class TestApplyFee:
    def test_percent_of_a_base(self) -> None:
        assert service.apply_fee(
            Decimal("1200"), value=Decimal("15"), mode=FeeMode.PERCENT
        ) == Decimal("180.00")

    def test_fixed_ignores_the_base_entirely(self) -> None:
        assert service.apply_fee(
            Decimal("1200"), value=Decimal("15"), mode=FeeMode.FIXED
        ) == Decimal("15.00")

    def test_a_percentage_late_charge_is_a_share_of_the_whole_bill(self) -> None:
        # What "10% late fee" means to somebody who owes 2346.
        assert service.apply_fee(
            Decimal("2346.00"), value=Decimal("10"), mode=FeeMode.PERCENT
        ) == Decimal("234.60")

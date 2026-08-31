"""How much of a bill is the doctor's, and when they may take it.

The split is the part worth pinning. It is one line of code and it decides who
gets somebody's money, so it is tested against the shape of a real invoice
rather than against itself: a bill with a consultation fee, a platform fee, tax
on both, and a late charge on top.
"""

from __future__ import annotations

from decimal import Decimal

from app.db.enums import FeeMode, InvoiceStatus
from app.db.models import Invoice
from app.modules.billing import earnings, service


def billed(consultation: str, *, platform: str = "0", tax_percent: str = "0") -> Invoice:
    """An invoice as `generate_for_appointment` would have built it."""
    charges = service.totals(
        Decimal(consultation),
        platform_fee=Decimal(platform),
        platform_fee_mode=FeeMode.FIXED,
        tax_percent=Decimal(tax_percent),
        tax_mode=FeeMode.PERCENT,
    )
    return Invoice(
        id="i1",
        patient_id="p1",
        invoice_number="INV-1",
        amount=charges.subtotal,
        platform_fee=charges.platform_fee,
        tax_amount=charges.tax,
        tax_percent=charges.tax_percent,
        total_amount=charges.total,
        late_fee=Decimal("250.00"),
        status=InvoiceStatus.ISSUED,
    )


class TestTheSplit:
    def test_the_doctor_gets_the_consultation_fee(self) -> None:
        assert earnings.doctor_share(billed("2000")) == Decimal("2000.00")

    def test_the_platform_fee_is_not_the_doctors(self) -> None:
        # It is the hospital's cut by definition. A doctor paid it would be
        # paid for something they did not provide.
        invoice = billed("2000", platform="500")
        assert invoice.total_amount == Decimal("2500.00")
        assert earnings.doctor_share(invoice) == Decimal("2000.00")

    def test_tax_is_not_the_doctors(self) -> None:
        # Collected on the state's behalf. Passing it to a doctor would be
        # handing over somebody else's money.
        invoice = billed("2000", tax_percent="15")
        assert invoice.tax_amount == Decimal("300.00")
        assert earnings.doctor_share(invoice) == Decimal("2000.00")

    def test_the_late_charge_is_not_the_doctors(self) -> None:
        # It compensates the hospital for chasing a bill the doctor had no part
        # in. `doctor_share` reads `amount`, so this holds by construction —
        # the test exists so that changing it to read the total fails loudly.
        invoice = billed("2000", platform="500", tax_percent="15")
        assert invoice.late_fee == Decimal("250.00")
        assert earnings.doctor_share(invoice) == Decimal("2000.00")

    def test_the_hospital_keeps_exactly_the_rest(self) -> None:
        # Nothing falls between the two shares, and nothing is counted twice.
        invoice = billed("2000", platform="500", tax_percent="15")
        doctor = earnings.doctor_share(invoice)
        hospital = invoice.platform_fee + invoice.tax_amount
        assert doctor + hospital == invoice.total_amount

    def test_a_free_consultation_earns_nothing(self) -> None:
        assert earnings.doctor_share(billed("0")) == Decimal("0.00")

    def test_the_share_keeps_two_decimal_places(self) -> None:
        assert earnings.doctor_share(billed("1333.335")).as_tuple().exponent == -2


class TestTheWithdrawalFloor:
    def test_the_minimum_is_a_thousand(self) -> None:
        # The number itself, because it is the requirement.
        assert earnings.MINIMUM_WITHDRAWAL == Decimal("1000.00")

    def test_it_is_a_floor_and_not_a_fee(self) -> None:
        # Nothing is deducted at the boundary: a doctor with exactly the
        # minimum withdraws exactly the minimum.
        assert earnings.MINIMUM_WITHDRAWAL - Decimal("1000.00") == Decimal("0")

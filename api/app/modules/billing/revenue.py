"""What the platform has taken, and what of it is actually the platform's.

Two questions that look like one and are not, which is why they are answered
separately here.

**Money handled** is every rupee that came through: consultation fees, platform
fees, tax, late charges. It is the headline figure and it flatters — most of it
was never the platform's, it passed through on its way to a doctor or to the
tax authority.

**Money kept** is the platform fee plus tax, which is what stayed. Even that is
overstated, because tax is collected on the state's behalf and is a liability
rather than income — so it is reported *beside* the fee rather than folded into
it, and the honest "what MediSense has earned" is the fee alone. A dashboard
that adds tax into its own revenue is one somebody eventually has to explain to
an accountant.

**Owed to doctors** completes the picture: the balance sitting in doctors'
ledgers that the platform is holding and has not yet paid out. It is the one
figure here that is a debt rather than an asset.

Only **confirmed** money counts. An invoice that has been issued is a hope; one
that has been paid is a fact, and a revenue chart built on the first is a chart
that goes down when somebody finally chases the debtors.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import utcnow
from app.db.enums import InvoiceStatus
from app.db.models import Appointment, Doctor, DoctorLedgerEntry, Invoice

#: How a period is cut up. The label is what a chart axis shows.
Grain = Literal["day", "week", "month"]

#: PostgreSQL's own names, so `date_trunc` does the bucketing rather than this
#: process pulling every invoice and grouping them in Python.
_TRUNC: dict[Grain, str] = {"day": "day", "week": "week", "month": "month"}

#: How far back each grain looks by default — chosen so a chart has enough
#: points to show a shape and few enough to stay readable.
_WINDOW: dict[Grain, timedelta] = {
    "day": timedelta(days=30),
    "week": timedelta(weeks=12),
    "month": timedelta(days=365),
}


@dataclass(frozen=True)
class Totals:
    """Money, split by whose it is."""

    #: Everything that came through, most of which was never the platform's.
    handled: Decimal
    #: The consultation fees inside that — the doctors' share.
    to_doctors: Decimal
    #: The platform's own fee. This is the honest "we earned".
    platform_fee: Decimal
    #: Collected for the state. Held, not earned.
    tax: Decimal
    #: Charged for chasing late bills. The platform's, but not its trade.
    late_fees: Decimal
    #: How many paid invoices this is built from.
    invoices: int


async def totals(
    db: AsyncSession, *, since: datetime | None = None, until: datetime | None = None
) -> Totals:
    """Confirmed money over a period, or over all time when unbounded.

    Counted on ``paidAt`` rather than on when the invoice was raised: revenue in
    a month means money that arrived in that month, and dating it to when the
    bill was written puts January's income in December whenever somebody pays
    late — which is precisely the case a late fee exists for.
    """
    where = [Invoice.status == InvoiceStatus.PAID, Invoice.paid_at.is_not(None)]
    if since is not None:
        where.append(Invoice.paid_at >= since)
    if until is not None:
        where.append(Invoice.paid_at < until)

    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(Invoice.total_amount), 0),
                func.coalesce(func.sum(Invoice.amount), 0),
                func.coalesce(func.sum(Invoice.platform_fee), 0),
                func.coalesce(func.sum(Invoice.tax_amount), 0),
                func.count(Invoice.id),
            ).where(*where)
        )
    ).one()

    handled, fees, platform, tax, count = row

    # A late charge is only real once the bill it sits on was actually paid
    # late, and `total_amount` never contained it — so it is summed separately
    # over the invoices that were overdue when they settled.
    late = (
        await db.execute(
            select(func.coalesce(func.sum(Invoice.late_fee), 0)).where(
                *where, Invoice.paid_at > Invoice.due_at
            )
        )
    ).scalar_one()

    return Totals(
        handled=Decimal(handled) + Decimal(late),
        to_doctors=Decimal(fees),
        platform_fee=Decimal(platform),
        tax=Decimal(tax),
        late_fees=Decimal(late),
        invoices=int(count),
    )


async def owed_to_doctors(db: AsyncSession) -> Decimal:
    """The balance the platform is holding on doctors' behalf.

    The sum of every ledger, which is what has been credited less what has been
    withdrawn or is being held against a request. A debt, not an asset — money
    in the account that is already somebody else's.
    """
    total = (
        await db.execute(select(func.coalesce(func.sum(DoctorLedgerEntry.amount), 0)))
    ).scalar_one()
    return Decimal(total)


async def series(db: AsyncSession, grain: Grain) -> list[dict[str, Any]]:
    """One point per period, oldest first, for a chart.

    Periods with no income are **not** filled in. A gap in a bar chart is
    honest; a run of zeroes invented by this function would be indistinguishable
    from real quiet days, and the client can decide which it wants to draw.
    """
    bucket = func.date_trunc(_TRUNC[grain], Invoice.paid_at).label("bucket")
    since = utcnow() - _WINDOW[grain]

    rows = (
        await db.execute(
            select(
                bucket,
                func.coalesce(func.sum(Invoice.total_amount), 0),
                func.coalesce(func.sum(Invoice.platform_fee), 0),
                func.coalesce(func.sum(Invoice.tax_amount), 0),
                func.coalesce(func.sum(Invoice.amount), 0),
                func.count(Invoice.id),
            )
            .where(
                Invoice.status == InvoiceStatus.PAID,
                Invoice.paid_at.is_not(None),
                Invoice.paid_at >= since,
            )
            .group_by(bucket)
            .order_by(bucket)
        )
    ).all()

    return [
        {
            "period": moment.isoformat() + "Z",
            "handled": str(handled),
            "platformFee": str(platform),
            "tax": str(tax),
            "toDoctors": str(fees),
            "invoices": int(count),
        }
        for moment, handled, platform, tax, fees, count in rows
    ]


async def top_specialities(db: AsyncSession, limit: int = 6) -> list[dict[str, Any]]:
    """Where the money came from, biggest first.

    Joined through the appointment to the doctor, so this reads the doctor's
    *current* speciality. That is a real limitation and worth naming: a doctor
    who changes speciality moves their past income with them. Reading it off the
    invoice instead would need the speciality stored on the row at issue, which
    it is not — and inventing it out of the line-item text would be a fragile
    query pretending to be a fact.

    Invoices with no appointment behind them are excluded rather than bucketed
    as "other": they are a small edge here, and a slice labelled "other" that
    quietly grows is worse than one that is absent.
    """
    rows = (
        await db.execute(
            select(
                Doctor.specialization,
                func.coalesce(func.sum(Invoice.total_amount), 0),
                func.count(Invoice.id),
            )
            .join(Appointment, Appointment.id == Invoice.appointment_id)
            .join(Doctor, Doctor.id == Appointment.doctor_id)
            .where(Invoice.status == InvoiceStatus.PAID)
            .group_by(Doctor.specialization)
            .order_by(func.sum(Invoice.total_amount).desc())
            .limit(limit)
        )
    ).all()

    return [
        {"label": speciality, "amount": str(amount), "invoices": int(count)}
        for speciality, amount, count in rows
    ]


def serialize(totals_: Totals) -> dict[str, Any]:
    return {
        "handled": str(totals_.handled),
        "toDoctors": str(totals_.to_doctors),
        "platformFee": str(totals_.platform_fee),
        "tax": str(totals_.tax),
        "lateFees": str(totals_.late_fees),
        # The platform's own income: the fee it charges, and the late charges it
        # collects for chasing. Tax is deliberately not in here — it is held for
        # the state, and a dashboard that counts it as revenue is one somebody
        # has to explain to an accountant.
        "earned": str(totals_.platform_fee + totals_.late_fees),
        "invoices": totals_.invoices,
    }

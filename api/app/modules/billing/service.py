"""Invoicing (spec §15, requirement R4).

    doctor completes consultation
              |
        backend transaction
              |
      status = COMPLETED
              |
        invoice generated
              |
     patient + admin notified

Three properties carry this module.

**Generation is idempotent, and the database is what guarantees it.** Spec §15
says "prevent duplicate invoices if the request is retried. Use
idempotency/unique constraints." ``invoices_appointmentId_key`` is that
constraint: two concurrent completions of the same consultation cannot both
insert, because the loser hits the unique index rather than an application check
it might have raced past. The loser then reads the winner's invoice and returns
it, so a retry is a success rather than a conflict.

**An issued invoice is never edited** (conflict C4). Money that has been billed
is a statement to a patient, and rewriting it in place destroys the record of
what they were originally told. Corrections are new documents: a void for an
invoice nothing has been paid against, and a credit note — a negative invoice
carrying ``amendsInvoiceId`` — for one that has.

**The invoice number comes from a sequence, not a count.** ``SELECT count(*)+1``
is a race with a unique index at the end of it; two concurrent completions
would compute the same number and one would fail on a constraint that has
nothing to do with the real problem.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import bad_request, conflict
from app.core.logging import logger
from app.db.base import new_id, utcnow
from app.db.enums import FeeMode, InvoiceStatus, NotificationType, Role
from app.db.models import (
    Appointment,
    BillingSettings,
    Doctor,
    Invoice,
    Patient,
    Payment,
    User,
)
from app.modules.notifications.service import notify
from app.services import email as email_service
from app.services import email_templates

#: How long a patient has before an invoice is considered overdue.
#:
#: Three days, not a month. A consultation fee is a small, immediate debt and a
#: month-long window means a bill is forgotten long before it is chased. The
#: consequence of missing it is a single late fee, added once — see
#: ``amount_due`` for why it is never charged per day.
PAYMENT_TERMS_DAYS = 3

CENTS = Decimal("0.01")


def _money(value: Decimal | float | int) -> Decimal:
    """Two decimal places, rounded the way money is rounded.

    ``ROUND_HALF_UP`` rather than Python's banker's rounding: an invoice has to
    match what a person gets when they check the arithmetic by hand.
    """
    return Decimal(str(value)).quantize(CENTS, rounding=ROUND_HALF_UP)


async def next_invoice_number(db: AsyncSession) -> str:
    """``INV-<year>-<sequence>``, allocated atomically.

    ``nextval`` is transactional but not rolled back, so a failed transaction
    burns a number rather than reissuing it. That is the correct trade: a gap in
    the sequence is an accounting curiosity, a reused invoice number is a
    reconciliation problem.
    """
    value = (await db.execute(text("SELECT nextval('invoice_number_seq')"))).scalar_one()
    return f"INV-{utcnow().year}-{value:06d}"


def build_line_items(*, doctor_name: str, specialization: str, fee: Decimal) -> list[dict[str, Any]]:
    """What the patient is being charged for, in their own terms.

    Stored on the invoice rather than derived on read: the doctor's fee can
    change, and an invoice must always say what was actually charged at the time
    (conflict C4).
    """
    return [
        {
            "description": f"Consultation — {doctor_name} ({specialization})",
            "quantity": 1,
            "unitPrice": str(_money(fee)),
            "amount": str(_money(fee)),
        }
    ]


async def load_settings(db: AsyncSession) -> BillingSettings:
    """The rates in force right now.

    These were environment variables, which meant the administrator accountable
    for the tax rate could not change it without the person holding the server.
    The row is created on first read rather than assumed, so a database restored
    from before this feature does not fail every consultation that completes.
    """
    row = (
        await db.execute(
            select(BillingSettings).where(BillingSettings.id == BillingSettings.SINGLETON)
        )
    ).scalar_one_or_none()

    if row is None:
        row = BillingSettings(
            id=BillingSettings.SINGLETON,
            # Seeded from the setting this replaces, so a deployment that had a
            # tax rate configured keeps charging it across the upgrade.
            tax_percent=_money(Decimal(str(settings.INVOICE_TAX_PERCENT))),
            platform_fee=Decimal("0"),
            late_fee=Decimal("0"),
            updated_at=utcnow(),
        )
        db.add(row)
        await db.flush()

    return row


@dataclass(frozen=True)
class Charges:
    """What one bill comes to, broken into the parts a patient can read."""

    subtotal: Decimal
    platform_fee: Decimal
    tax: Decimal
    total: Decimal
    #: The rate that produced ``tax``, as a percentage, whatever mode was used.
    #: Stored on the invoice so an old bill can explain its own tax without
    #: anybody looking up what the settings said that month. A flat tax records
    #: zero here, because there was no rate — the amount *was* the charge.
    tax_percent: Decimal


def apply_fee(base: Decimal, *, value: Decimal, mode: FeeMode) -> Decimal:
    """A fee against a base, whichever way it was configured.

    ``FIXED`` ignores the base entirely; ``PERCENT`` takes a share of it. The
    base differs by fee and is the caller's business — a platform fee is a share
    of the consultation, a late charge a share of the whole bill — which is why
    it is a parameter rather than something decided here.
    """
    if mode is FeeMode.PERCENT:
        return _money(_money(base) * Decimal(value) / Decimal("100"))
    return _money(value)


def totals(
    subtotal: Decimal,
    *,
    platform_fee: Decimal,
    platform_fee_mode: FeeMode = FeeMode.FIXED,
    tax_percent: Decimal,
    tax_mode: FeeMode = FeeMode.PERCENT,
) -> Charges:
    """The consultation fee, the platform fee, the tax on both, and the sum.

    Tax is charged on the fee **and** the platform fee rather than the fee
    alone: the platform fee is part of what is being sold, and taxing only half
    of a bill is the kind of quiet arithmetic error nobody notices until an
    audit. A percentage platform fee is a share of the consultation fee, not of
    itself — the alternative is circular.

    The rates arrive as arguments rather than being read here, because the
    caller has to store the ones it used on the invoice — see ``Invoice``.
    """
    subtotal = _money(subtotal)
    fee = apply_fee(subtotal, value=platform_fee, mode=platform_fee_mode)
    taxable = subtotal + fee
    tax = apply_fee(taxable, value=tax_percent, mode=tax_mode)

    # What rate that tax actually worked out to, so the invoice can show one
    # even when the charge was entered as a flat amount.
    effective = (
        _money(tax * Decimal("100") / taxable) if taxable > 0 else Decimal("0.00")
    )

    return Charges(
        subtotal=subtotal,
        platform_fee=fee,
        tax=tax,
        total=_money(taxable + tax),
        tax_percent=effective,
    )


async def existing_for_appointment(db: AsyncSession, appointment_id: str) -> Invoice | None:
    return (
        await db.execute(select(Invoice).where(Invoice.appointment_id == appointment_id))
    ).scalar_one_or_none()


async def generate_for_appointment(
    db: AsyncSession, appointment: Appointment
) -> tuple[Invoice, bool]:
    """Create the invoice for a completed consultation.

    Returns ``(invoice, created)``. ``created`` is False when one already
    existed, which is the normal outcome of a retry and is not an error.

    The insert runs inside a SAVEPOINT so that losing the unique-index race
    costs only the savepoint. Without it the ``IntegrityError`` would poison the
    surrounding transaction and take the consultation's completion down with it
    — turning a duplicate invoice into a lost clinical fact.
    """
    already = await existing_for_appointment(db, appointment.id)
    if already is not None:
        return already, False

    doctor = (
        await db.execute(
            select(Doctor, User.name)
            .join(User, User.id == Doctor.user_id)
            .where(Doctor.id == appointment.doctor_id)
        )
    ).first()
    if doctor is None:
        raise bad_request("The consultation has no doctor to bill for.")

    record, doctor_name = doctor
    rates = await load_settings(db)
    charges = totals(
        record.consultation_fee,
        platform_fee=rates.platform_fee,
        platform_fee_mode=rates.platform_fee_mode,
        tax_percent=rates.tax_percent,
        tax_mode=rates.tax_mode,
    )

    invoice = Invoice(
        id=new_id(),
        patient_id=appointment.patient_id,
        appointment_id=appointment.id,
        invoice_number=await next_invoice_number(db),
        amount=charges.subtotal,
        tax_amount=charges.tax,
        total_amount=charges.total,
        # Copied, never read live afterwards: an invoice states a debt as it
        # stood when it was issued, and reading current settings would restate
        # every unpaid bill in the hospital whenever a rate was corrected.
        platform_fee=charges.platform_fee,
        tax_percent=charges.tax_percent,
        # Resolved to rupees here and locked, so a percentage late charge is a
        # share of *this* bill rather than of whatever the total happens to be
        # when somebody finally looks at it.
        late_fee=apply_fee(
            charges.total, value=rates.late_fee, mode=rates.late_fee_mode
        ),
        currency=settings.INVOICE_CURRENCY,
        # Issued, not draft: the patient is notified about it in the next step,
        # and notifying someone about a document they cannot see would be worse
        # than not notifying them.
        status=InvoiceStatus.ISSUED,
        line_items=build_line_items(
            doctor_name=doctor_name, specialization=record.specialization, fee=record.consultation_fee
        ),
        issued_at=utcnow(),
        due_at=utcnow() + timedelta(days=PAYMENT_TERMS_DAYS),
    )

    try:
        async with db.begin_nested():
            db.add(invoice)
            await db.flush()
    except IntegrityError:
        # Another completion won the race. Its invoice is the real one.
        duplicate = await existing_for_appointment(db, appointment.id)
        if duplicate is None:  # pragma: no cover — the index says this cannot happen
            raise
        logger.info("invoice_generation_deduplicated", appointment_id=appointment.id)
        return duplicate, False

    return invoice, True


async def announce(db: AsyncSession, invoice: Invoice) -> None:
    """Tell the patient and the administrators (spec §15's flow).

    Both, because they need different things from it: the patient needs to know
    they owe something, and the administrators need the receivable to appear
    without anyone watching for it.
    """
    patient = (
        await db.execute(
            select(Patient.user_id, User.name, User.email)
            .join(User, User.id == Patient.user_id)
            .where(Patient.id == invoice.patient_id)
        )
    ).first()

    await notify(
        db,
        user_id=patient[0] if patient else None,
        notification_type=NotificationType.INVOICE_ISSUED,
        title="Invoice for your consultation",
        body=(
            f"Invoice {invoice.invoice_number} for {invoice.currency} "
            f"{invoice.total_amount} is available in your billing page."
        ),
        link="/patient/billing",
        metadata={"invoiceId": invoice.id},
        # The templated message below carries the amount, the date and a link
        # to pay; the generic one would deliver a second, thinner copy.
        email=False,
    )

    if patient is not None:
        _, patient_name, patient_email = patient
        message = email_templates.invoice_issued(
            name=patient_name,
            invoice_number=invoice.invoice_number,
            currency=invoice.currency,
            amount=str(invoice.total_amount),
            due=invoice.due_at.strftime("%d %B %Y") if invoice.due_at else "the due date",
        )
        # A bill that failed to email is still a bill: it is in the portal, the
        # notification row exists, and raising here would roll back the invoice
        # a consultation just produced.
        await email_service.send(
            to=patient_email,
            subject=message.subject,
            text_body=message.text,
            html_body=message.html,
        )

    admin_ids = (
        (await db.execute(select(User.id).where(User.role == Role.ADMIN))).scalars().all()
    )
    for admin_id in admin_ids:
        await notify(
            db,
            user_id=admin_id,
            notification_type=NotificationType.INVOICE_ISSUED,
            title=f"Invoice {invoice.invoice_number} issued",
            body=f"{invoice.currency} {invoice.total_amount} billed for a completed consultation.",
            link="/admin/billing",
            metadata={"invoiceId": invoice.id},
        )


def mark_paid(invoice: Invoice) -> None:
    """Record payment. Only an issued or overdue invoice can be paid."""
    if invoice.status == InvoiceStatus.PAID:
        return  # idempotent: recording a payment twice is not two payments
    if invoice.status not in (InvoiceStatus.ISSUED, InvoiceStatus.OVERDUE):
        raise conflict(
            f"An invoice that is {str(invoice.status).lower()} cannot be marked paid."
        )
    invoice.status = InvoiceStatus.PAID
    invoice.paid_at = utcnow()


def void(invoice: Invoice, reason: str) -> None:
    """Cancel an invoice nothing has been paid against.

    A paid invoice is deliberately not voidable: money has moved, and pretending
    the document never existed would leave the payment unexplained. That case
    needs a credit note instead.
    """
    if invoice.status == InvoiceStatus.PAID:
        raise conflict("A paid invoice cannot be voided. Issue a credit note instead.")
    if invoice.status == InvoiceStatus.VOID:
        return
    invoice.status = InvoiceStatus.VOID
    invoice.voided_at = utcnow()
    invoice.notes = f"Voided: {reason}"


async def credit_note(db: AsyncSession, original: Invoice, reason: str) -> Invoice:
    """A negative invoice that corrects an issued one (conflict C4).

    The original is left exactly as the patient first saw it. What changes is
    that a second document now exists saying how much of it is being taken back,
    and the pair is what the accounts reflect.
    """
    if original.status in (InvoiceStatus.VOID, InvoiceStatus.REFUNDED):
        raise conflict("That invoice has already been reversed.")

    note = Invoice(
        id=new_id(),
        patient_id=original.patient_id,
        # Deliberately not linked to the appointment: the unique index allows
        # exactly one invoice per consultation, and the credit note is a
        # correction of a document rather than a second bill for the visit.
        appointment_id=None,
        invoice_number=await next_invoice_number(db),
        amount=-original.amount,
        tax_amount=-original.tax_amount,
        total_amount=-original.total_amount,
        currency=original.currency,
        status=InvoiceStatus.ISSUED,
        line_items=[
            {
                "description": f"Credit note against {original.invoice_number} — {reason}",
                "quantity": 1,
                "unitPrice": str(-original.total_amount),
                "amount": str(-original.total_amount),
            }
        ],
        notes=reason,
        issued_at=utcnow(),
        amends_invoice_id=original.id,
    )
    db.add(note)

    original.status = InvoiceStatus.REFUNDED
    await db.flush()
    return note


def is_overdue(invoice: Invoice) -> bool:
    """Computed rather than stored.

    A stored OVERDUE would need a sweep job to stay true, and an invoice that
    silently stops being overdue when the job fails is worse than one that works
    it out on read.
    """
    return (
        invoice.status == InvoiceStatus.ISSUED
        and invoice.due_at is not None
        and invoice.due_at < utcnow()
    )


def late_fee_applies(invoice: Invoice) -> Decimal:
    """The late fee currently owed on this invoice — zero, or the whole of it.

    **Once, not per day.** A daily charge on a hospital bill compounds while the
    person owing it is too ill to deal with it, which is the exact circumstance
    this system exists inside. So the fee is a single fixed amount that lands
    when the due date passes and never grows.

    Computed from ``due_at`` for the same reason ``is_overdue`` is: storing it
    would need a nightly sweep, and a bill that only becomes overdue once a job
    has run is a bill that lies between midnights.
    """
    return invoice.late_fee if is_overdue(invoice) else Decimal("0")


def amount_due(invoice: Invoice) -> Decimal:
    """What settles this invoice today.

    Distinct from ``total_amount``, which is what the invoice was issued for and
    never changes. A late fee is an additional charge, not a rewrite of a
    document the patient has already been sent — showing them a total that grew
    since they last looked, with no line explaining it, is how a bill loses a
    patient's trust.
    """
    if invoice.status in (InvoiceStatus.PAID, InvoiceStatus.VOID, InvoiceStatus.REFUNDED):
        return Decimal("0")
    return _money(invoice.total_amount + late_fee_applies(invoice))


def serialize_payment(payment: Payment, *, proof_url: str | None = None) -> dict[str, Any]:
    """One claim against an invoice.

    ``proofUrl`` is signed by the caller and passed in rather than minted here,
    because signing is a network round-trip and a list of twenty payments should
    issue them together rather than one after another. Absent means "not asked
    for", which is the normal case in a list.
    """
    return {
        "id": payment.id,
        "invoiceId": payment.invoice_id,
        "amount": str(payment.amount),
        "currency": payment.currency,
        "method": str(payment.method),
        "status": str(payment.status),
        "reference": payment.reference,
        "hasProof": payment.proof_path is not None,
        "proofUrl": proof_url,
        "rejectionReason": payment.rejection_reason,
        "createdAt": payment.created_at.isoformat() + "Z" if payment.created_at else None,
        "reviewedAt": payment.reviewed_at.isoformat() + "Z" if payment.reviewed_at else None,
    }


def serialize(invoice: Invoice, *, awaiting_review: bool = False) -> dict[str, Any]:
    """One invoice, as the portal shows it.

    ``awaiting_review`` is passed in rather than looked up, because a list of
    thirty invoices should ask "which of these have a payment under review" once
    rather than thirty times.
    """
    return {
        "id": invoice.id,
        "patientId": invoice.patient_id,
        "appointmentId": invoice.appointment_id,
        "invoiceNumber": invoice.invoice_number,
        # Decimal is rendered as a string, not a float: 0.1 + 0.2 is not 0.3 in
        # binary floating point, and a currency amount must survive the trip.
        "amount": str(invoice.amount),
        "platformFee": str(invoice.platform_fee),
        "taxPercent": str(invoice.tax_percent),
        "taxAmount": str(invoice.tax_amount),
        "totalAmount": str(invoice.total_amount),
        # What this bill *would* cost if it goes past its date, and what it is
        # actually charging right now. The first is on every invoice so a
        # patient can see the consequence before it arrives; the second is zero
        # until it does.
        "lateFee": str(invoice.late_fee),
        "lateFeeCharged": str(late_fee_applies(invoice)),
        "amountDue": str(amount_due(invoice)),
        "currency": invoice.currency,
        # A patient who has transferred and is waiting on a person has not
        # failed to pay, and telling them their bill is "Due" — or worse,
        # "Overdue" — while the money sits in the hospital's account is the
        # system blaming them for its own queue.
        "status": (
            "AWAITING_APPROVAL"
            if awaiting_review and invoice.status == InvoiceStatus.ISSUED
            else "OVERDUE"
            if is_overdue(invoice)
            else str(invoice.status)
        ),
        "awaitingReview": awaiting_review,
        "lineItems": invoice.line_items,
        "notes": invoice.notes,
        "issuedAt": invoice.issued_at.isoformat() + "Z" if invoice.issued_at else None,
        "dueAt": invoice.due_at.isoformat() + "Z" if invoice.due_at else None,
        "paidAt": invoice.paid_at.isoformat() + "Z" if invoice.paid_at else None,
        "voidedAt": invoice.voided_at.isoformat() + "Z" if invoice.voided_at else None,
        "amendsInvoiceId": invoice.amends_invoice_id,
        "createdAt": invoice.created_at.isoformat() + "Z",
    }

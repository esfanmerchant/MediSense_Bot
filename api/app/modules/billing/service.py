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
from app.db.enums import InvoiceStatus, NotificationType, Role
from app.db.models import Appointment, Doctor, Invoice, Patient, User
from app.modules.notifications.service import notify

#: How long a patient has before an invoice is considered overdue.
PAYMENT_TERMS_DAYS = 30

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


def totals(subtotal: Decimal) -> tuple[Decimal, Decimal, Decimal]:
    """Subtotal, tax and total.

    The tax rate is configuration, not a literal: rates differ by jurisdiction
    and change, and a number compiled into the billing code is a number nobody
    can correct without a deployment. It defaults to zero, so an unconfigured
    deployment bills the fee and nothing else rather than inventing a tax.
    """
    subtotal = _money(subtotal)
    tax = _money(subtotal * Decimal(str(settings.INVOICE_TAX_PERCENT)) / Decimal("100"))
    return subtotal, tax, _money(subtotal + tax)


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
    subtotal, tax, total = totals(record.consultation_fee)

    invoice = Invoice(
        id=new_id(),
        patient_id=appointment.patient_id,
        appointment_id=appointment.id,
        invoice_number=await next_invoice_number(db),
        amount=subtotal,
        tax_amount=tax,
        total_amount=total,
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
    patient_user_id = (
        await db.execute(select(Patient.user_id).where(Patient.id == invoice.patient_id))
    ).scalar_one_or_none()

    await notify(
        db,
        user_id=patient_user_id,
        notification_type=NotificationType.INVOICE_ISSUED,
        title="Invoice for your consultation",
        body=(
            f"Invoice {invoice.invoice_number} for {invoice.currency} "
            f"{invoice.total_amount} is available in your billing page."
        ),
        link="/patient/billing",
        metadata={"invoiceId": invoice.id},
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


def serialize(invoice: Invoice) -> dict[str, Any]:
    return {
        "id": invoice.id,
        "patientId": invoice.patient_id,
        "appointmentId": invoice.appointment_id,
        "invoiceNumber": invoice.invoice_number,
        # Decimal is rendered as a string, not a float: 0.1 + 0.2 is not 0.3 in
        # binary floating point, and a currency amount must survive the trip.
        "amount": str(invoice.amount),
        "taxAmount": str(invoice.tax_amount),
        "totalAmount": str(invoice.total_amount),
        "currency": invoice.currency,
        "status": "OVERDUE" if is_overdue(invoice) else str(invoice.status),
        "lineItems": invoice.line_items,
        "notes": invoice.notes,
        "issuedAt": invoice.issued_at.isoformat() + "Z" if invoice.issued_at else None,
        "dueAt": invoice.due_at.isoformat() + "Z" if invoice.due_at else None,
        "paidAt": invoice.paid_at.isoformat() + "Z" if invoice.paid_at else None,
        "voidedAt": invoice.voided_at.isoformat() + "Z" if invoice.voided_at else None,
        "amendsInvoiceId": invoice.amends_invoice_id,
        "createdAt": invoice.created_at.isoformat() + "Z",
    }

"""Invoices (spec §15, requirement R4).

Billing is administrative, and the permission catalogue already says so: a
patient holds ``invoice:read:own``, an administrator holds ``invoice:read:any``
and ``invoice:manage``, and a doctor holds neither. A doctor still *causes*
invoices — completing a consultation is the trigger — but they do it by treating
a patient, not by touching a billing endpoint.

There is no PDF generator here, and none is pretended. No PDF library is
installed in this environment, so ``GET /invoices/{id}`` returns the invoice in
full — line items, totals, dates — and the client renders a printable view the
browser can save as PDF. Shipping a route called ``/download`` that emitted
something other than a document would be worse than not having one.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.config import settings
from app.core.errors import bad_request, conflict, forbidden, not_found
from app.db.base import new_id, utcnow
from app.db.enums import (
    AuditAction,
    FeeMode,
    InvoiceStatus,
    NotificationType,
    PaymentMethod,
    PaymentStatus,
    Role,
    UserStatus,
)
from app.db.models import Invoice, Patient, Payment, User
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.billing import revenue, service
from app.modules.notifications.service import notify
from app.services import email as email_service
from app.services import email_templates, receipt_ocr, storage
from app.services.files import FileRejectedError, inspect_upload

router = APIRouter(prefix="/invoices", tags=["billing"])

RequireInvoiceManage = Annotated[
    object, Depends(require_permission(Permission.INVOICE_MANAGE))
]

#: A screenshot of a banking app. Five megabytes is generous for one and small
#: enough that a mistaken photo of something else is refused before it is
#: stored — the same reasoning as avatars, and the same limit.
MAX_PROOF_BYTES = 5 * 1024 * 1024

#: What a reviewer can actually look at. A PDF would be a valid receipt and is
#: absent for the same reason it is absent from avatars: this is displayed
#: inline beside the invoice, and a format the page cannot render is a proof
#: nobody can check without downloading it first.
PROOF_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})


class BillingSettingsUpdate(BaseModel):
    """The rates an administrator may change. Every field optional."""

    model_config = ConfigDict(populate_by_name=True)

    #: Each value is read through the mode beside it: rupees under FIXED,
    #: percent under PERCENT.
    #:
    #: The ceiling is the flat one in both cases rather than 100 for percentages.
    #: A percentage over 100 is refused by :meth:`_percentages_are_percentages`,
    #: which can see the mode; a `le=100` here could not, and would reject a
    #: perfectly ordinary flat fee of 500.
    tax_percent: Annotated[Decimal, Field(ge=0, le=1_000_000)] | None = Field(
        default=None, alias="taxPercent"
    )
    tax_mode: FeeMode | None = Field(default=None, alias="taxMode")
    platform_fee: Annotated[Decimal, Field(ge=0, le=1_000_000)] | None = Field(
        default=None, alias="platformFee"
    )
    platform_fee_mode: FeeMode | None = Field(default=None, alias="platformFeeMode")
    #: Charged once when a bill passes its due date, never per day.
    late_fee: Annotated[Decimal, Field(ge=0, le=1_000_000)] | None = Field(
        default=None, alias="lateFee"
    )
    late_fee_mode: FeeMode | None = Field(default=None, alias="lateFeeMode")

    #: The account patients are told to transfer into. Empty string clears one,
    #: which is why these are not merged with the `exclude_none` rates above —
    #: an administrator removing a wallet is a real edit, not an omission.
    payee_name: Annotated[str, Field(max_length=160)] | None = Field(
        default=None, alias="payeeName"
    )
    nayapay_number: Annotated[str, Field(max_length=32)] | None = Field(
        default=None, alias="nayapayNumber"
    )
    easypaisa_number: Annotated[str, Field(max_length=32)] | None = Field(
        default=None, alias="easypaisaNumber"
    )
    payment_note: Annotated[str, Field(max_length=500)] | None = Field(
        default=None, alias="paymentNote"
    )

    @model_validator(mode="after")
    def _percentages_are_percentages(self) -> BillingSettingsUpdate:
        """A share of a bill cannot exceed the bill.

        Checked here rather than by a column constraint because the limit
        depends on the mode, and the database column holds both kinds of number.
        """
        for value, mode, name in (
            (self.tax_percent, self.tax_mode, "taxPercent"),
            (self.platform_fee, self.platform_fee_mode, "platformFee"),
            (self.late_fee, self.late_fee_mode, "lateFee"),
        ):
            if mode is FeeMode.PERCENT and value is not None and value > 100:
                raise ValueError(f"{name} cannot be more than 100 percent")
        return self


class VoidRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    #: Required, and stored on the invoice. "Why is this cancelled" is the first
    #: question anyone reconciling the accounts will ask.
    reason: Annotated[str, Field(min_length=3, max_length=500)]


def scope_for(auth: CurrentAuth) -> Any:
    """The invoices this caller may see, as a SQL condition.

    Applied as a filter rather than checked afterwards, so out-of-scope rows are
    never loaded and paging totals stay honest.
    """
    if auth.has(Permission.INVOICE_READ_ANY):
        return True  # administrators see the whole ledger
    if auth.role == Role.PATIENT and auth.patient_id:
        return Invoice.patient_id == auth.patient_id
    raise forbidden("You do not have access to invoices.")


async def under_review(db: DbSession, invoice_ids: list[str]) -> set[str]:
    """Which of these invoices have a payment waiting on an administrator.

    One query for the whole page. Asked per row it would be thirty round trips
    to render a list.
    """
    if not invoice_ids:
        return set()
    return set(
        (
            await db.execute(
                select(Payment.invoice_id).where(
                    Payment.invoice_id.in_(invoice_ids),
                    Payment.status == PaymentStatus.SUBMITTED,
                )
            )
        )
        .scalars()
        .all()
    )


async def load_visible(db: DbSession, auth: CurrentAuth, invoice_id: str) -> Invoice:
    invoice = (
        await db.execute(select(Invoice).where(Invoice.id == invoice_id, scope_for(auth)))
    ).scalar_one_or_none()
    # One message whether it does not exist or is not theirs: an id that answers
    # differently in the two cases is an enumeration oracle.
    if invoice is None:
        raise not_found("No such invoice.")
    return invoice


@router.get("")
async def list_invoices(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    status: InvoiceStatus | None = None,
    patient_id: Annotated[str | None, Query(alias="patientId", max_length=64)] = None,
) -> dict[str, Any]:
    """Invoice history, newest first.

    ``meta`` carries the outstanding balance so the client does not have to page
    through the whole ledger to show what is owed.
    """
    filters: list[Any] = [scope_for(auth)]
    if status is not None:
        filters.append(Invoice.status == status)
    if patient_id is not None:
        if not auth.has(Permission.INVOICE_READ_ANY):
            # A patient's filter cannot widen their scope; saying so plainly is
            # better than silently returning their own rows.
            raise forbidden("You can only view your own invoices.")
        filters.append(Invoice.patient_id == patient_id)

    total = (
        await db.execute(select(func.count()).select_from(Invoice).where(*filters))
    ).scalar_one()

    rows = (
        (
            await db.execute(
                select(Invoice)
                .where(*filters)
                .order_by(Invoice.created_at.desc())
                .limit(page.limit)
                .offset(page.offset)
            )
        )
        .scalars()
        .all()
    )

    outstanding = (
        await db.execute(
            select(func.coalesce(func.sum(Invoice.total_amount), 0)).where(
                *filters, Invoice.status == InvoiceStatus.ISSUED
            )
        )
    ).scalar_one()

    waiting = await under_review(db, [row.id for row in rows])
    return ok(
        [service.serialize(row, awaiting_review=row.id in waiting) for row in rows],
        {**page.meta(total), "outstanding": str(outstanding)},
    )


@router.get("/{invoice_id}")
async def get_invoice(
    invoice_id: str, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """One invoice in full — everything a printable view needs."""
    invoice = await load_visible(db, auth, invoice_id)
    waiting = await under_review(db, [invoice.id])
    return ok(service.serialize(invoice, awaiting_review=invoice.id in waiting))


@router.post("/{invoice_id}/pay")
async def record_payment(
    invoice_id: str,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireInvoiceManage,
) -> dict[str, Any]:
    """Record money taken at the billing desk.

    Not the route a patient's online payment takes — that goes through the
    review queue, which is the one place a submitted payment is accepted. This
    is for cash or a transfer handled in person.

    **It settles the invoice the same way the queue does**, through
    ``service.settle``. The two used to differ: the queue credited the treating
    doctor and emailed the patient, this marked the invoice paid and did
    neither — so whether a doctor got paid depended on which button somebody
    pressed, which is not a difference anybody notices until a doctor asks where
    their money is.

    Calling it twice is not two payments — the second call returns the
    already-paid invoice rather than failing, because a retried request must not
    look like a second transaction.
    """
    invoice = await load_visible(db, auth, invoice_id)
    already_paid = invoice.status == InvoiceStatus.PAID

    # Read before `mark_paid`, which zeroes it: a settled invoice owes nothing.
    collected = service.amount_due(invoice) or invoice.total_amount

    service.mark_paid(invoice)
    await db.flush()

    if not already_paid:
        await service.settle(
            db, invoice, currency=invoice.currency, amount=collected
        )

    if not already_paid:
        await record_audit(
            db,
            AuditEntry(
                action=AuditAction.INVOICE_UPDATED,
                user_id=auth.user_id,
                actor_role=auth.role,
                patient_id=invoice.patient_id,
                entity_type="Invoice",
                entity_id=invoice.id,
                ip_address=client_ip(request),
                request_id=getattr(request.state, "request_id", None),
                metadata={
                    "operation": "pay",
                    "invoiceNumber": invoice.invoice_number,
                    "totalAmount": str(invoice.total_amount),
                },
            ),
        )

    return ok(service.serialize(invoice))


@router.post("/{invoice_id}/void")
async def void_invoice(
    invoice_id: str,
    payload: VoidRequest,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireInvoiceManage,
) -> dict[str, Any]:
    """Cancel an invoice nothing has been paid against.

    A paid invoice is refused here on purpose: money has moved, and voiding the
    document would leave the payment unexplained. That case needs a credit note.
    """
    invoice = await load_visible(db, auth, invoice_id)
    service.void(invoice, payload.reason)
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.INVOICE_UPDATED,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=invoice.patient_id,
            entity_type="Invoice",
            entity_id=invoice.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={
                "operation": "void",
                "invoiceNumber": invoice.invoice_number,
                "reason": payload.reason,
            },
        ),
    )

    return ok(service.serialize(invoice))


@router.post("/{invoice_id}/credit-note", status_code=201)
async def issue_credit_note(
    invoice_id: str,
    payload: VoidRequest,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireInvoiceManage,
) -> dict[str, Any]:
    """Correct an issued invoice without editing it (conflict C4).

    The original stays exactly as the patient first saw it. The correction is a
    second, negative document that references it, and the pair is what the
    accounts reflect.
    """
    original = await load_visible(db, auth, invoice_id)
    note = await service.credit_note(db, original, payload.reason)

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.INVOICE_CREATED,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=note.patient_id,
            entity_type="Invoice",
            entity_id=note.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={
                "operation": "credit_note",
                "invoiceNumber": note.invoice_number,
                "amends": original.invoice_number,
                "reason": payload.reason,
            },
        ),
    )

    return ok(
        {
            "creditNote": service.serialize(note),
            "original": service.serialize(original),
        }
    )


# ---------------------------------------------------------------------------
# The rates, and who owns them
# ---------------------------------------------------------------------------


def _settings_payload(row: Any) -> dict[str, Any]:
    return {
        "taxPercent": str(row.tax_percent),
        "taxMode": str(row.tax_mode),
        "platformFee": str(row.platform_fee),
        "platformFeeMode": str(row.platform_fee_mode),
        "lateFee": str(row.late_fee),
        "lateFeeMode": str(row.late_fee_mode),
        "payeeName": row.payee_name,
        "nayapayNumber": row.nayapay_number,
        "easypaisaNumber": row.easypaisa_number,
        "paymentNote": row.payment_note,
        "paymentTermsDays": service.PAYMENT_TERMS_DAYS,
        "currency": settings.INVOICE_CURRENCY,
        "updatedAt": row.updated_at.isoformat() + "Z" if row.updated_at else None,
    }


@router.get("/settings/billing")
async def read_billing_settings(
    auth: CurrentAuth, db: DbSession, _: RequireInvoiceManage
) -> dict[str, Any]:
    """The rates in force. Administrators only, because they are the rates."""
    return ok(_settings_payload(await service.load_settings(db)))


@router.patch("/settings/billing")
async def update_billing_settings(
    payload: BillingSettingsUpdate,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireInvoiceManage,
) -> dict[str, Any]:
    """Change the tax rate, the platform fee, or the late fee.

    **Only invoices issued after this take the new rates.** Every invoice stores
    what it charged, so nothing already issued is touched -- which is the point:
    a bill a patient has already been sent must not quietly change because an
    administrator corrected a percentage this morning.

    Audited with both the old and the new value. "The tax rate is 17%" answers
    nothing six months later; "it went from 0 to 17, on this date, by this
    person" is what a reconciliation actually needs.
    """
    row = await service.load_settings(db)
    changes = payload.model_dump(exclude_none=True)
    if not changes:
        return ok(_settings_payload(row))

    # The mode belongs in the trail beside the number: "the platform fee went
    # from 2 to 5" means two entirely different things depending on it.
    def snapshot() -> dict[str, str]:
        return {
            "taxPercent": str(row.tax_percent),
            "taxMode": str(row.tax_mode),
            "platformFee": str(row.platform_fee),
            "platformFeeMode": str(row.platform_fee_mode),
            "lateFee": str(row.late_fee),
            "lateFeeMode": str(row.late_fee_mode),
        }

    before = snapshot()

    for field, value in changes.items():
        setattr(row, field, value)
    row.updated_at = utcnow()
    row.updated_by_id = auth.user_id
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.CONFIG_CHANGED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="BillingSettings",
            entity_id=row.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"before": before, "after": snapshot()},
        ),
    )

    return ok(_settings_payload(row))


# ---------------------------------------------------------------------------
# Paying one
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Paying by transfer
# ---------------------------------------------------------------------------


@router.get("/{invoice_id}/payment-instructions")
async def payment_instructions(
    invoice_id: str, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Where to send the money, and how much.

    The amount is ``amountDue`` rather than the invoice total, so a bill past
    its date is quoted with its late charge included and the patient transfers
    one figure rather than settling the original and leaving a stub.

    Reachable by anyone who can already see the invoice — this is the patient's
    own bill and the account is published information, not a secret.
    """
    invoice = await load_visible(db, auth, invoice_id)
    rates = await service.load_settings(db)

    return ok(
        {
            "amountDue": str(service.amount_due(invoice)),
            "currency": invoice.currency,
            "invoiceNumber": invoice.invoice_number,
            "payeeName": rates.payee_name,
            "nayapayNumber": rates.nayapay_number,
            "easypaisaNumber": rates.easypaisa_number,
            "note": rates.payment_note,
            # Nothing to pay into means nothing to instruct. The client says so
            # rather than showing an empty account.
            "configured": bool(rates.nayapay_number or rates.easypaisa_number),
        }
    )


@router.post("/{invoice_id}/payment-proof", status_code=201)
async def submit_payment_proof(
    invoice_id: str,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    method: Annotated[PaymentMethod, Form()],
    reference: Annotated[str, Form(min_length=3, max_length=120)],
    file: Annotated[UploadFile, File()],
) -> dict[str, Any]:
    """Tell the hospital a transfer has been made, and show it.

    **This does not mark the invoice paid, and must not.** It records a claim
    with evidence attached; an administrator who has looked at the receiving
    account is what turns it into a payment. The distinction is the entire
    security model of paying this way — without it a screenshot settles a bill.

    The amount recorded is what is owed *now*, taken from the invoice rather
    than from anything the caller sends, so a patient cannot declare their own
    bill smaller by posting a different number.

    One outstanding claim at a time. A second submission while one is already
    waiting would leave a reviewer with two pictures and no way to know which
    the patient means, so the earlier one has to be resolved first.
    """
    invoice = await load_visible(db, auth, invoice_id)

    if invoice.status == InvoiceStatus.PAID:
        raise bad_request("This invoice has already been paid.")
    if invoice.status in (InvoiceStatus.VOID, InvoiceStatus.REFUNDED):
        raise bad_request("This invoice is not payable.")
    if method is PaymentMethod.COUNTER:
        # Counter payments are recorded by staff who took the money; a patient
        # claiming one has nothing to evidence.
        raise bad_request("Choose the wallet you transferred from.")

    # The account this claim is against, fixed now rather than looked up later.
    # A clinic that changes wallet next month must not rewrite where last
    # month's money was supposed to have gone.
    rates = await service.load_settings(db)
    payee_account = (
        rates.nayapay_number if method is PaymentMethod.NAYAPAY else rates.easypaisa_number
    )
    if not payee_account:
        # Nothing to pay into means nothing to claim against. Better a refusal
        # than a payment recorded as having gone to an account that does not
        # exist.
        raise bad_request("That wallet is not set up for payments. Choose the other one.")

    waiting = (
        await db.execute(
            select(Payment).where(
                Payment.invoice_id == invoice.id,
                Payment.status == PaymentStatus.SUBMITTED,
            )
        )
    ).scalar_one_or_none()
    if waiting is not None:
        raise conflict("A payment for this invoice is already awaiting confirmation.")

    content = await file.read()
    try:
        inspected = inspect_upload(
            content,
            declared_mime=file.content_type,
            original_name=file.filename,
            max_bytes=MAX_PROOF_BYTES,
        )
    except FileRejectedError as exc:
        raise bad_request(str(exc)) from exc

    if inspected.detected_mime not in PROOF_MIME_TYPES:
        raise bad_request("Upload a screenshot as a JPEG, PNG or WebP image.")

    payment = Payment(
        id=new_id(),
        invoice_id=invoice.id,
        # From the invoice, never from the request: a caller cannot declare
        # their own bill smaller.
        amount=service.amount_due(invoice),
        currency=invoice.currency,
        method=method,
        status=PaymentStatus.SUBMITTED,
        reference=reference.strip(),
        payee_account=payee_account,
    )

    # Read the screenshot before it is filed, so the reviewer opens a payment
    # that already carries its second opinion rather than waiting on a provider
    # with the queue in front of them. `read` never raises: a provider that is
    # down or out of quota costs the reviewer a convenience, and must not cost
    # the patient the ability to say they have paid.
    receipt = await receipt_ocr.read(content, inspected.detected_mime)

    # The one thing that stops the submission rather than flagging it.
    #
    # Everything else the reading finds is a question for the reviewer, because
    # a model can be wrong about a blurry screenshot and a patient who really
    # has paid must not be locked out by it. A transaction ID is different: it
    # is the one field the patient also typed, so a mismatch is not the model
    # disagreeing with a photograph — it is the screenshot disagreeing with the
    # person, about the same number, and one of the two is wrong before anybody
    # is asked to review it.
    #
    # Note the shape of the condition. It refuses only when a reference was
    # *read* and *differs*; an unreadable receipt goes through and is flagged,
    # because "I could not tell" must never become "no".
    if receipt_ocr.reference_conflict(reference, receipt.reference):
        # Neither number is quoted back, and that is not only tidiness. Printing
        # what was read off the image hands anybody probing this the exact value
        # that gets past the check — the refusal would be telling them what to
        # type. The receipt is in front of the patient; they can read it there.
        raise bad_request("Transaction ID does not match the screenshot.")

    if not receipt.is_empty:
        payment.receipt_text = receipt.text
        payment.receipt_reference = receipt.reference
        payment.receipt_amount = receipt.amount
        payment.receipt_paid_at = receipt.paid_at
        payment.receipt_sender = receipt.sender
        payment.receipt_sender_account = receipt.sender_account
        payment.receipt_receiver = receipt.receiver
        payment.receipt_receiver_account = receipt.receiver_account
        payment.receipt_wallet = receipt.wallet
        payment.receipt_looks_valid = receipt.is_receipt
        payment.receipt_read_at = datetime.now(UTC).replace(tzinfo=None)

    bucket = settings.SUPABASE_PAYMENT_PROOFS_BUCKET
    path = f"{invoice.patient_id}/{payment.id}{inspected.extension}"
    await storage.upload(bucket, path, content, inspected.detected_mime)

    try:
        payment.proof_path = path
        db.add(payment)
        await db.flush()
    except Exception:
        # The documents module's ordering: an object with no row is litter
        # nobody can account for.
        await storage.remove(bucket, path)
        raise

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.INVOICE_UPDATED,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=invoice.patient_id,
            entity_type="Payment",
            entity_id=payment.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={
                "operation": "payment_proof_submitted",
                "invoiceId": invoice.id,
                "amount": str(payment.amount),
                "method": str(method),
                # Whether the screenshot was read, never what it said: the
                # audit trail is queried by people who are not in this
                # patient's care, and a bank screenshot is not theirs to read.
                "receiptRead": payment.receipt_read_at is not None,
            },
        ),
    )

    await _tell_administrators(db, invoice=invoice, payment=payment, auth=auth)

    return ok(service.serialize_payment(payment))


async def _tell_administrators(
    db: DbSession, *, invoice: Invoice, payment: Payment, auth: CurrentAuth
) -> None:
    """Put the claim in front of whoever can check the receiving account.

    In-app and by email, because this is work that only happens if somebody
    notices it: a patient who has transferred is waiting on a person, and a
    queue nobody is told about is a queue nobody opens.
    """
    payer = (
        await db.execute(
            select(User.name)
            .join(Patient, Patient.user_id == User.id)
            .where(Patient.id == invoice.patient_id)
        )
    ).scalar_one_or_none() or "A patient"

    admins = (
        (
            await db.execute(
                select(User).where(User.role == Role.ADMIN, User.status == UserStatus.ACTIVE)
            )
        )
        .scalars()
        .all()
    )

    message = email_templates.admin_payment_submitted(
        patient_name=payer,
        invoice_number=invoice.invoice_number,
        currency=payment.currency,
        amount=str(payment.amount),
        reference=payment.reference or "",
    )

    for admin in admins:
        await notify(
            db,
            user_id=admin.id,
            notification_type=NotificationType.INVOICE_ISSUED,
            title="A payment is waiting for confirmation",
            body=f"{payer} sent {payment.currency} {payment.amount} for {invoice.invoice_number}.",
            link="/admin/billing",
            # Sent directly below; queuing one too would deliver it twice.
            email=False,
        )
        await email_service.send(
            to=admin.email,
            subject=message.subject,
            text_body=message.text,
            html_body=message.html,
        )


@router.get("/{invoice_id}/payments")
async def invoice_payments(
    invoice_id: str, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Every claim made against one invoice, newest first.

    A patient sees their own: whether it is still waiting, and — if it was
    refused — the reason, which is the only way they learn to try again.
    """
    invoice = await load_visible(db, auth, invoice_id)
    rows = (
        (
            await db.execute(
                select(Payment)
                .where(Payment.invoice_id == invoice.id)
                .order_by(Payment.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return ok([service.serialize_payment(row) for row in rows])


# ---------------------------------------------------------------------------
# What the platform has taken
# ---------------------------------------------------------------------------


@router.get("/revenue/summary")
async def revenue_summary(
    auth: CurrentAuth, db: DbSession, _: RequireInvoiceManage
) -> dict[str, Any]:
    """All-time money, this month's, and what is owed out.

    Three figures rather than one, because "total revenue" is the question that
    flatters: most of what came through was never the platform's. See
    `revenue.py` for the split and why tax is reported beside the fee rather
    than inside it.
    """
    month_start = utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    all_time = await revenue.totals(db)
    this_month = await revenue.totals(db, since=month_start)
    owed = await revenue.owed_to_doctors(db)

    return ok(
        {
            "currency": settings.INVOICE_CURRENCY,
            "allTime": revenue.serialize(all_time),
            "thisMonth": revenue.serialize(this_month),
            # A debt, not an asset: money already credited to doctors that the
            # platform is holding and has not yet paid out.
            "owedToDoctors": str(owed),
        }
    )


@router.get("/revenue/series")
async def revenue_series(
    auth: CurrentAuth,
    db: DbSession,
    _: RequireInvoiceManage,
    grain: Annotated[str, Query(pattern="^(day|week|month)$")] = "month",
) -> dict[str, Any]:
    """One point per day, week or month, for a chart."""
    points = await revenue.series(db, grain)  # type: ignore[arg-type]
    return ok(
        {
            "grain": grain,
            "currency": settings.INVOICE_CURRENCY,
            "points": points,
            "bySpeciality": await revenue.top_specialities(db),
        }
    )

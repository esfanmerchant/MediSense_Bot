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

from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.config import settings
from app.core.errors import bad_request, forbidden, not_found, service_unavailable
from app.db.base import new_id, utcnow
from app.db.enums import (
    AuditAction,
    FeeMode,
    InvoiceStatus,
    PaymentMethod,
    PaymentStatus,
    Role,
)
from app.db.models import Invoice, Payment
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.billing import service
from app.services import jazzcash

router = APIRouter(prefix="/invoices", tags=["billing"])

RequireInvoiceManage = Annotated[
    object, Depends(require_permission(Permission.INVOICE_MANAGE))
]


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

    return ok(
        [service.serialize(row) for row in rows],
        {**page.meta(total), "outstanding": str(outstanding)},
    )


@router.get("/{invoice_id}")
async def get_invoice(
    invoice_id: str, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """One invoice in full — everything a printable view needs."""
    invoice = await load_visible(db, auth, invoice_id)
    return ok(service.serialize(invoice))


@router.post("/{invoice_id}/pay")
async def record_payment(
    invoice_id: str,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireInvoiceManage,
) -> dict[str, Any]:
    """Record that this invoice has been paid.

    There is no payment gateway in scope; this records a payment taken
    elsewhere. Calling it twice is not two payments — the second call returns
    the already-paid invoice rather than failing, because a retried request
    must not look like a second transaction.
    """
    invoice = await load_visible(db, auth, invoice_id)
    already_paid = invoice.status == InvoiceStatus.PAID

    service.mark_paid(invoice)
    await db.flush()

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


@router.post("/{invoice_id}/checkout")
async def start_checkout(
    invoice_id: str, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Begin a JazzCash payment for an invoice the caller can see.

    Deliberately *not* behind ``INVOICE_MANAGE``: this is the endpoint a patient
    uses to pay their own bill, and ``load_visible`` already restricts them to
    their own invoices. The billing desk's ``/pay`` route stays where it is, for
    money taken at the counter.

    The amount charged is ``amountDue``, not ``totalAmount`` -- so a bill past
    its date is paid together with its late fee in one transaction, rather than
    settling the original and leaving a stub nobody chases.

    A ``Payment`` row is written **before** the payer is sent away. A redirect
    gateway means the next thing that happens is out of our sight; without the
    row, somebody who pays and closes the tab is money with no record on our
    side at all.
    """
    invoice = await load_visible(db, auth, invoice_id)

    if invoice.status == InvoiceStatus.PAID:
        raise bad_request("This invoice has already been paid.")
    if invoice.status in (InvoiceStatus.VOID, InvoiceStatus.REFUNDED):
        raise bad_request("This invoice is not payable.")
    if not settings.jazzcash_configured:
        # Named plainly rather than dressed up: sending a patient to a checkout
        # that will refuse them is worse than telling them it is unavailable.
        raise service_unavailable(
            "Online payment is not set up yet. You can pay at the hospital billing desk."
        )

    due = service.amount_due(invoice)
    reference = f"MS{utcnow().strftime('%y%m%d%H%M%S')}{new_id()[:6].upper()}"

    payment = Payment(
        id=new_id(),
        invoice_id=invoice.id,
        amount=due,
        currency=invoice.currency,
        method=PaymentMethod.JAZZCASH,
        status=PaymentStatus.INITIATED,
        gateway_ref=reference,
    )
    db.add(payment)
    await db.flush()

    fields = jazzcash.build_request(
        reference=reference,
        amount=due,
        description=f"Invoice {invoice.invoice_number}",
        bill_reference=invoice.invoice_number,
    )

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.INVOICE_UPDATED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="Payment",
            entity_id=payment.id,
            patient_id=invoice.patient_id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={
                "operation": "checkout_started",
                "invoiceId": invoice.id,
                "amount": str(due),
                "method": "JAZZCASH",
            },
        ),
    )

    # The signed form, and where to post it. The salt that signed it stays here.
    return ok({"endpoint": settings.jazzcash_endpoint, "fields": fields, "reference": reference})

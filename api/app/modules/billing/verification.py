"""The queue where a person decides whether money actually arrived.

Paying by transfer means the system never sees the money. A patient sends it in
their own banking app and shows us a screenshot; somebody at the hospital opens
the receiving account and checks. That check is the only thing standing between
a bill and anybody who can take a screenshot, which is why it lives here as an
explicit, audited, human decision rather than as anything automatic.

Two rules run through all of it:

* **Confirming is what pays the invoice.** Nothing else in the system marks a
  bill paid on the strength of an upload.
* **A refusal needs a reason, and the patient reads it.** "Rejected" with no
  sentence attached leaves somebody who has genuinely paid with no idea what to
  do next, which is worse than not offering the option at all.
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.config import settings
from app.core.errors import bad_request, not_found
from app.core.logging import logger
from app.db.base import utcnow
from app.db.enums import AuditAction, PaymentStatus
from app.db.models import Invoice, Patient, Payment, User
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.billing import service

# The one definition of who may see a patient's billing. Imported rather
# than restated, so this cannot drift from the invoice list's rule.
from app.modules.billing.router import scope_for as billing_scope
from app.services import storage

router = APIRouter(prefix="/payments", tags=["billing"])

RequireInvoiceManage = Annotated[
    object, Depends(require_permission(Permission.INVOICE_MANAGE))
]


class RejectRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    #: Shown to the patient. Somebody who has genuinely paid needs to know
    #: whether to re-upload, transfer again, or come to the desk — so this is a
    #: sentence they will read, not an internal code.
    reason: Annotated[str, Field(min_length=3, max_length=500)]


async def _signed_proof(payment: Payment) -> str | None:
    """A short-lived link to one screenshot, or None.

    Never raises. A payment whose proof cannot be linked is still a payment a
    reviewer needs to see in the queue — losing the whole list because storage
    hiccuped would be an outage caused by a thumbnail.
    """
    if not payment.proof_path:
        return None
    try:
        return await storage.signed_url(
            settings.SUPABASE_PAYMENT_PROOFS_BUCKET, payment.proof_path
        )
    except Exception as exc:
        logger.warning("payment_proof_sign_failed", error=type(exc).__name__)
        return None


async def _load(db: DbSession, payment_id: str) -> Payment:
    payment = (
        await db.execute(select(Payment).where(Payment.id == payment_id))
    ).scalar_one_or_none()
    if payment is None:
        raise not_found("No such payment.")
    return payment


@router.get("/pending")
async def pending_payments(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    _: RequireInvoiceManage,
    status: PaymentStatus = Query(default=PaymentStatus.SUBMITTED),
) -> dict[str, Any]:
    """Claims waiting on somebody to check the receiving account.

    Oldest first, unlike every other list here. This is a work queue, and the
    person who has been waiting longest for their bill to clear should be dealt
    with first — newest-first would leave them at the bottom forever.
    """
    base = (
        select(Payment, Invoice, User.name)
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .join(Patient, Patient.id == Invoice.patient_id)
        .join(User, User.id == Patient.user_id)
        .where(Payment.status == status)
    )

    total = (
        await db.execute(
            select(func.count(Payment.id)).where(Payment.status == status)
        )
    ).scalar_one()

    rows = (
        await db.execute(
            base.order_by(Payment.created_at.asc()).limit(page.limit).offset(page.offset)
        )
    ).all()

    # Signed together rather than one after another: a page of twenty proofs
    # would otherwise be twenty sequential round-trips to storage.
    urls = await asyncio.gather(*(_signed_proof(payment) for payment, _, _ in rows))

    return ok(
        [
            {
                **service.serialize_payment(payment, proof_url=url),
                "invoiceNumber": invoice.invoice_number,
                "patientName": patient_name,
                "invoiceTotal": str(invoice.total_amount),
            }
            for (payment, invoice, patient_name), url in zip(rows, urls, strict=True)
        ],
        page.meta(total),
    )


@router.post("/{payment_id}/confirm")
async def confirm_payment(
    payment_id: str,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireInvoiceManage,
) -> dict[str, Any]:
    """Confirm the money arrived, and settle the invoice.

    This is the step the whole arrangement rests on: an administrator has opened
    the receiving account, found the transfer, and is saying so. Only here does
    an invoice become PAID.

    Refuses a claim that has already been decided rather than deciding it twice
    — two confirmations of one transfer is a reconciliation nobody can unpick.
    """
    payment = await _load(db, payment_id)
    if payment.status is not PaymentStatus.SUBMITTED:
        raise bad_request("This payment has already been reviewed.")

    payment.status = PaymentStatus.SUCCEEDED
    payment.reviewed_by_id = auth.user_id
    payment.reviewed_at = utcnow()
    payment.completed_at = utcnow()

    invoice = await db.get(Invoice, payment.invoice_id)
    if invoice is None:  # pragma: no cover — the foreign key forbids it
        raise not_found("No such invoice.")
    service.mark_paid(invoice)
    await db.flush()

    await service.settle(db, invoice, currency=payment.currency, amount=payment.amount)

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
                "operation": "payment_confirmed",
                "invoiceId": invoice.id,
                "invoiceNumber": invoice.invoice_number,
                "amount": str(payment.amount),
                "method": str(payment.method),
                # The reference the reviewer matched against the account, so the
                # trail records what they claim to have checked.
                "reference": payment.reference,
            },
        ),
    )

    return ok(service.serialize_payment(payment))


@router.post("/{payment_id}/reject")
async def reject_payment(
    payment_id: str,
    payload: RejectRequest,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireInvoiceManage,
) -> dict[str, Any]:
    """Refuse a claim, with a reason the patient will read.

    The screenshot is kept rather than deleted. A refused claim is the beginning
    of a dispute more often than the end of one, and throwing away the evidence
    the moment somebody decides against it leaves nothing to look at when the
    patient says they did pay.
    """
    payment = await _load(db, payment_id)
    if payment.status is not PaymentStatus.SUBMITTED:
        raise bad_request("This payment has already been reviewed.")

    payment.status = PaymentStatus.FAILED
    payment.rejection_reason = payload.reason
    payment.reviewed_by_id = auth.user_id
    payment.reviewed_at = utcnow()
    await db.flush()

    invoice = await db.get(Invoice, payment.invoice_id)
    if invoice is not None:
        # The invoice was never marked paid, so it is still outstanding and the
        # patient's billing page shows it as due again on its own — no state to
        # put back, only somebody to tell.
        await service.payment_refused(
            db, invoice, currency=payment.currency, amount=payment.amount,
            reason=payload.reason,
        )

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.INVOICE_UPDATED,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=invoice.patient_id if invoice else None,
            entity_type="Payment",
            entity_id=payment.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={
                "operation": "payment_rejected",
                "invoiceId": payment.invoice_id,
                "amount": str(payment.amount),
                "reason": payload.reason,
            },
        ),
    )

    return ok(service.serialize_payment(payment))


@router.get("/{payment_id}/proof")
async def payment_proof(
    payment_id: str, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """A fresh link to one screenshot.

    Visible to whoever may see the invoice it belongs to — the patient who
    uploaded it, and administrators. The check is delegated to the invoice's own
    scope rather than repeated here, so there is one definition of who may see a
    patient's billing and this cannot drift from it.
    """
    payment = await _load(db, payment_id)

    invoice = (
        await db.execute(
            select(Invoice).where(
                Invoice.id == payment.invoice_id, billing_scope(auth)
            )
        )
    ).scalar_one_or_none()
    if invoice is None:
        raise not_found("No such payment.")

    url = await _signed_proof(payment)
    if url is None:
        raise not_found("There is no screenshot on this payment.")

    return ok({"url": url, "expiresInSeconds": settings.SUPABASE_SIGNED_URL_TTL_SECONDS})

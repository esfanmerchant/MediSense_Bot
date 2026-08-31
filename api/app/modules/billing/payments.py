"""Where JazzCash sends the payer back to.

This is the only endpoint in the system with no authentication on it, and that
is not an oversight: the request arrives from JazzCash's servers, or from a
browser they redirected, and neither carries a session cookie for this API.

So the signature does the work a session would. Every field JazzCash sends is
re-hashed with the integrity salt and compared with the one they attached; a
response that does not verify is discarded without touching a single row. That
ordering matters — verify first, then look anything up — because the alternative
is an endpoint anybody on the internet can post "invoice paid" to.

Three further rules, each guarding a way money can go wrong:

* **The reference is looked up, never trusted to describe itself.** What is owed
  comes from our own ``Payment`` row, not from the amount in the callback.
* **Delivered twice is not paid twice.** A gateway retries. A payment already
  marked ``SUCCEEDED`` short-circuits, and the second callback changes nothing.
* **A failure is recorded as a failure.** A declined card is a fact worth
  keeping; silently ignoring non-success responses would leave a row stuck at
  ``INITIATED`` forever with nothing saying why.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.api.deps import DbSession, client_ip
from app.core.config import settings
from app.core.logging import logger
from app.db.base import utcnow
from app.db.enums import AuditAction, PaymentStatus
from app.db.models import Invoice, Payment
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.billing import service
from app.services import jazzcash

router = APIRouter(prefix="/payments", tags=["billing"])


def _back_to(outcome: str, **extra: str) -> RedirectResponse:
    """Send the payer to their own billing page with the result on it.

    303, not 302: the browser arrives here on a POST from JazzCash, and only
    303 tells it to follow with a GET. A 302 leaves some browsers re-posting
    the gateway's form fields at a page that has no idea what to do with them.
    """
    query = urlencode({"payment": outcome, **extra})
    return RedirectResponse(f"{settings.CLIENT_ORIGIN}/patient/billing?{query}", status_code=303)


@router.post("/jazzcash/callback")
async def jazzcash_callback(request: Request, db: DbSession) -> Any:
    """JazzCash's verdict on one payment.

    Returns a redirect rather than JSON, because what arrives here is usually a
    person in a browser rather than a program.
    """
    form = await request.form()
    response = {key: str(value) for key, value in form.items()}

    if not jazzcash.verify(response):
        # Not an error worth explaining to the caller: an unsigned callback is
        # either a misconfigured salt or somebody trying it on, and the two look
        # identical from here. Logged with the reference only — never the fields,
        # which carry payer detail.
        logger.warning(
            "jazzcash_callback_rejected",
            reason="bad_signature",
            reference=response.get("pp_TxnRefNo"),
        )
        return _back_to("failed")

    reference = response.get("pp_TxnRefNo", "")
    payment = (
        await db.execute(select(Payment).where(Payment.gateway_ref == reference))
    ).scalar_one_or_none()

    if payment is None:
        logger.warning("jazzcash_callback_unknown_reference", reference=reference)
        return _back_to("failed")

    # A gateway retries. The second delivery must not be a second payment.
    if payment.status is PaymentStatus.SUCCEEDED:
        return _back_to("paid", invoice=payment.invoice_id)

    payment.gateway_code = response.get("pp_ResponseCode")
    payment.gateway_message = response.get("pp_ResponseMessage")
    payment.completed_at = utcnow()

    if not jazzcash.succeeded(response):
        payment.status = PaymentStatus.FAILED
        await db.flush()
        return _back_to("failed", invoice=payment.invoice_id)

    payment.status = PaymentStatus.SUCCEEDED

    invoice = await db.get(Invoice, payment.invoice_id)
    if invoice is not None:
        service.mark_paid(invoice)

    await db.flush()

    # Audited against the patient, not the caller: there is no caller here, and
    # the trail's question is whose bill was settled.
    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.INVOICE_UPDATED,
            user_id=None,
            actor_role=None,
            entity_type="Payment",
            entity_id=payment.id,
            patient_id=invoice.patient_id if invoice else None,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={
                "operation": "gateway_callback",
                "method": "JAZZCASH",
                "invoiceId": payment.invoice_id,
                "amount": str(payment.amount),
                # The gateway's own code, so a reconciliation can match ours to
                # theirs. Never the rest of the callback: it carries payer
                # detail this log has no business keeping.
                "gatewayCode": payment.gateway_code,
            },
        ),
    )

    return _back_to("paid", invoice=payment.invoice_id)

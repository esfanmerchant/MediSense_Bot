"""A doctor asking for their money, and somebody sending it.

The mirror of the patient side, and deliberately the same shape: a request with
details attached, a person who acts on it, and evidence of what they did. Money
does not move by itself in either direction here, and both directions leave a
screenshot behind.

Who may do what is the one thing worth stating plainly. A doctor sees their own
balance, their own statement and their own requests, and nothing else — the
endpoints below derive the doctor from the session rather than taking an id, so
there is no parameter to tamper with. An administrator sees the queue and
decides; they cannot request on anyone's behalf.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.config import settings
from app.core.errors import bad_request, forbidden, not_found
from app.core.logging import logger
from app.db.base import utcnow
from app.db.enums import (
    AuditAction,
    NotificationType,
    Role,
    UserStatus,
    WithdrawalMethod,
    WithdrawalStatus,
)
from app.db.models import Doctor, DoctorLedgerEntry, User, Withdrawal
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.billing import earnings
from app.modules.notifications.service import notify
from app.services import email as email_service
from app.services import email_templates, storage
from app.services.files import FileRejectedError, inspect_upload

router = APIRouter(prefix="/withdrawals", tags=["billing"])

RequireInvoiceManage = Annotated[
    object, Depends(require_permission(Permission.INVOICE_MANAGE))
]

#: The receipt an administrator attaches. Same limits as a patient's proof, for
#: the same reason: it is a screenshot of a banking app, and a format the page
#: cannot render is evidence nobody can check without downloading it first.
MAX_PROOF_BYTES = 5 * 1024 * 1024
PROOF_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})


class WithdrawalRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True)

    amount: Annotated[Decimal, Field(gt=0, le=10_000_000)]
    method: WithdrawalMethod
    #: Checked by the administrator against the account they are sending to, so
    #: a mistyped name is caught before the money is, not after.
    account_name: Annotated[str, Field(min_length=2, max_length=160)] = Field(
        alias="accountName"
    )
    account_number: Annotated[str, Field(min_length=5, max_length=64)] = Field(
        alias="accountNumber"
    )
    #: A bank needs naming; a wallet is identified by its number alone.
    bank_name: Annotated[str, Field(max_length=120)] | None = Field(
        default=None, alias="bankName"
    )


class RejectRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    reason: Annotated[str, Field(min_length=3, max_length=500)]


def _own_doctor_id(auth: CurrentAuth) -> str:
    if auth.role != Role.DOCTOR or not auth.doctor_id:
        raise forbidden("This is for doctors.")
    return auth.doctor_id


async def _signed_proof(withdrawal: Withdrawal) -> str | None:
    """A short-lived link to the receipt, or None. Never raises."""
    if not withdrawal.proof_path:
        return None
    try:
        return await storage.signed_url(
            settings.SUPABASE_PAYMENT_PROOFS_BUCKET, withdrawal.proof_path
        )
    except Exception as exc:
        logger.warning("withdrawal_proof_sign_failed", error=type(exc).__name__)
        return None


# ---------------------------------------------------------------------------
# The doctor's side
# ---------------------------------------------------------------------------


@router.get("/me")
async def my_earnings(
    auth: CurrentAuth, db: DbSession, page: Annotated[Page, Depends(pagination)]
) -> dict[str, Any]:
    """Balance, statement and requests — everything a doctor's money page needs.

    One endpoint rather than three, because the three are never useful apart:
    a balance with no statement behind it is a number to be argued with.
    """
    doctor_id = _own_doctor_id(auth)

    available = await earnings.balance(db, doctor_id)

    total = (
        await db.execute(
            select(func.count(DoctorLedgerEntry.id)).where(
                DoctorLedgerEntry.doctor_id == doctor_id
            )
        )
    ).scalar_one()

    entries = (
        (
            await db.execute(
                select(DoctorLedgerEntry)
                .where(DoctorLedgerEntry.doctor_id == doctor_id)
                .order_by(DoctorLedgerEntry.created_at.desc())
                .limit(page.limit)
                .offset(page.offset)
            )
        )
        .scalars()
        .all()
    )

    requests = (
        (
            await db.execute(
                select(Withdrawal)
                .where(Withdrawal.doctor_id == doctor_id)
                .order_by(Withdrawal.created_at.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )
    urls = await asyncio.gather(*(_signed_proof(row) for row in requests))

    #: Everything earned, before anything was taken out — so a doctor can see
    #: the difference between "I have earned little" and "I have withdrawn a lot".
    earned = (
        await db.execute(
            select(func.coalesce(func.sum(DoctorLedgerEntry.amount), 0)).where(
                DoctorLedgerEntry.doctor_id == doctor_id,
                DoctorLedgerEntry.amount > 0,
            )
        )
    ).scalar_one()

    return ok(
        {
            "balance": str(available),
            "lifetimeEarned": str(earned),
            "currency": settings.INVOICE_CURRENCY,
            "minimumWithdrawal": str(earnings.MINIMUM_WITHDRAWAL),
            "canWithdraw": available >= earnings.MINIMUM_WITHDRAWAL,
            "entries": [earnings.serialize_entry(entry) for entry in entries],
            "withdrawals": [
                earnings.serialize_withdrawal(row, proof_url=url)
                for row, url in zip(requests, urls, strict=True)
            ],
        },
        page.meta(total),
    )


@router.post("", status_code=201)
async def request_withdrawal(
    payload: WithdrawalRequest, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Ask for a payout. The amount is held against the balance immediately."""
    doctor_id = _own_doctor_id(auth)

    if payload.method is WithdrawalMethod.BANK and not payload.bank_name:
        raise bad_request("Name the bank for a bank transfer.")

    withdrawal = await earnings.request_withdrawal(
        db,
        doctor_id=doctor_id,
        amount=payload.amount,
        method=payload.method,
        account_name=payload.account_name,
        account_number=payload.account_number,
        bank_name=payload.bank_name,
        currency=settings.INVOICE_CURRENCY,
    )

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.INVOICE_UPDATED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="Withdrawal",
            entity_id=withdrawal.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={
                "operation": "withdrawal_requested",
                "amount": str(withdrawal.amount),
                "method": str(withdrawal.method),
            },
        ),
    )

    await _tell_administrators(db, withdrawal, auth.user_id)
    return ok(earnings.serialize_withdrawal(withdrawal))


async def _tell_administrators(
    db: DbSession, withdrawal: Withdrawal, doctor_user_id: str
) -> None:
    """A payout only happens if a person makes it, so a person has to be told."""
    doctor_name = (
        await db.execute(select(User.name).where(User.id == doctor_user_id))
    ).scalar_one_or_none() or "A doctor"

    admins = (
        (
            await db.execute(
                select(User).where(User.role == Role.ADMIN, User.status == UserStatus.ACTIVE)
            )
        )
        .scalars()
        .all()
    )

    message = email_templates.admin_withdrawal_requested(
        doctor_name=doctor_name,
        currency=withdrawal.currency,
        amount=str(withdrawal.amount),
        method=str(withdrawal.method),
        account=withdrawal.account_number,
    )
    for admin in admins:
        await notify(
            db,
            user_id=admin.id,
            notification_type=NotificationType.INVOICE_ISSUED,
            title="A doctor has requested a withdrawal",
            body=f"{doctor_name} requested {withdrawal.currency} {withdrawal.amount}.",
            link="/admin/withdrawals",
            email=False,
        )
        await email_service.send(
            to=admin.email,
            subject=message.subject,
            text_body=message.text,
            html_body=message.html,
        )


# ---------------------------------------------------------------------------
# The administrator's side
# ---------------------------------------------------------------------------


@router.get("/pending")
async def pending_withdrawals(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    _: RequireInvoiceManage,
) -> dict[str, Any]:
    """Requests waiting to be paid, oldest first — this is a work queue."""
    base = (
        select(Withdrawal, User.name)
        .join(Doctor, Doctor.id == Withdrawal.doctor_id)
        .join(User, User.id == Doctor.user_id)
        .where(Withdrawal.status == WithdrawalStatus.REQUESTED)
    )
    total = (
        await db.execute(
            select(func.count(Withdrawal.id)).where(
                Withdrawal.status == WithdrawalStatus.REQUESTED
            )
        )
    ).scalar_one()

    rows = (
        await db.execute(
            base.order_by(Withdrawal.created_at.asc()).limit(page.limit).offset(page.offset)
        )
    ).all()

    return ok(
        [
            {**earnings.serialize_withdrawal(row), "doctorName": name}
            for row, name in rows
        ],
        page.meta(total),
    )


@router.post("/{withdrawal_id}/paid")
async def mark_paid(
    withdrawal_id: str,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireInvoiceManage,
    reference: Annotated[str, Form(max_length=120)] = "",
    file: Annotated[UploadFile | None, File()] = None,
) -> dict[str, Any]:
    """Record that the money has been sent, with the receipt.

    The screenshot is optional in the schema and expected in practice: a payout
    with no evidence is a claim, and this system asks a patient for proof on the
    way in. Refusing the request outright would leave an administrator who paid
    by a route that produces no screenshot unable to close it at all, so it is
    allowed and its absence is visible on the record.

    The held debit is *not* touched. It was written when the doctor asked, the
    money has now genuinely left, and the balance was correct all along.
    """
    withdrawal = (
        await db.execute(select(Withdrawal).where(Withdrawal.id == withdrawal_id))
    ).scalar_one_or_none()
    if withdrawal is None:
        raise not_found("No such withdrawal.")
    if withdrawal.status is not WithdrawalStatus.REQUESTED:
        raise bad_request("This withdrawal has already been dealt with.")

    if file is not None and file.filename:
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
            raise bad_request("Upload the receipt as a JPEG, PNG or WebP image.")

        bucket = settings.SUPABASE_PAYMENT_PROOFS_BUCKET
        path = f"withdrawals/{withdrawal.id}{inspected.extension}"
        await storage.upload(bucket, path, content, inspected.detected_mime)
        withdrawal.proof_path = path

    withdrawal.status = WithdrawalStatus.PAID
    withdrawal.reference = reference.strip() or None
    withdrawal.reviewed_by_id = auth.user_id
    withdrawal.reviewed_at = utcnow()
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.INVOICE_UPDATED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="Withdrawal",
            entity_id=withdrawal.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={
                "operation": "withdrawal_paid",
                "amount": str(withdrawal.amount),
                "method": str(withdrawal.method),
                "reference": withdrawal.reference,
                "hasProof": withdrawal.proof_path is not None,
            },
        ),
    )

    await _tell_the_doctor(db, withdrawal, paid=True)
    return ok(earnings.serialize_withdrawal(withdrawal))


@router.post("/{withdrawal_id}/reject")
async def reject_withdrawal(
    withdrawal_id: str,
    payload: RejectRequest,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireInvoiceManage,
) -> dict[str, Any]:
    """Refuse a request and hand the money back to the balance."""
    withdrawal = (
        await db.execute(select(Withdrawal).where(Withdrawal.id == withdrawal_id))
    ).scalar_one_or_none()
    if withdrawal is None:
        raise not_found("No such withdrawal.")
    if withdrawal.status is not WithdrawalStatus.REQUESTED:
        raise bad_request("This withdrawal has already been dealt with.")

    withdrawal.status = WithdrawalStatus.REJECTED
    withdrawal.rejection_reason = payload.reason
    withdrawal.reviewed_by_id = auth.user_id
    withdrawal.reviewed_at = utcnow()
    await db.flush()

    # The held amount goes back, as a reversing entry rather than by deleting
    # the debit: the ledger records what happened, not what was left over.
    await earnings.release_hold(db, withdrawal)

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.INVOICE_UPDATED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="Withdrawal",
            entity_id=withdrawal.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={
                "operation": "withdrawal_rejected",
                "amount": str(withdrawal.amount),
                "reason": payload.reason,
            },
        ),
    )

    await _tell_the_doctor(db, withdrawal, paid=False)
    return ok(earnings.serialize_withdrawal(withdrawal))


async def _tell_the_doctor(db: DbSession, withdrawal: Withdrawal, *, paid: bool) -> None:
    """Say what happened to the money, either way.

    A refusal matters more than a payment here: the doctor's balance has just
    changed twice and they need to know the amount came back rather than went
    missing.
    """
    row = (
        await db.execute(
            select(Doctor.user_id, User.name, User.email)
            .join(User, User.id == Doctor.user_id)
            .where(Doctor.id == withdrawal.doctor_id)
        )
    ).first()
    if row is None:
        return
    user_id, name, address = row

    message = (
        email_templates.doctor_withdrawal_paid(
            name=name,
            currency=withdrawal.currency,
            amount=str(withdrawal.amount),
            account=withdrawal.account_number,
            reference=withdrawal.reference,
        )
        if paid
        else email_templates.doctor_withdrawal_rejected(
            name=name,
            currency=withdrawal.currency,
            amount=str(withdrawal.amount),
            reason=withdrawal.rejection_reason or "",
        )
    )

    await notify(
        db,
        user_id=user_id,
        notification_type=NotificationType.INVOICE_ISSUED,
        title="Your withdrawal was paid" if paid else "Your withdrawal was not paid",
        body=(
            f"{withdrawal.currency} {withdrawal.amount} sent to {withdrawal.account_number}."
            if paid
            else f"{withdrawal.currency} {withdrawal.amount} has been returned to your balance."
        ),
        link="/doctor/earnings",
        email=False,
    )
    await email_service.send(
        to=address,
        subject=message.subject,
        text_body=message.text,
        html_body=message.html,
    )

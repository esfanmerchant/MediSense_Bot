"""What a doctor is owed, and getting it to them.

**The split.** A bill is not all the doctor's. The consultation fee is what they
charged and what they are paid; the platform fee, the tax and any late charge
belong to the hospital — the platform fee is the hospital's cut by definition,
tax is collected on the state's behalf and passing it to a doctor would be
handing over somebody else's money, and a late charge compensates the hospital
for chasing a bill the doctor had no part in. So the doctor's share is
``invoice.amount``, the consultation fee exactly, and that is written in one
place here rather than assumed at each call site.

**The balance is a sum, never a stored number.** Every movement is a signed
entry naming its cause, and the balance is their total. A stored balance is one
bad write away from being wrong with nothing to compare it against and no way to
answer "wrong since when"; this can be recomputed at any time, and a mistake is
a correcting entry rather than an edit to a figure somebody is owed.

**A withdrawal is held at request, not at payment.** The debit lands the moment
a doctor asks, so the same money cannot be requested twice while the first
request sits in the queue. A refusal writes a reversing credit rather than
deleting the debit, because the ledger should read as what happened.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import bad_request
from app.core.logging import logger
from app.db.base import new_id
from app.db.enums import LedgerEntryKind, WithdrawalStatus
from app.db.models import DoctorLedgerEntry, Invoice, Withdrawal

#: The least a doctor may take out at once.
#:
#: A floor rather than no floor because each payout is a manual transfer somebody
#: at the hospital makes by hand: a queue of fifty-rupee requests costs more in
#: attention than it moves in money. It is not a fee — nothing is deducted, the
#: balance simply has to reach this before it can be asked for.
MINIMUM_WITHDRAWAL = Decimal("1000.00")


def doctor_share(invoice: Invoice) -> Decimal:
    """The part of one bill that belongs to the treating doctor.

    The consultation fee, and only that. See this module's own docstring for
    why the platform fee, the tax and the late charge stay with the hospital.
    """
    return Decimal(invoice.amount)


async def balance(db: AsyncSession, doctor_id: str) -> Decimal:
    """What this doctor can withdraw right now.

    A sum over the ledger, so it is always derivable and never drifts. Money
    already held against a pending withdrawal is a debit and is therefore
    already excluded — the figure is what is *available*, not what was earned.
    """
    total = (
        await db.execute(
            select(func.coalesce(func.sum(DoctorLedgerEntry.amount), 0)).where(
                DoctorLedgerEntry.doctor_id == doctor_id
            )
        )
    ).scalar_one()
    return Decimal(total)


async def credit_for_invoice(
    db: AsyncSession, *, invoice: Invoice, doctor_id: str, patient_name: str
) -> DoctorLedgerEntry | None:
    """Credit a doctor for a bill that has just been paid.

    Returns the entry, or ``None`` when one already existed — which is the
    normal outcome of a repeated confirmation and is not an error.

    The database refuses a second earning against one invoice through a partial
    unique index, and that refusal is caught here rather than prevented by a
    prior read: two confirmations arriving together would both find nothing and
    both insert. Letting the index decide is the only version that is actually
    safe, and paying a doctor twice for one consultation is exactly the kind of
    mistake nobody notices until reconciliation.
    """
    entry = DoctorLedgerEntry(
        id=new_id(),
        doctor_id=doctor_id,
        amount=doctor_share(invoice),
        currency=invoice.currency,
        kind=LedgerEntryKind.EARNING,
        description=f"Consultation for {patient_name} · {invoice.invoice_number}",
        invoice_id=invoice.id,
    )

    try:
        async with db.begin_nested():
            db.add(entry)
            await db.flush()
    except IntegrityError:
        logger.info("doctor_earning_already_credited", invoice_id=invoice.id)
        return None

    return entry


async def request_withdrawal(
    db: AsyncSession,
    *,
    doctor_id: str,
    amount: Decimal,
    method: Any,
    account_name: str,
    account_number: str,
    bank_name: str | None,
    currency: str,
) -> Withdrawal:
    """Ask for money out, and hold it against the balance immediately.

    Refuses before it holds anything: below the minimum, more than is
    available, or while an earlier request is still waiting. That last one is
    not strictly necessary — the balance check would catch the double-spend on
    its own — but two open requests to the same doctor is a queue an
    administrator has to reason about, and there is no reason to create one.
    """
    if amount < MINIMUM_WITHDRAWAL:
        raise bad_request(
            f"The smallest withdrawal is {currency} {MINIMUM_WITHDRAWAL:.0f}."
        )

    pending = (
        await db.execute(
            select(Withdrawal).where(
                Withdrawal.doctor_id == doctor_id,
                Withdrawal.status == WithdrawalStatus.REQUESTED,
            )
        )
    ).scalar_one_or_none()
    if pending is not None:
        raise bad_request("You already have a withdrawal waiting to be paid.")

    available = await balance(db, doctor_id)
    if amount > available:
        raise bad_request(f"You have {currency} {available} available.")

    withdrawal = Withdrawal(
        id=new_id(),
        doctor_id=doctor_id,
        amount=amount,
        currency=currency,
        method=method,
        account_name=account_name,
        account_number=account_number,
        bank_name=bank_name,
        status=WithdrawalStatus.REQUESTED,
    )
    db.add(withdrawal)
    await db.flush()

    # Held now, not when it is paid: otherwise the same balance can be asked
    # for again while this request is still in the queue.
    db.add(
        DoctorLedgerEntry(
            id=new_id(),
            doctor_id=doctor_id,
            amount=-amount,
            currency=currency,
            kind=LedgerEntryKind.WITHDRAWAL,
            description=f"Withdrawal to {account_number}",
            withdrawal_id=withdrawal.id,
        )
    )
    await db.flush()
    return withdrawal


async def release_hold(db: AsyncSession, withdrawal: Withdrawal) -> None:
    """Hand back money held against a withdrawal that was refused.

    A reversing credit rather than deleting the debit. The ledger is a record of
    what happened, and "asked for, refused, returned" is three facts a doctor
    querying their balance is entitled to see — deleting the first two would
    leave them looking at a number that had moved twice for no stated reason.
    """
    db.add(
        DoctorLedgerEntry(
            id=new_id(),
            doctor_id=withdrawal.doctor_id,
            amount=withdrawal.amount,
            currency=withdrawal.currency,
            kind=LedgerEntryKind.WITHDRAWAL_REVERSAL,
            description="Withdrawal was not paid — amount returned",
            withdrawal_id=withdrawal.id,
        )
    )
    await db.flush()


def serialize_entry(entry: DoctorLedgerEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "amount": str(entry.amount),
        "currency": entry.currency,
        "kind": str(entry.kind),
        "description": entry.description,
        "invoiceId": entry.invoice_id,
        "withdrawalId": entry.withdrawal_id,
        "createdAt": entry.created_at.isoformat() + "Z" if entry.created_at else None,
    }


def serialize_withdrawal(
    withdrawal: Withdrawal, *, proof_url: str | None = None
) -> dict[str, Any]:
    return {
        "id": withdrawal.id,
        "amount": str(withdrawal.amount),
        "currency": withdrawal.currency,
        "method": str(withdrawal.method),
        "accountName": withdrawal.account_name,
        "accountNumber": withdrawal.account_number,
        "bankName": withdrawal.bank_name,
        "status": str(withdrawal.status),
        "reference": withdrawal.reference,
        "hasProof": withdrawal.proof_path is not None,
        "proofUrl": proof_url,
        "rejectionReason": withdrawal.rejection_reason,
        "createdAt": withdrawal.created_at.isoformat() + "Z" if withdrawal.created_at else None,
        "reviewedAt": withdrawal.reviewed_at.isoformat() + "Z" if withdrawal.reviewed_at else None,
    }

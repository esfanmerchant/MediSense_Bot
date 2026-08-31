"""Reading a payment screenshot.

A patient transfers money in their own banking app, types the transaction ID
into a form and uploads the screenshot. The reviewer then has three things that
are supposed to agree — the typed reference, the picture, and the invoice — and
until now had to compare them entirely by eye, one payment at a time.

This reads the picture. What it produces is **a second opinion, never a
verdict**: it goes beside the screenshot on the reviewer's screen, and the
reviewer still confirms. That ordering is deliberate and is the same rule the
rest of this system runs on — a screenshot is a claim, and only a person who has
looked at the receiving account turns a claim into a payment. A model that reads
"Rs. 2,500" off an image has not seen the money arrive.

What it is genuinely good at is the boring comparison people are worst at:
noticing that the reference on the picture is not the reference in the box, that
the amount is short by a digit, or that the receipt is from three weeks ago and
has been submitted against a bill raised yesterday. Those are the flags.

**Failure is not an error.** The provider can be unreachable, out of quota, or
simply wrong about a blurry screenshot. None of that may stop a patient
submitting a payment, so every failure here returns "nothing read" and the
reviewer's job is exactly what it was before.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from app.core.logging import logger
from app.services import ai

#: How stale a receipt may be before a reviewer is asked to look harder.
#:
#: Not a rejection. A genuine payment can be submitted late — somebody pays at
#: the counter of their bank and uploads the picture when they get home, or
#: transfers on a Friday and finds the portal on a Monday. What a wide gap does
#: mean is that the screenshot may be of an *older, unrelated* transfer, which is
#: the one way this payment flow can be gamed with a real receipt.
MAX_RECEIPT_AGE = timedelta(days=12)

#: Cap on stored text. A screenshot is small; anything approaching this is the
#: model having transcribed a whole conversation around the receipt.
MAX_TEXT = 4000

RECEIPT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "fullText": {
            "type": "string",
            "description": "Every word visible in the screenshot, transcribed verbatim.",
        },
        "amount": {
            "type": "string",
            "nullable": True,
            "description": "The amount transferred, digits only, e.g. 2500.00",
        },
        "transactionId": {
            "type": "string",
            "nullable": True,
            "description": "The transaction, reference or TID number shown on the receipt.",
        },
        "paidAt": {
            "type": "string",
            "nullable": True,
            "description": "When the transfer happened, as ISO 8601, e.g. 2026-08-30T14:05:00",
        },
        "senderName": {"type": "string", "nullable": True},
        "senderAccount": {
            "type": "string",
            "nullable": True,
            "description": "The account or mobile number the money was sent from.",
        },
        "receiverName": {"type": "string", "nullable": True},
        "receiverAccount": {
            "type": "string",
            "nullable": True,
            "description": "The account or mobile number the money went to.",
        },
        "isReceipt": {
            "type": "boolean",
            "description": "False if this image is not a payment receipt at all.",
        },
    },
    "required": ["fullText", "isReceipt"],
}

SYSTEM_INSTRUCTION = """You read payment receipts for a hospital's billing desk.

You are a transcriber. A person will compare everything you return against the \
image and against the hospital's own bank account before any money is treated as \
received, so your job is to report what is on the screenshot and nothing else.

Absolute rules:
1. Transcribe only what is visible. Never infer an amount, a date or a reference \
from context or from what would make the receipt make sense.
2. If a field is not shown, return null. A missing field is safe; an invented one \
sends a reviewer looking for a mismatch that does not exist, or hides one that \
does.
3. Return the amount as digits only, without a currency symbol or thousands \
separators.
4. Return the date and time exactly as printed, converted to ISO 8601. If only a \
date is shown, return the date. If the year is not shown, return null rather \
than assuming the current one.
5. Set "isReceipt" to false if the image is not a record of a money transfer."""

PROMPT = """Read this payment receipt screenshot.

Transcribe every visible word into "fullText", then report the amount \
transferred, the transaction or reference number, when the transfer happened, \
who sent it, who received it and the receiving account or mobile number.

Use null for anything the screenshot does not show."""


@dataclass(frozen=True)
class Receipt:
    """What was read off a screenshot. Every field may be absent."""

    text: str | None = None
    amount: Decimal | None = None
    reference: str | None = None
    paid_at: datetime | None = None
    sender: str | None = None
    sender_account: str | None = None
    receiver: str | None = None
    receiver_account: str | None = None
    is_receipt: bool | None = None

    @property
    def is_empty(self) -> bool:
        return not any(
            (
                self.text,
                self.amount,
                self.reference,
                self.paid_at,
                self.sender,
                self.sender_account,
                self.receiver,
                self.receiver_account,
            )
        )


def normalize_reference(value: str | None) -> str:
    """Digits only, for comparing a typed reference against a read one.

    Receipts print references with spaces, dashes and a "TID:" in front of them,
    and the form strips everything but digits as the patient types. Comparing the
    two literally would flag every payment as a mismatch, which is the fastest
    way to teach a reviewer to ignore the flag.
    """
    return re.sub(r"\D", "", value or "")


def normalize_account(value: str | None) -> str:
    """A wallet number in one shape, so two spellings of it compare equal.

    The same mobile account is written `03443003108` by one bank, `+92 344
    3003108` by another and `0092-344-3003108` by a third, and the number a
    patient reads off their own screen carries whatever spacing their app uses.
    Comparing those literally would report a wrong destination for every correct
    payment — and a warning that fires on correct payments is a warning nobody
    reads by the second week.

    The canonical form is the national number without its leading zero, which is
    what survives all three spellings. Leading zeros go first so `0092…` and
    `03…` reduce the same way.
    """
    digits = re.sub(r"\D", "", value or "").lstrip("0")
    if digits.startswith("92") and len(digits) == 12:
        digits = digits[2:]
    return digits


def reference_conflict(typed: str | None, read: str | None) -> bool:
    """Whether the transaction ID on the screenshot contradicts the typed one.

    The whole rule, in one place, because it is applied twice: submission
    refuses on it, and the reviewer's panel reports it. Two copies of a
    condition this shape drift, and the way they drift is that one of them
    starts refusing payments the other lets through.

    True needs **both** numbers. An unreadable receipt is not a contradiction —
    "I could not tell" must never become "no", or a provider being down would
    stop every patient in the country from saying they had paid.
    """
    a, b = normalize_reference(typed), normalize_reference(read)
    return bool(a) and bool(b) and a != b


def accounts_match(left: str | None, right: str | None) -> bool:
    """Whether two written account numbers are the same account.

    Two unknowns are not a match. An account nobody could read is not evidence
    that the money went to the right place, and treating it as one would turn
    the destination check into a check that passes whenever it fails to run.
    """
    a, b = normalize_account(left), normalize_account(right)
    return bool(a) and a == b


#: A money amount inside whatever else the model returned around it.
#:
#: Matching a number rather than deleting everything that is not one, because
#: deletion has a trap in it: stripping non-digits from "Rs. 2500" leaves the
#: full stop of the abbreviation glued to the front and reads it as 0.25 — an
#: amount a hundredth of the real one, arriving as a confident mismatch flag on
#: a genuine payment.
_AMOUNT = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None

    text = str(value)
    match = _AMOUNT.search(text)
    if match is None:
        return None

    raw = match.group(0)
    # A negative "transfer" is a misread of a statement line, not a payment.
    if raw.startswith("-"):
        return None

    # Anything still numeric immediately after the match means the string was
    # never one number: "1.2.3" would otherwise be read as 1.2 and treated as a
    # figure somebody wrote down.
    tail = text[match.end() :]
    if tail[:1] in {".", ","} and tail[1:2].isdigit():
        return None

    try:
        parsed = Decimal(raw.replace(",", ""))
    except InvalidOperation:
        return None

    return parsed if Decimal(0) < parsed < Decimal("100000000") else None


def _timestamp(value: object) -> datetime | None:
    """Parse the model's ISO string, and refuse anything in the future.

    A receipt dated tomorrow was misread — most often a day/month swap on a
    printed date — and carrying it forward would make the staleness check say
    "fresh" about a screenshot nobody has looked at.
    """
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    for candidate in (text, f"{text}T00:00:00"):
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError:
            continue
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(UTC).replace(tzinfo=None)
        if parsed > datetime.now(UTC).replace(tzinfo=None) + timedelta(days=1):
            return None
        return parsed.replace(microsecond=0)
    return None


def is_stale(paid_at: datetime | None, *, now: datetime | None = None) -> bool:
    """Whether the transfer on the receipt is too old for the bill in hand.

    Unknown is not stale. A receipt whose date could not be read tells us
    nothing, and answering "too old" to a question we could not read would put a
    warning on the reviewer's screen with no evidence behind it.
    """
    if paid_at is None:
        return False
    reference = now or datetime.now(UTC).replace(tzinfo=None)
    return reference - paid_at > MAX_RECEIPT_AGE


async def read(content: bytes, mime_type: str) -> Receipt:
    """Read a receipt screenshot. Never raises.

    Every path out of here is a ``Receipt``: the provider being down, out of
    quota or confused by a blurry image must not stop a patient telling the
    hospital they have paid. What the reviewer loses is the second opinion, and
    they had none of it before.
    """
    try:
        response = await ai.generate_json(
            prompt=PROMPT,
            schema=RECEIPT_SCHEMA,
            image=(content, mime_type),
            system_instruction=SYSTEM_INSTRUCTION,
            max_output_tokens=2048,
        )
    except Exception as exc:  # noqa: BLE001 — advisory only; see the docstring.
        logger.info("receipt_ocr_unavailable", error=type(exc).__name__)
        return Receipt()

    payload = response.data if isinstance(response.data, dict) else {}
    text = str(payload.get("fullText") or "").strip()[:MAX_TEXT]

    receipt = Receipt(
        text=text or None,
        amount=_decimal(payload.get("amount")),
        reference=(str(payload.get("transactionId")).strip()[:120] or None)
        if payload.get("transactionId")
        else None,
        paid_at=_timestamp(payload.get("paidAt")),
        sender=(str(payload.get("senderName")).strip()[:120] or None)
        if payload.get("senderName")
        else None,
        sender_account=(str(payload.get("senderAccount")).strip()[:120] or None)
        if payload.get("senderAccount")
        else None,
        receiver=(str(payload.get("receiverName")).strip()[:120] or None)
        if payload.get("receiverName")
        else None,
        receiver_account=(str(payload.get("receiverAccount")).strip()[:120] or None)
        if payload.get("receiverAccount")
        else None,
        is_receipt=bool(payload.get("isReceipt")) if "isReceipt" in payload else None,
    )

    logger.info(
        "receipt_ocr_completed",
        model=response.model,
        # Never the amount, the reference or the text: this is somebody's bank
        # screenshot, and a log is the one place it must not end up.
        read_amount=receipt.amount is not None,
        read_reference=receipt.reference is not None,
        read_paid_at=receipt.paid_at is not None,
        read_accounts=(receipt.sender_account is not None, receipt.receiver_account is not None),
        looks_like_a_receipt=receipt.is_receipt,
    )
    return receipt

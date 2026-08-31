"""The JazzCash hosted checkout: signing a request, and trusting a response.

JazzCash's redirect flow is a signed form post. This module does the two things
that actually carry risk — building the signature, and checking the one that
comes back — and nothing else. It touches no database and makes no network call:
the browser posts the form, the payer authorises on JazzCash's own page, and
JazzCash posts them back to us. There is no HTTP client here because there is no
request for us to make.

**The integrity salt is the whole security model.** It is a shared secret, and
the hash it produces is what tells JazzCash a request really came from this
merchant and tells us a response really came from JazzCash. Two consequences run
through everything below: the salt never leaves the server, and a response whose
hash does not verify is discarded rather than investigated. An unsigned "payment
succeeded" is not a payment that needs looking into; it is somebody trying it on.

Amounts are in **paisa**, as whole numbers. JazzCash takes no decimal point, and
sending rupees where paisa are expected undercharges by a factor of a hundred —
so the conversion lives here, once, next to the field it applies to.
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from app.core.config import settings

#: JazzCash's own timestamp format. Local time, no zone, no separator.
STAMP = "%Y%m%d%H%M%S"

#: How long a started payment stays valid. Long enough to find a phone and
#: approve a push notification; short enough that an abandoned attempt does not
#: sit open for a day.
EXPIRY_MINUTES = 30

#: The response code that means the money moved. Everything else is a failure
#: with a message worth showing the payer.
SUCCESS_CODE = "000"


def to_paisa(amount: Decimal) -> str:
    """Rupees to whole paisa.

    Rounded half-up rather than truncated: dropping a fraction of a paisa in the
    payer's favour on every transaction is a rounding error that only ever costs
    the hospital.
    """
    paisa = (Decimal(amount) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return str(int(paisa))


def _signature(fields: dict[str, str]) -> str:
    """HMAC-SHA256 over the fields, in the order JazzCash specifies.

    The order is not ours to choose: keys sorted, values joined with ``&``, the
    salt in front. Getting any part of that wrong produces a hash that is
    perfectly valid and that JazzCash rejects, with an error that names nothing
    — which is why this is one function used for both signing and verifying,
    rather than the same rule written out twice and drifting.

    Empty values are excluded, because JazzCash excludes them, and a field we
    left blank would otherwise contribute an empty segment they never saw.
    """
    ordered = [fields[key] for key in sorted(fields) if fields[key] != ""]
    message = "&".join([settings.JAZZCASH_INTEGRITY_SALT, *ordered])
    return hmac.new(
        settings.JAZZCASH_INTEGRITY_SALT.encode(),
        message.encode(),
        hashlib.sha256,
    ).hexdigest().upper()


def build_request(
    *,
    reference: str,
    amount: Decimal,
    description: str,
    bill_reference: str,
    now: datetime | None = None,
) -> dict[str, str]:
    """The complete, signed set of fields for the checkout form.

    The caller posts these to :attr:`Settings.jazzcash_endpoint` from the
    payer's browser. Everything secret has already been consumed here: the
    password is a merchant field JazzCash requires in the form, the salt only
    ever appears inside the hash.
    """
    started = now or datetime.now()

    fields = {
        "pp_Version": "1.1",
        # The hosted page that offers both a mobile wallet and a card.
        "pp_TxnType": "MWALLET",
        "pp_Language": "EN",
        "pp_MerchantID": settings.JAZZCASH_MERCHANT_ID,
        "pp_SubMerchantID": "",
        "pp_Password": settings.JAZZCASH_PASSWORD,
        "pp_BankID": "",
        "pp_ProductID": "",
        "pp_TxnRefNo": reference,
        "pp_Amount": to_paisa(amount),
        "pp_TxnCurrency": "PKR",
        "pp_TxnDateTime": started.strftime(STAMP),
        "pp_BillReference": bill_reference,
        "pp_Description": description,
        "pp_TxnExpiryDateTime": (started + timedelta(minutes=EXPIRY_MINUTES)).strftime(STAMP),
        "pp_ReturnURL": settings.JAZZCASH_RETURN_URL,
        "ppmpf_1": "",
        "ppmpf_2": "",
        "ppmpf_3": "",
        "ppmpf_4": "",
        "ppmpf_5": "",
    }

    fields["pp_SecureHash"] = _signature(fields)
    return fields


def verify(response: dict[str, str]) -> bool:
    """Whether this response genuinely came from JazzCash.

    The hash is recomputed over everything *except* the hash itself and compared
    in constant time. ``hmac.compare_digest`` rather than ``==`` because a plain
    comparison returns as soon as two bytes differ, and the time it takes is a
    measurable clue to how much of a forged hash was right.

    A missing hash is a failure, not an absence: a response with no signature is
    exactly what an attacker posting straight to the callback would send.
    """
    provided = response.get("pp_SecureHash", "")
    if not provided:
        return False

    fields = {k: v for k, v in response.items() if k != "pp_SecureHash"}
    return hmac.compare_digest(_signature(fields).upper(), provided.upper())


def succeeded(response: dict[str, str]) -> bool:
    """Whether the money actually moved. Only meaningful after :func:`verify`."""
    return response.get("pp_ResponseCode", "") == SUCCESS_CODE

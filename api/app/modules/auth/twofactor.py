"""The mechanics of one-time codes, TOTP and backup codes.

Pure functions with no database and no request context, so every rule that
decides whether a code is accepted can be tested exhaustively and in
milliseconds — which is the difference between checking this on every change and
checking it once.

Three decisions are worth stating outright.

**Codes are hashed with the same primitive as passwords.** A six-digit code has
a million possibilities, so a stolen SHA-256 of one is trivially reversible; a
scrypt hash of it is not, and the cost is paid once per verification rather than
per request. The comparison itself is constant time (``verify_password`` ends in
``hmac.compare_digest``), so a code cannot be recovered a digit at a time.

**Backup codes are single use and are stored only as hashes.** Consuming one
removes its hash from the array, so "already used" is a property of the stored
data rather than a flag somebody has to remember to set.

**Masking is done on the local part only.** ``sentTo`` exists so a person can
tell *which* of their addresses a code went to. Showing the whole thing would
turn an unauthenticated endpoint into a way of reading a stranger's email
address out of a leaked password.
"""

from __future__ import annotations

import secrets

import pyotp
import segno

from app.core.security import hash_password, verify_password

#: Six digits is what people are used to typing and what every authenticator
#: shows. The strength comes from the expiry and the attempt limit, not the
#: length: five guesses in ten minutes against a million values is not an attack.
CODE_LENGTH = 6

#: Emailed codes expire in ten minutes — long enough for a mail server to be
#: slow, short enough that a message left open on a shared screen is stale.
EMAIL_CODE_TTL_MINUTES = 10

#: A login challenge is much shorter lived: the person is sitting at the form.
CHALLENGE_TTL_MINUTES = 5

MAX_VERIFICATION_ATTEMPTS = 5

BACKUP_CODE_COUNT = 8
#: Ten hex characters — enough entropy that guessing is hopeless, few enough to
#: copy off a screen without a mistake.
BACKUP_CODE_BYTES = 5

TOTP_ISSUER = "MediSense"
#: One step either side of now. Phone clocks drift and people start typing on
#: the last second of a window; refusing those is a support ticket, not security.
TOTP_VALID_WINDOW = 1

TRUSTED_DEVICE_DAYS = 30


def generate_code() -> str:
    """A zero-padded numeric code. ``secrets`` rather than ``random``."""
    return f"{secrets.randbelow(10**CODE_LENGTH):0{CODE_LENGTH}d}"


def hash_code(code: str) -> str:
    return hash_password(normalize_code(code))


def verify_code(code: str, stored_hash: str | None) -> bool:
    """False for an absent hash, so "no code issued" can never verify."""
    if not stored_hash:
        return False
    return verify_password(normalize_code(code), stored_hash)


def normalize_code(code: str) -> str:
    """Strip what people paste around a code: spaces, dashes, invisible runs.

    A code copied out of an email routinely arrives as ``123 456``. Refusing it
    teaches nothing and helps nobody.
    """
    return "".join(ch for ch in code.strip() if ch.isalnum()).upper()


def generate_backup_codes(count: int = BACKUP_CODE_COUNT) -> list[str]:
    """Plaintext codes, shown once and never stored in this form."""
    return [secrets.token_hex(BACKUP_CODE_BYTES).upper() for _ in range(count)]


def hash_backup_codes(codes: list[str]) -> list[str]:
    return [hash_code(code) for code in codes]


def consume_backup_code(code: str, stored_hashes: list[str]) -> list[str] | None:
    """Returns the remaining hashes when the code matched, ``None`` when it did
    not.

    Every stored hash is checked even after a match is found. Returning early
    would make the time taken depend on the code's position in the list, which
    leaks how many codes are still unused.
    """
    candidate = normalize_code(code)
    matched_index: int | None = None
    for index, stored in enumerate(stored_hashes):
        if verify_password(candidate, stored) and matched_index is None:
            matched_index = index
    if matched_index is None:
        return None
    return [h for i, h in enumerate(stored_hashes) if i != matched_index]


# ---------------------------------------------------------------------------
# TOTP
# ---------------------------------------------------------------------------


def generate_totp_secret() -> str:
    return str(pyotp.random_base32())


def verify_totp(secret: str, code: str) -> bool:
    try:
        return bool(pyotp.TOTP(secret).verify(normalize_code(code), valid_window=TOTP_VALID_WINDOW))
    except (ValueError, TypeError):
        # A malformed secret is a corrupt enrolment, not a reason to 500 on a
        # sign-in attempt.
        return False


def provisioning_uri(secret: str, email: str) -> str:
    """The ``otpauth://`` URI an authenticator app scans."""
    return str(pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=TOTP_ISSUER))


def qr_svg(uri: str) -> str:
    """An inline SVG of the enrolment QR.

    Inline rather than a data URI or a hosted image: the secret is inside that
    URI, and a QR fetched from anywhere — a CDN, an image endpoint, a cached
    ``<img>`` — is a copy of a credential sitting somewhere nobody is watching.
    """
    return str(segno.make(uri, error="m").svg_inline(scale=5, border=2))


# ---------------------------------------------------------------------------
# Presentation
# ---------------------------------------------------------------------------


def mask_email(email: str) -> str:
    """``priya.sharma@example.com`` -> ``p•••a@example.com``.

    Enough for the owner to recognise their own address, not enough for someone
    holding only a password to learn one.
    """
    local, _, domain = email.partition("@")
    if not domain:
        return "•••"
    if len(local) <= 2:
        return f"{local[:1]}•••@{domain}"
    return f"{local[0]}•••{local[-1]}@{domain}"

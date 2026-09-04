"""Password hashing, opaque tokens, access tokens and sealed secrets.

scrypt (RFC 7914) comes from the standard library, so there is no native build
step on a fresh clone. Cost parameters are stored inside the hash string, which
means they can be raised later without invalidating existing passwords.

Everything here is standard library. That is a deliberate constraint rather than
an accident: a healthcare service carrying a native crypto dependency has to
keep it patched forever, and every primitive this application actually needs —
scrypt, HMAC, SHA-256, HKDF built from HMAC — is already in ``hashlib`` and
``hmac``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt

from app.core.config import settings

# scrypt cost. n=2**15 needs ~64 MB, hence the explicit maxmem.
_N = 2**15
_R = 8
_P = 1
_KEY_LENGTH = 64
_SALT_BYTES = 16
_MAX_MEMORY = 64 * 1024 * 1024

_ISSUER = "medisense-api"


def hash_password(password: str) -> str:
    """Returns ``scrypt$N$r$p$<salt-b64>$<hash-b64>``."""
    salt = secrets.token_bytes(_SALT_BYTES)
    derived = hashlib.scrypt(
        unicodedata.normalize("NFKC", password).encode(),
        salt=salt,
        n=_N,
        r=_R,
        p=_P,
        dklen=_KEY_LENGTH,
        maxmem=_MAX_MEMORY,
    )
    return f"scrypt${_N}${_R}${_P}${base64.b64encode(salt).decode()}${base64.b64encode(derived).decode()}"


def verify_password(password: str, stored: str) -> bool:
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return False
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt = base64.b64decode(parts[4])
        expected = base64.b64decode(parts[5])
    except (ValueError, TypeError):
        return False
    if not expected:
        return False

    try:
        derived = hashlib.scrypt(
            unicodedata.normalize("NFKC", password).encode(),
            salt=salt,
            n=n,
            r=r,
            p=p,
            dklen=len(expected),
            maxmem=_MAX_MEMORY,
        )
    except ValueError:
        return False
    return hmac.compare_digest(derived, expected)


def needs_rehash(stored: str) -> bool:
    """True when a stored hash uses weaker parameters than current policy."""
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return True
    try:
        return int(parts[1]) < _N or int(parts[2]) < _R
    except ValueError:
        return True


@dataclass(frozen=True)
class PasswordPolicyResult:
    valid: bool
    problems: list[str]


def check_password_policy(password: str, email: str | None = None) -> PasswordPolicyResult:
    problems: list[str] = []
    if len(password) < 10:
        problems.append("Use at least 10 characters.")
    if not any(c.islower() for c in password):
        problems.append("Include a lowercase letter.")
    if not any(c.isupper() for c in password):
        problems.append("Include an uppercase letter.")
    if not any(c.isdigit() for c in password):
        problems.append("Include a number.")
    if email:
        local = email.split("@")[0].lower()
        if len(local) > 2 and local in password.lower():
            problems.append("Do not use your email address in your password.")
    return PasswordPolicyResult(valid=not problems, problems=problems)


# --------------------------------------------------------------------------
# Opaque tokens — refresh tokens, password-reset links
# --------------------------------------------------------------------------


def generate_opaque_token(nbytes: int = 48) -> str:
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    """Only the hash is persisted, so a database dump cannot be replayed."""
    return hashlib.sha256(token.encode()).hexdigest()


# --------------------------------------------------------------------------
# Sealed secrets — values that must come back out again
# --------------------------------------------------------------------------
#
# A TOTP shared secret is the one credential in this system that cannot be
# hashed: verifying a code requires the secret itself, so it has to be stored in
# a recoverable form. Recoverable must not mean readable, and a database dump
# must not hand an attacker every enrolled authenticator.
#
# The threat model is exactly that — a dump, or a backup that escapes. The key
# is derived from ``SESSION_SECRET``, which lives in the environment and is not
# in the database, so the two have to be stolen separately.
#
# **Why this construction and not a library.** The standard library ships no
# AEAD, and adding ``cryptography`` (or PyNaCl) for one column would put a
# native, separately-versioned dependency into a healthcare service's tree. So
# the sealing is encrypt-then-MAC built from HMAC-SHA256: a keystream of
# HMAC(key, nonce || counter) blocks XORed with the plaintext, then a tag over
# the version, nonce and ciphertext under a *separate* key. Encrypt-then-MAC
# with independent keys is the composition with a security proof; the tag is
# checked before a single byte is decrypted, and compared with
# ``hmac.compare_digest``.
#
# The nonce is random per seal and never reused, which is what a keystream
# cipher requires. Secrets sealed here are short and rewritten only when 2FA is
# re-enrolled, so there is no counter to overflow and no reuse window.

_SEAL_VERSION = "v1"
_SEAL_NONCE_BYTES = 16
_SEAL_SALT = b"medisense.seal.v1"


class SealError(Exception):
    """A sealed value failed authentication, or was not a sealed value at all."""


def _hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    """HKDF (RFC 5869) over HMAC-SHA256.

    Present because ``hashlib`` has no HKDF and ``SESSION_SECRET`` is a
    human-supplied string rather than uniform key material. Extract turns it
    into a uniform pseudorandom key; expand derives independent subkeys from it,
    which is what lets encryption and authentication use keys that cannot be
    confused for each other.
    """
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    out = b""
    block = b""
    counter = 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def _seal_keys(purpose: str, key_material: str | None = None) -> tuple[bytes, bytes]:
    """Encryption and authentication subkeys, bound to what they are sealing.

    ``purpose`` goes into the HKDF info, so a sealed TOTP secret cannot be
    replayed into a column that seals something else.

    ``key_material`` defaults to ``SESSION_SECRET`` — right for anything whose
    loss is an inconvenience, like a TOTP enrolment that can be redone. Callers
    holding something that cannot be re-created pass their own: rotating the
    session secret is ordinary hygiene, and it must not be the act that makes
    every patient's diagnosis unreadable.
    """
    material = _hkdf_sha256(
        (key_material or settings.SESSION_SECRET).encode(), _SEAL_SALT, purpose.encode(), 64
    )
    return material[:32], material[32:]


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    stream = b""
    counter = 0
    while len(stream) < length:
        stream += hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        counter += 1
    return stream[:length]


def seal_secret(plaintext: str, purpose: str = "totp", key_material: str | None = None) -> str:
    """Returns ``v1$<nonce-b64>$<ciphertext-b64>$<tag-b64>``."""
    enc_key, mac_key = _seal_keys(purpose, key_material)
    nonce = secrets.token_bytes(_SEAL_NONCE_BYTES)
    raw = plaintext.encode()
    ciphertext = bytes(a ^ b for a, b in zip(raw, _keystream(enc_key, nonce, len(raw)), strict=True))
    tag = hmac.new(mac_key, _SEAL_VERSION.encode() + nonce + ciphertext, hashlib.sha256).digest()
    return "$".join(
        (
            _SEAL_VERSION,
            base64.b64encode(nonce).decode(),
            base64.b64encode(ciphertext).decode(),
            base64.b64encode(tag).decode(),
        )
    )


def unseal_secret(sealed: str, purpose: str = "totp", key_material: str | None = None) -> str:
    """Recover a sealed value, or raise ``SealError``.

    Raising rather than returning ``None`` is the point: a tampered or
    undecryptable secret is a corrupt credential, and silently treating it as
    "no secret configured" would turn a broken 2FA enrolment into a bypass.
    """
    parts = sealed.split("$")
    if len(parts) != 4 or parts[0] != _SEAL_VERSION:
        raise SealError("unrecognised sealed value")
    try:
        nonce = base64.b64decode(parts[1])
        ciphertext = base64.b64decode(parts[2])
        tag = base64.b64decode(parts[3])
    except (ValueError, TypeError) as exc:
        raise SealError("malformed sealed value") from exc

    enc_key, mac_key = _seal_keys(purpose, key_material)
    expected = hmac.new(mac_key, _SEAL_VERSION.encode() + nonce + ciphertext, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, tag):
        raise SealError("sealed value failed authentication")

    keystream = _keystream(enc_key, nonce, len(ciphertext))
    return bytes(a ^ b for a, b in zip(ciphertext, keystream, strict=True)).decode()


# --------------------------------------------------------------------------
# Access tokens
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class AccessTokenPayload:
    sub: str  # user id
    sid: str  # session id
    role: str
    eag: str | None = None  # active break-glass grant, when one applies


def sign_access_token(payload: AccessTokenPayload, expires_in_seconds: int) -> str:
    now = datetime.now(UTC)
    claims: dict[str, Any] = {
        "sub": payload.sub,
        "sid": payload.sid,
        "role": payload.role,
        "iss": _ISSUER,
        "iat": now,
        "exp": now + timedelta(seconds=expires_in_seconds),
    }
    if payload.eag:
        claims["eag"] = payload.eag
    return jwt.encode(claims, settings.JWT_SECRET, algorithm="HS256")


def verify_access_token(token: str) -> AccessTokenPayload | None:
    try:
        claims = jwt.decode(
            token,
            settings.JWT_SECRET,
            algorithms=["HS256"],
            issuer=_ISSUER,
            options={"require": ["exp", "iss"]},
        )
    except jwt.PyJWTError:
        return None

    sub, sid, role = claims.get("sub"), claims.get("sid"), claims.get("role")
    if not sub or not sid or not role:
        return None
    return AccessTokenPayload(sub=sub, sid=sid, role=role, eag=claims.get("eag"))

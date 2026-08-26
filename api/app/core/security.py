"""Password hashing, opaque tokens and access tokens.

scrypt (RFC 7914) comes from the standard library, so there is no native build
step on a fresh clone. Cost parameters are stored inside the hash string, which
means they can be raised later without invalidating existing passwords.
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

"""Account security: second factors, and the sessions signed into this account.

Everything here acts on **the caller's own account and nothing else**. There is
no user id in any path: the subject comes from the session, so there is no
identifier for anyone to tamper with and no route by which an administrator —
who legitimately manages accounts elsewhere — could turn somebody else's second
factor off from here.

Three of these operations weaken the account, and each is guarded by more than
being signed in: disabling asks for the password *and* a current code, reissuing
backup codes asks for the password, and revoking a session cannot touch the one
making the request. A session left unlocked on a ward machine is the threat
these endpoints exist under, so "you are signed in" is nowhere near enough.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip
from app.api.responses import ok
from app.core.errors import bad_request, not_found
from app.db.enums import TwoFactorMethod
from app.db.models import Session, TrustedDevice, User
from app.modules.auth import service
from app.modules.auth.router import TRUSTED_DEVICE_COOKIE
from app.modules.auth.schemas import (
    PasswordConfirmRequest,
    TwoFactorConfirmRequest,
    TwoFactorDisableRequest,
    TwoFactorStartRequest,
)
from app.modules.auth.twofactor import mask_email

router = APIRouter(prefix="/account", tags=["account"])


def _ctx(request: Request) -> service.RequestContext:
    return service.RequestContext(
        ip_address=client_ip(request),
        user_agent=request.headers.get("user-agent"),
        request_id=getattr(request.state, "request_id", None),
    )


async def _own_account(db: DbSession, user_id: str) -> User:
    """The caller's own row.

    Takes the id rather than the whole auth context so every call site reads
    ``auth.user_id`` out loud: the scoping is the access check here, and it
    should be visible where the endpoint is, not buried one call away.
    """
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise not_found("User")
    return user


@router.get("/2fa")
async def two_factor_status(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    user = await _own_account(db, auth.user_id)
    trusted = (
        await db.execute(
            select(func.count(TrustedDevice.id)).where(TrustedDevice.user_id == auth.user_id)
        )
    ).scalar_one()
    return ok(
        {
            "enabled": user.two_factor_enabled,
            "method": str(user.two_factor_method) if user.two_factor_method else None,
            # The count, never the codes. They exist only as hashes after the
            # one moment they were shown.
            "backupCodesRemaining": len(user.two_factor_backup_codes or []),
            "enabledAt": user.two_factor_enabled_at.isoformat() + "Z"
            if user.two_factor_enabled_at
            else None,
            "trustedDevices": trusted,
            "maskedEmail": mask_email(user.email),
        }
    )


@router.post("/2fa/start")
async def start_two_factor(
    payload: TwoFactorStartRequest, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Begin enrolling a second factor. Nothing is switched on yet.

    For TOTP the secret and its QR come back once and are never retrievable
    again: they live on the challenge, sealed, until a correct code proves the
    authenticator took them.
    """
    user = await _own_account(db, auth.user_id)
    enrolment = await service.start_two_factor(db, user, payload.method)
    body: dict[str, Any] = {"challengeId": enrolment.challenge_id, "method": str(payload.method)}
    if payload.method == TwoFactorMethod.EMAIL:
        body["sentTo"] = enrolment.sent_to
    else:
        body["secret"] = enrolment.secret
        body["qrSvg"] = enrolment.qr_svg
    return ok(body)


@router.post("/2fa/confirm")
async def confirm_two_factor(
    payload: TwoFactorConfirmRequest, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Switch it on, and hand over the backup codes.

    The codes are returned once and stored only as hashes. Saying so in the
    response is not decoration: a client that treats them as re-fetchable will
    let somebody skip writing them down.
    """
    user = await _own_account(db, auth.user_id)
    codes = await service.confirm_two_factor(db, user, payload.challenge_id, payload.code, _ctx(request))
    return ok(
        {
            "enabled": True,
            "method": str(user.two_factor_method) if user.two_factor_method else None,
            "backupCodes": codes,
            "note": "Save these now. They are shown once and cannot be retrieved again.",
        }
    )


@router.post("/2fa/disable")
async def disable_two_factor(
    payload: TwoFactorDisableRequest,
    request: Request,
    response: Response,
    auth: CurrentAuth,
    db: DbSession,
) -> dict[str, Any]:
    """Turn the second factor off. Needs the password *and* a current code.

    ``code`` is whatever the account can currently produce: a TOTP, a backup
    code, or — for an account on the EMAIL method — a code from an open
    challenge, which ``POST /2fa/start`` with ``{"method": "EMAIL"}`` sends.
    Either credential alone is enough to *use* the account; removing the factor
    should need both, or a session left open on a ward machine becomes a way to
    strip it.
    """
    user = await _own_account(db, auth.user_id)
    await service.disable_two_factor(db, user, payload.password, payload.code, _ctx(request))
    # The rows are gone; the cookie would otherwise sit in the browser naming a
    # trust that no longer exists.
    response.delete_cookie(TRUSTED_DEVICE_COOKIE, path="/")
    return ok({"enabled": False})


@router.post("/2fa/backup-codes")
async def regenerate_backup_codes(
    payload: PasswordConfirmRequest, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    user = await _own_account(db, auth.user_id)
    codes = await service.regenerate_backup_codes(db, user, payload.password, _ctx(request))
    return ok(
        {
            "backupCodes": codes,
            "note": "The previous codes stopped working. Save these now.",
        }
    )


@router.delete("/2fa/trusted-devices")
async def forget_trusted_devices(
    response: Response, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Make every remembered browser ask for a second factor again."""
    forgotten = await service.forget_trusted_devices(db, auth.user_id)
    response.delete_cookie(TRUSTED_DEVICE_COOKIE, path="/")
    return ok({"forgotten": forgotten})


@router.get("/sessions")
async def list_sessions(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    """Where this account is currently signed in.

    Only live sessions. A list that accumulates every session ever opened is
    harder to read for no benefit, and the question this answers is "is anything
    signed in that should not be?".
    """
    rows = (
        (
            await db.execute(
                select(Session)
                .where(Session.user_id == auth.user_id, Session.revoked_at.is_(None))
                .order_by(Session.last_seen_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return ok(
        [
            {
                "id": row.id,
                "deviceClass": row.device_class,
                "userAgent": row.user_agent,
                "ipAddress": row.ip_address,
                "createdAt": row.created_at.isoformat() + "Z",
                "lastSeenAt": row.last_seen_at.isoformat() + "Z",
                "expiresAt": row.expires_at.isoformat() + "Z",
                "current": row.id == auth.session_id,
            }
            for row in rows
        ]
    )


@router.delete("/sessions/{session_id}")
async def revoke_session(
    session_id: str, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """End one of the caller's other sessions.

    Never the current one: signing yourself out belongs on ``/auth/logout``,
    which also clears the cookies. Doing it here would leave the browser holding
    credentials for a session that no longer exists.
    """
    if session_id == auth.session_id:
        raise bad_request("Use sign out to end the session you are using.")

    # Scoped to the caller's own rows, so another account's session id is simply
    # not found rather than refused — there is nothing to learn from the answer.
    session = (
        await db.execute(
            select(Session).where(Session.id == session_id, Session.user_id == auth.user_id)
        )
    ).scalar_one_or_none()
    if session is None:
        raise not_found("Session")

    await service.revoke_session(db, session_id, "REVOKED_BY_USER")
    return ok({"id": session_id, "revoked": True})

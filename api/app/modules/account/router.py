"""The settings a person keeps for themselves: a picture, second factors, sessions.

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

from typing import Annotated, Any

from fastapi import APIRouter, File, Request, Response, UploadFile
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip
from app.api.responses import ok
from app.core.config import settings
from app.core.errors import bad_request, not_found
from app.db.base import new_id
from app.db.enums import AuditAction, TwoFactorMethod
from app.db.models import Session, TrustedDevice, User
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth import service
from app.modules.auth.router import TRUSTED_DEVICE_COOKIE
from app.modules.auth.schemas import (
    PasswordConfirmRequest,
    TwoFactorConfirmRequest,
    TwoFactorDisableRequest,
    TwoFactorStartRequest,
)
from app.modules.auth.twofactor import mask_email
from app.services import avatars, storage
from app.services.files import FileRejectedError

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


# ---------------------------------------------------------------------------
# Profile picture
# ---------------------------------------------------------------------------


async def _audit_avatar(
    request: Request,
    db: DbSession,
    auth: CurrentAuth,
    metadata: dict[str, Any],
) -> None:
    """Record a change to the caller's own picture.

    ``USER_UPDATED`` rather than an action of its own. The enum reserves its
    dedicated names for the changes that alter what it takes to *become* this
    user — enabling a second factor, disabling one, reissuing the codes that
    bypass it — and filing a profile picture beside those would flatten the
    distinction the log exists to keep. A picture is a profile edit, and the
    metadata says which field moved and in which direction.

    Field, direction, type and size. Never the file name: people name a photo
    after themselves, and a name is not something the trail needs in order to
    answer who changed what, and when.
    """
    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.USER_UPDATED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="User",
            # Subject and actor are the same person by construction: there is no
            # user id in the path, so this endpoint cannot act on anyone else.
            entity_id=auth.user_id,
            ip_address=client_ip(request),
            user_agent=request.headers.get("user-agent"),
            request_id=getattr(request.state, "request_id", None),
            metadata=metadata,
        ),
    )


@router.get("/avatar")
async def get_avatar(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    """A fresh signed link to the caller's own picture, or nulls if there is none.

    This exists because the link handed out with the session expires in minutes
    while a tab stays open for hours. It is how a client asks for another one
    without signing in again.

    Not audited. It reads one row belonging to the caller and hands back a link
    to their own face; recording it would add an entry for every idle tab that
    re-signed a link, which makes the trail worse at the question it is for.
    """
    user = await _own_account(db, auth.user_id)
    url = await avatars.signed_url_for(user.avatar_path)
    return ok(
        {
            "avatarUrl": url,
            # Null, not zero, when there is nothing to expire: a client that
            # schedules a refresh from this should have nothing to schedule.
            "expiresInSeconds": settings.SUPABASE_SIGNED_URL_TTL_SECONDS if url else None,
        }
    )


@router.post("/avatar")
async def set_avatar(
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    file: Annotated[UploadFile, File()],
) -> dict[str, Any]:
    """Replace the caller's picture with the uploaded image.

    The order is the one the documents module established, for the same reason:
    validate, store, write the row, and remove the object again if the row write
    fails, so a half-finished upload cannot leave a file in a bucket that nothing
    references and nobody will ever account for.

    Replacement adds one step. The new picture is written to a **new** key, and
    the old object is deleted only once the column points at the new one — so a
    replacement that fails part-way leaves the previous picture whole, rather
    than a row pointing at an object that was overwritten and then rolled back.
    That last delete is best-effort by design: ``storage.remove`` returns False
    instead of raising, because an orphan in a private bucket is a cleanup
    problem, and failing the request over it would report failure for a change
    the person can already see happened.
    """
    user = await _own_account(db, auth.user_id)

    content = await file.read()
    try:
        inspected = avatars.inspect_avatar(
            content, declared_mime=file.content_type, original_name=file.filename
        )
    except FileRejectedError as exc:
        raise bad_request(str(exc)) from exc

    bucket = settings.SUPABASE_AVATARS_BUCKET
    previous = user.avatar_path
    path = avatars.object_path(auth.user_id, new_id(), inspected.extension)

    await storage.upload(bucket, path, content, inspected.detected_mime)

    try:
        user.avatar_path = path
        await db.flush()
        await _audit_avatar(
            request,
            db,
            auth,
            {
                "field": "avatarPath",
                "change": "SET",
                "mimeType": inspected.detected_mime,
                "fileSize": inspected.size,
                "replaced": previous is not None,
            },
        )
    except Exception:
        await storage.remove(bucket, path)
        raise

    if previous and previous != path:
        await storage.remove(bucket, previous)

    # Signed strictly here rather than through ``avatars.signed_url_for``: this
    # URL *is* the answer, and a 200 carrying a null link would report success
    # while leaving the person looking at their initials. On a session payload
    # the same failure is worth swallowing, because there the picture is
    # decoration on a response that must not fail; here it is the response.
    url = await storage.signed_url(bucket, path)
    return ok({"avatarUrl": url, "expiresInSeconds": settings.SUPABASE_SIGNED_URL_TTL_SECONDS})


@router.delete("/avatar")
async def remove_avatar(request: Request, auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    """Take the picture down: the column is cleared and the object deleted.

    Not a soft delete, unlike a medical document. A document a clinician has
    already read is part of what informed their decision and the trail must
    still be able to name it. A profile picture informed nothing, and somebody
    asking a hospital system to stop holding a photograph of their face should
    have it deleted rather than hidden.

    The column is cleared **before** the object goes. The other order opens a
    window in which the row names an object that no longer exists and every
    session response tries to sign a dead path; this way the worst case is an
    orphan nobody can reach — the bucket is private, and no row names the key
    any more.

    Idempotent: removing a picture that is not there succeeds with
    ``removed: false``, so a double-click is not an error.
    """
    user = await _own_account(db, auth.user_id)
    path = user.avatar_path
    if not path:
        return ok({"removed": False})

    user.avatar_path = None
    await db.flush()
    await _audit_avatar(request, db, auth, {"field": "avatarPath", "change": "REMOVED"})

    await storage.remove(settings.SUPABASE_AVATARS_BUCKET, path)
    return ok({"removed": True})

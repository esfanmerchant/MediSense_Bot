"""Authentication routes.

Four of these carry no session and cannot: registering, proving an address,
asking for another code, and answering a second-factor challenge all happen
*before* there is anything to authenticate with. Each one carries its own
credential instead — a password, a six-digit code that expires, or a challenge
id that is single-use — and each is rate limited, because an endpoint anybody
can reach is an endpoint anybody can hammer.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response, status

from app.api.deps import ACCESS_COOKIE, REFRESH_COOKIE, CurrentAuth, DbSession, client_ip
from app.core.config import settings
from app.core.errors import AppError, unauthenticated
from app.core.logging import logger
from app.core.ratelimit import limit
from app.modules.auth import service
from app.modules.auth.schemas import (
    ChallengeRequest,
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResendCodeRequest,
    ResetPasswordRequest,
    TwoFactorVerifyRequest,
    VerifyEmailRequest,
)

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE_PATH = "/api/auth"
#: Sent on every request rather than only to /auth, because login has to read it
#: before deciding whether a second factor is owed.
TRUSTED_DEVICE_COOKIE = "ms_td"


def _ctx(request: Request) -> service.RequestContext:
    return service.RequestContext(
        ip_address=client_ip(request),
        user_agent=request.headers.get("user-agent"),
        request_id=getattr(request.state, "request_id", None),
    )


#: A first layer in front of the account lockout that already exists. Lockout
#: protects *one* account and counts in the database, so it holds however many
#: workers are running; this bounds a client working through many accounts, which
#: lockout alone never sees. Ten a minute leaves room for a mistyped password
#: and none for a wordlist.
LoginRateLimit = Annotated[None, Depends(limit(times=10, seconds=60, scope="login"))]

#: Guessing a six-digit code is bounded by the per-code attempt counter in the
#: database, which counts correctly however many workers are running. This is
#: the cheaper outer layer: it stops one client working through many accounts.
VerifyRateLimit = Annotated[None, Depends(limit(times=10, seconds=60, scope="verify_code"))]
#: Each accepted resend costs an email to a real person. The per-address
#: throttle in the service is the real control; this bounds the requests before
#: they get that far.
ResendRateLimit = Annotated[None, Depends(limit(times=5, seconds=300, scope="resend_code"))]


def _set_auth_cookies(response: Response, tokens: service.SessionTokens) -> None:
    """Tokens live in httpOnly cookies.

    Page JavaScript — and therefore any injected script — cannot read them, so
    the SPA sends credentials with each request rather than holding a token in
    memory or localStorage.
    """
    secure = settings.is_production
    response.set_cookie(
        ACCESS_COOKIE,
        tokens.access_token,
        max_age=tokens.access_token_expires_in_seconds,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        REFRESH_COOKIE,
        tokens.refresh_token,
        max_age=tokens.refresh_token_expires_in_seconds,
        httponly=True,
        secure=secure,
        samesite="lax",
        path=REFRESH_COOKIE_PATH,
    )


def _clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(ACCESS_COOKIE, path="/")
    response.delete_cookie(REFRESH_COOKIE, path=REFRESH_COOKIE_PATH)


def _set_trusted_device_cookie(response: Response, token: str, max_age: int) -> None:
    """A month-long marker saying this browser has already passed a second factor.

    httpOnly like the session cookies, and only ever a pointer: the row it names
    is checked on every login, so forgetting a device works immediately rather
    than in thirty days' time.
    """
    response.set_cookie(
        TRUSTED_DEVICE_COOKIE,
        token,
        max_age=max_age,
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
        path="/",
    )


def _user_payload(user: service.AuthenticatedUser) -> dict[str, Any]:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "role": str(user.role),
        "phone": user.phone,
        "status": str(user.status),
        "patientId": user.patient_id,
        "doctorId": user.doctor_id,
        "permissions": user.permissions,
    }


def _session_payload(tokens: service.SessionTokens) -> dict[str, Any]:
    """Facts the client needs for its own inactivity countdown."""
    return {
        "sessionId": tokens.session_id,
        "idleTimeoutSeconds": tokens.idle_timeout_seconds,
        "accessTokenExpiresInSeconds": tokens.access_token_expires_in_seconds,
    }


def _signed_in_payload(response: Response, result: service.SignedIn) -> dict[str, Any]:
    _set_auth_cookies(response, result.tokens)
    if result.trusted_device_token and result.trusted_device_expires_in_seconds:
        _set_trusted_device_cookie(
            response, result.trusted_device_token, result.trusted_device_expires_in_seconds
        )
    return {
        "user": _user_payload(result.user),
        "session": _session_payload(result.tokens),
        "redirectTo": result.redirect_to,
    }


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest, request: Request, db: DbSession) -> dict[str, Any]:
    """Create an account and email it a code. No session is issued here.

    Nothing usable exists until the address is proved, which is what stops a
    stranger typing somebody else's address from creating anything that person
    then has to deal with.
    """
    pending = await service.register(db, payload, _ctx(request))
    return {
        "success": True,
        "data": {
            "pendingVerification": True,
            "email": pending.email,
            "resendAfterSeconds": pending.resend_after_seconds,
        },
    }


@router.post("/verify-email")
async def verify_email(
    payload: VerifyEmailRequest,
    request: Request,
    response: Response,
    db: DbSession,
    _: VerifyRateLimit,
) -> dict[str, Any]:
    result = await service.verify_email(
        db, str(payload.email), payload.code, str(payload.device_class), _ctx(request)
    )
    return {"success": True, "data": _signed_in_payload(response, result)}


@router.post("/resend-code")
async def resend_code(
    payload: ResendCodeRequest, db: DbSession, _: ResendRateLimit
) -> dict[str, Any]:
    """Ask for another verification code.

    The response never varies. An address with no account, one already verified
    and one that asked ten seconds ago all get the same body as one that gets a
    code — otherwise this becomes a way to find out which addresses are
    registered, which is precisely what ``forgot-password`` refuses to be.
    """
    cooldown = await service.resend_verification_code(db, str(payload.email))
    return {"success": True, "data": {"sent": True, "resendAfterSeconds": cooldown}}


@router.post("/login")
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: DbSession,
    _: LoginRateLimit,
) -> dict[str, Any]:
    result = await service.login(
        db, payload, _ctx(request), request.cookies.get(TRUSTED_DEVICE_COOKIE)
    )

    if isinstance(result, service.PendingTwoFactor):
        return {
            "success": True,
            "data": {
                "requires2FA": True,
                "challengeId": result.challenge_id,
                "method": str(result.method),
                # Masked. Enough for the owner to recognise their own address,
                # not enough for somebody holding only a password to learn one.
                "sentTo": result.sent_to,
            },
        }

    return {
        "success": True,
        "data": {"requires2FA": False, **_signed_in_payload(response, result)},
    }


@router.post("/2fa/verify")
async def verify_two_factor(
    payload: TwoFactorVerifyRequest,
    request: Request,
    response: Response,
    db: DbSession,
    _: VerifyRateLimit,
) -> dict[str, Any]:
    result = await service.verify_two_factor(
        db, payload.challenge_id, payload.code, payload.remember_device, _ctx(request)
    )
    return {"success": True, "data": _signed_in_payload(response, result)}


@router.post("/2fa/resend")
async def resend_two_factor(
    payload: ChallengeRequest, db: DbSession, _: ResendRateLimit
) -> dict[str, Any]:
    cooldown = await service.resend_two_factor_code(db, payload.challenge_id)
    return {"success": True, "data": {"sent": True, "resendAfterSeconds": cooldown}}


@router.post("/refresh")
async def refresh(request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        body = {}
        try:
            body = await request.json()
        except Exception:
            body = {}
        token = body.get("refreshToken") if isinstance(body, dict) else None
    if not token:
        raise unauthenticated("Your session has ended. Sign in again.")

    tokens = await service.refresh_session(db, token, _ctx(request))
    _set_auth_cookies(response, tokens)
    return {"success": True, "data": {"session": _session_payload(tokens)}}


@router.post("/logout")
async def logout(request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    # Works even with an already-expired session so the client can always clear
    # its cookies; authentication is therefore best-effort here.
    from app.api.deps import get_current_auth

    try:
        auth = await get_current_auth(request, db)
        await service.logout(db, auth.session_id, auth.user_id, auth.role, _ctx(request))
    except AppError:
        # An expired or already-revoked session is the normal case here, not a
        # failure: the caller still gets their cookies cleared. Only auth errors
        # are swallowed — anything else is a genuine fault and propagates.
        logger.info("logout_without_valid_session", path=request.url.path)

    _clear_auth_cookies(response)
    return {"success": True, "data": {"loggedOut": True}}


@router.get("/me")
async def me(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    user = await service.get_authenticated_user(db, auth.user_id)
    return {"success": True, "data": {"user": _user_payload(user)}}


@router.post("/forgot-password")
async def forgot_password(payload: ForgotPasswordRequest, request: Request, db: DbSession) -> dict[str, Any]:
    dev_token = await service.request_password_reset(db, str(payload.email), _ctx(request))
    data: dict[str, Any] = {
        # Identical whether or not the address has an account.
        "message": "If an account exists for that address, a reset link has been sent."
    }
    if dev_token:
        data["devToken"] = dev_token
    return {"success": True, "data": data}


@router.post("/reset-password")
async def reset_password(
    payload: ResetPasswordRequest, request: Request, response: Response, db: DbSession
) -> dict[str, Any]:
    await service.reset_password(db, payload.token, payload.password, _ctx(request))
    _clear_auth_cookies(response)
    return {
        "success": True,
        "data": {"message": "Your password has been changed. Sign in with your new password."},
    }


@router.post("/change-password")
async def change_password(
    payload: ChangePasswordRequest, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    await service.change_password(
        db, auth.user_id, payload.current_password, payload.new_password, _ctx(request)
    )
    return {"success": True, "data": {"message": "Your password has been changed."}}

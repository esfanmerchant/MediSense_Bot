"""Authentication routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response, status

from app.api.deps import ACCESS_COOKIE, REFRESH_COOKIE, CurrentAuth, DbSession, client_ip
from app.core.config import settings
from app.core.errors import AppError, unauthenticated
from app.core.logging import logger
from app.modules.auth import service
from app.modules.auth.schemas import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
)

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE_PATH = "/api/auth"


def _ctx(request: Request) -> service.RequestContext:
    return service.RequestContext(
        ip_address=client_ip(request),
        user_agent=request.headers.get("user-agent"),
        request_id=getattr(request.state, "request_id", None),
    )


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


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest, request: Request, db: DbSession) -> dict[str, Any]:
    user = await service.register_patient(db, payload, _ctx(request))
    return {"success": True, "data": {"user": _user_payload(user)}}


@router.post("/login")
async def login(payload: LoginRequest, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    user, tokens = await service.login(db, payload, _ctx(request))
    _set_auth_cookies(response, tokens)
    return {"success": True, "data": {"user": _user_payload(user), "session": _session_payload(tokens)}}


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

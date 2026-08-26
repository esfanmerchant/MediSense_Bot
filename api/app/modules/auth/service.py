"""Authentication and session lifecycle."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import AppError, ErrorCode, conflict, invalid_credentials, not_found, unauthenticated
from app.core.security import (
    AccessTokenPayload,
    check_password_policy,
    generate_opaque_token,
    hash_password,
    hash_token,
    needs_rehash,
    sign_access_token,
    verify_password,
)
from app.core.session_policy import (
    REFRESH_TOKEN_TTL_SECONDS,
    absolute_timeout_seconds,
    access_token_ttl_seconds,
    idle_timeout_seconds,
)
from app.db.base import new_id, utcnow
from app.db.enums import AuditAction, AuditSeverity, Gender, Role, UserStatus
from app.db.models import Doctor, PasswordResetToken, Patient, RefreshToken, Session, User
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import permissions_for
from app.modules.auth.schemas import LoginRequest, RegisterRequest

MAX_FAILED_LOGINS = 5
LOCKOUT_MINUTES = 15
PASSWORD_RESET_TTL_MINUTES = 30

#: A dummy hash with real cost, so an unknown email takes roughly as long as a
#: wrong password and the endpoint cannot be timed for account enumeration.
_DUMMY_HASH = hash_password("timing-equalisation-placeholder")


@dataclass(frozen=True)
class RequestContext:
    ip_address: str | None = None
    user_agent: str | None = None
    request_id: str | None = None


@dataclass(frozen=True)
class SessionTokens:
    access_token: str
    refresh_token: str
    access_token_expires_in_seconds: int
    refresh_token_expires_in_seconds: int
    idle_timeout_seconds: int | None
    session_id: str


@dataclass(frozen=True)
class AuthenticatedUser:
    id: str
    name: str
    email: str
    role: Role
    phone: str | None
    status: UserStatus
    permissions: list[str]
    patient_id: str | None = None
    doctor_id: str | None = None


def _to_authenticated(
    user: User, patient_id: str | None = None, doctor_id: str | None = None
) -> AuthenticatedUser:
    return AuthenticatedUser(
        id=user.id,
        name=user.name,
        email=user.email,
        role=user.role,
        phone=user.phone,
        status=user.status,
        permissions=sorted(str(p) for p in permissions_for(user.role)),
        patient_id=patient_id,
        doctor_id=doctor_id,
    )


def _generate_mrn() -> str:
    return f"MRN-{datetime.now().year}-{secrets.randbelow(1_000_000):06d}"


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


async def register_patient(
    db: AsyncSession, payload: RegisterRequest, ctx: RequestContext
) -> AuthenticatedUser:
    """Public registration always creates a PATIENT.

    Doctor, nurse and admin accounts are created by an administrator, so the
    role can never be chosen by the person signing up.
    """
    policy = check_password_policy(payload.password, str(payload.email))
    if not policy.valid:
        raise AppError(
            422,
            ErrorCode.VALIDATION_ERROR,
            "Choose a stronger password.",
            [{"field": "password", "message": m} for m in policy.problems],
        )

    existing = (
        await db.execute(select(User.id).where(User.email == str(payload.email)))
    ).scalar_one_or_none()
    if existing:
        raise conflict("An account with that email already exists.")

    user = User(
        id=new_id(),
        name=payload.name,
        email=str(payload.email),
        password_hash=hash_password(payload.password),
        role=Role.PATIENT,
        phone=payload.phone,
        status=UserStatus.ACTIVE,
    )
    db.add(user)
    await db.flush()

    patient = Patient(
        id=new_id(),
        user_id=user.id,
        medical_record_number=_generate_mrn(),
        date_of_birth=payload.date_of_birth.replace(tzinfo=None) if payload.date_of_birth else None,
        gender=payload.gender or Gender.UNDISCLOSED,
        blood_group=payload.blood_group,
        address=payload.address,
        emergency_contact_name=payload.emergency_contact_name,
        emergency_contact_phone=payload.emergency_contact_phone,
    )
    db.add(patient)
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.USER_CREATED,
            user_id=user.id,
            actor_role=user.role,
            entity_type="User",
            entity_id=user.id,
            ip_address=ctx.ip_address,
            user_agent=ctx.user_agent,
            request_id=ctx.request_id,
            metadata={"role": str(user.role), "selfRegistered": True},
        ),
    )

    return _to_authenticated(user, patient_id=patient.id)


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------


async def login(
    db: AsyncSession, payload: LoginRequest, ctx: RequestContext
) -> tuple[AuthenticatedUser, SessionTokens]:
    row = (
        await db.execute(
            select(User, Patient.id, Doctor.id)
            .outerjoin(Patient, Patient.user_id == User.id)
            .outerjoin(Doctor, Doctor.user_id == User.id)
            .where(User.email == str(payload.email))
        )
    ).first()

    if row is None:
        verify_password(payload.password, _DUMMY_HASH)
        await record_audit(
            db,
            AuditEntry(
                action=AuditAction.LOGIN_FAILED,
                severity=AuditSeverity.SECURITY,
                ip_address=ctx.ip_address,
                user_agent=ctx.user_agent,
                request_id=ctx.request_id,
                metadata={"reason": "UNKNOWN_EMAIL"},
            ),
        )
        # Security bookkeeping must survive the error it describes: `get_db`
        # rolls back on exception, so without this commit the audit entry — and
        # below, the failed-attempt counter that drives lockout — would be
        # discarded the moment the 401 is raised.
        await db.commit()
        raise invalid_credentials()

    user, patient_id, doctor_id = row
    now = utcnow()

    if user.locked_until and user.locked_until > now:
        raise AppError(
            423,
            ErrorCode.ACCOUNT_LOCKED,
            f"Too many failed attempts. Try again after {user.locked_until:%H:%M} UTC.",
        )

    if not verify_password(payload.password, user.password_hash):
        failed = user.failed_login_count + 1
        should_lock = failed >= MAX_FAILED_LOGINS
        await db.execute(
            update(User)
            .where(User.id == user.id)
            .values(
                failed_login_count=failed,
                locked_until=(now + timedelta(minutes=LOCKOUT_MINUTES)) if should_lock else None,
            )
        )
        await record_audit(
            db,
            AuditEntry(
                action=AuditAction.LOGIN_FAILED,
                severity=AuditSeverity.SECURITY,
                user_id=user.id,
                actor_role=user.role,
                ip_address=ctx.ip_address,
                user_agent=ctx.user_agent,
                request_id=ctx.request_id,
                metadata={"reason": "BAD_PASSWORD", "failedLoginCount": failed, "locked": should_lock},
            ),
        )
        await db.commit()  # see the note above — lockout depends on this
        raise invalid_credentials()

    if user.status != UserStatus.ACTIVE:
        raise AppError(
            403, ErrorCode.ACCOUNT_INACTIVE, "This account is not active. Contact an administrator."
        )

    values: dict[str, object] = {"failed_login_count": 0, "locked_until": None, "last_login_at": now}
    # Transparent upgrade if the stored hash predates the current parameters.
    if needs_rehash(user.password_hash):
        values["password_hash"] = hash_password(payload.password)
    await db.execute(update(User).where(User.id == user.id).values(**values))

    tokens = await create_session(db, user.id, user.role, str(payload.device_class), ctx)

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.LOGIN,
            user_id=user.id,
            actor_role=user.role,
            entity_type="Session",
            entity_id=tokens.session_id,
            ip_address=ctx.ip_address,
            user_agent=ctx.user_agent,
            request_id=ctx.request_id,
            metadata={"deviceClass": str(payload.device_class)},
        ),
    )

    return _to_authenticated(user, patient_id, doctor_id), tokens


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


async def create_session(
    db: AsyncSession,
    user_id: str,
    role: Role,
    device_class: str,
    ctx: RequestContext,
    emergency_access_id: str | None = None,
) -> SessionTokens:
    session = Session(
        id=new_id(),
        user_id=user_id,
        device_class=device_class,
        ip_address=ctx.ip_address,
        user_agent=ctx.user_agent,
        expires_at=utcnow() + timedelta(seconds=absolute_timeout_seconds()),
    )
    db.add(session)
    await db.flush()
    return await _issue_tokens(db, session.id, user_id, role, device_class, emergency_access_id)


async def _issue_tokens(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    role: Role,
    device_class: str,
    emergency_access_id: str | None = None,
) -> SessionTokens:
    ttl = access_token_ttl_seconds(device_class)
    access_token = sign_access_token(
        AccessTokenPayload(sub=user_id, sid=session_id, role=str(role), eag=emergency_access_id), ttl
    )

    refresh_token = generate_opaque_token()
    db.add(
        RefreshToken(
            id=new_id(),
            user_id=user_id,
            session_id=session_id,
            token_hash=hash_token(refresh_token),
            expires_at=utcnow() + timedelta(seconds=REFRESH_TOKEN_TTL_SECONDS),
        )
    )
    await db.flush()

    return SessionTokens(
        access_token=access_token,
        refresh_token=refresh_token,
        access_token_expires_in_seconds=ttl,
        refresh_token_expires_in_seconds=REFRESH_TOKEN_TTL_SECONDS,
        idle_timeout_seconds=idle_timeout_seconds(device_class),
        session_id=session_id,
    )


async def refresh_session(db: AsyncSession, refresh_token: str, ctx: RequestContext) -> SessionTokens:
    """Rotate a refresh token.

    Refreshing does NOT extend an idle session: the inactivity window is checked
    first, so a client cannot keep a session alive in the background while the
    user is away — that would silently defeat R8.
    """
    row = (
        await db.execute(
            select(RefreshToken, Session, User)
            .join(Session, Session.id == RefreshToken.session_id)
            .join(User, User.id == RefreshToken.user_id)
            .where(RefreshToken.token_hash == hash_token(refresh_token))
        )
    ).first()

    if row is None:
        raise unauthenticated("Your session has ended. Sign in again.")

    stored, session, user = row
    now = utcnow()

    if stored.used_at is not None:
        # Reuse of an already-rotated token means it leaked: burn the session.
        await revoke_session(db, stored.session_id, "REFRESH_TOKEN_REUSE")
        await record_audit(
            db,
            AuditEntry(
                action=AuditAction.SESSION_EXPIRED,
                severity=AuditSeverity.SECURITY,
                user_id=stored.user_id,
                entity_type="Session",
                entity_id=stored.session_id,
                ip_address=ctx.ip_address,
                request_id=ctx.request_id,
                metadata={"reason": "REFRESH_TOKEN_REUSE"},
            ),
        )
        await db.commit()  # the revocation must outlive the 401 it accompanies
        raise unauthenticated("Your session has ended. Sign in again.")

    if stored.expires_at <= now or session.revoked_at is not None or session.expires_at <= now:
        raise unauthenticated("Your session has ended. Sign in again.")
    if user.status != UserStatus.ACTIVE:
        raise unauthenticated("This account is not active.")

    idle = idle_timeout_seconds(session.device_class)
    if idle is not None and (now - session.last_seen_at).total_seconds() >= idle:
        await revoke_session(db, stored.session_id, "IDLE_TIMEOUT")
        await db.commit()
        raise AppError(
            401,
            ErrorCode.SESSION_EXPIRED,
            "Your session expired after a period of inactivity. Sign in again to continue.",
        )

    tokens = await _issue_tokens(db, session.id, user.id, user.role, session.device_class)

    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.id == stored.id)
        .values(used_at=now, replaced_by_id=session.id)
    )
    await db.execute(update(Session).where(Session.id == session.id).values(last_seen_at=now))

    return tokens


async def revoke_session(db: AsyncSession, session_id: str, reason: str = "LOGOUT") -> None:
    now = utcnow()
    await db.execute(
        update(Session)
        .where(Session.id == session_id, Session.revoked_at.is_(None))
        .values(revoked_at=now, revoked_reason=reason)
    )
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.session_id == session_id, RefreshToken.used_at.is_(None))
        .values(used_at=now)
    )


async def logout(db: AsyncSession, session_id: str, user_id: str, role: Role, ctx: RequestContext) -> None:
    await revoke_session(db, session_id, "LOGOUT")
    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.LOGOUT,
            user_id=user_id,
            actor_role=role,
            entity_type="Session",
            entity_id=session_id,
            ip_address=ctx.ip_address,
            request_id=ctx.request_id,
        ),
    )


# ---------------------------------------------------------------------------
# Current user & passwords
# ---------------------------------------------------------------------------


async def get_authenticated_user(db: AsyncSession, user_id: str) -> AuthenticatedUser:
    row = (
        await db.execute(
            select(User, Patient.id, Doctor.id)
            .outerjoin(Patient, Patient.user_id == User.id)
            .outerjoin(Doctor, Doctor.user_id == User.id)
            .where(User.id == user_id)
        )
    ).first()
    if row is None:
        raise not_found("User")
    user, patient_id, doctor_id = row
    return _to_authenticated(user, patient_id, doctor_id)


async def request_password_reset(db: AsyncSession, email: str, ctx: RequestContext) -> str | None:
    """Returns the token outside production so the flow is testable without email."""
    row = (await db.execute(select(User.id, User.role).where(User.email == email))).first()

    # Always succeeds from the caller's point of view — otherwise the endpoint
    # reveals which addresses have accounts.
    if row is None:
        return None

    user_id, role = row
    token = generate_opaque_token(32)
    db.add(
        PasswordResetToken(
            id=new_id(),
            user_id=user_id,
            token_hash=hash_token(token),
            expires_at=utcnow() + timedelta(minutes=PASSWORD_RESET_TTL_MINUTES),
        )
    )
    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.PASSWORD_RESET_REQUESTED,
            severity=AuditSeverity.NOTICE,
            user_id=user_id,
            actor_role=role,
            ip_address=ctx.ip_address,
            request_id=ctx.request_id,
        ),
    )
    return None if settings.is_production else token


async def reset_password(db: AsyncSession, token: str, new_password: str, ctx: RequestContext) -> None:
    row = (
        await db.execute(
            select(PasswordResetToken, User)
            .join(User, User.id == PasswordResetToken.user_id)
            .where(PasswordResetToken.token_hash == hash_token(token))
        )
    ).first()

    now = utcnow()
    if row is None or row[0].used_at is not None or row[0].expires_at <= now:
        raise AppError(400, ErrorCode.BAD_REQUEST, "This reset link is invalid or has expired.")

    stored, user = row
    policy = check_password_policy(new_password, user.email)
    if not policy.valid:
        raise AppError(
            422,
            ErrorCode.VALIDATION_ERROR,
            "Choose a stronger password.",
            [{"field": "password", "message": m} for m in policy.problems],
        )

    await db.execute(
        update(User)
        .where(User.id == user.id)
        .values(password_hash=hash_password(new_password), failed_login_count=0, locked_until=None)
    )
    await db.execute(update(PasswordResetToken).where(PasswordResetToken.id == stored.id).values(used_at=now))
    # A password change ends every existing session for that user.
    await db.execute(
        update(Session)
        .where(Session.user_id == user.id, Session.revoked_at.is_(None))
        .values(revoked_at=now, revoked_reason="PASSWORD_CHANGED")
    )
    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.PASSWORD_CHANGED,
            severity=AuditSeverity.NOTICE,
            user_id=user.id,
            actor_role=user.role,
            ip_address=ctx.ip_address,
            request_id=ctx.request_id,
            metadata={"method": "RESET_LINK"},
        ),
    )


async def change_password(
    db: AsyncSession, user_id: str, current_password: str, new_password: str, ctx: RequestContext
) -> None:
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise not_found("User")

    if not verify_password(current_password, user.password_hash):
        raise invalid_credentials()

    policy = check_password_policy(new_password, user.email)
    if not policy.valid:
        raise AppError(
            422,
            ErrorCode.VALIDATION_ERROR,
            "Choose a stronger password.",
            [{"field": "newPassword", "message": m} for m in policy.problems],
        )

    await db.execute(update(User).where(User.id == user_id).values(password_hash=hash_password(new_password)))
    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.PASSWORD_CHANGED,
            severity=AuditSeverity.NOTICE,
            user_id=user_id,
            actor_role=user.role,
            ip_address=ctx.ip_address,
            request_id=ctx.request_id,
            metadata={"method": "SELF_SERVICE"},
        ),
    )

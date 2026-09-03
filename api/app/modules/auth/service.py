"""Authentication and session lifecycle.

Signing in is three gates, in this order, and the order is the design:

1. **the password**, which proves you know a secret;
2. **the account's own state** — a verified address and an active status — which
   decides whether that secret is currently worth anything;
3. **the second factor**, when one is enrolled and the browser is not already
   trusted.

A doctor's registration is not one of these gates. An unapproved doctor signs in
like anybody else and gets a session that reaches their own application and
nothing else — the narrowing is per request, in ``api.deps``, not per login.

No session exists until all three are past. Registration therefore issues no
session at all, and neither does the first half of a two-factor login: both
return something that says what is still owed, and ``_complete_sign_in`` is the
single place a session is ever created. Having one such place is what makes
"the same cookies, the same session row, the same audit entry" true by
construction rather than by three functions agreeing to be careful.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import AppError, ErrorCode, conflict, invalid_credentials, not_found, unauthenticated
from app.core.logging import logger
from app.core.security import (
    AccessTokenPayload,
    SealError,
    check_password_policy,
    generate_opaque_token,
    hash_password,
    hash_token,
    needs_rehash,
    seal_secret,
    sign_access_token,
    unseal_secret,
    verify_password,
)
from app.core.session_policy import (
    REFRESH_TOKEN_TTL_SECONDS,
    DeviceClass,
    absolute_timeout_seconds,
    access_token_ttl_seconds,
    idle_timeout_seconds,
)
from app.db.base import new_id, utcnow
from app.db.enums import (
    AuditAction,
    AuditSeverity,
    DoctorApplicationStatus,
    Gender,
    NotificationType,
    Role,
    TwoFactorMethod,
    UserStatus,
)
from app.db.models import (
    Doctor,
    DoctorApplication,
    PasswordResetToken,
    Patient,
    RefreshToken,
    Session,
    TrustedDevice,
    TwoFactorChallenge,
    User,
)
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth import twofactor
from app.modules.auth.rbac import permissions_for
from app.modules.auth.schemas import LoginRequest, RegisterRequest
from app.modules.notifications.service import notify
from app.services import email as email_service
from app.services import email_templates, terms

#: Where the welcome sends each role. Kept here rather than imported from a
#: routing module the API does not have; the client owns its own paths, and
#: this is one link in one email.
_PORTAL_HOME = {
    Role.PATIENT: "/patient",
    Role.DOCTOR: "/doctor",
    Role.ADMIN: "/admin",
}

MAX_FAILED_LOGINS = 5
LOCKOUT_MINUTES = 15
PASSWORD_RESET_TTL_MINUTES = 30

#: The client is told to wait this long before offering "resend" again. Enforced
#: against the stored ``emailVerificationSentAt``, not trusted from the client.
RESEND_COOLDOWN_SECONDS = 60
#: Five in an hour. Beyond that the request is accepted and quietly does
#: nothing — see ``resend_verification_code`` for why it cannot say so.
MAX_SENDS_PER_HOUR = 5

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
    #: The storage key for their picture, or None. A *path*, not a link: the
    #: router mints a signed URL from it per response, because the bucket is
    #: private and a link that outlived the session would be a way to read
    #: somebody's face after they signed out.
    avatar_path: str | None = None


@dataclass(frozen=True)
class PendingVerification:
    """What registration returns instead of a session."""

    email: str
    resend_after_seconds: int = RESEND_COOLDOWN_SECONDS


@dataclass(frozen=True)
class PendingTwoFactor:
    """A password accepted, a second factor still owed."""

    challenge_id: str
    method: TwoFactorMethod
    #: The masked address a code went to, or ``None`` for TOTP where nothing was
    #: sent anywhere.
    sent_to: str | None


@dataclass(frozen=True)
class SignedIn:
    user: AuthenticatedUser
    tokens: SessionTokens
    redirect_to: str
    #: Set when the caller asked to remember this browser and the request was
    #: allowed to. The router turns it into a cookie; the service never touches
    #: one.
    trusted_device_token: str | None = None
    trusted_device_expires_in_seconds: int | None = None


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
        avatar_path=user.avatar_path,
    )


def _generate_mrn() -> str:
    return f"MRN-{datetime.now().year}-{secrets.randbelow(1_000_000):06d}"


async def _redirect_for(db: AsyncSession, user: User) -> str:
    """Where the client should land after a successful sign-in.

    Computed on the server because the answer depends on state the client
    cannot see — for a doctor, how far their registration has got. It is
    navigation, not authorization: every one of these destinations is guarded on
    its own, so a client that ignores this lands somewhere that refuses it.
    """
    if user.role == Role.PATIENT:
        return "/patient"
    if user.role == Role.ADMIN:
        return "/admin"
    if user.role != Role.DOCTOR:
        return "/no-dashboard"

    status = (
        await db.execute(
            select(DoctorApplication.status).where(DoctorApplication.user_id == user.id)
        )
    ).scalar_one_or_none()
    if status == DoctorApplicationStatus.SUBMITTED:
        return "/doctor/pending"
    if status == DoctorApplicationStatus.APPROVED:
        return "/doctor"
    # DRAFT, REJECTED, and a doctor with no application at all: the form is
    # where they need to be.
    return "/doctor/onboarding"


# ---------------------------------------------------------------------------
# Registration & email verification
# ---------------------------------------------------------------------------


async def _issue_verification_code(db: AsyncSession, user: User) -> str:
    """Store a fresh code's hash and reset the attempt counter.

    Returns the plaintext for the one caller that has to send it. Nothing else
    ever sees it again — only the hash is persisted, so a database dump does not
    let anybody verify an address they do not control.
    """
    code = twofactor.generate_code()
    now = utcnow()
    user.email_verification_code_hash = twofactor.hash_code(code)
    user.email_verification_expires_at = now + timedelta(minutes=twofactor.EMAIL_CODE_TTL_MINUTES)
    user.email_verification_attempts = 0
    user.email_verification_sent_at = now
    user.email_verification_send_count += 1
    await db.flush()
    return code


async def register(
    db: AsyncSession, payload: RegisterRequest, ctx: RequestContext
) -> PendingVerification:
    """Create an unverified account and email it a code.

    **No session is issued.** Until the address is proved, the account is a
    claim: it cannot sign in, and nothing has been created that a stranger who
    typed somebody else's address could use.

    A PATIENT gets their patient record here, because a patient with no chart is
    not a usable account. A DOCTOR gets an empty DRAFT application instead —
    never a ``Doctor`` row, which is a credential an administrator grants.
    """
    if not payload.accepted_terms:
        # Checked before the password, because it is the cheapest refusal and
        # because an account must never exist without a recorded agreement —
        # there is no later point at which one could honestly be added.
        raise AppError(
            422,
            ErrorCode.VALIDATION_ERROR,
            "You need to accept the terms to create an account.",
            [{"field": "acceptedTerms", "message": "Please read and accept the terms."}],
        )

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
        cnic=payload.cnic,
        password_hash=hash_password(payload.password),
        role=Role(payload.role),
        phone=payload.phone,
        status=UserStatus.PENDING_VERIFICATION,
    )
    # Stamped with the version, so a later change to the wording asks again
    # rather than assuming the agreement of everybody who signed up before.
    user.terms_accepted_at = utcnow()
    user.terms_version = terms.TERMS_VERSION

    db.add(user)
    await db.flush()

    if user.role == Role.PATIENT:
        db.add(
            Patient(
                id=new_id(),
                user_id=user.id,
                medical_record_number=_generate_mrn(),
                date_of_birth=(
                    payload.date_of_birth.replace(tzinfo=None) if payload.date_of_birth else None
                ),
                gender=payload.gender or Gender.UNDISCLOSED,
                blood_group=payload.blood_group,
                address=payload.address,
                emergency_contact_name=payload.emergency_contact_name,
                emergency_contact_phone=payload.emergency_contact_phone,
            )
        )
    else:
        db.add(
            DoctorApplication(
                id=new_id(),
                user_id=user.id,
                status=DoctorApplicationStatus.DRAFT,
                full_name=payload.name,
                phone=payload.phone,
                address=payload.address,
            )
        )
    await db.flush()

    code = await _issue_verification_code(db, user)

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

    message = email_templates.verify_email(
        name=user.name, code=code, expires_minutes=twofactor.EMAIL_CODE_TTL_MINUTES
    )
    await email_service.send_or_log_code(
        to=user.email, subject=message.subject, text_body=message.text, code=code
    )

    return PendingVerification(email=user.email)


async def verify_email(
    db: AsyncSession, email: str, code: str, device_class: str, ctx: RequestContext
) -> SignedIn:
    """Prove an address, activate the account, and sign the person in.

    Verification is the last step of registration rather than a separate errand,
    so it issues the session the way login does — the person has just proved both
    factors registration asked of them, and sending them back to a sign-in form
    to type the password they typed a minute ago achieves nothing.
    """
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()

    # An unknown address and a wrong code are the same answer, for the same
    # reason the login form gives one answer: otherwise this endpoint says which
    # addresses have accounts.
    if user is None or not user.email_verification_code_hash:
        raise AppError(400, ErrorCode.INVALID_CODE, "That code is not valid. Request a new one.")

    now = utcnow()
    if user.email_verification_expires_at is None or user.email_verification_expires_at <= now:
        raise AppError(400, ErrorCode.CODE_EXPIRED, "That code has expired. Request a new one.")

    if user.email_verification_attempts >= twofactor.MAX_VERIFICATION_ATTEMPTS:
        await _burn_verification_code(db, user)
        await db.commit()
        raise AppError(
            400, ErrorCode.CODE_EXPIRED, "Too many attempts. Request a new code to continue."
        )

    if not twofactor.verify_code(code, user.email_verification_code_hash):
        user.email_verification_attempts += 1
        exhausted = user.email_verification_attempts >= twofactor.MAX_VERIFICATION_ATTEMPTS
        if exhausted:
            # Burn rather than lock: the person failing is nearly always the
            # owner mistyping, and a fresh code costs them one click while it
            # costs an attacker their whole guess budget.
            await _burn_verification_code(db, user)
        await db.flush()
        # The counter must outlive the error it produced, or the attempt limit
        # would be rolled back with every failed attempt and never reach five.
        await db.commit()
        raise AppError(
            400,
            ErrorCode.INVALID_CODE,
            "That code is not valid. Request a new one."
            if exhausted
            else "That code is not valid. Check the email and try again.",
        )

    user.email_verified_at = now
    user.status = UserStatus.ACTIVE
    await _burn_verification_code(db, user)

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.EMAIL_VERIFIED,
            severity=AuditSeverity.NOTICE,
            user_id=user.id,
            actor_role=user.role,
            entity_type="User",
            entity_id=user.id,
            ip_address=ctx.ip_address,
            user_agent=ctx.user_agent,
            request_id=ctx.request_id,
        ),
    )

    # The account is real from this moment — the address is proved and the
    # password works — so this is where a registration is "successful" and
    # where it is honest to say so. Saying it at the point the form was
    # submitted would congratulate somebody who may never come back to the
    # code, and would be a second email for the same event.
    await notify(
        db,
        user_id=user.id,
        notification_type=NotificationType.ACCOUNT_REGISTERED,
        title="Your MediSense account is ready",
        body="Your email is verified and your account is active.",
        link=_PORTAL_HOME.get(user.role, "/"),
        # The template below is a welcome with somewhere to go; the generic one
        # would be a thinner second copy of it.
        email=False,
    )
    if settings.email_configured:
        message = email_templates.account_registered(name=user.name, role=str(user.role))
        await email_service.send(
            to=user.email,
            subject=message.subject,
            text_body=message.text,
            html_body=message.html,
        )

    return await _complete_sign_in(db, user, device_class, ctx, method="EMAIL_VERIFICATION")


async def _burn_verification_code(db: AsyncSession, user: User) -> None:
    user.email_verification_code_hash = None
    user.email_verification_expires_at = None
    user.email_verification_attempts = 0
    await db.flush()


async def resend_verification_code(db: AsyncSession, email: str) -> int:
    """Send another code, if this address is owed one and is not being hammered.

    Returns the cooldown the client should show. **The answer is the same for
    every address**: one that has no account, one already verified, one that
    asked ten seconds ago, and one that gets a code. Anything else turns this
    into a way to test which addresses are registered — which is exactly what
    ``forgot-password`` already refuses to be.

    The throttle is checked against the stored ``emailVerificationSentAt`` rather
    than only the IP-based limiter, because the cost being bounded here is an
    email to a real person, and that cost does not care how many addresses the
    requests came from.
    """
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if user is None or user.status != UserStatus.PENDING_VERIFICATION:
        return RESEND_COOLDOWN_SECONDS

    now = utcnow()
    sent_at = user.email_verification_sent_at
    if sent_at is not None:
        elapsed = (now - sent_at).total_seconds()
        if elapsed < RESEND_COOLDOWN_SECONDS:
            return RESEND_COOLDOWN_SECONDS
        # An hour of quiet clears the hourly budget. Counting from the last send
        # rather than from a stored window start keeps this to one column and
        # errs towards the stricter reading: five in a row, then an hour off.
        if elapsed >= 3600:
            user.email_verification_send_count = 0
        elif user.email_verification_send_count >= MAX_SENDS_PER_HOUR:
            return RESEND_COOLDOWN_SECONDS

    code = await _issue_verification_code(db, user)
    message = email_templates.verify_email(
        name=user.name, code=code, expires_minutes=twofactor.EMAIL_CODE_TTL_MINUTES
    )
    await email_service.send_or_log_code(
        to=user.email, subject=message.subject, text_body=message.text, code=code
    )
    return RESEND_COOLDOWN_SECONDS


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------


def _require_cleared_to_sign_in(user: User) -> None:
    """The account-state gate: is this password currently worth anything?

    Checked after the password so that neither answer can be obtained without
    one, and before any session is created so that no half-authorized session
    ever exists.

    **A doctor's registration is deliberately not checked here.** An unapproved
    doctor signs in normally and gets a session that reaches their own
    application and nothing else; the narrowing lives in ``api.deps``, which can
    refuse per request instead of per login. Refusing the login instead would
    lock an applicant out of the half-finished form that the refusal is telling
    them to go and finish — see the note in ``deps.require_doctor_is_credentialed``
    for why that failure mode is the wrong one to choose.
    """
    if user.status == UserStatus.PENDING_VERIFICATION or user.email_verified_at is None:
        raise AppError(
            403,
            ErrorCode.EMAIL_NOT_VERIFIED,
            "Confirm your email address first. Check your inbox for the code we sent, "
            "or ask for a new one.",
        )

    if user.status != UserStatus.ACTIVE:
        raise AppError(
            403, ErrorCode.ACCOUNT_INACTIVE, "This account is not active. Contact an administrator."
        )


async def _complete_sign_in(
    db: AsyncSession,
    user: User,
    device_class: str,
    ctx: RequestContext,
    *,
    method: str,
    remember_device: bool = False,
) -> SignedIn:
    """Create the session. The only place in the application that does.

    Every entry point — password-only login, email verification, and passing a
    second factor — arrives here, so they cannot drift into issuing subtly
    different sessions.
    """
    now = utcnow()
    values: dict[str, object] = {"failed_login_count": 0, "locked_until": None, "last_login_at": now}
    await db.execute(update(User).where(User.id == user.id).values(**values))

    tokens = await create_session(db, user.id, user.role, device_class, ctx)

    trusted_token: str | None = None
    trusted_ttl: int | None = None
    if remember_device:
        trusted_token, trusted_ttl = await remember_this_device(db, user.id, ctx)

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
            metadata={
                "deviceClass": device_class,
                "method": method,
                "deviceRemembered": trusted_token is not None,
            },
        ),
    )

    patient_id, doctor_id = (
        await db.execute(
            select(Patient.id, Doctor.id)
            .select_from(User)
            .outerjoin(Patient, Patient.user_id == User.id)
            .outerjoin(Doctor, Doctor.user_id == User.id)
            .where(User.id == user.id)
        )
    ).one()

    return SignedIn(
        user=_to_authenticated(user, patient_id, doctor_id),
        tokens=tokens,
        redirect_to=await _redirect_for(db, user),
        trusted_device_token=trusted_token,
        trusted_device_expires_in_seconds=trusted_ttl,
    )


async def login(
    db: AsyncSession,
    payload: LoginRequest,
    ctx: RequestContext,
    trusted_device_token: str | None = None,
) -> SignedIn | PendingTwoFactor:
    """Either a completed sign-in or a challenge — the return type says which.

    Two shapes rather than one with optional halves, so a caller cannot forget
    that "signed in" is not the only way this succeeds.
    """
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

    user, _patient_id, _doctor_id = row
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

    _require_cleared_to_sign_in(user)

    # Transparent upgrade if the stored hash predates the current parameters.
    if needs_rehash(user.password_hash):
        await db.execute(
            update(User)
            .where(User.id == user.id)
            .values(password_hash=hash_password(payload.password))
        )

    device_class = str(payload.device_class)

    if user.two_factor_enabled and not await _device_is_trusted(db, user.id, trusted_device_token):
        return await _start_login_challenge(db, user, device_class)

    return await _complete_sign_in(db, user, device_class, ctx, method="PASSWORD")


# ---------------------------------------------------------------------------
# Two-factor authentication
# ---------------------------------------------------------------------------


async def _device_is_trusted(db: AsyncSession, user_id: str, token: str | None) -> bool:
    """Does this browser already hold a live trust for this account?

    The token is matched against a row, not merely decoded, so forgetting a
    device takes effect on its next request rather than when its cookie happens
    to expire. It is also scoped to the user: a trust cookie from one account
    cannot skip the second factor on another.
    """
    if not token:
        return False
    device = (
        await db.execute(
            select(TrustedDevice).where(
                TrustedDevice.token_hash == hash_token(token),
                TrustedDevice.user_id == user_id,
                TrustedDevice.expires_at > utcnow(),
            )
        )
    ).scalar_one_or_none()
    if device is None:
        return False
    device.last_used_at = utcnow()
    await db.flush()
    return True


async def remember_this_device(
    db: AsyncSession, user_id: str, ctx: RequestContext
) -> tuple[str, int]:
    """Mint a trust for this browser. Returns the token and its lifetime."""
    token = generate_opaque_token()
    ttl = twofactor.TRUSTED_DEVICE_DAYS * 24 * 60 * 60
    db.add(
        TrustedDevice(
            id=new_id(),
            user_id=user_id,
            token_hash=hash_token(token),
            expires_at=utcnow() + timedelta(seconds=ttl),
            user_agent=ctx.user_agent,
        )
    )
    await db.flush()
    return token, ttl


async def forget_trusted_devices(db: AsyncSession, user_id: str) -> int:
    """Drop every trust for one account. Returns how many went."""
    count = (
        await db.execute(
            select(func.count(TrustedDevice.id)).where(TrustedDevice.user_id == user_id)
        )
    ).scalar_one()
    await db.execute(delete(TrustedDevice).where(TrustedDevice.user_id == user_id))
    await db.flush()
    return int(count)


async def _send_challenge_code(db: AsyncSession, user: User, challenge: TwoFactorChallenge) -> None:
    code = twofactor.generate_code()
    challenge.code_hash = twofactor.hash_code(code)
    challenge.sent_at = utcnow()
    await db.flush()

    message = email_templates.two_factor_code(
        name=user.name, code=code, expires_minutes=twofactor.CHALLENGE_TTL_MINUTES
    )
    await email_service.send_or_log_code(
        to=user.email, subject=message.subject, text_body=message.text, code=code
    )


async def create_challenge(
    db: AsyncSession,
    user: User,
    method: TwoFactorMethod,
    *,
    purpose: str,
    device_class: str = str(DeviceClass.PERSONAL),
    pending_secret: str | None = None,
) -> TwoFactorChallenge:
    challenge = TwoFactorChallenge(
        id=new_id(),
        user_id=user.id,
        purpose=purpose,
        method=method,
        device_class=device_class,
        pending_secret=pending_secret,
        expires_at=utcnow() + timedelta(minutes=twofactor.CHALLENGE_TTL_MINUTES),
    )
    db.add(challenge)
    await db.flush()
    if method == TwoFactorMethod.EMAIL:
        await _send_challenge_code(db, user, challenge)
    return challenge


async def _start_login_challenge(
    db: AsyncSession, user: User, device_class: str
) -> PendingTwoFactor:
    method = user.two_factor_method or TwoFactorMethod.EMAIL
    challenge = await create_challenge(
        db, user, method, purpose="LOGIN", device_class=device_class
    )
    return PendingTwoFactor(
        challenge_id=challenge.id,
        method=method,
        sent_to=twofactor.mask_email(user.email) if method == TwoFactorMethod.EMAIL else None,
    )


async def load_open_challenge(
    db: AsyncSession, challenge_id: str, purpose: str | None = None
) -> tuple[TwoFactorChallenge, User]:
    """Fetch a challenge that is still usable, or raise.

    Expiry, consumption and the attempt ceiling are all decided here, once, so
    no caller can accidentally accept a challenge that one of the other callers
    would have refused.
    """
    row = (
        await db.execute(
            select(TwoFactorChallenge, User)
            .join(User, User.id == TwoFactorChallenge.user_id)
            .where(TwoFactorChallenge.id == challenge_id)
        )
    ).first()
    if row is None:
        raise AppError(400, ErrorCode.INVALID_CODE, "That sign-in attempt is no longer valid.")

    challenge, user = row
    if purpose is not None and challenge.purpose != purpose:
        raise AppError(400, ErrorCode.INVALID_CODE, "That sign-in attempt is no longer valid.")
    if challenge.consumed_at is not None:
        raise AppError(400, ErrorCode.INVALID_CODE, "That code has already been used.")
    if challenge.expires_at <= utcnow():
        raise AppError(400, ErrorCode.CODE_EXPIRED, "That code has expired. Start again.")
    if challenge.attempts >= twofactor.MAX_VERIFICATION_ATTEMPTS:
        raise AppError(400, ErrorCode.CODE_EXPIRED, "Too many attempts. Start again.")
    return challenge, user


def _unseal_totp(sealed: str | None, user_id: str) -> str | None:
    """Recover a stored TOTP secret, or ``None`` if it is unusable.

    A secret that will not unseal means the key changed or the row was tampered
    with. Logged and treated as "no secret", which makes the account fall back
    to a backup code rather than crashing a sign-in on a 500.
    """
    if not sealed:
        return None
    try:
        return unseal_secret(sealed)
    except SealError:
        logger.error("totp_secret_unreadable", user_id=user_id)
        return None


async def check_challenge_code(
    db: AsyncSession, challenge: TwoFactorChallenge, user: User, code: str
) -> str:
    """Accept an emailed code, a TOTP, or a backup code. Returns which it was.

    A backup code is accepted whatever the enrolled method is — it exists for the
    day the phone is lost or the mailbox is unreachable, and one that only works
    when the ordinary factor already works would be useless — but **only when
    signing in**. Letting one confirm an enrolment would enable an authenticator
    nobody has proved they can read, which is the one thing confirmation is for.
    """
    if challenge.method == TwoFactorMethod.EMAIL and twofactor.verify_code(
        code, challenge.code_hash
    ):
        return "EMAIL"

    if challenge.method == TwoFactorMethod.TOTP:
        secret = _unseal_totp(challenge.pending_secret or user.two_factor_secret, user.id)
        if secret and twofactor.verify_totp(secret, code):
            return "TOTP"

    if challenge.purpose == "LOGIN" and user.two_factor_backup_codes:
        remaining = twofactor.consume_backup_code(code, list(user.two_factor_backup_codes))
        if remaining is not None:
            user.two_factor_backup_codes = remaining
            await db.flush()
            return "BACKUP_CODE"

    challenge.attempts += 1
    await db.flush()
    # The attempt counter has to survive the rejection it caused, or five wrong
    # codes would never add up to five.
    await db.commit()
    raise AppError(400, ErrorCode.INVALID_CODE, "That code is not valid.")


async def verify_two_factor(
    db: AsyncSession,
    challenge_id: str,
    code: str,
    remember_device: bool,
    ctx: RequestContext,
) -> SignedIn:
    challenge, user = await load_open_challenge(db, challenge_id, purpose="LOGIN")
    method = await check_challenge_code(db, challenge, user, code)

    challenge.consumed_at = utcnow()
    await db.flush()

    # A shared ward terminal is the exact device the second factor exists to
    # protect against, so it is never remembered — whatever the client asked
    # for. Silently declining is deliberate: refusing the whole sign-in would
    # punish someone for ticking a box.
    on_shared_terminal = challenge.device_class == str(DeviceClass.SHARED_TERMINAL)

    return await _complete_sign_in(
        db,
        user,
        challenge.device_class,
        ctx,
        method=f"TWO_FACTOR_{method}",
        remember_device=remember_device and not on_shared_terminal,
    )


async def resend_two_factor_code(db: AsyncSession, challenge_id: str) -> int:
    """Send the challenge's code again. Returns the cooldown in seconds.

    Unlike ``resend-code``, this one may be honest about being throttled: the
    caller already holds a challenge id, so there is nothing left to learn from
    the answer.
    """
    challenge, user = await load_open_challenge(db, challenge_id)
    if challenge.method != TwoFactorMethod.EMAIL:
        raise AppError(
            400,
            ErrorCode.BAD_REQUEST,
            "This account uses an authenticator app. Open it for the current code.",
        )

    if challenge.sent_at is not None:
        elapsed = (utcnow() - challenge.sent_at).total_seconds()
        if elapsed < RESEND_COOLDOWN_SECONDS:
            raise AppError(
                429,
                ErrorCode.RATE_LIMITED,
                f"Wait {int(RESEND_COOLDOWN_SECONDS - elapsed)} seconds before asking again.",
            )

    await _send_challenge_code(db, user, challenge)
    return RESEND_COOLDOWN_SECONDS


# ---------------------------------------------------------------------------
# Second-factor enrolment (account settings)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TwoFactorEnrolment:
    challenge_id: str
    #: TOTP only. Shown once, so somebody without a camera can type it in.
    secret: str | None = None
    qr_svg: str | None = None
    sent_to: str | None = None


async def start_two_factor(
    db: AsyncSession, user: User, method: TwoFactorMethod
) -> TwoFactorEnrolment:
    """Begin enrolment, or send a code for confirming a change.

    Nothing about the account changes here. A TOTP secret is generated and held
    on the challenge, sealed, until a correct code proves the authenticator
    actually has it — an account that claims a second factor its owner cannot
    produce is worse than one with none, because the recovery path is the same
    but nobody knows it is needed until they are locked out.
    """
    if method == TwoFactorMethod.EMAIL:
        challenge = await create_challenge(db, user, method, purpose="ENROLMENT")
        return TwoFactorEnrolment(
            challenge_id=challenge.id, sent_to=twofactor.mask_email(user.email)
        )

    secret = twofactor.generate_totp_secret()
    challenge = await create_challenge(
        db, user, method, purpose="ENROLMENT", pending_secret=seal_secret(secret)
    )
    uri = twofactor.provisioning_uri(secret, user.email)
    return TwoFactorEnrolment(
        challenge_id=challenge.id, secret=secret, qr_svg=twofactor.qr_svg(uri)
    )


async def confirm_two_factor(
    db: AsyncSession, user: User, challenge_id: str, code: str, ctx: RequestContext
) -> list[str]:
    """Turn the second factor on. Returns the backup codes, shown once."""
    challenge, challenge_user = await load_open_challenge(db, challenge_id, purpose="ENROLMENT")
    if challenge_user.id != user.id:
        raise AppError(400, ErrorCode.INVALID_CODE, "That request is no longer valid.")

    await check_challenge_code(db, challenge, user, code)
    challenge.consumed_at = utcnow()

    codes = twofactor.generate_backup_codes()
    user.two_factor_enabled = True
    user.two_factor_method = challenge.method
    user.two_factor_secret = challenge.pending_secret
    user.two_factor_backup_codes = twofactor.hash_backup_codes(codes)
    user.two_factor_enabled_at = utcnow()
    await db.flush()

    await _audit_two_factor(
        db, user, AuditAction.TWO_FACTOR_ENABLED, ctx, {"method": str(challenge.method)}
    )
    return codes


async def _verify_current_second_factor(db: AsyncSession, user: User, code: str) -> str:
    """Prove possession of the factor the account currently has enrolled.

    Used by the two operations that weaken the account — turning 2FA off and
    reissuing backup codes — so neither can be done with a stolen session and a
    known password alone.
    """
    secret = _unseal_totp(user.two_factor_secret, user.id)
    if user.two_factor_method == TwoFactorMethod.TOTP and secret and twofactor.verify_totp(secret, code):
        return "TOTP"

    open_challenge = (
        await db.execute(
            select(TwoFactorChallenge)
            .where(
                TwoFactorChallenge.user_id == user.id,
                TwoFactorChallenge.method == TwoFactorMethod.EMAIL,
                TwoFactorChallenge.consumed_at.is_(None),
                TwoFactorChallenge.expires_at > utcnow(),
            )
            .order_by(TwoFactorChallenge.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if open_challenge is not None and twofactor.verify_code(code, open_challenge.code_hash):
        open_challenge.consumed_at = utcnow()
        await db.flush()
        return "EMAIL"

    remaining = twofactor.consume_backup_code(code, list(user.two_factor_backup_codes or []))
    if remaining is not None:
        user.two_factor_backup_codes = remaining
        await db.flush()
        return "BACKUP_CODE"

    raise AppError(400, ErrorCode.INVALID_CODE, "That code is not valid.")


async def disable_two_factor(
    db: AsyncSession, user: User, password: str, code: str, ctx: RequestContext
) -> None:
    if not user.two_factor_enabled:
        raise conflict("Two-factor authentication is not switched on for this account.")
    if not verify_password(password, user.password_hash):
        raise invalid_credentials()

    method = await _verify_current_second_factor(db, user, code)

    user.two_factor_enabled = False
    user.two_factor_method = None
    user.two_factor_secret = None
    user.two_factor_backup_codes = []
    user.two_factor_enabled_at = None
    # Every remembered device was a promise that this account had a second
    # factor. Leaving them behind would mean re-enabling 2FA silently trusted
    # browsers nobody has checked since.
    forgotten = await forget_trusted_devices(db, user.id)
    await db.flush()

    await _audit_two_factor(
        db,
        user,
        AuditAction.TWO_FACTOR_DISABLED,
        ctx,
        {"confirmedWith": method, "trustedDevicesForgotten": forgotten},
    )


async def regenerate_backup_codes(
    db: AsyncSession, user: User, password: str, ctx: RequestContext
) -> list[str]:
    if not user.two_factor_enabled:
        raise conflict("Two-factor authentication is not switched on for this account.")
    if not verify_password(password, user.password_hash):
        raise invalid_credentials()

    codes = twofactor.generate_backup_codes()
    # The old set stops working the moment the new one is issued: two live sets
    # would double the number of standing bypasses for this account.
    user.two_factor_backup_codes = twofactor.hash_backup_codes(codes)
    await db.flush()

    await _audit_two_factor(
        db, user, AuditAction.BACKUP_CODES_REGENERATED, ctx, {"count": len(codes)}
    )
    return codes


async def _audit_two_factor(
    db: AsyncSession,
    user: User,
    action: AuditAction,
    ctx: RequestContext,
    metadata: dict[str, object],
) -> None:
    await record_audit(
        db,
        AuditEntry(
            action=action,
            severity=AuditSeverity.SECURITY,
            user_id=user.id,
            actor_role=user.role,
            entity_type="User",
            entity_id=user.id,
            ip_address=ctx.ip_address,
            user_agent=ctx.user_agent,
            request_id=ctx.request_id,
            metadata=metadata,
        ),
    )


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
        # One answer for "no such token", "already used" and "too old": the
        # holder of a dead link learns nothing about which it was.
        raise AppError(400, ErrorCode.INVALID_CODE, "This reset link is invalid or has expired.")

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

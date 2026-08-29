"""Request-scoped dependencies: authentication, RBAC, resource authorization."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated, Literal

from fastapi import Depends, Request
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import (
    AppError,
    ErrorCode,
    forbidden,
    forbidden_resource,
    session_expired,
    unauthenticated,
)
from app.core.security import verify_access_token
from app.core.session_policy import LAST_SEEN_WRITE_THROTTLE_SECONDS, check_idle
from app.db.base import utcnow
from app.db.enums import (
    ENCOUNTER_STATUSES,
    AuditAction,
    AuditSeverity,
    DoctorApplicationStatus,
    EmergencyAccessStatus,
    Role,
    UserStatus,
)
from app.db.models import (
    Appointment,
    Doctor,
    DoctorApplication,
    DoctorPatientAssignment,
    EmergencyAccess,
    Patient,
    Session,
    User,
)
from app.db.session import get_db
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission, permissions_for

ACCESS_COOKIE = "ms_at"
REFRESH_COOKIE = "ms_rt"

DbSession = Annotated[AsyncSession, Depends(get_db)]


@dataclass(frozen=True)
class AuthContext:
    user_id: str
    role: Role
    session_id: str
    permissions: frozenset[Permission]
    #: Present only for PATIENT users.
    patient_id: str | None = None
    #: Present only for DOCTOR users.
    doctor_id: str | None = None
    #: Active break-glass grant, when the request runs under one (R3).
    emergency_access_id: str | None = None

    def has(self, permission: Permission) -> bool:
        return permission in self.permissions


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _extract_token(request: Request) -> str | None:
    cookie = request.cookies.get(ACCESS_COOKIE)
    if cookie:
        return cookie
    header = request.headers.get("authorization")
    if header and header.startswith("Bearer "):
        return header[7:].strip() or None
    return None


async def _revoke(db: AsyncSession, session_id: str, reason: str) -> None:
    """Revoke a session and commit immediately.

    The commit is not optional. Every caller raises straight afterwards, and the
    ``get_db`` dependency rolls back on exception — so without an explicit commit
    the revocation would be discarded by the very error it accompanies, and an
    expired session would stay usable.
    """
    await db.execute(
        update(Session).where(Session.id == session_id).values(revoked_at=utcnow(), revoked_reason=reason)
    )
    await db.commit()


#: What a doctor may still reach while their registration is not approved.
#:
#: Everything on this list is either the account itself or the application: who
#: am I, sign out, refresh, change my password, my own security settings, my own
#: registration form and its documents, and the department list that form has to
#: populate. **Nothing clinical is here, and nothing may be added to it that
#: is** — no patient, no record, no appointment, no document.
#:
#: Matched as prefixes: an entry covers itself and anything under it.
ONBOARDING_PATHS: tuple[str, ...] = (
    "/api/auth/me",
    "/api/auth/logout",
    "/api/auth/refresh",
    "/api/auth/change-password",
    "/api/account",
    "/api/doctor/application",
    "/api/departments",
)


def _is_onboarding_path(path: str) -> bool:
    return any(path == allowed or path.startswith(f"{allowed}/") for allowed in ONBOARDING_PATHS)


async def require_doctor_is_credentialed(
    db: AsyncSession, request: Request, user_id: str, doctor_id: str | None
) -> None:
    """Hold an unapproved doctor inside their own onboarding.

    **Which failure mode this chooses.** There are two ways to get this wrong.
    Refuse the *login* and an applicant is locked out of the half-finished form
    the refusal is telling them to go and finish — their only session was the one
    email verification minted, and it expires in minutes. Refuse *nothing* and an
    unapproved stranger who typed "DOCTOR" into a sign-up form is holding the
    DOCTOR role against real patient data.

    This refuses per request instead, which fails in the safe direction: the
    worst case is a doctor who cannot reach a page they have no business on yet,
    never a doctor who reaches a chart before anybody checked their licence.

    **The credential is the check, not the application row.** ``approve`` is the
    only thing that creates a ``Doctor`` row, so holding one *is* being approved
    — which is also why a doctor an administrator created before self-
    registration existed passes here without an application at all. That makes
    the common path free: an approved doctor costs no query, because the id is
    already on the join that authenticated them.
    """
    if doctor_id is not None or _is_onboarding_path(request.url.path):
        return

    status = (
        await db.execute(
            select(DoctorApplication.status).where(DoctorApplication.user_id == user_id)
        )
    ).scalar_one_or_none()

    if status == DoctorApplicationStatus.APPROVED:
        return

    if status == DoctorApplicationStatus.SUBMITTED:
        raise AppError(
            403,
            ErrorCode.PENDING_APPROVAL,
            "Your registration is with our administrators. We will email you as soon as "
            "it has been reviewed.",
        )
    if status == DoctorApplicationStatus.REJECTED:
        raise AppError(
            403,
            ErrorCode.APPLICATION_REJECTED,
            "Your registration was not approved. Check what needs changing, then submit "
            "it again.",
        )
    # DRAFT, or no application at all.
    raise AppError(
        403,
        ErrorCode.PROFILE_INCOMPLETE,
        "Finish your registration and submit it for approval before using the portal.",
    )


async def get_current_auth(request: Request, db: DbSession) -> AuthContext:
    """Authenticate the request and enforce session expiry server-side.

    The JWT proves identity; the Session row decides whether the caller is still
    allowed in. That split is what makes R8 real — a client that never fires its
    inactivity timer, or a script calling the API directly with a saved cookie,
    is still cut off at the configured idle limit.
    """
    token = _extract_token(request)
    if not token:
        raise unauthenticated()

    payload = verify_access_token(token)
    if payload is None:
        raise unauthenticated("Your sign-in could not be verified. Sign in again.")

    row = (
        await db.execute(
            select(Session, User, Patient.id, Doctor.id)
            .join(User, User.id == Session.user_id)
            .outerjoin(Patient, Patient.user_id == User.id)
            .outerjoin(Doctor, Doctor.user_id == User.id)
            .where(Session.id == payload.sid)
        )
    ).first()

    if row is None:
        raise unauthenticated("Your session has ended. Sign in again.")

    session, user, patient_id, doctor_id = row
    if session.revoked_at is not None or session.user_id != payload.sub:
        raise unauthenticated("Your session has ended. Sign in again.")

    now = utcnow()

    # Absolute lifetime: activity cannot keep a session alive indefinitely.
    if session.expires_at <= now:
        await _revoke(db, session.id, "ABSOLUTE_TIMEOUT")
        raise session_expired("Your session reached its maximum length. Sign in again.")

    idle = check_idle(session.device_class, session.last_seen_at, now)
    if idle.expired:
        await _revoke(db, session.id, "IDLE_TIMEOUT")
        raise session_expired()

    if user.status != UserStatus.ACTIVE:
        await _revoke(db, session.id, "ACCOUNT_INACTIVE")
        raise unauthenticated("This account is not active. Contact an administrator.")

    # Throttled activity write — far finer than the shortest timeout, without
    # an UPDATE on every single request.
    if now - session.last_seen_at > timedelta(seconds=LAST_SEEN_WRITE_THROTTLE_SECONDS):
        await db.execute(update(Session).where(Session.id == session.id).values(last_seen_at=now))

    # Published on the request so a dependency that runs without the auth
    # context — the rate limiter — can bucket by session rather than by IP. An
    # authenticated user behind a hospital's shared NAT should get their own
    # budget instead of sharing one with the whole building.
    request.state.session_id = session.id

    if user.role == Role.DOCTOR:
        await require_doctor_is_credentialed(db, request, user.id, doctor_id)

    return AuthContext(
        user_id=user.id,
        role=user.role,
        session_id=session.id,
        permissions=permissions_for(user.role),
        patient_id=patient_id,
        doctor_id=doctor_id,
        emergency_access_id=payload.eag,
    )


CurrentAuth = Annotated[AuthContext, Depends(get_current_auth)]


def require_role(*roles: Role) -> Callable[[AuthContext], Awaitable[AuthContext]]:
    """Coarse role gate. Useful for whole route groups; never sufficient alone."""

    async def dependency(auth: CurrentAuth) -> AuthContext:
        if auth.role not in roles:
            raise forbidden()
        return auth

    return dependency


def require_permission(*permissions: Permission) -> Callable[[AuthContext], Awaitable[AuthContext]]:
    """Requires every listed permission."""

    async def dependency(auth: CurrentAuth) -> AuthContext:
        if not all(auth.has(p) for p in permissions):
            raise forbidden()
        return auth

    return dependency


def require_any_permission(*permissions: Permission) -> Callable[[AuthContext], Awaitable[AuthContext]]:
    async def dependency(auth: CurrentAuth) -> AuthContext:
        if not any(auth.has(p) for p in permissions):
            raise forbidden()
        return auth

    return dependency


PatientAccessReason = Literal["SELF", "ASSIGNED_DOCTOR", "TREATING_DOCTOR", "ADMIN", "EMERGENCY_ACCESS"]


@dataclass(frozen=True)
class PatientAccess:
    allowed: bool
    reason: PatientAccessReason | None = None


async def resolve_patient_access(db: AsyncSession, auth: AuthContext, patient_id: str) -> PatientAccess:
    """May this caller touch THIS patient?

    A role alone never answers this. For a doctor, access requires a care
    relationship — a standing assignment, or an encounter they are or were
    consulting on. For a patient, the id comes from the session, never the URL
    (spec §8: never trust IDs supplied by the frontend).
    """
    if auth.role == Role.PATIENT:
        return PatientAccess(True, "SELF") if auth.patient_id == patient_id else PatientAccess(False)

    if auth.role == Role.DOCTOR and auth.doctor_id:
        assignment = (
            await db.execute(
                select(DoctorPatientAssignment.id).where(
                    DoctorPatientAssignment.doctor_id == auth.doctor_id,
                    DoctorPatientAssignment.patient_id == patient_id,
                    DoctorPatientAssignment.ended_at.is_(None),
                )
            )
        ).first()
        if assignment:
            return PatientAccess(True, "ASSIGNED_DOCTOR")

        # A doctor consulting this patient has access for that encounter even
        # without a standing assignment.
        encounter = (
            await db.execute(
                select(Appointment.id).where(
                    Appointment.doctor_id == auth.doctor_id,
                    Appointment.patient_id == patient_id,
                    Appointment.status.in_(ENCOUNTER_STATUSES),
                )
            )
        ).first()
        if encounter:
            return PatientAccess(True, "TREATING_DOCTOR")

        return PatientAccess(False)

    if auth.has(Permission.PATIENT_READ_ANY):
        return PatientAccess(True, "ADMIN")

    # Break-glass: only while the grant is active, and only for the exact
    # patient it was issued for.
    if auth.emergency_access_id:
        grant = (
            await db.execute(
                select(EmergencyAccess.id).where(
                    EmergencyAccess.id == auth.emergency_access_id,
                    EmergencyAccess.patient_id == patient_id,
                    EmergencyAccess.status == EmergencyAccessStatus.ACTIVE,
                    EmergencyAccess.expires_at > utcnow(),
                )
            )
        ).first()
        if grant:
            return PatientAccess(True, "EMERGENCY_ACCESS")

    return PatientAccess(False)


async def require_patient_access(
    patient_id: str, request: Request, db: DbSession, auth: CurrentAuth
) -> AuthContext:
    """Route guard for ``/patients/{patient_id}/...``.

    Denials are audited: a rejected attempt to read someone else's chart is a
    security event, not a 403 to discard.
    """
    access = await resolve_patient_access(db, auth, patient_id)

    if not access.allowed:
        await record_audit(
            db,
            AuditEntry(
                action=AuditAction.ACCESS_DENIED,
                severity=AuditSeverity.SECURITY,
                user_id=auth.user_id,
                actor_role=auth.role,
                patient_id=patient_id,
                entity_type="Patient",
                entity_id=patient_id,
                ip_address=client_ip(request),
                user_agent=request.headers.get("user-agent"),
                request_id=getattr(request.state, "request_id", None),
                metadata={"path": request.url.path, "method": request.method},
            ),
        )
        # A rejected attempt to read someone else's chart is a security event
        # that must be retained, not rolled back with the 403 it produced.
        await db.commit()
        raise forbidden_resource()

    if access.reason == "EMERGENCY_ACCESS" and auth.emergency_access_id:
        # Every read under a grant is recorded, and the grant counts its uses.
        await db.execute(
            update(EmergencyAccess)
            .where(EmergencyAccess.id == auth.emergency_access_id)
            .values(access_count=EmergencyAccess.access_count + 1)
        )
        await record_audit(
            db,
            AuditEntry(
                action=AuditAction.EMERGENCY_ACCESS_USED,
                severity=AuditSeverity.BREAK_GLASS,
                user_id=auth.user_id,
                actor_role=auth.role,
                patient_id=patient_id,
                emergency_access_id=auth.emergency_access_id,
                ip_address=client_ip(request),
                user_agent=request.headers.get("user-agent"),
                request_id=getattr(request.state, "request_id", None),
                metadata={"path": request.url.path, "method": request.method},
            ),
        )

    return auth

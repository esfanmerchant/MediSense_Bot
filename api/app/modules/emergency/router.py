"""Break-glass endpoints (requirement R3).

Granting re-mints the caller's **access token** with the grant's id in it. It
does not create a session and does not touch the refresh token: the emergency is
an episode inside the shift someone is already signed in for, not a new login.

**The token is a pointer, not the authority.** ``resolve_patient_access`` looks
the grant up on every single read and checks that it is still ACTIVE, still
unexpired, and still for that exact patient. So a revoked grant stops working on
the next request even though the token in the browser still names it — which is
what makes revocation immediate rather than "immediate once the token expires".
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.config import settings
from app.core.errors import forbidden, not_found
from app.core.ratelimit import limit
from app.core.security import AccessTokenPayload, sign_access_token
from app.db.enums import AuditAction, AuditSeverity, EmergencyAccessStatus
from app.db.models import EmergencyAccess, Session, User
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.auth.service import access_token_ttl_seconds
from app.modules.emergency import service

router = APIRouter(prefix="/emergency", tags=["emergency"])

RequireEmergencyRequest = Annotated[
    object, Depends(require_permission(Permission.EMERGENCY_REQUEST))
]
RequireEmergencyReview = Annotated[
    object, Depends(require_permission(Permission.EMERGENCY_REVIEW))
]

ACCESS_COOKIE = "ms_at"

#: Break-glass is rare by nature — a clinician needs one or two in a shift, not
#: dozens. A low ceiling makes probing for which patient ids exist expensive
#: without ever getting in the way of a real emergency.
GrantRateLimit = Annotated[None, Depends(limit(times=5, seconds=60, scope="emergency"))]


class GrantRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    patient_id: str = Field(alias="patientId", min_length=1, max_length=64)
    #: Long enough to be a sentence. The reason is the only part of this record
    #: that explains the rest of it, so a keystroke is not accepted.
    reason: Annotated[
        str, Field(min_length=service.MIN_REASON_LENGTH, max_length=1000)
    ]


class ReviewRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    notes: Annotated[str, Field(min_length=3, max_length=2000)]


async def _requester_names(db: DbSession, ids: list[str]) -> dict[str, str]:
    if not ids:
        return {}
    rows = (await db.execute(select(User.id, User.name).where(User.id.in_(ids)))).all()
    return {row.id: row.name for row in rows}


@router.post("/request", status_code=201)
async def request_access(
    payload: GrantRequest,
    request: Request,
    response: Response,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireEmergencyRequest,
    __: GrantRateLimit,
) -> dict[str, Any]:
    """Open one patient's chart, now.

    Deliberately not an approval queue. Break-glass that waits for a human has
    failed at the moment it exists for, and staff who cannot get in during an
    emergency start sharing logins — which defeats every control in this system
    rather than just this one.

    What makes it safe instead: a stored reason, a single patient, a short
    clock, a counted and audited read trail, a notification to the patient, and
    a compliance review afterwards.
    """
    grant, created = await service.grant(
        db,
        requester_id=auth.user_id,
        patient_id=payload.patient_id,
        reason=payload.reason,
        ip_address=client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )

    # The device class decides the token's lifetime; a break-glass token on a
    # shared terminal must expire as fast as any other token there.
    device_class = (
        await db.execute(select(Session.device_class).where(Session.id == auth.session_id))
    ).scalar_one_or_none() or "SHARED_TERMINAL"

    ttl = access_token_ttl_seconds(device_class)
    token = sign_access_token(
        AccessTokenPayload(
            sub=auth.user_id, sid=auth.session_id, role=str(auth.role), eag=grant.id
        ),
        ttl,
    )
    response.set_cookie(
        ACCESS_COOKIE,
        token,
        max_age=ttl,
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
        path="/",
    )

    if created:
        await record_audit(
            db,
            AuditEntry(
                action=AuditAction.EMERGENCY_ACCESS_GRANTED,
                severity=AuditSeverity.BREAK_GLASS,
                user_id=auth.user_id,
                actor_role=auth.role,
                patient_id=grant.patient_id,
                entity_type="EmergencyAccess",
                entity_id=grant.id,
                emergency_access_id=grant.id,
                ip_address=client_ip(request),
                user_agent=request.headers.get("user-agent"),
                request_id=getattr(request.state, "request_id", None),
                # The reason is recorded here as well as on the grant: the audit
                # log is append-only, so this copy cannot be edited later even
                # if the grant row somehow could be.
                metadata={"reason": grant.reason, "expiresAt": grant.expires_at.isoformat()},
            ),
        )

        requester = (
            await db.execute(select(User.name).where(User.id == auth.user_id))
        ).scalar_one_or_none()
        await service.announce(db, grant, requester or "A clinician")

    return ok(
        {
            **service.serialize(grant),
            # False when an existing live grant was reused — a dropped session
            # mid-emergency should not create a second record of one event.
            "created": created,
            "expiresInMinutes": service.GRANT_MINUTES,
            "notice": (
                "This access is limited to this patient, expires automatically, and "
                "every record you open is logged and reviewed."
            ),
        }
    )


@router.get("/active")
async def my_active_grants(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    """What the caller currently holds. Any signed-in user may ask about their own."""
    rows = (
        (
            await db.execute(
                select(EmergencyAccess)
                .where(
                    EmergencyAccess.requester_id == auth.user_id,
                    EmergencyAccess.status == EmergencyAccessStatus.ACTIVE,
                )
                .order_by(EmergencyAccess.granted_at.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )
    return ok([service.serialize(row) for row in rows if service.is_live(row)])


@router.post("/{grant_id}/revoke")
async def revoke_access(
    grant_id: str,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
) -> dict[str, Any]:
    """End a grant early.

    The holder may hand it back, and an administrator may take it away. Nobody
    else — a third party revoking someone's access mid-emergency is its own
    safety problem.
    """
    grant = (
        await db.execute(select(EmergencyAccess).where(EmergencyAccess.id == grant_id))
    ).scalar_one_or_none()
    if grant is None:
        raise not_found("No such emergency access.")

    is_holder = grant.requester_id == auth.user_id
    if not is_holder and not auth.has(Permission.EMERGENCY_REVIEW):
        raise forbidden("You cannot revoke that emergency access.")

    await service.revoke(db, grant, revoked_by=auth.user_id)

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.EMERGENCY_ACCESS_REVOKED,
            severity=AuditSeverity.BREAK_GLASS,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=grant.patient_id,
            entity_type="EmergencyAccess",
            entity_id=grant.id,
            emergency_access_id=grant.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"byHolder": is_holder, "accessCount": grant.access_count},
        ),
    )

    return ok(service.serialize(grant))


@router.get("")
async def list_grants(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    _: RequireEmergencyReview,
    unreviewed_only: Annotated[bool, Query(alias="unreviewedOnly")] = False,
) -> dict[str, Any]:
    """The compliance review queue.

    ``meta.unreviewed`` is the number that matters: the control here is that
    somebody looks at every one of these, so the outstanding count belongs in
    front of the reviewer rather than behind a filter they have to think to
    apply.
    """
    filters: list[Any] = []
    if unreviewed_only:
        filters.append(EmergencyAccess.reviewed_at.is_(None))

    total = (
        await db.execute(select(func.count()).select_from(EmergencyAccess).where(*filters))
    ).scalar_one()
    outstanding = (
        await db.execute(
            select(func.count())
            .select_from(EmergencyAccess)
            .where(EmergencyAccess.reviewed_at.is_(None))
        )
    ).scalar_one()

    rows = (
        (
            await db.execute(
                select(EmergencyAccess)
                .where(*filters)
                .order_by(EmergencyAccess.granted_at.desc())
                .limit(page.limit)
                .offset(page.offset)
            )
        )
        .scalars()
        .all()
    )
    names = await _requester_names(db, [row.requester_id for row in rows])

    return ok(
        [service.serialize(row, requester_name=names.get(row.requester_id)) for row in rows],
        {**page.meta(total), "unreviewed": outstanding},
    )


@router.post("/{grant_id}/review")
async def review_grant(
    grant_id: str,
    payload: ReviewRequest,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireEmergencyReview,
) -> dict[str, Any]:
    """Record the review. This is the control the whole design rests on."""
    grant = (
        await db.execute(select(EmergencyAccess).where(EmergencyAccess.id == grant_id))
    ).scalar_one_or_none()
    if grant is None:
        raise not_found("No such emergency access.")

    await service.review(db, grant, reviewer_id=auth.user_id, notes=payload.notes)

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.EMERGENCY_ACCESS_GRANTED,
            severity=AuditSeverity.BREAK_GLASS,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=grant.patient_id,
            entity_type="EmergencyAccess",
            entity_id=grant.id,
            emergency_access_id=grant.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"operation": "review", "accessCount": grant.access_count},
        ),
    )

    names = await _requester_names(db, [grant.requester_id])
    return ok(service.serialize(grant, requester_name=names.get(grant.requester_id)))

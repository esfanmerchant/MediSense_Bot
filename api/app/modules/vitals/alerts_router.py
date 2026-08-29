"""Alerts and the live feed (spec §16).

Alerts carry a measured value and a patient, so they are clinical content and
are scoped like it: a doctor sees their own caseload, a patient sees their own
alerts, and anyone else sees nothing. That includes nurses — they hold
``alert:read:assigned`` but have no assignments, so they see alerts only for
patients they currently hold a break-glass grant on, which is the same rule
their chart access follows (conflict C1). Administrators are excluded here as
they are from every other clinical read.

The stream is server-sent events. Its scope is resolved once, when the
connection opens, from the same clinical rules — a client is never sent an event
about a patient it would be refused on a GET, so there is nothing for a modified
page to reveal.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.errors import bad_request, not_found
from app.db.base import utcnow
from app.db.enums import AlertSeverity, AlertStatus, AuditAction, Role
from app.db.models import Alert, EmergencyAccess
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.records.access import caseload_patient_ids
from app.modules.vitals import service, stream

router = APIRouter(prefix="/alerts", tags=["alerts"])

RequireAlertRead = Annotated[
    object, Depends(require_permission(Permission.ALERT_READ_ASSIGNED))
]
RequireAlertManage = Annotated[object, Depends(require_permission(Permission.ALERT_MANAGE))]


async def visible_patient_ids(db: DbSession, auth: CurrentAuth) -> frozenset[str]:
    """Exactly the patients this caller may hear about.

    Materialised as a set rather than left as a SQL condition because the stream
    needs to filter in Python, and having one function answer the question for
    both paths is what stops the live feed and the list view drifting apart.
    """
    if auth.role == Role.PATIENT and auth.patient_id:
        return frozenset({auth.patient_id})

    if auth.role == Role.DOCTOR and auth.doctor_id:
        rows = (
            (await db.execute(select(caseload_patient_ids(auth.doctor_id))))
            .scalars()
            .all()
        )
        return frozenset(rows)

    if auth.role == Role.NURSE:
        # No standing access; only patients under an active grant right now.
        rows = (
            (
                await db.execute(
                    select(EmergencyAccess.patient_id).where(
                        EmergencyAccess.requester_id == auth.user_id,
                        EmergencyAccess.revoked_at.is_(None),
                        EmergencyAccess.expires_at > utcnow(),
                    )
                )
            )
            .scalars()
            .all()
        )
        return frozenset(rows)

    return frozenset()


@router.get("")
async def list_alerts(
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireAlertRead,
    page: Annotated[Page, Depends(pagination)],
    status: AlertStatus | None = None,
    severity: AlertSeverity | None = None,
    patient_id: Annotated[str | None, Query(alias="patientId", max_length=64)] = None,
) -> dict[str, Any]:
    """Alerts this caller may see, newest first."""
    visible = await visible_patient_ids(db, auth)
    if not visible:
        # An honest empty page. A doctor with no caseload and a nurse with no
        # grant are both legitimately in this position.
        return ok([], page.meta(0))

    filters: list[Any] = [Alert.patient_id.in_(visible)]
    if status is not None:
        filters.append(Alert.status == status)
    if severity is not None:
        filters.append(Alert.severity == severity)
    if patient_id is not None:
        if patient_id not in visible:
            raise not_found("No alerts for that patient.")
        filters.append(Alert.patient_id == patient_id)

    total = (
        await db.execute(select(func.count()).select_from(Alert).where(*filters))
    ).scalar_one()

    rows = (
        (
            await db.execute(
                select(Alert)
                .where(*filters)
                .order_by(Alert.created_at.desc())
                .limit(page.limit)
                .offset(page.offset)
            )
        )
        .scalars()
        .all()
    )

    return ok([service.serialize_alert(row) for row in rows], page.meta(total))


async def _load_visible_alert(db: DbSession, auth: CurrentAuth, alert_id: str) -> Alert:
    alert = (
        await db.execute(select(Alert).where(Alert.id == alert_id))
    ).scalar_one_or_none()
    # One message for "does not exist" and "not yours": an id that answers
    # differently in the two cases is an enumeration oracle.
    visible = await visible_patient_ids(db, auth)
    if alert is None or alert.patient_id not in visible:
        raise not_found("No such alert.")
    return alert


@router.post("/{alert_id}/acknowledge")
async def acknowledge(
    alert_id: str,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireAlertManage,
) -> dict[str, Any]:
    """Record that a clinician has seen this and is dealing with it.

    Acknowledging is not resolving. It stops the alert being re-raised as new
    while leaving it open, because "someone is looking at it" and "the patient
    is fine" are different claims and the ward needs to tell them apart.
    """
    alert = await _load_visible_alert(db, auth, alert_id)
    if alert.status == AlertStatus.RESOLVED:
        raise bad_request("That alert is already resolved.")

    alert.status = AlertStatus.ACKNOWLEDGED
    alert.acknowledged_by_id = auth.user_id
    alert.acknowledged_at = utcnow()
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.VITAL_ALERT,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=alert.patient_id,
            entity_type="Alert",
            entity_id=alert.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"operation": "acknowledge", "severity": str(alert.severity)},
        ),
    )

    stream.publish("alert", alert.patient_id, service.serialize_alert(alert))
    return ok(service.serialize_alert(alert))


@router.post("/{alert_id}/resolve")
async def resolve(
    alert_id: str,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireAlertManage,
) -> dict[str, Any]:
    """Close the alert.

    Only after this can the same vital raise a new one, which is what makes a
    recurrence visible instead of being folded into a stale entry.
    """
    alert = await _load_visible_alert(db, auth, alert_id)
    if alert.status == AlertStatus.RESOLVED:
        return ok(service.serialize_alert(alert))

    alert.status = AlertStatus.RESOLVED
    alert.resolved_at = utcnow()
    if alert.acknowledged_by_id is None:
        # Resolving without acknowledging is normal — the doctor saw it and
        # acted in one step — but the trail should not claim nobody saw it.
        alert.acknowledged_by_id = auth.user_id
        alert.acknowledged_at = alert.resolved_at
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.VITAL_ALERT,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=alert.patient_id,
            entity_type="Alert",
            entity_id=alert.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"operation": "resolve", "severity": str(alert.severity)},
        ),
    )

    stream.publish("alert", alert.patient_id, service.serialize_alert(alert))
    return ok(service.serialize_alert(alert))


@router.get("/stream")
async def alert_stream(
    auth: CurrentAuth,
    db: DbSession,
    _: RequireAlertRead,
) -> StreamingResponse:
    """Live vitals and alerts over SSE (spec §16: not a frontend timer).

    Scope is fixed at connection time. A doctor whose caseload changes mid-shift
    picks the change up on the next reconnect rather than having it applied to a
    long-lived stream — the conservative direction, since the alternative is
    re-resolving access on every event.
    """
    visible = await visible_patient_ids(db, auth)
    subscriber = stream.subscribe(visible)

    return StreamingResponse(
        stream.events(subscriber),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Nginx buffers proxied responses by default, which would hold
            # events until the buffer fills and defeat the whole mechanism.
            "X-Accel-Buffering": "no",
        },
    )

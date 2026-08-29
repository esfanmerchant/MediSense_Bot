"""Reading the audit trail (spec §"Audit Logging", requirement R6).

**Read-only, and there is no counterpart.** This module has no POST, PATCH or
DELETE, because the requirement is that audit records are "append-only and
inaccessible for modification/deletion through ordinary application APIs". The
absence of a write route is not an omission to fill in later — it is the
requirement, expressed the only way an API can express it.

``record_audit()`` remains the sole writer, and it is called from inside the
operations being recorded rather than exposed as an endpoint. Nothing, including
an administrator, can add an entry by hand: an audit log somebody can write to
is a log somebody can forge.

**Reading it is itself audited.** Who looked at the trail, and for which
patient, is exactly the kind of question the trail exists to answer — and an
administrator browsing charts through the audit log would otherwise be the one
access this system does not record.

**Entries are not clinical content.** Metadata holds references — field names,
record ids, counts — never diagnoses or values (conflict C5), so this endpoint
cannot become a back door into records an administrator is otherwise refused.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.db.enums import AuditAction, AuditSeverity
from app.db.models import AuditLog, User
from app.modules.audit.service import AuditEntry, record_audit, verify_audit_chain
from app.modules.auth.rbac import Permission

router = APIRouter(prefix="/audit-logs", tags=["audit"])

RequireAuditRead = Annotated[object, Depends(require_permission(Permission.AUDIT_READ))]


def _serialize(row: AuditLog, actor_name: str | None) -> dict[str, Any]:
    return {
        "id": row.id,
        "action": str(row.action),
        "severity": str(row.severity),
        "userId": row.user_id,
        # Resolved for display, and deliberately nullable: `userId` is not a
        # foreign key, so an entry outlives the account that caused it (R6).
        # "(deleted account)" is the honest answer, not a broken row.
        "actorName": actor_name,
        "actorRole": str(row.actor_role) if row.actor_role else None,
        "entityType": row.entity_type,
        "entityId": row.entity_id,
        "patientId": row.patient_id,
        "ipAddress": row.ip_address,
        "requestId": row.request_id,
        "emergencyAccessId": row.emergency_access_id,
        "metadata": row.audit_metadata,
        "timestamp": row.timestamp.isoformat() + "Z",
    }


@router.get("")
async def list_entries(
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    _: RequireAuditRead,
    action: AuditAction | None = None,
    severity: AuditSeverity | None = None,
    user_id: Annotated[str | None, Query(alias="userId", max_length=64)] = None,
    patient_id: Annotated[str | None, Query(alias="patientId", max_length=64)] = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> dict[str, Any]:
    """The trail, newest first.

    ``meta.securityEvents`` counts the entries that describe something going
    wrong — denied access, break-glass use. Those are what an administrator is
    actually here for, and burying the count behind a filter means it is only
    seen by someone who already suspected there was something to see.
    """
    filters: list[Any] = []
    if action is not None:
        filters.append(AuditLog.action == action)
    if severity is not None:
        filters.append(AuditLog.severity == severity)
    if user_id is not None:
        filters.append(AuditLog.user_id == user_id)
    if patient_id is not None:
        filters.append(AuditLog.patient_id == patient_id)
    if since is not None:
        filters.append(AuditLog.timestamp >= _naive_utc(since))
    if until is not None:
        filters.append(AuditLog.timestamp < _naive_utc(until))

    total = (
        await db.execute(select(func.count()).select_from(AuditLog).where(*filters))
    ).scalar_one()

    rows = (
        (
            await db.execute(
                select(AuditLog)
                .where(*filters)
                .order_by(AuditLog.timestamp.desc())
                .limit(page.limit)
                .offset(page.offset)
            )
        )
        .scalars()
        .all()
    )

    actor_ids = {row.user_id for row in rows if row.user_id}
    names: dict[str, str] = {}
    if actor_ids:
        names = {
            row.id: row.name
            for row in (
                await db.execute(select(User.id, User.name).where(User.id.in_(actor_ids)))
            ).all()
        }

    security_events = (
        await db.execute(
            select(func.count())
            .select_from(AuditLog)
            .where(
                *filters,
                AuditLog.severity.in_([AuditSeverity.SECURITY, AuditSeverity.BREAK_GLASS]),
            )
        )
    ).scalar_one()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.AUDIT_VIEWED,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=patient_id,
            entity_type="AuditLog",
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            # The filters, not the results: what someone went looking for is the
            # useful fact, and copying rows back in would grow the log by the
            # square of how often it is read.
            metadata={
                "action": str(action) if action else None,
                "severity": str(severity) if severity else None,
                "userId": user_id,
                "returned": len(rows),
            },
        ),
    )

    return ok(
        [_serialize(row, names.get(row.user_id or "")) for row in rows],
        {**page.meta(total), "securityEvents": security_events},
    )


@router.get("/verify")
async def verify_chain(
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireAuditRead,
    limit: Annotated[int, Query(ge=1, le=10000)] = 1000,
) -> dict[str, Any]:
    """Recompute the hash chain and report whether it still holds.

    This is what makes "immutable" a testable claim rather than an assertion in
    a document. Entries are chained under a Postgres advisory lock, so a row
    edited or removed directly in the database — bypassing the application
    entirely — fails here and names the entry where the chain breaks.

    A failure is not a bug in this endpoint. It means the table has been
    tampered with.
    """
    result = await verify_audit_chain(db, limit=limit)

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.AUDIT_VIEWED,
            severity=AuditSeverity.NOTICE if result.valid else AuditSeverity.SECURITY,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="AuditLog",
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"operation": "verify", "valid": result.valid, "checked": result.checked},
        ),
    )

    return ok(
        {
            "valid": result.valid,
            "checked": result.checked,
            "brokenAt": result.broken_at_id,
            "detail": (
                "The chain is intact."
                if result.valid
                else "The chain does not verify. An entry has been altered or removed."
            ),
        }
    )


def _naive_utc(value: datetime) -> datetime:
    """Stored timestamps are naive UTC; a query parameter may carry a zone."""
    if value.tzinfo is not None:
        return value.astimezone(UTC).replace(tzinfo=None)
    return value

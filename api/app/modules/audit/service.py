"""Append-only, hash-chained audit log (R6).

``record_audit`` is the only write path. There is no update or delete
counterpart anywhere in the application, and deployments should additionally
revoke UPDATE/DELETE on ``audit_logs`` from the application role — an
append-only guarantee enforced only in code does not hold against the database
credential the code itself uses.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import logger
from app.db.base import new_id, utcnow
from app.db.enums import AuditAction, AuditSeverity, Role
from app.db.models import AuditLog

#: Never allowed in audit metadata, dropped defensively even if a caller passes
#: them. Metadata holds references — field names, ids, counts — never values.
FORBIDDEN_METADATA_KEYS = frozenset(
    {
        "password",
        "passwordHash",
        "password_hash",
        "newPassword",
        "new_password",
        "currentPassword",
        "current_password",
        "token",
        "accessToken",
        "access_token",
        "refreshToken",
        "refresh_token",
        "tokenHash",
        "token_hash",
        "apiKey",
        "api_key",
        "extractedText",
        "extracted_text",
        "authorization",
        "cookie",
    }
)


@dataclass
class AuditEntry:
    action: AuditAction
    user_id: str | None = None
    actor_role: Role | None = None
    severity: AuditSeverity = AuditSeverity.INFO
    entity_type: str | None = None
    entity_id: str | None = None
    #: Patient whose data was touched — powers per-patient access reports.
    patient_id: str | None = None
    ip_address: str | None = None
    user_agent: str | None = None
    request_id: str | None = None
    emergency_access_id: str | None = None
    metadata: dict[str, Any] | None = field(default=None)


def sanitize_metadata(value: Any, depth: int = 0) -> Any:
    if depth > 4 or not isinstance(value, dict | list):
        return value
    if isinstance(value, list):
        return [sanitize_metadata(item, depth + 1) for item in value[:50]]
    return {
        key: sanitize_metadata(val, depth + 1)
        for key, val in value.items()
        if key not in FORBIDDEN_METADATA_KEYS
    }


def _canonical(value: Any) -> Any:
    """Sort keys at EVERY depth, not just the top level.

    Postgres ``jsonb`` does not preserve object key order — it stores keys
    sorted by length then bytewise — so metadata read back comes out reordered.
    Without recursive sorting, no stored entry would ever re-verify. Arrays keep
    their order, where order is meaningful.
    """
    if isinstance(value, dict):
        return {key: _canonical(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    return value


def compute_entry_hash(previous_hash: str | None, payload: dict[str, Any]) -> str:
    canonical = json.dumps(_canonical(payload), separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(f"{previous_hash or 'GENESIS'}|{canonical}".encode()).hexdigest()


def _payload(entry: AuditEntry, timestamp: datetime, metadata: Any) -> dict[str, Any]:
    return {
        "action": str(entry.action),
        "userId": entry.user_id,
        "actorRole": str(entry.actor_role) if entry.actor_role else None,
        "severity": str(entry.severity),
        "entityType": entry.entity_type,
        "entityId": entry.entity_id,
        "patientId": entry.patient_id,
        "ipAddress": entry.ip_address,
        "requestId": entry.request_id,
        "emergencyAccessId": entry.emergency_access_id,
        "timestamp": timestamp.isoformat(),
        "metadata": metadata,
    }


async def record_audit(db: AsyncSession, entry: AuditEntry) -> None:
    """Append one entry.

    The chain is built under a Postgres advisory lock so two concurrent writers
    cannot read the same predecessor and fork the chain. A failure here is
    logged loudly but never fails the request that triggered it — though a
    silent failure would defeat R6, so it is surfaced for alerting.
    """
    try:
        metadata = sanitize_metadata(entry.metadata) if entry.metadata is not None else None

        # Serialises chain appends; released automatically at transaction end.
        await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('medisense_audit_chain'))"))

        previous = (
            await db.execute(select(AuditLog.entry_hash).order_by(AuditLog.timestamp.desc()).limit(1))
        ).scalar_one_or_none()

        timestamp = utcnow()
        db.add(
            AuditLog(
                id=new_id(),
                user_id=entry.user_id,
                actor_role=entry.actor_role,
                action=entry.action,
                severity=entry.severity,
                entity_type=entry.entity_type,
                entity_id=entry.entity_id,
                patient_id=entry.patient_id,
                ip_address=entry.ip_address,
                user_agent=entry.user_agent,
                request_id=entry.request_id,
                audit_metadata=metadata,
                emergency_access_id=entry.emergency_access_id,
                previous_hash=previous,
                entry_hash=compute_entry_hash(previous, _payload(entry, timestamp, metadata)),
                timestamp=timestamp,
            )
        )
        await db.flush()
    except Exception:
        logger.exception("audit_write_failed", action=str(entry.action))


@dataclass(frozen=True)
class ChainVerification:
    valid: bool
    checked: int
    broken_at_id: str | None = None


async def verify_audit_chain(db: AsyncSession, limit: int = 1000) -> ChainVerification:
    """Walk the chain oldest-first and recompute each hash.

    A row edited or deleted directly in the database breaks verification here —
    this is what makes "immutable" testable rather than merely asserted.
    """
    rows = (
        (await db.execute(select(AuditLog).order_by(AuditLog.timestamp.asc()).limit(limit))).scalars().all()
    )

    previous_hash: str | None = None
    checked = 0

    for row in rows:
        payload = {
            "action": str(row.action),
            "userId": row.user_id,
            "actorRole": str(row.actor_role) if row.actor_role else None,
            "severity": str(row.severity),
            "entityType": row.entity_type,
            "entityId": row.entity_id,
            "patientId": row.patient_id,
            "ipAddress": row.ip_address,
            "requestId": row.request_id,
            "emergencyAccessId": row.emergency_access_id,
            "timestamp": row.timestamp.isoformat(),
            "metadata": row.audit_metadata,
        }
        if row.previous_hash != previous_hash:
            return ChainVerification(valid=False, checked=checked, broken_at_id=row.id)
        if compute_entry_hash(previous_hash, payload) != row.entry_hash:
            return ChainVerification(valid=False, checked=checked, broken_at_id=row.id)

        previous_hash = row.entry_hash
        checked += 1

    return ChainVerification(valid=True, checked=checked)

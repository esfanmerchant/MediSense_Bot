"""Add AUDIT_VIEWED to the AuditAction enum.

Reading the audit trail is itself a sensitive action. Without a value for it,
the one access this system would not record is an administrator browsing charts
*through* the audit log — which is precisely the gap R6 exists to close.

Recording it as CONFIG_CHANGED or PATIENT_RECORD_VIEW instead would put a false
claim in an append-only table, and the whole value of that table is that what it
says happened is what happened.

Revision ID: 0005_audit_viewed_action
Revises: 0004_invoice_number_sequence
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0005_audit_viewed_action"
down_revision: str | None = "0004_invoice_number_sequence"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # IF NOT EXISTS makes this a no-op on a database that already has the value,
    # so the migration is safe to re-run and safe against a hand-patched
    # environment. Postgres will not add an enum value inside a transaction
    # block on older versions; Alembic runs this statement on its own.
    op.execute("ALTER TYPE \"AuditAction\" ADD VALUE IF NOT EXISTS 'AUDIT_VIEWED'")


def downgrade() -> None:
    # Deliberately a no-op. Postgres cannot remove a value from an enum without
    # rewriting the type, and rows already recorded as AUDIT_VIEWED must not be
    # rewritten to say something else — the log is append-only in both
    # directions.
    pass

"""A sequence for invoice numbers.

``invoices_invoiceNumber_key`` is unique, so the number has to be allocated
atomically. Deriving it from ``SELECT count(*) + 1`` is a race with that very
index at the end of it: two consultations completing at the same moment compute
the same number, and one fails on a constraint that has nothing to do with the
actual problem.

A sequence removes the race entirely. ``nextval`` is not rolled back with its
transaction, so a failed completion burns a number rather than reissuing it —
the correct trade, since a gap in a number series is an accounting curiosity and
a reused invoice number is a reconciliation problem.

The sequence starts above any number already in the table, so this is safe to
run against a database that has been billing for a while.

Revision ID: 0004_invoice_number_sequence
Revises: 0003_vital_threshold_defaults
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0004_invoice_number_sequence"
down_revision: str | None = "0003_vital_threshold_defaults"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE SEQUENCE IF NOT EXISTS invoice_number_seq AS bigint START WITH 1")

    # Existing numbers look like INV-2026-000123. Advance past the highest one
    # so a database with history cannot reissue a number it has already used.
    op.execute(
        """
        SELECT setval(
            'invoice_number_seq',
            GREATEST(
                (SELECT COALESCE(MAX(NULLIF(regexp_replace("invoiceNumber", '^.*-', ''), '')::bigint), 0)
                 FROM invoices
                 WHERE "invoiceNumber" ~ '^INV-[0-9]{4}-[0-9]+$'),
                1
            ),
            true
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP SEQUENCE IF EXISTS invoice_number_seq")

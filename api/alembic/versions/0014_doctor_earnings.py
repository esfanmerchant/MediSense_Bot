"""What a doctor has earned, and getting it out.

Two tables, and the choice between them is the whole design.

**``doctor_ledger_entries``** is a list of signed movements, not a balance. A
balance stored on the doctor row is one bad write away from being wrong with
nothing to check it against — no way to answer "wrong since when, and because of
what". A sum of entries can be recomputed at any time, every movement names its
cause, and a mistake is a correcting entry rather than an edit to a number
somebody is owed.

A withdrawal debits the ledger the moment it is **requested**, not when it is
paid. Otherwise the same balance can be requested twice while the first request
sits in the queue, and the hospital finds out by paying out more than it holds.
A refused withdrawal writes a reversing credit rather than deleting the debit,
so the ledger reads as what happened rather than as what was left over.

**``withdrawals``** is the request itself: how much, where to send it, and what
became of it. The account details live on the row rather than on the doctor,
because a doctor may be paid to a different account each time and the record has
to say where *this* money actually went — a doctor changing their bank next
month must not silently rewrite where last month's payment was sent.

``proofPath`` is the administrator's own screenshot of the outgoing transfer,
mirroring the one the patient uploads on the way in. Both sides of the money
carry evidence, and neither is taken on trust.

Revision ID: 0014_doctor_earnings
Revises: 0013_manual_payments
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0014_doctor_earnings"
down_revision: str | None = "0013_manual_payments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# `create_type=False` because these are created explicitly in `upgrade`, before
# the tables that use them. Left at the default, SQLAlchemy emits CREATE TYPE a
# second time as a side effect of `create_table` and the migration dies on
# "type already exists" — having created it itself moments earlier.
KIND = postgresql.ENUM(
    "EARNING", "WITHDRAWAL", "WITHDRAWAL_REVERSAL",
    name="LedgerEntryKind", create_type=False,
)
METHOD = postgresql.ENUM(
    "BANK", "EASYPAISA", "JAZZCASH", "NAYAPAY",
    name="WithdrawalMethod", create_type=False,
)
STATUS = postgresql.ENUM(
    "REQUESTED", "PAID", "REJECTED", name="WithdrawalStatus", create_type=False
)


def upgrade() -> None:
    KIND.create(op.get_bind(), checkfirst=True)
    METHOD.create(op.get_bind(), checkfirst=True)
    STATUS.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "withdrawals",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "doctorId",
            sa.Text(),
            sa.ForeignKey("doctors.id", ondelete="CASCADE", onupdate="CASCADE"),
            nullable=False,
        ),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("currency", sa.Text(), nullable=False, server_default="PKR"),
        sa.Column("method", METHOD, nullable=False),
        # Where this particular payment went. On the row, not the doctor: a
        # doctor changing bank next month must not rewrite where last month's
        # money was sent.
        sa.Column("accountName", sa.String(160), nullable=False),
        sa.Column("accountNumber", sa.String(64), nullable=False),
        sa.Column("bankName", sa.String(120), nullable=True),
        sa.Column("status", STATUS, nullable=False, server_default="REQUESTED"),
        # The administrator's screenshot of the outgoing transfer, and their
        # reference for it — the mirror of what the patient uploads coming in.
        sa.Column("proofPath", sa.Text(), nullable=True),
        sa.Column("reference", sa.String(120), nullable=True),
        sa.Column("reviewedById", sa.Text(), nullable=True),
        sa.Column("reviewedAt", sa.DateTime(), nullable=True),
        sa.Column("rejectionReason", sa.Text(), nullable=True),
        sa.Column("createdAt", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("amount > 0", name="ck_withdrawal_amount_positive"),
    )
    op.create_index("ix_withdrawals_doctor", "withdrawals", ["doctorId"])
    op.create_index("ix_withdrawals_status", "withdrawals", ["status"])

    op.create_table(
        "doctor_ledger_entries",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "doctorId",
            sa.Text(),
            sa.ForeignKey("doctors.id", ondelete="CASCADE", onupdate="CASCADE"),
            nullable=False,
        ),
        # Signed: credits positive, debits negative, and the balance is their
        # sum. One column rather than two means no query can add up the wrong
        # one, and no entry can be a credit and a debit at once.
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("currency", sa.Text(), nullable=False, server_default="PKR"),
        sa.Column("kind", KIND, nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "invoiceId",
            sa.Text(),
            sa.ForeignKey("invoices.id", ondelete="SET NULL", onupdate="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "withdrawalId",
            sa.Text(),
            sa.ForeignKey("withdrawals.id", ondelete="SET NULL", onupdate="CASCADE"),
            nullable=True,
        ),
        sa.Column("createdAt", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_ledger_doctor", "doctor_ledger_entries", ["doctorId"])
    # One earning per invoice, structurally. A confirmation delivered twice, or
    # an administrator who confirms and un-confirms, must not pay a doctor
    # twice for one consultation — and a partial unique index says so in the
    # place that cannot be bypassed.
    op.execute(
        'CREATE UNIQUE INDEX ux_ledger_one_earning_per_invoice '
        'ON doctor_ledger_entries ("invoiceId") '
        "WHERE kind = 'EARNING' AND \"invoiceId\" IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ux_ledger_one_earning_per_invoice")
    op.drop_index("ix_ledger_doctor", table_name="doctor_ledger_entries")
    op.drop_table("doctor_ledger_entries")

    op.drop_index("ix_withdrawals_status", table_name="withdrawals")
    op.drop_index("ix_withdrawals_doctor", table_name="withdrawals")
    op.drop_table("withdrawals")

    STATUS.drop(op.get_bind(), checkfirst=True)
    METHOD.drop(op.get_bind(), checkfirst=True)
    KIND.drop(op.get_bind(), checkfirst=True)

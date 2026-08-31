"""Rates an administrator owns, and a record of every payment attempt.

Three changes, all answering the same complaint: the money side of this system
was fixed at deploy time and had no way in for the person who owes.

**``billing_settings``** — one row, ever. The tax rate lived in
``INVOICE_TAX_PERCENT``, an environment variable, so correcting it meant a
redeployment by whoever holds the server; a hospital administrator could not
touch the rate they are accountable for. It moves into the database beside two
new figures, a platform fee and a late fee. The single row is enforced by a
check constraint on a fixed primary key rather than by convention, because "we
only ever insert one" is a rule that survives exactly until somebody writes a
second insert.

**Three columns on ``invoices``** — ``platformFee``, ``taxPercent`` and
``lateFee``. Every one of them records *what was charged on this bill*, not what
the current settings say, and that is the whole design. An invoice is a
statement of a debt as it stood when it was issued; if it read its numbers from
live settings, changing the tax rate would silently restate every unpaid bill in
the hospital, including ones already sent to a patient. So the rates are copied
onto the invoice at issue, and a later change reaches new invoices only — which
is exactly what was asked for.

``lateFee`` is the amount that *will* be charged if this bill goes past its due
date, locked at issue for the same reason. Whether it currently applies is
computed from ``dueAt``, never stored, matching how ``OVERDUE`` already works
here: a stored flag would need a nightly sweep to stay true, and a bill that is
overdue only once a job has run is a bill that lies between midnights.

**``payments``** — one row per attempt, not per success. A redirect gateway
takes the payer out of this system entirely, so the row is written before they
leave; a person who pays and then closes the tab is then a payment to reconcile
rather than money with no trace on our side. ``gatewayRef`` is unique, because
it is what a gateway echoes back and what stops one callback being counted
twice.

Nothing is backfilled onto existing invoices beyond a zero default: they were
issued under the old terms and their totals are already correct.

Revision ID: 0011_billing_settings_pay
Revises: 0010_practice_location

The identifier is abbreviated for the same reason 0006 through 0010 are:
Alembic stores it in a ``varchar(32)``.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0011_billing_settings_pay"
down_revision: str | None = "0010_practice_location"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: The one row's primary key. A constant rather than a generated id, so the
#: settings can always be fetched without first asking which row they are in.
SINGLETON = "singleton"


def upgrade() -> None:
    # ---- the rates an administrator owns --------------------------------
    op.create_table(
        "billing_settings",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("taxPercent", sa.Numeric(5, 2), nullable=False, server_default="0"),
        sa.Column("platformFee", sa.Numeric(10, 2), nullable=False, server_default="0"),
        sa.Column("lateFee", sa.Numeric(10, 2), nullable=False, server_default="0"),
        sa.Column("updatedAt", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.Column("updatedById", sa.Text(), nullable=True),
        # One row, structurally.
        sa.CheckConstraint(f"id = '{SINGLETON}'", name="ck_billing_settings_singleton"),
        # Negative money is a typo, not a discount. A refund is a credit note.
        sa.CheckConstraint("\"taxPercent\" >= 0 AND \"taxPercent\" <= 100", name="ck_billing_tax_range"),
        sa.CheckConstraint("\"platformFee\" >= 0", name="ck_billing_platform_fee_positive"),
        sa.CheckConstraint("\"lateFee\" >= 0", name="ck_billing_late_fee_positive"),
    )

    # Seeded from the environment variable this replaces, so a deployment that
    # had configured a tax rate keeps charging it across the upgrade.
    op.execute(
        sa.text(
            'INSERT INTO billing_settings (id, "taxPercent", "platformFee", "lateFee") '
            "VALUES (:id, 0, 0, 0) ON CONFLICT (id) DO NOTHING"
        ).bindparams(id=SINGLETON)
    )

    # ---- what each invoice actually charged ------------------------------
    for name in ("platformFee", "lateFee"):
        op.add_column(
            "invoices",
            sa.Column(name, sa.Numeric(10, 2), nullable=False, server_default="0"),
        )
    op.add_column(
        "invoices",
        sa.Column("taxPercent", sa.Numeric(5, 2), nullable=False, server_default="0"),
    )

    # ---- every attempt to settle one -------------------------------------
    op.create_table(
        "payments",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "invoiceId",
            sa.Text(),
            sa.ForeignKey("invoices.id", ondelete="CASCADE", onupdate="CASCADE"),
            nullable=False,
        ),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("currency", sa.Text(), nullable=False, server_default="PKR"),
        sa.Column(
            "method",
            sa.Enum("JAZZCASH", "EASYPAISA", "COUNTER", name="PaymentMethod"),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Enum("INITIATED", "SUCCEEDED", "FAILED", name="PaymentStatus"),
            nullable=False,
        ),
        #: Our reference, sent to the gateway and echoed back. Unique, because
        #: it is the only thing standing between one payment and a callback
        #: delivered twice.
        sa.Column("gatewayRef", sa.Text(), nullable=False, unique=True),
        sa.Column("gatewayCode", sa.Text(), nullable=True),
        sa.Column("gatewayMessage", sa.Text(), nullable=True),
        sa.Column("createdAt", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.Column("completedAt", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_payments_invoice", "payments", ["invoiceId"])


def downgrade() -> None:
    op.drop_index("ix_payments_invoice", table_name="payments")
    op.drop_table("payments")
    op.execute('DROP TYPE IF EXISTS "PaymentStatus"')
    op.execute('DROP TYPE IF EXISTS "PaymentMethod"')

    for name in ("taxPercent", "lateFee", "platformFee"):
        op.drop_column("invoices", name)

    op.drop_table("billing_settings")

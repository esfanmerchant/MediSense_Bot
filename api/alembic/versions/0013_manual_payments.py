"""Pay by transfer, and have a person check it.

Replaces the redirect gateway. There is no merchant account behind this system
and there was never going to be one in time, so a hosted checkout was an
endpoint that could only ever answer "not configured". What actually happens in
a Pakistani clinic is what is modelled here: the hospital publishes a NayaPay or
EasyPaisa number, the patient transfers the money in their own banking app, and
somebody at the hospital confirms it arrived.

**The whole design is that a screenshot is not a payment.** A ``SUBMITTED``
payment means the payer says they have paid and has shown us something; only an
administrator who has looked at the receiving account moves it to
``SUCCEEDED``, and only that marks the invoice paid. Collapsing the two would
let anybody settle a bill with a picture of somebody else's transfer.

Three groups of columns:

* **``billing_settings``** gains the account to pay *into*. In the settings
  table rather than in configuration because it is the administrator's to
  change — a clinic that switches wallets should not need a deployment — and
  because it sits beside the rates they already edit.
* **``payments``** gains what the payer supplies (a transaction reference and a
  screenshot) and what the reviewer decides (who, when, and why not).
* **``PaymentStatus``** gains ``SUBMITTED`` and ``PaymentMethod`` gains
  ``NAYAPAY``. ``INITIATED`` and ``JAZZCASH`` stay in the type: PostgreSQL
  cannot remove an enum value without rewriting the type, and no row uses them.

The reference is deliberately **not** unique. Two people paying from the same
wallet can produce the same visible reference, banks reuse them across days, and
a unique index here would refuse a genuine second payment at the moment somebody
is trying to settle a bill. Duplicates are a thing for the reviewer to notice,
which is what the reviewer is for.

Revision ID: 0013_manual_payments
Revises: 0012_fee_modes
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0013_manual_payments"
down_revision: str | None = "0012_fee_modes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ---- where the money should be sent ---------------------------------
    for name, size in (
        ("payeeName", 160),
        ("nayapayNumber", 32),
        ("easypaisaNumber", 32),
    ):
        op.add_column(
            "billing_settings",
            sa.Column(name, sa.String(size), nullable=True),
        )
    op.add_column(
        "billing_settings",
        sa.Column("paymentNote", sa.Text(), nullable=True),
    )

    # ---- new states, before anything can be in them ----------------------
    # ALTER TYPE ... ADD VALUE cannot run inside a transaction block on older
    # PostgreSQL, and Alembic wraps migrations in one. IF NOT EXISTS makes the
    # statement safe to re-run, and modern PostgreSQL permits it here.
    op.execute("ALTER TYPE \"PaymentStatus\" ADD VALUE IF NOT EXISTS 'SUBMITTED'")
    op.execute("ALTER TYPE \"PaymentMethod\" ADD VALUE IF NOT EXISTS 'NAYAPAY'")

    # ---- what the payer shows, and what the reviewer decides -------------
    op.add_column("payments", sa.Column("reference", sa.String(120), nullable=True))
    #: The object key for the screenshot, in the private proofs bucket. A path,
    #: not a URL, for the same reason avatars are: the bucket has no public
    #: address and every link is signed per response.
    op.add_column("payments", sa.Column("proofPath", sa.Text(), nullable=True))
    op.add_column("payments", sa.Column("reviewedById", sa.Text(), nullable=True))
    op.add_column("payments", sa.Column("reviewedAt", sa.DateTime(), nullable=True))
    op.add_column("payments", sa.Column("rejectionReason", sa.Text(), nullable=True))

    # `gatewayRef` was unique because a gateway echoed it back and a duplicate
    # meant a replayed callback. Nothing echoes anything now: the column holds a
    # reference a *person* typed off their banking app, and two of those can
    # legitimately match. A unique index would refuse a real payment.
    op.drop_constraint("payments_gatewayRef_key", "payments", type_="unique")
    op.alter_column("payments", "gatewayRef", nullable=True)

    op.create_index("ix_payments_status", "payments", ["status"])


def downgrade() -> None:
    op.drop_index("ix_payments_status", table_name="payments")
    op.alter_column("payments", "gatewayRef", nullable=False)
    op.create_unique_constraint("payments_gatewayRef_key", "payments", ["gatewayRef"])

    for name in ("rejectionReason", "reviewedAt", "reviewedById", "proofPath", "reference"):
        op.drop_column("payments", name)

    # The enum values stay. PostgreSQL cannot drop one without rebuilding the
    # type, and leaving two unused labels behind is cheaper and safer than that.

    for name in ("paymentNote", "easypaisaNumber", "nayapayNumber", "payeeName"):
        op.drop_column("billing_settings", name)

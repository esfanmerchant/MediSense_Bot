"""Both ends of a transfer, recorded on the transfer.

A payment row said how much and which wallet, and nothing about the two
accounts the money supposedly moved between. The administrator's ledger
therefore had to show whatever the screenshot happened to say — including, on
the row that prompted this, a "to" account that is not one of the hospital's at
all, displayed as though it were.

``payeeAccount`` is the account the patient was *told* to pay into, snapshotted
when they submitted. It is stored rather than looked up for the same reason an
invoice stores its own line items: an administrator changing the clinic's wallet
next month must not silently rewrite where last month's money was supposed to
have gone.

``receiptSenderAccount`` is the account the screenshot says it came *from*, read
by the same pass that already reads the receiver. Together they are what lets
the ledger answer "from whom, to where" with two account numbers instead of one
name — and what lets the destination be checked at all.

Revision ID: 0017_payment_accounts
Revises: 0016_receipt_reading
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0017_payment_accounts"
down_revision: str | None = "0016_receipt_reading"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Same width as billing_settings' own wallet columns, which is where the
    # value is copied from.
    op.add_column("payments", sa.Column("payeeAccount", sa.String(32), nullable=True))
    # Wider, like the other receipt columns: this one holds whatever the model
    # read, which may be an IBAN or a formatted number rather than a mobile.
    op.add_column("payments", sa.Column("receiptSenderAccount", sa.String(120), nullable=True))


def downgrade() -> None:
    op.drop_column("payments", "receiptSenderAccount")
    op.drop_column("payments", "payeeAccount")

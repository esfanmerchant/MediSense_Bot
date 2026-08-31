"""The service a receipt belongs to, as the receipt spells it.

The ledger names the wallet from ``payments.method``, which is the option the
patient picked from a list of two. That is not the same question as "what does
this screenshot say it is": a patient can transfer from JazzCash or from a bank
app, and neither has a name in that list, so the column would confidently print
EASYPAISA over a JazzCash receipt.

Free text, deliberately, and short. It is read off the image and shown as read.
Anything that has to be *decided* from it — did the money reach the right
account — is decided from the account numbers, which are compared, not from
this, which is only transcribed.

Revision ID: 0018_receipt_wallet
Revises: 0017_payment_accounts
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0018_receipt_wallet"
down_revision: str | None = "0017_payment_accounts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("payments", sa.Column("receiptWallet", sa.String(60), nullable=True))


def downgrade() -> None:
    op.drop_column("payments", "receiptWallet")

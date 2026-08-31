"""What a model read off a payment screenshot.

Stored on the payment rather than derived when a reviewer opens the queue, for
two reasons. The screenshot is read once, at the moment it is uploaded, so a
reviewer never waits on a provider that might be slow or down — and the reading
is evidence about what was submitted, so it has to be the reading of the image
*as it arrived*, not whatever the model would say about it three weeks later.

Every column is nullable and none of them decide anything. They sit beside the
screenshot on the reviewer's screen so the boring comparison — does the
reference match, does the amount match, is this receipt from last month —
happens without anybody squinting. A person still confirms the payment.

Revision ID: 0016_receipt_reading
Revises: 0015_terms_acceptance
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0016_receipt_reading"
down_revision: str | None = "0015_terms_acceptance"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("payments", sa.Column("receiptText", sa.Text(), nullable=True))
    op.add_column("payments", sa.Column("receiptReference", sa.String(120), nullable=True))
    # Same precision as the amount it is compared against. A receipt read into a
    # wider or narrower type would differ from the payment by rounding alone.
    op.add_column("payments", sa.Column("receiptAmount", sa.Numeric(10, 2), nullable=True))
    op.add_column("payments", sa.Column("receiptPaidAt", sa.DateTime(), nullable=True))
    op.add_column("payments", sa.Column("receiptSender", sa.String(120), nullable=True))
    op.add_column("payments", sa.Column("receiptReceiver", sa.String(120), nullable=True))
    op.add_column("payments", sa.Column("receiptReceiverAccount", sa.String(120), nullable=True))
    # NULL means "not read" — the provider was unavailable, or the upload
    # predates this. False means "read, and it is not a receipt", which is a
    # different thing entirely and one the reviewer wants to know.
    op.add_column("payments", sa.Column("receiptLooksValid", sa.Boolean(), nullable=True))
    op.add_column("payments", sa.Column("receiptReadAt", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("payments", "receiptReadAt")
    op.drop_column("payments", "receiptLooksValid")
    op.drop_column("payments", "receiptReceiverAccount")
    op.drop_column("payments", "receiptReceiver")
    op.drop_column("payments", "receiptSender")
    op.drop_column("payments", "receiptPaidAt")
    op.drop_column("payments", "receiptAmount")
    op.drop_column("payments", "receiptReference")
    op.drop_column("payments", "receiptText")

"""Record which version of the terms somebody agreed to.

Two columns, and the version is the one that matters. Storing only "accepted:
true" would mean the system can say somebody agreed but not *to what* — and the
moment the wording changes, every past acceptance silently becomes a claim about
a document that person never saw. The version stamps the agreement to a specific
text, so a later change asks again rather than assuming.

Nullable, with no backfill. Accounts that already exist have not seen this
document, and marking them as having agreed to it would be recording a consent
that never happened — which is the one thing a consent record must never do.
They are asked the next time they sign in.

Revision ID: 0015_terms_acceptance
Revises: 0014_doctor_earnings
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0015_terms_acceptance"
down_revision: str | None = "0014_doctor_earnings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("termsAcceptedAt", sa.DateTime(), nullable=True))
    op.add_column("users", sa.Column("termsVersion", sa.String(32), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "termsVersion")
    op.drop_column("users", "termsAcceptedAt")

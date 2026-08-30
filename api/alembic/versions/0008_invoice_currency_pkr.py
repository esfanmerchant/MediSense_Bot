"""Bill in Pakistani rupees.

The invoice currency was configured, defaulted and stored as ``INR`` while the
appointment screen already quoted a consultation fee in ``PKR`` — one clinic
keeping two currencies, with nothing reconciling them.

**The amounts are not converted, only relabelled**, and that is defensible here
and nowhere else: every figure in this database is fictional demo data seeded
for a build. On a system holding real money this migration would be wrong — an
800-rupee bill is not the same debt in another currency, and a correct version
would carry a rate, the date it was taken, and would leave the original amount
recorded beside the converted one. Anyone running this against real invoices
should write that migration instead of this one.

Only rows still marked ``INR`` are touched, so it is safe to run twice, and the
column default moves with them. The downgrade puts both back.

Revision ID: 0008_invoice_currency_pkr
Revises: 0007_qualification_years

The identifier is abbreviated for the same reason 0006's and 0007's are:
Alembic stores it in a ``varchar(32)``.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0008_invoice_currency_pkr"
down_revision: str | None = "0007_qualification_years"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE invoices ALTER COLUMN currency SET DEFAULT 'PKR'")
    op.execute("UPDATE invoices SET currency = 'PKR' WHERE currency = 'INR'")


def downgrade() -> None:
    op.execute("ALTER TABLE invoices ALTER COLUMN currency SET DEFAULT 'INR'")
    op.execute("UPDATE invoices SET currency = 'INR' WHERE currency = 'PKR'")

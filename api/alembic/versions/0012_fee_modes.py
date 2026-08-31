"""Let each fee be a flat amount or a share of the bill.

The three figures an administrator sets were all flat amounts except tax, which
was always a percentage. That is the common arrangement and it is not the only
one: a clinic may want a platform fee of two percent rather than two hundred
rupees, or a late charge proportional to what is owed rather than the same fifty
rupees on a two-hundred-rupee bill and a twenty-thousand-rupee one.

So each of the three gains a mode. The value column keeps its meaning from the
mode beside it — rupees under ``FIXED``, percent under ``PERCENT`` — rather than
adding three more columns that would then have to be kept consistent with the
first three.

The defaults preserve exactly what is in force today: tax is a percentage,
because that is what the column already held, and the two fees are flat amounts,
because that is what they already were. Nobody's billing changes by applying
this.

``taxPercent`` keeps its name. Renaming a column that every invoice row and
several queries refer to, to gain the word "value", would be a rename for
tidiness paid for in a migration that can go wrong — and the comment on the
model says what it holds.

Revision ID: 0012_fee_modes
Revises: 0011_billing_settings_pay
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0012_fee_modes"
down_revision: str | None = "0011_billing_settings_pay"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

MODE = sa.Enum("FIXED", "PERCENT", name="FeeMode")

#: column -> the mode that reproduces today's behaviour exactly.
COLUMNS: tuple[tuple[str, str], ...] = (
    ("taxMode", "PERCENT"),
    ("platformFeeMode", "FIXED"),
    ("lateFeeMode", "FIXED"),
)


def upgrade() -> None:
    MODE.create(op.get_bind(), checkfirst=True)
    for name, default in COLUMNS:
        op.add_column(
            "billing_settings",
            sa.Column(name, MODE, nullable=False, server_default=default),
        )

    # A percentage cannot exceed 100, but a flat fee has no such ceiling — so
    # the old range check on taxPercent has to go, or a clinic charging a
    # fixed 500 in tax is refused by a constraint that assumed percent.
    op.drop_constraint("ck_billing_tax_range", "billing_settings", type_="check")
    op.create_check_constraint(
        "ck_billing_tax_positive", "billing_settings", '"taxPercent" >= 0'
    )


def downgrade() -> None:
    op.drop_constraint("ck_billing_tax_positive", "billing_settings", type_="check")
    op.create_check_constraint(
        "ck_billing_tax_range",
        "billing_settings",
        '"taxPercent" >= 0 AND "taxPercent" <= 100',
    )
    for name, _ in reversed(COLUMNS):
        op.drop_column("billing_settings", name)
    MODE.drop(op.get_bind(), checkfirst=True)

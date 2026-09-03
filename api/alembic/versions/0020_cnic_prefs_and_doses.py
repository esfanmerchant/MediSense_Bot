"""A CNIC on every account, per-user channels, and the daily dose ticks.

Three unrelated things in one revision because they arrived in one request and
each is a couple of columns; splitting them would be three round trips to a
database in another country for no benefit.

``cnic`` is nullable here and required by the API. Accounts that existed before
it was asked for do not have one, and a NOT NULL with a made-up default would
put a fake identity number on a real person's record — which is worse than a
gap, because a gap is visibly a gap.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0020_cnic_prefs_and_doses"
down_revision = "0019_push_and_reminders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # A welcome is not a security warning, so it gets its own type.
    op.execute("ALTER TYPE \"NotificationType\" ADD VALUE IF NOT EXISTS 'ACCOUNT_REGISTERED'")

    op.add_column("users", sa.Column("cnic", sa.String(length=13), nullable=True))
    # Defaulted true and NOT NULL: an account that has never opened the setting
    # should behave as it did before this migration existed, which is "tell me".
    op.add_column(
        "users",
        sa.Column("notifyByEmail", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "users",
        sa.Column("notifyByPush", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    # Not unique. Two people can hold one CNIC in this table only through a data
    # error, but a unique index would turn that error into a failed registration
    # for the second person with no way to explain it to them — and duplicate
    # detection belongs where a human can look at both accounts.
    op.create_index("users_cnic_idx", "users", ["cnic"])

    op.create_table(
        "medication_doses",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("reminderId", sa.String(length=64), nullable=False),
        sa.Column("patientId", sa.String(length=64), nullable=False),
        # The clinic-local calendar date, as YYYY-MM-DD. A date rather than a
        # timestamp because "which day's list" is the question, and a timestamp
        # would answer it differently depending on where it was read.
        sa.Column("on", sa.String(length=10), nullable=False),
        sa.Column("takenAt", sa.DateTime(), nullable=False),
        sa.Column("createdAt", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ["reminderId"], ["medication_reminders.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["patientId"], ["patients.id"], ondelete="CASCADE"),
    )
    # What makes marking a dose idempotent: a double tap is one row.
    op.create_index(
        "medication_doses_reminderId_on_key",
        "medication_doses",
        ["reminderId", "on"],
        unique=True,
    )
    op.create_index(
        "medication_doses_patientId_on_idx", "medication_doses", ["patientId", "on"]
    )


def downgrade() -> None:
    op.drop_index("medication_doses_patientId_on_idx", table_name="medication_doses")
    op.drop_index("medication_doses_reminderId_on_key", table_name="medication_doses")
    op.drop_table("medication_doses")
    op.drop_index("users_cnic_idx", table_name="users")
    op.drop_column("users", "notifyByPush")
    op.drop_column("users", "notifyByEmail")
    op.drop_column("users", "cnic")
    # The enum value stays. Postgres cannot drop one, and a row that already
    # names it would become unreadable if it could.

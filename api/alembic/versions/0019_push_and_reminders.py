"""Enrolled devices, and the hours a patient takes their medicine.

Two tables and one enum value, all in service of the same thing: reaching
somebody who is not looking at the site.

``push_subscriptions`` holds what a browser hands over when a person allows
notifications — an endpoint and the two keys the payload is encrypted to. One
row per device, so a phone and a laptop are both reached, and unique on the
endpoint so re-enrolling the same browser updates rather than accumulates.

``medication_reminders`` holds the times a patient chose, not times read out of
the prescription. A doctor writes "twice a day"; turning that into a clock
means guessing whether that is twelve hours apart or morning and evening, and a
confident reminder at the wrong hour is worse on a medicine than no reminder at
all. The prescription stays as written and the patient says when they take it.

Minutes past local midnight rather than a timestamp: "eight in the morning"
should stay eight in the morning when the zone's offset changes.

Revision ID: 0019_push_and_reminders
Revises: 0018_receipt_wallet
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0019_push_and_reminders"
down_revision: str | None = "0018_receipt_wallet"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # A third delivery channel. Added to the existing type rather than replacing
    # it, so no row has to be rewritten.
    op.execute("ALTER TYPE \"NotificationChannel\" ADD VALUE IF NOT EXISTS 'PUSH'")

    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("userId", sa.Text(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.Text(), nullable=False),
        sa.Column("auth", sa.Text(), nullable=False),
        sa.Column("userAgent", sa.Text(), nullable=True),
        sa.Column("lastSeenAt", sa.DateTime(), nullable=True),
        sa.Column("failedAt", sa.DateTime(), nullable=True),
        sa.Column("createdAt", sa.DateTime(), nullable=False),
        sa.Column("updatedAt", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["userId"], ["users.id"], ondelete="CASCADE", onupdate="CASCADE"
        ),
    )
    op.create_index(
        "push_subscriptions_endpoint_key", "push_subscriptions", ["endpoint"], unique=True
    )
    op.create_index("push_subscriptions_userId_idx", "push_subscriptions", ["userId"])

    op.create_table(
        "medication_reminders",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("prescriptionId", sa.Text(), nullable=False),
        sa.Column("patientId", sa.Text(), nullable=False),
        sa.Column("atMinutes", sa.Integer(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("createdAt", sa.DateTime(), nullable=False),
        sa.Column("updatedAt", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["prescriptionId"], ["prescriptions.id"], ondelete="CASCADE", onupdate="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["patientId"], ["patients.id"], ondelete="CASCADE", onupdate="CASCADE"
        ),
        sa.CheckConstraint(
            '"atMinutes" >= 0 AND "atMinutes" < 1440',
            name="medication_reminders_atMinutes_check",
        ),
    )
    op.create_index(
        "medication_reminders_active_atMinutes_idx",
        "medication_reminders",
        ["active", "atMinutes"],
    )
    op.create_index(
        "medication_reminders_patientId_idx", "medication_reminders", ["patientId"]
    )
    op.create_index(
        "medication_reminders_prescriptionId_atMinutes_key",
        "medication_reminders",
        ["prescriptionId", "atMinutes"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_table("medication_reminders")
    op.drop_table("push_subscriptions")
    # The enum value stays. Postgres cannot drop one, and a value nothing
    # references costs nothing.

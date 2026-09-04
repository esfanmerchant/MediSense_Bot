"""Removing an account: what survives it.

Two changes, both about the same idea — a person leaving must not take other
people's records with them.

``invoices.patientId`` becomes nullable and SET NULL. A settled invoice is the
hospital's financial record, not the patient's: deleting it would silently
restate last quarter's revenue, with no line anywhere explaining why the total
moved. So the money stays and the patient does not — the row keeps its amount,
date and status, and loses the only thing that tied it to a person.

``users.removedAt`` marks an account that has been emptied rather than deleted.
Clinical authorship is why: a doctor's medical records name them as the author,
and dropping the row would either break every join that reads a chart or delete
the charts. So for anyone who authored somebody else's record, the row stays and
everything identifying inside it is destroyed — the email is rewritten to a
dead address, freeing the real one to register again, which is the point of the
whole exercise.

The audit log is untouched by both. ``audit_logs.userId`` is deliberately not a
foreign key (see the model), so the trail outlives its subject exactly as it was
designed to.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0023_remove_account"
down_revision = "0022_patient_data_export"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Removal is a distinct act from suspension and needs its own name in the
    # trail. Filing "this account and its data were destroyed" under
    # USER_STATUS_CHANGED would make the two indistinguishable afterwards.
    op.execute("ALTER TYPE \"AuditAction\" ADD VALUE IF NOT EXISTS 'USER_REMOVED'")

    op.add_column("users", sa.Column("removedAt", sa.DateTime(), nullable=True))

    op.alter_column("invoices", "patientId", existing_type=sa.Text(), nullable=True)
    op.drop_constraint("invoices_patientId_fkey", "invoices", type_="foreignkey")
    op.create_foreign_key(
        "invoices_patientId_fkey",
        "invoices",
        "patients",
        ["patientId"],
        ["id"],
        ondelete="SET NULL",
        onupdate="CASCADE",
    )


def downgrade() -> None:
    # Anonymised invoices have no patient to point back at, so restoring the
    # NOT NULL would fail on exactly the rows this change exists to keep. They
    # are deleted here rather than blocking the downgrade — which is the honest
    # behaviour, and the reason a downgrade is not a way to undo a removal.
    op.execute('delete from invoices where "patientId" is null')

    op.drop_constraint("invoices_patientId_fkey", "invoices", type_="foreignkey")
    op.create_foreign_key(
        "invoices_patientId_fkey",
        "invoices",
        "patients",
        ["patientId"],
        ["id"],
        ondelete="CASCADE",
        onupdate="CASCADE",
    )
    op.alter_column("invoices", "patientId", existing_type=sa.Text(), nullable=False)

    op.drop_column("users", "removedAt")
    # The enum value stays: Postgres cannot drop one, and an audit row already
    # naming it would become unreadable if it could.

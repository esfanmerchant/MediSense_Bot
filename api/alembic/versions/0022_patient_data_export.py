"""One new audit action: a patient exported their own record.

Separate revision from 0021 because ``ALTER TYPE ... ADD VALUE`` and a
table-wide data rewrite do not belong in one transaction — if the rewrite has
to be re-run, the enum change should not be re-run with it.
"""

from __future__ import annotations

from alembic import op

revision = "0022_patient_data_export"
down_revision = "0021_encrypt_clinical_text"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE \"AuditAction\" ADD VALUE IF NOT EXISTS 'PATIENT_DATA_EXPORTED'")


def downgrade() -> None:
    # Postgres cannot remove an enum value, and a row already naming it would
    # become unreadable if it could. The trail outlives the schema change.
    pass

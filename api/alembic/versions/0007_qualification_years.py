"""Give each stored qualification the years it spans.

``doctor_applications.qualifications`` held an array of strings — "MBBS, King
Edward Medical University" and nothing more. It now holds an array of objects,
``{"title", "startYear", "endYear"}``, so a reviewer can see when a degree was
taken rather than only that it was claimed.

**No column changes.** The column is already ``jsonb`` and stays exactly as it
is; what changes is the shape of the documents inside it. So this revision is
entirely a data rewrite, and the application code that reads the column is what
depends on it having run.

*Upgrade.* Every string entry becomes ``{"title": <the string>, "startYear":
null, "endYear": null}``. Order is preserved — ``WITH ORDINALITY`` and an
ordered ``jsonb_agg`` — because an applicant listed their degrees in the order
they earned them. Entries that are already objects are left untouched, so a row
written after the new code deployed is not rewritten, and the whole statement
skips any row that holds no strings at all: running it twice is a no-op.

*Downgrade.* Each object collapses back to its title, which is the only part the
old shape can hold. **The years are lost, and not recoverably** — that is
inherent in the old shape rather than a shortcut taken here, and it is the thing
to weigh before running it. Like the upgrade it is guarded and safe to repeat.

Revision ID: 0007_qualification_years
Revises: 0006_verify_2fa_doctor_apps

The identifier is abbreviated for the same reason revision 0006's is: Alembic
stores it in a ``varchar(32)``, and a longer one fails the migration after every
statement has already run.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0007_qualification_years"
down_revision: str | None = "0006_verify_2fa_doctor_apps"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE doctor_applications
        SET qualifications = (
            SELECT COALESCE(
                jsonb_agg(
                    CASE
                        WHEN jsonb_typeof(entry) = 'string'
                            THEN jsonb_build_object(
                                'title', entry,
                                'startYear', 'null'::jsonb,
                                'endYear', 'null'::jsonb
                            )
                        ELSE entry
                    END
                    ORDER BY position
                ),
                '[]'::jsonb
            )
            FROM jsonb_array_elements(qualifications) WITH ORDINALITY AS listed(entry, position)
        )
        WHERE jsonb_typeof(qualifications) = 'array'
          AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(qualifications) AS existing
              WHERE jsonb_typeof(existing) = 'string'
          )
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE doctor_applications
        SET qualifications = (
            SELECT COALESCE(
                jsonb_agg(
                    CASE
                        WHEN jsonb_typeof(entry) <> 'object' THEN entry
                        WHEN jsonb_typeof(entry -> 'title') = 'string' THEN entry -> 'title'
                        ELSE '""'::jsonb
                    END
                    ORDER BY position
                ),
                '[]'::jsonb
            )
            FROM jsonb_array_elements(qualifications) WITH ORDINALITY AS listed(entry, position)
        )
        WHERE jsonb_typeof(qualifications) = 'array'
          AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(qualifications) AS existing
              WHERE jsonb_typeof(existing) = 'object'
          )
        """
    )

"""Where a doctor actually sits.

A patient choosing between six general physicians needs to know which of them
they can reach, and until now the system could not answer that: ``doctors`` held
a specialization, a fee and a licence number, and nothing about place.

Five columns, on both the live record and the application that becomes it:

* ``clinicName`` — the hospital or the practice by name, which is how people say
  where a doctor sits ("Aga Khan", "the clinic on Tariq Road"), not a postcode.
* ``city`` — the one field the directory filters on. Plain text rather than a
  lookup table, because Pakistan's city names are not a closed set anybody
  should have to maintain here, and a doctor typing "Rawalpindi" must not be
  blocked because nobody seeded it.
* ``addressLine`` — the street address, for actually arriving.
* ``latitude`` / ``longitude`` — the pin. ``Numeric(9, 6)`` holds every legal
  coordinate to about a tenth of a metre and, unlike a float, holds it exactly:
  a map pin that drifts in the last decimal because of binary rounding is a
  small bug that is very hard to see and impossible to explain.

**Why the application carries them too.** Every professional fact here is
collected on the application and copied onto the doctor at approval, so that an
administrator reviews what will actually be published. Adding these only to
``doctors`` would leave a doctor approved with no location and no screen that
asks for one.

All nullable, no backfill and no default: the existing doctors have no location
because nobody has ever been asked for it, and inventing one for them would put
a wrong address in front of a patient. The directory treats a missing city as
"not stated" rather than as a filter miss.

Revision ID: 0010_practice_location
Revises: 0009_user_avatar_path

The identifier is abbreviated for the same reason 0006 through 0009 are:
Alembic stores it in a ``varchar(32)``.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0010_practice_location"
down_revision: str | None = "0009_user_avatar_path"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Same shape on both tables, so a value copied at approval needs no conversion.
COLUMNS: tuple[tuple[str, sa.types.TypeEngine[object]], ...] = (
    ("clinicName", sa.Text()),
    ("city", sa.Text()),
    ("addressLine", sa.Text()),
    ("latitude", sa.Numeric(9, 6)),
    ("longitude", sa.Numeric(9, 6)),
)

TABLES = ("doctors", "doctor_applications")


def upgrade() -> None:
    for table in TABLES:
        for name, type_ in COLUMNS:
            op.add_column(table, sa.Column(name, type_, nullable=True))

    # The directory filters on city and nothing else, and does it with a
    # case-insensitive match, so the index has to be on the same lowered
    # expression or it will simply never be used.
    op.execute('CREATE INDEX ix_doctors_city_lower ON doctors (lower(city))')


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_doctors_city_lower")
    for table in TABLES:
        for name, _ in reversed(COLUMNS):
            op.drop_column(table, name)

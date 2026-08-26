"""Baseline: the full MediSense schema.

The schema already exists in the development database — it was created by the
initial Prisma migration before the backend moved to Python. This revision
reproduces exactly that shape from the SQLAlchemy models, so:

* a fresh database can be built from Alembic alone, and
* running it against the existing database is a no-op, because every CREATE is
  guarded (``checkfirst`` for tables, a duplicate_object catch for enum types).

Alembic owns every schema change from here on. ``_prisma_migrations`` is left
alone: it is inert, and dropping it would discard the record of how the
production schema was originally built.

Revision ID: 0001_baseline
Revises:
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# Importing the models registers every table on Base.metadata.
from app.db import models  # noqa: F401
from app.db.base import Base
from app.db.enums import PG_ENUM_TYPES

revision: str = "0001_baseline"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()

    # Enum types first: the models bind to them with create_type=False, so
    # nothing else will create them.
    for type_name, enum_cls in PG_ENUM_TYPES.items():
        values = ", ".join(f"'{member.value}'" for member in enum_cls)
        op.execute(
            f"""
            DO $$ BEGIN
                CREATE TYPE "{type_name}" AS ENUM ({values});
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
            """
        )

    Base.metadata.create_all(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    Base.metadata.drop_all(bind, checkfirst=True)
    for type_name in PG_ENUM_TYPES:
        op.execute(f'DROP TYPE IF EXISTS "{type_name}"')

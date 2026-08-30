"""Give a user somewhere to keep their profile picture.

One nullable column, ``users."avatarPath"``, holding the object key inside the
private ``avatars`` bucket — ``{userId}/{avatarId}.{ext}``.

**A path, not a URL, and that is the whole design.** The bucket is private, so
there is no permanent address a column could hold; every link is signed and
minted per response with a few minutes' life. Storing a URL instead would create
exactly the artefact this application refuses everywhere else: a way to read
somebody's face long after their session ended.

Nullable with no default and no backfill: an account without a picture is the
normal state, not a missing value, and the initials the interface already draws
are the answer for it.

Adding the column is the whole change. Nothing reads it until the account
endpoints ship, and nothing breaks if they never do, so this is safe to apply
ahead of the code and safe to run against a live database — ``ADD COLUMN`` of a
nullable text column takes no table rewrite on PostgreSQL 11 or later.

Revision ID: 0009_user_avatar_path
Revises: 0008_invoice_currency_pkr

The identifier is abbreviated for the same reason 0006's, 0007's and 0008's are:
Alembic stores it in a ``varchar(32)``, and a longer one fails *after* every
statement has already run.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0009_user_avatar_path"
down_revision: str | None = "0008_invoice_currency_pkr"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("avatarPath", sa.Text(), nullable=True))


def downgrade() -> None:
    """Drops the column. The objects themselves are not touched.

    Deleting somebody's picture out of storage on a schema rollback would make a
    reversible migration destroy data it cannot restore. The rows lose their
    pointer; a re-upgrade starts from no pictures, and the orphaned objects are
    a cleanup task with a bucket listing, not something a downgrade should do
    silently.
    """
    op.drop_column("users", "avatarPath")

"""Seal the clinical free text in ``medical_records``.

The columns do not change type — they were ``text`` and they stay ``text``,
because ciphertext is text. What changes is what is in them: after this, a
``select diagnosis from medical_records`` returns ``v1$...$...$...`` to anyone
holding the connection string, and the prose only exists inside a process that
also holds ``PHI_ENCRYPTION_KEY``.

**This migration needs that key.** It reads every row through the same sealing
the application uses, so running it with the wrong key would write ciphertext
nothing can open afterwards. It is deliberately re-runnable: a value that is
already sealed is left alone, so an interrupted run is finished by running it
again rather than by restoring a backup.

``updatedAt`` is not touched. A record's amendment badge is computed from
``updatedAt`` against ``createdAt``, so letting the ORM's ``onupdate`` fire here
would put "Amended" on every historical note in the hospital — a false clinical
claim, produced by an encryption change that altered nothing a doctor wrote.
That is why this issues raw UPDATEs naming five columns rather than going
through the models.
"""

from __future__ import annotations

from sqlalchemy import text

from alembic import op
from app.core.config import settings
from app.core.security import seal_secret
from app.db.encrypted import PHI_PURPOSE, looks_sealed

revision = "0021_encrypt_clinical_text"
down_revision = "0020_cnic_prefs_and_doses"
branch_labels = None
depends_on = None

#: Database column names, quoted below because four of them are camelCase.
COLUMNS = ("symptoms", "diagnosis", "treatmentPlan", "notes", "followUpNotes")

#: Rows per round trip. The database is in another region, so one row at a time
#: would be one network round trip per note; the whole table at once would hold
#: every diagnosis in the hospital in this process's memory at the same time.
BATCH = 500

_COLUMN_LIST = ", ".join(f'"{c}"' for c in COLUMNS)

# S608 flags the interpolation. What is interpolated is ``COLUMNS`` — five
# literals defined above and nothing else. No value ever reaches the SQL text:
# the prose and the ciphertext travel as bound parameters, here and in the
# UPDATE below.
_SELECT = text(
    f"select id, {_COLUMN_LIST} from medical_records where id > :after order by id limit :limit"  # noqa: S608
)


def _rewrite(convert) -> None:  # type: ignore[no-untyped-def]
    """Walk the table by primary key, applying ``convert`` to each cell.

    Keyset pagination rather than OFFSET: this rewrites the rows it is paging
    through, and OFFSET over a table being written to skips rows.
    """
    bind = op.get_bind()
    after = ""
    touched = 0
    while True:
        rows = bind.execute(_SELECT, {"after": after, "limit": BATCH}).fetchall()
        if not rows:
            break
        for row in rows:
            after = row[0]
            changes = {}
            for column, value in zip(COLUMNS, row[1:], strict=True):
                if value is None:
                    continue
                replacement = convert(value)
                if replacement is not None:
                    changes[column] = replacement
            if not changes:
                continue
            # `changes` is keyed by COLUMNS, so `assignments` is built from the
            # same five literals; the ciphertext travels as bound parameters.
            assignments = ", ".join(f'"{c}" = :{c}' for c in changes)
            bind.execute(
                text(f"update medical_records set {assignments} where id = :id"),  # noqa: S608
                {**changes, "id": row[0]},
            )
            touched += 1
    print(f"  medical_records: {touched} row(s) rewritten")


def upgrade() -> None:
    key = settings.phi_key_material
    if not key:
        raise RuntimeError(
            "PHI_ENCRYPTION_KEY (or SESSION_SECRET) must be set before encrypting clinical text."
        )

    def seal(value: str) -> str | None:
        # Already sealed — a re-run, not a double encryption.
        return None if looks_sealed(value) else seal_secret(value, PHI_PURPOSE, key)

    _rewrite(seal)


def downgrade() -> None:
    """Open every sealed cell and write the prose back.

    Present so this is reversible with the key in hand, which is what makes it
    safe to apply. Without the key there is no downgrade and no recovery — that
    is the whole point of the change, and the reason the key belongs in the
    backup set.
    """
    from app.core.security import unseal_secret

    key = settings.phi_key_material

    def unseal(value: str) -> str | None:
        return unseal_secret(value, PHI_PURPOSE, key) if looks_sealed(value) else None

    _rewrite(unseal)

"""Field-level encryption for the clinical free text (spec §"at-rest encryption").

Supabase encrypts the disk. That defends against someone walking off with the
drive, and against nothing else that is likely to happen. The realistic ways
this data leaks all end with the reader holding a *valid database session* — a
connection string in a leaked ``.env``, a backup restored into the wrong
project, a support query run by somebody who had no business reading charts.
Disk encryption is transparent to every one of them: they run
``select diagnosis from medical_records`` and read it.

So the five columns that carry a clinical judgement are sealed on the way into
Postgres and opened on the way out, under a key that lives in the environment
and never in the database. Reading a patient's diagnosis now takes both the
data and the key, and they are stolen separately.

**Why these columns and not every column.** A sealed value cannot be searched,
sorted, grouped or indexed by the database: ``WHERE diagnosis ILIKE '%x%'``
stops working the moment the column is sealed, silently, because it starts
matching ciphertext. These five are exactly the columns nothing in this
application queries that way — the searches that exist run over names, record
numbers and dates. That is a property worth re-checking before sealing anything
else, and ``test_clinical_text_is_encrypted.py`` checks it holds for these.

**One purpose, not one per column.** Everything sealed here shares the HKDF
purpose ``phi``, so ciphertext from ``diagnosis`` would also open in ``notes``.
Per-column purposes would stop an attacker moving a value between columns — but
that attacker already holds UPDATE on the table and can write whatever they
like into it, so the defence buys nothing real, and it would turn a column
rename into a data migration.

**Legacy plaintext reads through.** Rows written before this existed are not
sealed, and ``0021`` seals them. Until it runs, and for any row it missed, an
unsealed value is returned as it is rather than raising, because the alternative
is a chart that will not open. A value that *claims* to be sealed and fails
authentication is a different matter and always raises: that is tampering or a
wrong key, and quietly showing a blank diagnosis is the one outcome a medical
record must never produce.
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import Text
from sqlalchemy.types import TypeDecorator

from app.core.config import settings
from app.core.logging import logger
from app.core.security import SealError, seal_secret, unseal_secret

#: HKDF info for this key. Distinct from ``totp``, so the two sealed columns in
#: this database cannot open each other.
PHI_PURPOSE = "phi"

#: The exact shape ``seal_secret`` writes: ``v1$<nonce>$<ciphertext>$<tag>``,
#: base64 throughout. Deliberately strict — this is the test that decides
#: whether a stored value is ciphertext or a doctor's prose, and prose that
#: matched it would be raised on instead of shown.
_SEALED = re.compile(r"^v1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]*={0,2}\$[A-Za-z0-9+/]+={0,2}$")


def looks_sealed(value: str) -> bool:
    return bool(_SEALED.match(value))


class SealedText(TypeDecorator[str]):
    """``Text`` in Postgres, plaintext in Python, ciphertext in between.

    Nothing above this line changes: the ORM attribute is still ``str | None``,
    the router still assigns prose to it, and the column is still ``Text``. The
    sealing happens in the two hooks below, which is why adding it to a column
    needed no change to any handler.
    """

    impl = Text
    #: The type carries no per-instance state, so SQLAlchemy may cache compiled
    #: statements that use it.
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> str | None:
        if value is None:
            return None
        return seal_secret(str(value), purpose=PHI_PURPOSE, key_material=settings.phi_key_material)

    def process_result_value(self, value: Any, dialect: Any) -> str | None:
        if value is None:
            return None
        text = str(value)
        if not looks_sealed(text):
            # Written before 0021, or by something that bypassed the ORM.
            return text
        try:
            return unseal_secret(text, purpose=PHI_PURPOSE, key_material=settings.phi_key_material)
        except SealError:
            # Never degrade to "no diagnosis recorded". A wrong PHI_ENCRYPTION_KEY
            # is an operator mistake that has to be visible in the first second,
            # not a chart that reads as empty.
            logger.error("phi_unseal_failed", length=len(text))
            raise

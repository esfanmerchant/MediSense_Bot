"""The clinical text is sealed before it reaches Postgres.

These run the type itself rather than reading the model file. A test that greps
for ``SealedText`` in ``models.py`` passes just as happily when the sealing is
broken, and this project has already been bitten once by a test that read source
instead of executing it.

The last two are the ones that matter in a year's time. One asserts the five
columns are still sealed, so removing the type from a column is a failing test
rather than a silent regression. The other asserts nothing in the application
asks the *database* to search or sort that text — the property that makes
sealing possible at all, and the property a future feature would quietly break
by adding ``WHERE diagnosis ILIKE ...`` and finding it matches nothing.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.core.security import SealError, seal_secret, unseal_secret
from app.db.encrypted import PHI_PURPOSE, SealedText, looks_sealed
from app.db.models import MedicalRecord

DIAGNOSIS = "Type 2 diabetes mellitus with early nephropathy"

#: The columns this file is about, as the ORM names them.
SEALED_COLUMNS = ("symptoms", "diagnosis", "treatment_plan", "notes", "follow_up_notes")


def bind(value: str | None) -> str | None:
    """What the database would receive."""
    return SealedText().process_bind_param(value, None)


def result(value: str | None) -> str | None:
    """What the application gets back."""
    return SealedText().process_result_value(value, None)


class TestTheColumnTypeSeals:
    def test_what_postgres_receives_is_not_the_diagnosis(self) -> None:
        stored = bind(DIAGNOSIS)
        assert stored is not None
        assert DIAGNOSIS not in stored
        # Not merely absent as a whole string — no recognisable fragment either.
        assert "diabetes" not in stored.lower()
        assert looks_sealed(stored)

    def test_it_comes_back_exactly_as_written(self) -> None:
        assert result(bind(DIAGNOSIS)) == DIAGNOSIS

    def test_none_stays_none(self) -> None:
        # "No diagnosis recorded" is a real clinical state and must not become
        # an encrypted empty string that reads back as one.
        assert bind(None) is None
        assert result(None) is None

    def test_the_empty_string_survives_the_round_trip(self) -> None:
        assert result(bind("")) == ""

    def test_two_writes_of_the_same_text_look_different(self) -> None:
        """A fresh nonce per seal.

        Without it, equal ciphertext would mean equal diagnosis, and anyone with
        the table could group patients by condition without opening anything.
        """
        first, second = bind(DIAGNOSIS), bind(DIAGNOSIS)
        assert first != second
        assert result(first) == result(second) == DIAGNOSIS

    def test_urdu_and_unicode_survive(self) -> None:
        note = "مریض کو بخار ہے — 38.4°C, باقی ٹھیک"
        assert result(bind(note)) == note


class TestTheFailureModes:
    def test_legacy_plaintext_reads_through(self) -> None:
        """A row written before 0021 still opens its chart.

        Raising here would mean the encryption change, not a data problem, is
        what stopped a doctor reading a note.
        """
        assert result("Chest pain, three days, worse on exertion") == (
            "Chest pain, three days, worse on exertion"
        )

    def test_a_tampered_seal_raises_rather_than_reading_as_empty(self) -> None:
        """The one outcome a medical record must never produce.

        Showing "no diagnosis recorded" for a diagnosis that exists is worse
        than an error page: the error is visible, and the blank is believed.
        """
        sealed = bind(DIAGNOSIS)
        assert sealed is not None
        version, nonce, ciphertext, tag = sealed.split("$")
        flipped = "A" + ciphertext[1:] if ciphertext[0] != "A" else "B" + ciphertext[1:]
        with pytest.raises(SealError):
            result("$".join((version, nonce, flipped, tag)))

    def test_a_wrong_key_raises(self) -> None:
        elsewhere = seal_secret(DIAGNOSIS, PHI_PURPOSE, "a-different-deployments-key-entirely")
        with pytest.raises(SealError):
            result(elsewhere)

    def test_a_totp_secret_does_not_open_as_clinical_text(self) -> None:
        """Separate HKDF purposes, so the two sealed things cannot cross.

        The seal for a TOTP secret and the seal for a diagnosis are the same
        construction under different keys; if they were not, moving one column's
        value into the other would work.
        """
        totp = seal_secret("JBSWY3DPEHPK3PXP", "totp")
        with pytest.raises(SealError):
            unseal_secret(totp, PHI_PURPOSE)


class TestTheColumnsStaySealed:
    @pytest.mark.parametrize("column", SEALED_COLUMNS)
    def test_each_clinical_column_uses_the_sealed_type(self, column: str) -> None:
        attribute = getattr(MedicalRecord, column)
        assert isinstance(attribute.type, SealedText), (
            f"medical_records.{column} is no longer encrypted at rest"
        )

    def test_follow_up_date_is_not_sealed(self) -> None:
        """The line: a column the database has to reason about stays plain.

        ``followUpDate`` is ordered and filtered on by the scheduler. Sealing it
        would not error — it would quietly return the wrong appointments.
        """
        assert not isinstance(MedicalRecord.follow_up_date.type, SealedText)


class TestNothingAsksTheDatabaseToReadIt:
    """Sealing is only safe while no SQL touches these columns' contents.

    ``ILIKE`` against ciphertext does not fail; it matches nothing, which is a
    search that silently returns no results on a patient's own history. This
    catches the day somebody adds one.
    """

    #: SQL-level operations that would be reading the *value*.
    OPERATIONS = re.compile(
        r"\.(ilike|like|contains|startswith|endswith|icontains|regexp_match|"
        r"asc|desc|distinct|in_)\s*\(",
    )

    def test_no_query_filters_or_sorts_on_sealed_clinical_text(self) -> None:
        app_dir = Path(__file__).resolve().parent.parent / "app"
        columns = {"symptoms", "diagnosis", "treatment_plan", "notes", "follow_up_notes"}
        offenders: list[str] = []

        for path in app_dir.rglob("*.py"):
            if path.name in {"models.py", "encrypted.py"}:
                continue
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                for column in columns:
                    # Only the ORM attribute form — `MedicalRecord.diagnosis` or
                    # `.diagnosis.ilike(...)`. Plain `record.diagnosis` is a
                    # Python read and is exactly what this design allows.
                    marker = f"MedicalRecord.{column}"
                    if marker in line and self.OPERATIONS.search(line):
                        offenders.append(f"{path.name}:{number}: {line.strip()}")

        assert offenders == [], (
            "these ask Postgres to compare sealed text, which matches ciphertext "
            f"and silently returns nothing: {offenders}"
        )

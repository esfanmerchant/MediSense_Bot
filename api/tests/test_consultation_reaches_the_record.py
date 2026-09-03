"""A completed consultation has to reach the patient's own record.

The doctor writes "what was discussed, and what happens next" in the dialog
that completes an appointment, and those words went onto the appointment row
and stopped there. The patient's consultation history reads `medical_records`,
so somebody with four completed visits saw "No records yet" and had no way to
learn what their own doctor had written about them.

Two things this must not do, and both are pinned below: invent a diagnosis the
doctor did not give, and write a second record when a completion is retried.
"""

from __future__ import annotations

import inspect
from types import SimpleNamespace

import pytest

from app.db.enums import DataSource
from app.modules.appointments import router


class Recorder:
    """Enough of a session to see what would be written."""

    def __init__(self, existing: object | None = None) -> None:
        self.existing = existing
        self.added: list[object] = []
        self.statements: list[str] = []

    async def execute(self, statement: object) -> object:
        self.statements.append(str(statement))
        existing = self.existing

        class Result:
            def scalar_one_or_none(self) -> object | None:
                return existing

        return Result()

    def add(self, obj: object) -> None:
        self.added.append(obj)

    async def flush(self) -> None:
        return None


def appointment(notes: str | None) -> SimpleNamespace:
    return SimpleNamespace(id="a1", patient_id="p1", doctor_id="d1", notes=notes)


class TestTheNoteBecomesARecord:
    @pytest.mark.anyio
    async def test_a_completed_consultation_is_written_down(self) -> None:
        db = Recorder()
        await router._record_the_consultation(db, appointment("Reviewed BP. Review in six weeks."))
        assert len(db.added) == 1
        record = db.added[0]
        assert record.notes == "Reviewed BP. Review in six weeks."
        assert record.appointment_id == "a1"
        assert record.patient_id == "p1"
        assert record.doctor_id == "d1"

    @pytest.mark.anyio
    async def test_nothing_clinical_is_invented(self) -> None:
        # A diagnosis and a treatment plan are judgements a clinician states
        # deliberately. Deriving either from a free-text note would put words
        # in a doctor's mouth in the one table that is meant to be
        # authoritative — and the next clinician would read them as given.
        db = Recorder()
        await router._record_the_consultation(db, appointment("Discussed diet."))
        record = db.added[0]
        assert record.diagnosis is None
        assert record.treatment_plan is None
        assert record.symptoms is None

    @pytest.mark.anyio
    async def test_it_is_a_physician_record(self) -> None:
        db = Recorder()
        await router._record_the_consultation(db, appointment("Seen and reviewed."))
        # The other values on this enum describe machine output, which never
        # reaches this table.
        assert db.added[0].source is DataSource.PHYSICIAN


class TestItDoesNotWriteTwice:
    @pytest.mark.anyio
    async def test_a_second_completion_adds_nothing(self) -> None:
        # A retry, a double-click, or a doctor reopening and finishing again
        # must not leave a patient with two consultations for one visit.
        existing = SimpleNamespace(notes="Already written.")
        db = Recorder(existing=existing)
        await router._record_the_consultation(db, appointment("Seen and reviewed."))
        assert db.added == []
        assert existing.notes == "Already written."

    @pytest.mark.anyio
    async def test_it_fills_a_blank_record_rather_than_leaving_it_empty(self) -> None:
        existing = SimpleNamespace(notes="   ")
        db = Recorder(existing=existing)
        await router._record_the_consultation(db, appointment("The real note."))
        assert db.added == []
        assert existing.notes == "The real note."

    @pytest.mark.anyio
    async def test_it_never_overwrites_a_fuller_record(self) -> None:
        # A doctor who has since written a proper record from the chart said
        # more than the completion dialog did; replacing it with the older
        # note would lose the better one.
        existing = SimpleNamespace(notes="Full clinical note written from the chart.")
        db = Recorder(existing=existing)
        await router._record_the_consultation(db, appointment("Short note."))
        assert existing.notes == "Full clinical note written from the chart."

    @pytest.mark.anyio
    async def test_the_lookup_is_keyed_on_the_appointment(self) -> None:
        db = Recorder()
        await router._record_the_consultation(db, appointment("Anything."))
        assert 'medical_records."appointmentId" =' in db.statements[0]


class TestAnEmptyNoteWritesNothing:
    @pytest.mark.anyio
    @pytest.mark.parametrize("note", [None, "", "   ", "\n\t "])
    async def test_no_record_and_no_query(self, note: str | None) -> None:
        # A record that says only "a consultation happened" is already in the
        # appointment list. Putting an empty one in the clinical history makes
        # the history longer without making it say more.
        db = Recorder()
        await router._record_the_consultation(db, appointment(note))
        assert db.added == []
        assert db.statements == []


class TestItRunsWhenAConsultationIsCompleted:
    def test_the_status_endpoint_calls_it(self) -> None:
        source = inspect.getsource(router.set_status)
        assert "_record_the_consultation(db, appointment)" in source

    def test_it_happens_in_the_same_transaction_as_the_invoice(self) -> None:
        # A visit that is billed but not recorded, or recorded but never
        # billed, is the thing the surrounding comment exists to prevent.
        source = inspect.getsource(router.set_status)
        record_at = source.index("_record_the_consultation")
        invoice_at = source.index("generate_for_appointment")
        assert record_at < invoice_at
        assert "await db.commit()" not in source[record_at:invoice_at]

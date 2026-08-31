"""The staging tier between what a patient says and what a doctor writes.

These rows were being collected and never read: the assistant stored a
patient's own description of their symptoms, with its provenance, and no screen
anywhere showed them to the clinician who would see that patient the next
morning. The read side exists now, and these are the properties it must hold.

No database here. Route order and serialisation are both decidable from the
application object and a plain row, and both are exactly the kind of thing that
breaks silently — a shadowed route returns a confident 404 for a path that is
demonstrably registered.
"""

from __future__ import annotations

from datetime import datetime

from app.db.enums import DataSource, InputType
from app.db.models import ReportedSymptom
from app.main import app
from app.modules.records.service import serialize_reported_symptom


def _paths() -> list[str]:
    """Every registered path, in the order the application declares them.

    Read from the OpenAPI document rather than by walking ``app.routes``:
    routers are held nested in this version of FastAPI, behind a private
    ``_IncludedRouter`` whose prefix lives somewhere else again, and a test that
    reaches into that breaks on the next upgrade for no good reason. The schema
    is the public surface and it preserves declaration order, which is the
    property under test.
    """
    return list(app.openapi()["paths"].keys())


class TestRouting:
    def test_the_endpoint_is_registered(self) -> None:
        assert "/api/records/reported-symptoms" in _paths()

    def test_it_is_declared_before_the_record_lookup(self) -> None:
        """Otherwise ``/records/{record_id}`` eats it.

        FastAPI matches in declaration order, so a catch-all path parameter
        declared first would take "reported-symptoms" as a record id and answer
        404 for a route that is right there in the table. Nothing about that
        failure points at the cause, which is why it is asserted rather than
        left to whoever reorders the file next.
        """
        paths = _paths()
        assert paths.index("/api/records/reported-symptoms") < paths.index(
            "/api/records/{record_id}"
        )


class TestSerialisation:
    def _row(self, **overrides: object) -> ReportedSymptom:
        row = ReportedSymptom(
            id="sym_1",
            patient_id="pat_1",
            symptom="Headache",
            severity="severe",
            duration_text="3 days",
            raw_text="my head has been killing me for three days",
            source=DataSource.PATIENT_REPORTED,
            input_type=InputType.TEXT,
            confidence=None,
            created_at=datetime(2026, 8, 31, 9, 30),
        )
        for key, value in overrides.items():
            setattr(row, key, value)
        return row

    def test_carries_the_patients_own_words(self) -> None:
        payload = serialize_reported_symptom(self._row())
        assert payload["symptom"] == "Headache"
        assert payload["severity"] == "severe"
        assert payload["duration"] == "3 days"
        assert payload["rawText"].startswith("my head")

    def test_provenance_always_travels_with_the_row(self) -> None:
        """The whole point of this table is that it is not a clinical finding.

        A client that cannot see where a line came from cannot label it, and an
        unlabelled line beside a doctor's notes reads as a doctor's note.
        """
        payload = serialize_reported_symptom(self._row())
        assert payload["source"] == "PATIENT_REPORTED"
        assert payload["inputType"] == "TEXT"

    def test_speech_is_marked_as_the_machines_transcription(self) -> None:
        payload = serialize_reported_symptom(
            self._row(source=DataSource.AI_ASSISTED, input_type=InputType.VOICE)
        )
        assert payload["source"] == "AI_ASSISTED"

    def test_an_unreviewed_row_says_so(self) -> None:
        payload = serialize_reported_symptom(self._row())
        assert payload["promotedAt"] is None
        assert payload["promotedToRecordId"] is None

    def test_a_reviewed_row_points_at_the_record_that_answered_it(self) -> None:
        """This is what "a doctor validated it" means here.

        Not a flag somebody sets — a link to the note they wrote. Without it the
        same three symptoms sit at the top of the panel forever, and a list that
        never empties stops being read.
        """
        payload = serialize_reported_symptom(
            self._row(
                promoted_to_record_id="rec_9",
                promoted_at=datetime(2026, 9, 1, 10, 0),
            )
        )
        assert payload["promotedToRecordId"] == "rec_9"
        assert payload["promotedAt"].startswith("2026-09-01")

    def test_never_carries_a_diagnosis_field(self) -> None:
        # There is no clinical author on this row, so there is nothing on it
        # that a client could render under that heading even by mistake.
        payload = serialize_reported_symptom(self._row())
        assert "diagnosis" not in payload
        assert "treatmentPlan" not in payload

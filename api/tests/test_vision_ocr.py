"""Vision-model extraction: shaping and engine choice.

No network. What is tested here is how a model response is *interpreted* — which
is where the safety properties live. The model itself is exercised against a
real document in the integration suite.
"""

from __future__ import annotations

import pytest

from app.core.config import settings
from app.db.enums import OcrEngine
from app.services import extraction
from app.services.prescription_parser import expand_frequency
from app.services.vision_ocr import to_structured


def response(**overrides: object) -> dict:
    base = {
        "documentType": "PRESCRIPTION",
        "fullText": "Rx 1. Amoxicillin 500 mg TID x 5 days",
        "medications": [
            {
                "medication": "Amoxicillin",
                "dosage": "500 mg",
                "frequency": "TID",
                "duration": "5 days",
                "instructions": "1 tab",
                "sourceText": "1. Amoxicillin 500 mg - 1 tab TID x 5 days",
                "legible": True,
            }
        ],
        "unreadableRegions": 0,
    }
    return {**base, **overrides}


class TestShaping:
    def test_a_legible_line_produces_a_complete_entry(self) -> None:
        result = to_structured(response())
        medication = result["medications"][0]

        assert medication["medication"]["value"] == "Amoxicillin"
        assert medication["dosage"]["value"] == "500 mg"
        assert medication["duration"]["value"] == "5 days"
        assert medication["needsReview"] is False

    def test_shorthand_is_expanded_for_the_reader(self) -> None:
        # A patient should not have to know that TID means three times a day.
        result = to_structured(response())
        assert result["medications"][0]["frequency"]["value"] == "Three times daily"

    def test_the_source_line_keeps_the_original_shorthand(self) -> None:
        # Expansion is for display; the reviewer compares against what is
        # actually printed on the page.
        result = to_structured(response())
        assert "TID" in result["medications"][0]["sourceText"]

    def test_an_absent_field_is_null_and_needs_review(self) -> None:
        """The dangerous output is not a blank field — it is a plausible dose
        nobody wrote. Absent must stay absent."""
        result = to_structured(
            response(
                medications=[
                    {
                        "medication": "Paracetamol",
                        "dosage": "650 mg",
                        "frequency": "SOS",
                        "duration": None,
                        "sourceText": "2. Paracetamol 650 mg - SOS for fever",
                        "legible": True,
                    }
                ]
            )
        )
        duration = result["medications"][0]["duration"]

        assert duration["value"] is None
        assert duration["confidence"] == 0.0
        assert duration["needs_review"] is True
        assert result["medications"][0]["needsReview"] is True

    def test_an_empty_string_counts_as_absent(self) -> None:
        result = to_structured(
            response(
                medications=[
                    {
                        "medication": "Amoxicillin",
                        "dosage": "   ",
                        "frequency": "TID",
                        "sourceText": "x",
                        "legible": True,
                    }
                ]
            )
        )
        assert result["medications"][0]["dosage"]["value"] is None

    def test_an_illegible_line_drops_every_confidence(self) -> None:
        result = to_structured(
            response(
                medications=[
                    {
                        "medication": "Amoxicillin",
                        "dosage": "500 mg",
                        "frequency": "TID",
                        "duration": "5 days",
                        "sourceText": "illegible scrawl",
                        "legible": False,
                    }
                ]
            )
        )
        medication = result["medications"][0]

        assert medication["lineConfidence"] < 0.5
        assert medication["needsReview"] is True
        assert medication["dosage"]["needs_review"] is True

    def test_nothing_is_ever_fully_certain(self) -> None:
        # No machine reading is certain, so no field may claim 1.0.
        result = to_structured(response())
        for field in ("medication", "dosage", "frequency", "duration"):
            assert result["medications"][0][field]["confidence"] < 1.0


class TestReviewGate:
    def test_an_unread_region_forces_review_even_when_lines_look_clean(self) -> None:
        """The part that could not be read may be where the dose was."""
        result = to_structured(response(unreadableRegions=2))
        assert result["needsReview"] is True
        assert result["unreadableRegions"] == 2

    def test_a_document_with_no_medications_needs_review(self) -> None:
        result = to_structured(response(medications=[]))
        assert result["needsReview"] is True

    def test_the_disclaimer_is_always_present(self) -> None:
        result = to_structured(response())
        assert "not yet verified" in result["disclaimer"]

    def test_a_malformed_response_does_not_crash(self) -> None:
        # A provider returning something unexpected must degrade to "nothing
        # extracted, needs review", never to a confident empty result.
        for payload in ({}, {"medications": None}, {"medications": [{}]}):
            result = to_structured(payload)
            assert result["needsReview"] is True


class TestEngineChoice:
    """Consent decides the engine, because one of them sends the document away."""

    def test_vision_is_used_when_the_patient_has_consented(self, monkeypatch) -> None:
        monkeypatch.setattr(settings, "AI_API_KEY", "test-key")
        monkeypatch.setattr(settings, "AI_ENABLED", True)
        monkeypatch.setattr(settings, "AI_VISION_OCR_ENABLED", True)

        use_vision, reason = extraction.plan(
            patient_has_ai_consent=True, mime_type="image/png"
        )
        assert use_vision is True
        assert "consent" in reason

    def test_without_consent_the_document_never_leaves_the_deployment(
        self, monkeypatch
    ) -> None:
        monkeypatch.setattr(settings, "AI_API_KEY", "test-key")
        monkeypatch.setattr(settings, "AI_ENABLED", True)
        monkeypatch.setattr(settings, "AI_VISION_OCR_ENABLED", True)

        use_vision, reason = extraction.plan(
            patient_has_ai_consent=False, mime_type="image/png"
        )
        assert use_vision is False
        assert "consent" in reason

    def test_the_server_switch_overrides_consent(self, monkeypatch) -> None:
        monkeypatch.setattr(settings, "AI_API_KEY", "test-key")
        monkeypatch.setattr(settings, "AI_VISION_OCR_ENABLED", False)

        use_vision, _ = extraction.plan(patient_has_ai_consent=True, mime_type="image/png")
        assert use_vision is False

    def test_no_key_means_local_only(self, monkeypatch) -> None:
        monkeypatch.setattr(settings, "AI_API_KEY", "")
        use_vision, reason = extraction.plan(
            patient_has_ai_consent=True, mime_type="image/png"
        )
        assert use_vision is False
        assert "not configured" in reason

    def test_a_type_the_model_cannot_take_falls_back(self, monkeypatch) -> None:
        monkeypatch.setattr(settings, "AI_API_KEY", "test-key")
        monkeypatch.setattr(settings, "AI_ENABLED", True)
        monkeypatch.setattr(settings, "AI_VISION_OCR_ENABLED", True)

        use_vision, _ = extraction.plan(
            patient_has_ai_consent=True, mime_type="image/tiff"
        )
        assert use_vision is False

    def test_both_engines_are_reported_in_availability(self, monkeypatch) -> None:
        monkeypatch.setattr(settings, "AI_API_KEY", "test-key")
        monkeypatch.setattr(settings, "AI_ENABLED", True)
        state = extraction.availability()

        assert set(state) == {"vision", "local", "any"}
        assert "available" in state["vision"]


class TestSharedNormalisation:
    @pytest.mark.parametrize(
        ("shorthand", "expected"),
        [
            ("TID", "Three times daily"),
            ("tid", "Three times daily"),
            ("OD", "Once daily"),
            ("BD.", "Twice daily"),
            ("SOS", "As needed"),
            ("HS", "At bedtime"),
        ],
    )
    def test_it_expands_known_shorthand(self, shorthand: str, expected: str) -> None:
        assert expand_frequency(shorthand) == expected

    def test_anything_unrecognised_passes_through(self) -> None:
        # Guessing at unfamiliar shorthand would be inventing a schedule.
        assert expand_frequency("every other Tuesday") == "every other Tuesday"
        assert expand_frequency("Twice daily") == "Twice daily"

    @pytest.mark.parametrize("empty", [None, ""])
    def test_it_leaves_absent_values_absent(self, empty: str | None) -> None:
        assert expand_frequency(empty) == empty


class TestEngineIsRecorded:
    def test_the_two_engines_are_distinguishable(self) -> None:
        # A clinician re-checking a dose needs to know which read it: the two
        # fail differently, so "which engine" changes what to look for.
        assert OcrEngine.GEMINI_VISION != OcrEngine.PADDLE_OCR

"""Structured extraction from OCR text (spec §24).

The spec's worked example is a misread dose, and that is the risk these tests
exist for. A parser that confidently returns the wrong number is far more
dangerous than one that returns nothing, so most of what is asserted here is
what the parser *refuses* to claim.
"""

from __future__ import annotations

import pytest

from app.services.prescription_parser import (
    FREQUENCY_TERMS,
    parse,
    parse_line,
)

CONFIDENT = 0.99
SHAKY = 0.62


class TestMedicationLines:
    def test_it_reads_a_standard_prescription_line(self) -> None:
        parsed = parse_line("1. Amoxicillin 500 mg - 1 tab TID x 5 days", CONFIDENT)

        assert parsed is not None
        assert parsed.medication.value == "Amoxicillin"
        assert parsed.dosage.value == "500 mg"
        assert parsed.frequency.value == "Three times daily"
        assert parsed.duration.value == "5 days"

    def test_the_numbering_is_stripped_from_the_name(self) -> None:
        parsed = parse_line("2) Paracetamol 650 mg OD", CONFIDENT)
        assert parsed is not None
        assert parsed.medication.value == "Paracetamol"

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Metformin 500 mg BD", "Twice daily"),
            ("Metformin 500 mg bid", "Twice daily"),
            ("Atorvastatin 10 mg HS", "At bedtime"),
            ("Paracetamol 650 mg SOS", "As needed"),
            ("Amoxicillin 500 mg TDS", "Three times daily"),
            ("Insulin 10 iu QID", "Four times daily"),
        ],
    )
    def test_it_expands_prescription_shorthand(self, text: str, expected: str) -> None:
        # Expanding these is itself a safety feature: a patient reading their own
        # record should not have to know what TDS means.
        parsed = parse_line(text, CONFIDENT)
        assert parsed is not None
        assert parsed.frequency.value == expected

    def test_it_reads_frequency_written_out_in_words(self) -> None:
        parsed = parse_line("Ibuprofen 400 mg twice a day", CONFIDENT)
        assert parsed is not None
        assert parsed.frequency.value == "Twice daily"

    @pytest.mark.parametrize(
        ("text", "dose"),
        [
            ("Levothyroxine 25 mcg OD", "25 mcg"),
            ("Amoxicillin 1 g BD", "1 g"),
            ("Salbutamol 2.5 ml", "2.5 ml"),
            ("Insulin 10 IU", "10 iu"),
            ("Hydrocortisone 1 %", "1 %"),
        ],
    )
    def test_it_reads_each_dose_unit(self, text: str, dose: str) -> None:
        parsed = parse_line(text, CONFIDENT)
        assert parsed is not None
        assert parsed.dosage.value == dose

    def test_a_decimal_dose_keeps_its_decimal(self) -> None:
        """The failure this guards is 2.5 mg read as 25 mg."""
        parsed = parse_line("Clonazepam 0.5 mg HS", CONFIDENT)
        assert parsed is not None
        assert parsed.dosage.value == "0.5 mg"


class TestRefusals:
    """What the parser declines to claim matters more than what it extracts."""

    @pytest.mark.parametrize(
        "text",
        [
            "CITY GENERAL HOSPITAL",
            "Dept. of General Medicine",
            "Patient: Priya Sharma        Age: 34 / F",
            "MRN: MRN-DEMO-000001         Date: 12/08/2026",
            "Review after 5 days.",
            "Dr. Rajesh Iyer, MD",
            "Rx",
            "",
            "   ",
        ],
    )
    def test_it_ignores_everything_that_is_not_medication(self, text: str) -> None:
        assert parse_line(text, CONFIDENT) is None

    def test_a_line_with_no_dose_is_not_a_medication(self) -> None:
        # Without a dose this is prose or a heading. Treating it as medication
        # would invent a prescription that nobody wrote.
        assert parse_line("Continue current medication", CONFIDENT) is None

    def test_a_patient_line_with_a_number_is_not_a_dose(self) -> None:
        assert parse_line("Patient: Priya Sharma  Age: 34 / F", CONFIDENT) is None

    def test_two_frequencies_on_one_line_are_reported_as_unknown(self) -> None:
        """Ambiguity is surfaced, never resolved by guessing."""
        parsed = parse_line("Amoxicillin 500 mg BD or TID", CONFIDENT)
        assert parsed is not None
        assert parsed.frequency.value is None
        assert parsed.frequency.needs_review is True

    def test_an_abbreviation_inside_a_word_is_not_a_frequency(self) -> None:
        # "od" appears inside "Codeine"; matching it would be a false reading.
        parsed = parse_line("Codeine 30 mg", CONFIDENT)
        assert parsed is not None
        assert parsed.frequency.value is None

    def test_a_missing_field_is_missing_not_defaulted(self) -> None:
        parsed = parse_line("Amoxicillin 500 mg", CONFIDENT)
        assert parsed is not None
        assert parsed.duration.value is None
        assert parsed.frequency.value is None
        assert parsed.duration.needs_review is True


class TestConfidence:
    def test_low_ocr_confidence_flags_every_field(self) -> None:
        parsed = parse_line("Amoxicillin 500 mg TID x 5 days", SHAKY)
        assert parsed is not None
        assert parsed.needs_review is True
        assert parsed.dosage.needs_review is True

    def test_the_drug_name_is_trusted_least(self) -> None:
        """Picking a name out of free text is the least certain step, so it
        carries the largest penalty."""
        parsed = parse_line("Amoxicillin 500 mg TID x 5 days", CONFIDENT)
        assert parsed is not None
        assert parsed.medication.confidence < parsed.dosage.confidence

    def test_a_missing_field_has_no_confidence(self) -> None:
        parsed = parse_line("Amoxicillin 500 mg", CONFIDENT)
        assert parsed is not None
        assert parsed.frequency.confidence == 0.0
        assert parsed.frequency.needs_review is True


class TestWholeDocument:
    def test_it_extracts_the_medication_lines_from_a_full_prescription(self) -> None:
        # The same sample the OCR feasibility harness renders.
        lines = [
            ("CITY GENERAL HOSPITAL", 0.99),
            ("Dept. of General Medicine", 0.98),
            ("Patient: Priya Sharma        Age: 34 / F", 0.97),
            ("MRN: MRN-DEMO-000001         Date: 12/08/2026", 0.96),
            ("Rx", 0.99),
            ("1. Amoxicillin 500 mg  -  1 tab TID x 5 days", 0.98),
            ("2. Paracetamol 650 mg  -  SOS for fever", 0.97),
            ("3. Pantoprazole 40 mg  -  1 tab OD before food", 0.98),
            ("Review after 5 days.", 0.99),
            ("Dr. Rajesh Iyer, MD", 0.98),
        ]
        result = parse(lines)

        names = [m.medication.value for m in result.medications]
        assert names == ["Amoxicillin", "Paracetamol", "Pantoprazole"]
        assert [m.dosage.value for m in result.medications] == ["500 mg", "650 mg", "40 mg"]

    def test_the_payload_always_carries_a_disclaimer(self) -> None:
        # A client must not be able to render this as settled fact without
        # having been handed the warning.
        payload = parse([("Amoxicillin 500 mg TID", CONFIDENT)]).as_dict()
        assert "not yet verified" in payload["disclaimer"]

    def test_an_empty_document_needs_review(self) -> None:
        result = parse([])
        assert result.medications == []
        assert result.needs_review is True

    def test_review_is_required_whenever_any_field_is_uncertain(self) -> None:
        result = parse([("Amoxicillin 500 mg TID x 5 days", SHAKY)])
        assert result.needs_review is True

    def test_every_shorthand_term_maps_to_words(self) -> None:
        # Guards against a term being listed with no expansion, which would
        # surface the raw abbreviation to a patient.
        for term, meaning in FREQUENCY_TERMS.items():
            assert meaning and meaning[0].isupper(), term

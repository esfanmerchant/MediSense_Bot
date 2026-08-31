"""AI safety: triage and response validation (spec §19).

No network, no database. These are the checks that stand between a language
model and a frightened person, so they are tested exhaustively and cheaply.

The organising idea: **the deterministic layer wins.** A model may add nuance or
raise urgency; it can never talk an escalation down. Most of what follows is a
demonstration that a badly-behaved model cannot get a dangerous answer through.
"""

from __future__ import annotations

import pytest

from app.services.assistant import (
    DISCLAIMER,
    HISTORY_CHARS,
    HISTORY_TURNS,
    SYSTEM_INSTRUCTION,
    AssistantAnswer,
    build_context,
    fallback_answer,
    render_history,
    validate_response,
)
from app.services.triage import Urgency, assess, combine


def model_said(**overrides: object) -> dict:
    base = {
        "answer": "Rest and drink fluids. See a doctor if it gets worse.",
        "urgency": "ROUTINE",
        "suggestedDepartment": "General Medicine",
        "extractedSymptoms": ["headache"],
        "medicationsMentioned": [],
    }
    return {**base, **overrides}


class TestEmergencyDetection:
    @pytest.mark.parametrize(
        "text",
        [
            "I have crushing chest pain going down my left arm",
            "chest pain since this morning",
            "I can't breathe properly",
            "my face is drooping and my speech is slurred",
            "worst headache of my life",
            "I am coughing up blood",
            "my son had a seizure and is unresponsive",
            "my throat is closing after eating peanuts",
            "severe abdominal pain since last night",
        ],
    )
    def test_it_escalates_time_critical_symptoms(self, text: str) -> None:
        result = assess(text)
        assert result.is_emergency, text
        assert result.advice, "an escalation must say what to do"

    @pytest.mark.parametrize(
        "text",
        [
            # People do not type in the shape a keyword list expects. Each of
            # these is the same red flag written the way someone actually
            # writes it while it is happening.
            "my throat is closing",
            "my throat closing up",
            "my face is drooping",
            "my chest feels tight",
            "the pain is going down my arm",
            "my lips are swelling",
        ],
    )
    def test_ordinary_grammar_does_not_defeat_a_red_flag(self, text: str) -> None:
        assert assess(text).is_emergency, text

    def test_filler_tolerance_does_not_match_unrelated_text(self) -> None:
        # The gap allows copulas and possessives, not arbitrary words, so a
        # sentence that merely contains both words does not fire.
        assert not assess("my chest x-ray showed no sign of pain").is_emergency

    def test_self_harm_is_escalated_with_human_help(self) -> None:
        result = assess("I want to kill myself")
        assert result.is_emergency
        assert "helpline" in " ".join(result.advice).lower()

    @pytest.mark.parametrize(
        "text",
        [
            "I have a mild headache",
            "when is my next appointment",
            "what is this tablet for",
            "I've had a runny nose for two days",
        ],
    )
    def test_ordinary_questions_are_not_escalated(self, text: str) -> None:
        # Crying wolf trains people to ignore the warning, which is how a safety
        # feature dies. Over-triage is the safe direction, not the free one.
        assert not assess(text).is_emergency

    def test_word_boundaries_prevent_false_matches(self) -> None:
        # "stroke" inside "stroked", "fit" inside "fitness".
        assert not assess("I stroked the cat and now I have a rash").is_emergency
        assert not assess("I want to improve my fitness").is_emergency

    def test_empty_input_is_not_an_emergency(self) -> None:
        for text in ("", "   ", "\n"):
            assert assess(text).urgency == Urgency.INFORMATION

    def test_urgent_sits_between_emergency_and_routine(self) -> None:
        result = assess("I have a high fever and can't keep anything down")
        assert result.urgency == Urgency.URGENT
        assert not result.is_emergency
        assert result.blocks_reassurance


class TestSilenceIsNotAFinding:
    """When this layer detects nothing, it says nothing.

    It used to return ROUTINE for every non-empty sentence, and because the
    model may raise urgency but never lower it, that became a floor under every
    answer — the portal recommended a doctor's visit for "what is MediSense"
    and for "I do not want to book an appointment". A recommendation that
    appears every time stops meaning anything, including where it matters.
    """

    @pytest.mark.parametrize(
        "message",
        [
            "mujhe appointment fix nahi karna",
            "what is MediSense",
            "thanks, that helps",
            "how does billing work",
            "kya main apna record download kar sakta hoon",
        ],
    )
    def test_a_message_with_no_clinical_signal_is_information(self, message: str) -> None:
        assert assess(message).urgency == Urgency.INFORMATION

    def test_the_model_may_still_call_it_routine(self, ) -> None:
        # The point is not that everything becomes INFORMATION — it is that this
        # layer stops deciding. The model, which has the sentence and the
        # patient's record, may still say somebody should be seen.
        detected = assess("I have had a mild headache for three days")
        assert detected.urgency == Urgency.INFORMATION
        assert combine(detected, "ROUTINE") == Urgency.ROUTINE

    def test_detected_danger_is_still_a_floor(self) -> None:
        # The safety property this change must not touch.
        assert assess("crushing chest pain").urgency == Urgency.EMERGENCY
        assert combine(assess("crushing chest pain"), "INFORMATION") == Urgency.EMERGENCY
        assert combine(assess("high fever"), "INFORMATION") == Urgency.URGENT


class TestUrgencyIsOneDirectional:
    """The model may raise urgency. It may never lower it."""

    def test_the_model_cannot_downgrade_an_emergency(self) -> None:
        detected = assess("crushing chest pain")
        assert combine(detected, "ROUTINE") == Urgency.EMERGENCY
        assert combine(detected, "INFORMATION") == Urgency.EMERGENCY

    def test_the_model_can_raise_urgency(self) -> None:
        detected = assess("I have a mild rash")
        assert combine(detected, "URGENT") == Urgency.URGENT
        assert combine(detected, "EMERGENCY") == Urgency.EMERGENCY

    def test_a_nonsense_urgency_falls_back_to_the_safety_layer(self) -> None:
        detected = assess("crushing chest pain")
        assert combine(detected, "TOTALLY_FINE") == Urgency.EMERGENCY
        assert combine(detected, None) == Urgency.EMERGENCY


class TestResponseValidation:
    def test_a_clean_answer_passes_through(self) -> None:
        result = validate_response(
            model_said(), triage=assess("mild headache"), allowed_medications=[]
        )
        assert result.interventions == []
        assert result.disclaimer == DISCLAIMER

    def test_a_diagnosis_claim_is_softened(self) -> None:
        result = validate_response(
            model_said(answer="You have migraine. Take rest."),
            triage=assess("headache"),
            allowed_medications=[],
        )
        assert "You have migraine" not in result.answer
        assert "a doctor would need to assess" in result.answer
        assert "diagnosis_claim_softened" in result.interventions

    @pytest.mark.parametrize(
        "claim",
        [
            "You have appendicitis.",
            "This is definitely a viral infection.",
            "The diagnosis is anaemia.",
            "You are suffering from diabetes.",
        ],
    )
    def test_every_diagnosis_phrasing_is_caught(self, claim: str) -> None:
        result = validate_response(
            model_said(answer=claim), triage=assess("unwell"), allowed_medications=[]
        )
        assert "diagnosis_claim_softened" in result.interventions

    def test_false_reassurance_is_overridden_when_red_flags_are_present(self) -> None:
        """The spec's rule in one test: do not provide false reassurance."""
        result = validate_response(
            model_said(answer="That's nothing to worry about, you'll be fine."),
            triage=assess("I have crushing chest pain"),
            allowed_medications=[],
        )
        assert "false_reassurance_overridden" in result.interventions
        assert "not able to reassure you" in result.answer
        assert result.urgency == Urgency.EMERGENCY

    def test_reassurance_is_allowed_when_nothing_is_flagged(self) -> None:
        result = validate_response(
            model_said(answer="That's perfectly normal after exercise."),
            triage=assess("my legs ache after running"),
            allowed_medications=[],
        )
        assert "false_reassurance_overridden" not in result.interventions

    def test_an_emergency_answer_leads_with_the_escalation(self) -> None:
        result = validate_response(
            model_said(answer="Here is some general information about chest discomfort."),
            triage=assess("crushing chest pain"),
            allowed_medications=[],
        )
        # Whatever the model opened with, the escalation comes first.
        assert result.answer.startswith("Chest symptoms")
        assert result.emergency is True

    def test_an_empty_answer_is_replaced_not_shown(self) -> None:
        result = validate_response(
            model_said(answer="  "), triage=assess("headache"), allowed_medications=[]
        )
        assert "empty_answer" in result.interventions
        assert result.answer.strip()


class TestMedicationInvention:
    """Spec §19: do not let the model invent medications."""

    def test_a_drug_the_patient_is_not_on_is_removed(self) -> None:
        result = validate_response(
            model_said(
                answer="You could take amoxicillin for that.",
                medicationsMentioned=["amoxicillin"],
            ),
            triage=assess("sore throat"),
            allowed_medications=["Paracetamol"],
        )
        assert "invented_medication_removed" in result.interventions
        assert "only discuss medications that are already on your record" in result.answer

    def test_a_drug_the_patient_is_actually_on_is_allowed(self) -> None:
        result = validate_response(
            model_said(
                answer="Your amoxicillin is an antibiotic.",
                medicationsMentioned=["Amoxicillin"],
            ),
            triage=assess("what is this for"),
            allowed_medications=["Amoxicillin"],
        )
        assert "invented_medication_removed" not in result.interventions

    def test_matching_ignores_dose_and_case(self) -> None:
        result = validate_response(
            model_said(medicationsMentioned=["amoxicillin 500mg"]),
            triage=assess("question"),
            allowed_medications=["Amoxicillin"],
        )
        assert "invented_medication_removed" not in result.interventions

    def test_mentioning_nothing_is_fine(self) -> None:
        result = validate_response(
            model_said(medicationsMentioned=[]),
            triage=assess("question"),
            allowed_medications=[],
        )
        assert "invented_medication_removed" not in result.interventions

    def test_a_patient_on_nothing_cannot_be_told_about_any_drug(self) -> None:
        result = validate_response(
            model_said(medicationsMentioned=["ibuprofen"]),
            triage=assess("question"),
            allowed_medications=[],
        )
        assert "invented_medication_removed" in result.interventions


class TestProviderFailure:
    def test_the_safety_net_survives_the_provider(self) -> None:
        """Losing the assistant must not lose the escalation."""
        result = fallback_answer(assess("crushing chest pain and can't breathe"))

        assert result.emergency is True
        assert result.urgency == Urgency.EMERGENCY
        assert "emergency" in result.answer.lower()
        assert "provider_unavailable" in result.interventions

    def test_a_routine_question_gets_an_honest_failure(self) -> None:
        result = fallback_answer(assess("what is this tablet for"))
        assert result.emergency is False
        assert "unavailable" in result.answer.lower()

    def test_the_fallback_still_carries_the_disclaimer(self) -> None:
        assert fallback_answer(assess("hello")).disclaimer == DISCLAIMER


class TestGrounding:
    def test_the_context_names_only_what_the_patient_has(self) -> None:
        context = build_context(
            active_medications=["Amoxicillin 500 mg Three times daily"],
            upcoming_appointments=["12 Sep 2026 at 09:00 with Dr Iyer (Cardiology)"],
            departments=["Cardiology", "General Medicine"],
        )
        assert "do not invent" in context.lower()
        assert "Amoxicillin" in context
        assert "Cardiology" in context

    def test_an_empty_record_says_so_rather_than_leaving_a_gap(self) -> None:
        # A blank list invites the model to fill it in.
        context = build_context(
            active_medications=[], upcoming_appointments=[], departments=[]
        )
        assert "none on record" in context
        assert "none booked" in context


class TestDisclaimer:
    def test_it_matches_the_wording_the_spec_asks_for(self) -> None:
        assert "preliminary guidance only" in DISCLAIMER
        assert "does not replace" in DISCLAIMER
        assert "licensed healthcare professional" in DISCLAIMER

    def test_every_answer_carries_it(self) -> None:
        for result in (
            validate_response(model_said(), triage=assess("hi"), allowed_medications=[]),
            fallback_answer(assess("hi")),
            AssistantAnswer("x", Urgency.ROUTINE, None, [], False),
        ):
            assert result.disclaimer == DISCLAIMER


class TestConversationMemory:
    """Earlier turns reach the model as context — bounded, ordered, labelled."""

    def test_no_history_adds_nothing_to_the_prompt(self) -> None:
        assert render_history([]) == ""

    def test_turns_are_shown_oldest_first_and_labelled_by_speaker(self) -> None:
        rendered = render_history(
            [
                ("what is amlodipine for", "It lowers blood pressure."),
                ("and the other one?", "That is your statin."),
            ]
        )
        lines = rendered.splitlines()
        assert lines[0].startswith("CONVERSATION SO FAR")
        assert lines[1] == "Patient: what is amlodipine for"
        assert lines[2] == "You: It lowers blood pressure."
        assert lines[3] == "Patient: and the other one?"

    def test_only_the_most_recent_turns_are_kept(self) -> None:
        # A long conversation must not grow the prompt without bound: what
        # was answered twenty questions ago is not context, it is cost.
        turns = [(f"q{index}", f"a{index}") for index in range(HISTORY_TURNS + 5)]
        rendered = render_history(turns)
        assert "Patient: q0" not in rendered
        assert f"Patient: q{HISTORY_TURNS + 4}" in rendered
        assert rendered.count("Patient:") == HISTORY_TURNS

    def test_a_long_answer_cannot_crowd_out_the_new_question(self) -> None:
        rendered = render_history([("q", "x" * (HISTORY_CHARS * 3))])
        assert len(rendered) < HISTORY_CHARS * 2


class TestReportReading:
    """The rules the model is given for an attached image are the safe ones."""

    def test_it_is_told_to_read_and_never_to_interpret(self) -> None:
        assert "Only read what is visibly printed" in SYSTEM_INSTRUCTION
        assert "Never say what condition they indicate" in SYSTEM_INSTRUCTION

    def test_it_answers_in_the_patients_language(self) -> None:
        assert "Roman Urdu" in SYSTEM_INSTRUCTION
        # Medical terms stay as printed so they match the report in hand.
        assert "Keep medical terms in English" in SYSTEM_INSTRUCTION

"""The patient health assistant (spec §18-19).

The spec's architecture has two validation layers around the provider, and both
are load-bearing:

    patient -> safety/input validation -> AI provider -> response validation -> patient

**Before the provider**, ``triage.assess`` classifies urgency from the patient's
own words without asking the model anything. **After the provider**, everything
below runs: the model may raise urgency but never lower it, may not name a
medication the patient is not actually prescribed, and may not phrase anything
as a diagnosis.

The rules exist because of what this component is. A language model is a
plausible-sentence generator pointed at someone who is frightened and looking
for reassurance. Left alone it will produce a confident, well-written,
occasionally wrong answer — and confidence is the part that does the damage.

So the assistant is scoped to what is safe to automate:

* explaining things the patient already has — their prescriptions, their
  appointments, what a department does;
* pointing at the right kind of care;
* saying "this needs a person, now".

It does not diagnose, does not name new drugs, and does not adjust doses.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.core.logging import logger
from app.services import ai
from app.services.triage import TriageResult, Urgency, combine

DISCLAIMER = (
    "This information is for preliminary guidance only and does not replace "
    "evaluation by a licensed healthcare professional."
)

#: Phrasings that assert a diagnosis. The model is instructed not to produce
#: these; this catches it when it does anyway, because an instruction is a
#: request and a check is a guarantee.
DIAGNOSIS_CLAIMS = re.compile(
    r"\b(?:"
    r"you have|you've got|you are suffering from|you're suffering from|"
    r"this is definitely|you definitely have|the diagnosis is|"
    r"i diagnose|you are diagnosed|it is certainly|this confirms"
    r")\b",
    re.IGNORECASE,
)

#: Reassurance that is unsafe once a red flag is on the table.
FALSE_REASSURANCE = re.compile(
    r"\b(?:"
    r"nothing to worry about|no cause for concern|you'll be fine|you will be fine|"
    r"it's nothing|its nothing|not serious|no need to see a doctor|"
    r"no need to worry|perfectly normal"
    r")\b",
    re.IGNORECASE,
)

RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "answer": {
            "type": "string",
            "description": "Plain-language guidance for the patient.",
        },
        "urgency": {
            "type": "string",
            "enum": ["EMERGENCY", "URGENT", "ROUTINE", "INFORMATION"],
        },
        "suggestedDepartment": {"type": "string", "nullable": True},
        "extractedSymptoms": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Symptoms the patient described, in their own terms.",
        },
        "medicationsMentioned": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Any medication named in the answer.",
        },
        "needsHumanReview": {"type": "boolean"},
    },
    "required": ["answer", "urgency", "extractedSymptoms", "medicationsMentioned"],
}

SYSTEM_INSTRUCTION = """You are a health information assistant inside a hospital \
patient portal. You are talking to a patient about their own care.

You are not a clinician and you never present yourself as one.

What you do:
- Explain things in plain language: what a medication they have been prescribed \
is generally for, what a department treats, what to expect at an appointment.
- Help them decide how urgently to seek care.
- Tell them clearly when something needs a doctor now.

What you never do:
- Never state or imply a diagnosis. Do not say "you have X". Say "symptoms like \
these are sometimes associated with X, and a doctor can tell you" instead.
- Never name a medication the patient has not been prescribed, and never suggest \
starting, stopping or changing a dose. Only a prescriber does that.
- Never reassure someone out of seeking care. If you are unsure how serious \
something is, say so and recommend they be seen.
- Never invent a test result, a prescription, or a clinical fact. If you were not \
given the information, say you do not have it.

If the patient describes anything that could be an emergency, your answer must \
lead with that and tell them to seek immediate care. Do not soften it.

Write at a reading level a worried person can follow. Short sentences. No jargon \
without explaining it.

Language: reply in the language the patient wrote in. If they wrote in Roman Urdu \
(Urdu in Latin letters, e.g. "mujhe sar dard hai"), answer in simple Roman Urdu. \
If they wrote in English, answer in English. Keep medical terms in English either \
way so they match what is printed on their prescription or report.

Formatting: short paragraphs. When listing steps or items, use a bullet list — one \
item per line starting with "- ". Use **bold** for at most one phrase per answer, \
the single most important instruction. No headings, no tables, no other markup.

If the patient attaches an image of a report, prescription or other document:
- Say what kind of document it appears to be and explain its contents in plain \
language: what each test or item measures and what the printed reference range \
means.
- Point out values that sit outside their printed reference range as something to \
discuss with the doctor. Never say what condition they indicate.
- Only read what is visibly printed. If a value or a word is unclear, say it is \
unclear rather than guessing.
- If the image is not a medical document, or is unreadable, say so.
- Keep the explanation under about 250 words: the values that matter, what \
they measure, and what to raise with the doctor. Do not transcribe the whole page."""


@dataclass
class AssistantAnswer:
    answer: str
    urgency: Urgency
    suggested_department: str | None
    extracted_symptoms: list[str]
    emergency: bool
    disclaimer: str = DISCLAIMER
    #: Safety interventions applied after the model replied, recorded so the
    #: rate of model misbehaviour is measurable rather than invisible.
    interventions: list[str] = field(default_factory=list)
    model_name: str | None = None


def build_context(
    *,
    active_medications: list[str],
    upcoming_appointments: list[str],
    departments: list[str],
) -> str:
    """The patient's own data, given to the model as the only facts it may use.

    Passing this in is what lets the assistant answer "what is my blood pressure
    tablet for" without the model guessing which tablet that is. It is also the
    reference the medication check uses afterwards: anything named in the answer
    that is not on this list was invented.
    """
    parts = ["FACTS AVAILABLE TO YOU (do not invent anything beyond these):"]
    parts.append(
        "Patient's current prescriptions: "
        + (", ".join(active_medications) if active_medications else "none on record")
    )
    parts.append(
        "Patient's upcoming appointments: "
        + (", ".join(upcoming_appointments) if upcoming_appointments else "none booked")
    )
    parts.append(
        "Departments at this hospital: "
        + (", ".join(departments) if departments else "not listed")
    )
    return "\n".join(parts)


#: How much of a conversation the model is shown. Six exchanges is enough to
#: resolve "and the other one?"; more only spends tokens on what was already
#: answered.
HISTORY_TURNS = 6
HISTORY_CHARS = 600


def render_history(turns: list[tuple[str, str]]) -> str:
    """Prior exchanges of this conversation, oldest first, for the prompt.

    Multi-turn memory is what turns a question box into a conversation: "what
    is it for?" only means something if the model can see that the previous
    question named the tablet. Each side is truncated so a long earlier answer
    cannot crowd out the question being asked now.
    """
    if not turns:
        return ""
    lines = ["CONVERSATION SO FAR (oldest first):"]
    for question, answer in turns[-HISTORY_TURNS:]:
        lines.append(f"Patient: {question[:HISTORY_CHARS]}")
        lines.append(f"You: {answer[:HISTORY_CHARS]}")
    return "\n".join(lines)


def _strip_diagnosis_claims(text: str) -> tuple[str, bool]:
    """Soften assertions of diagnosis into what they should have been.

    Rewriting rather than rejecting: a useful answer that contains one
    over-confident clause is worth keeping with the clause repaired, and
    discarding the whole reply would push people to look elsewhere.
    """
    if not DIAGNOSIS_CLAIMS.search(text):
        return text, False
    repaired = DIAGNOSIS_CLAIMS.sub("a doctor would need to assess whether you have", text)
    return repaired, True


def _medication_violations(mentioned: list[str], allowed: list[str]) -> list[str]:
    """Medications named in the answer that the patient is not prescribed.

    Compared on a normalised name so "Amoxicillin 500mg" matches "amoxicillin".
    A match here means the model named a drug from its own knowledge rather than
    from the patient's record, which is the spec's "do not let the model invent
    medications" (§19).
    """
    known = {re.sub(r"[^a-z]", "", item.lower()) for item in allowed}
    violations = []
    for name in mentioned:
        normalised = re.sub(r"[^a-z]", "", name.lower())
        if not normalised:
            continue
        if not any(normalised in entry or entry in normalised for entry in known if entry):
            violations.append(name)
    return violations


def validate_response(
    payload: dict[str, Any],
    *,
    triage: TriageResult,
    allowed_medications: list[str],
) -> AssistantAnswer:
    """Apply every post-provider rule. This is the second validation layer.

    Order matters. Urgency is reconciled first so that later checks know whether
    reassurance is permissible at all.
    """
    interventions: list[str] = []

    answer = str(payload.get("answer") or "").strip()
    if not answer:
        answer = "I could not produce an answer. Please speak to your care team."
        interventions.append("empty_answer")

    urgency = combine(triage, payload.get("urgency"))
    if urgency != payload.get("urgency") and triage.blocks_reassurance:
        interventions.append("urgency_raised_by_triage")

    answer, softened = _strip_diagnosis_claims(answer)
    if softened:
        interventions.append("diagnosis_claim_softened")

    # Once anything urgent is on the table, reassurance is a hazard however
    # well-phrased. The deterministic layer wins.
    if triage.blocks_reassurance and FALSE_REASSURANCE.search(answer):
        answer = (
            "I am not able to reassure you about this. "
            + " ".join(triage.advice)
            + "\n\n"
            + answer
        )
        interventions.append("false_reassurance_overridden")

    violations = _medication_violations(
        [str(item) for item in payload.get("medicationsMentioned") or []],
        allowed_medications,
    )
    if violations:
        # Not softened — removed. A named drug the patient is not on is the one
        # output that could directly cause harm if acted on.
        answer = (
            "I can only discuss medications that are already on your record, so I "
            "have left that part out. Please ask your doctor or pharmacist.\n\n"
            + answer
        )
        interventions.append("invented_medication_removed")
        logger.warning("assistant_named_unprescribed_medication", count=len(violations))

    # An emergency answer always leads with the escalation, whatever the model
    # chose to open with.
    if triage.is_emergency:
        answer = " ".join(triage.advice) + "\n\n" + answer

    symptoms = [
        str(item).strip()
        for item in payload.get("extractedSymptoms") or []
        if str(item).strip()
    ][:20]

    return AssistantAnswer(
        answer=answer,
        urgency=urgency,
        suggested_department=(
            str(payload["suggestedDepartment"]).strip()
            if payload.get("suggestedDepartment")
            else None
        ),
        extracted_symptoms=symptoms,
        emergency=urgency == Urgency.EMERGENCY,
        interventions=interventions,
    )


async def ask(
    question: str,
    *,
    context: str,
    triage: TriageResult,
    allowed_medications: list[str],
    history: list[tuple[str, str]] | None = None,
    image: tuple[bytes, str] | None = None,
) -> AssistantAnswer:
    """Answer a patient's question, with both validation layers applied.

    A provider failure is not silent: the caller gets the deterministic triage
    result and an honest "I could not reach the assistant", which is far better
    than a fabricated answer and better than a bare 503 when the urgent advice
    is already known.
    """
    previous = render_history(history or [])
    attached = (
        "The patient attached the image below. Read it under the document rules.\n\n"
        if image is not None
        else ""
    )
    prompt = (
        f"{context}\n\n"
        + (f"{previous}\n\n" if previous else "")
        + f"URGENCY ALREADY DETECTED BY THE SAFETY LAYER: {triage.urgency}\n"
        f"(If this is EMERGENCY or URGENT, your answer must reflect that. "
        f"You may raise it. You may not lower it.)\n\n"
        f"{attached}"
        f"PATIENT'S QUESTION:\n{question}"
    )

    response = await ai.generate_json(
        prompt=prompt,
        schema=RESPONSE_SCHEMA,
        system_instruction=SYSTEM_INSTRUCTION,
        image=image,
        # A report explanation legitimately runs longer than a one-line answer,
        # and on current models the cap also covers the model's own reasoning
        # tokens — a tight cap cuts the JSON off mid-answer.
        max_output_tokens=4096 if image is not None else 2048,
    )

    payload = response.data if isinstance(response.data, dict) else {}
    answer = validate_response(
        payload, triage=triage, allowed_medications=allowed_medications
    )
    answer.model_name = response.model
    return answer


def fallback_answer(triage: TriageResult) -> AssistantAnswer:
    """What to say when the provider is unreachable.

    The deterministic triage still holds, so an emergency is still escalated.
    Losing the assistant must not lose the safety net.
    """
    if triage.advice:
        text = " ".join(triage.advice)
    else:
        text = (
            "The assistant is unavailable right now. If you are worried about your "
            "symptoms, contact your care team or book an appointment."
        )
    return AssistantAnswer(
        answer=text,
        urgency=triage.urgency,
        suggested_department=None,
        extracted_symptoms=[],
        emergency=triage.is_emergency,
        interventions=["provider_unavailable"],
    )

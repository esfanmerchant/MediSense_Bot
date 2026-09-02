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
  appointments, what a speciality treats;
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
is generally for, what a speciality treats, what to expect at an appointment.
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

About this platform:
- You know MediSense itself. Answer questions about how booking, billing, \
payment, records or emergencies work from the brief you are given, and never \
invent a policy, a price or a guarantee that is not in it.
- You know which doctors are available and where they practise. Recommend from \
that list only. Never invent a doctor, a clinic, a fee or an availability.

Booking an appointment:
- If the patient asks you to book, and you can identify a doctor from the list \
and a day from what they said, end your reply with a line of exactly this form:
  BOOK: doctor=<exact doctor name from the list>; date=<YYYY-MM-DD>
- Put nothing after that line. Say in your reply, in the patient's language, \
that you have found a time and they need to confirm it — never that you have \
booked it, because you have not: a person confirms it on the screen.
- If you cannot tell which doctor or which day they mean, ask instead of \
guessing. A wrong appointment wastes a clinic slot and the patient's day.

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


#: What MediSense is, in the assistant's own words.
#:
#: Held here rather than left to the model's guess. Asked "what is MediSense",
#: a model with no brief will invent something plausible and wrong — a pricing
#: model, a policy, a guarantee — and a patient has no way to tell that apart
#: from the truth. Everything below is a fact the system actually implements,
#: kept short enough to sit in every prompt.
PLATFORM_BRIEF = """ABOUT MEDISENSE (answer questions about the platform from this, and nothing else):
- MediSense connects patients with doctors: find a doctor, book an appointment, \
keep records in one place, and pay for visits.
- MediSense is not a medical provider. Doctors here are independent practitioners \
responsible for their own clinical decisions.
- Booking: the patient chooses a doctor, then a day, then a free time. Doctors \
publish their own weekly hours, so a doctor with no hours set cannot be booked.
- Bills: raised automatically when a consultation is completed. The consultation \
fee is the doctor's; MediSense adds a platform fee and any tax, both shown on the \
invoice.
- Paying: bills are due in 3 days. After that a single late charge is added — \
once, never per day. Payment is by transfer to the account shown on the bill; the \
patient uploads the screenshot and a person at MediSense confirms it. Uploading a \
screenshot is not payment — the bill is settled once the money is checked.
- Records: visible to the patient and the clinicians treating them. Every access \
is written to an audit trail that cannot be edited or deleted.
- Emergencies: a clinician can open a record without prior consent in an \
emergency; it is time-limited and reviewed afterwards.
- In a real emergency the patient should go to the nearest emergency department, \
not use this platform."""


#: How to use the portal — what every screen is for, and where each action is.
#:
#: The assistant knew what the platform does and could not tell anyone where to
#: do it. Asked "where do I pay my bill" it explained the payment policy and
#: left the person exactly where they started.
#:
#: This is deliberately written as *instructions*, not as a site map. "Billing"
#: tells somebody nothing; "open the bill, press Pay now, and the account to
#: transfer to is on the next screen" is the answer they actually asked for.
#: Names are the words on screen, so a person can match what they read here
#: against what they are looking at.
#:
#: Only the patient portal. `AI_CHAT` is held by the patient role and no other,
#: so a doctor or an administrator never reaches this prompt, and describing
#: their screens here would only give the model somewhere to wander.
#:
#: Keep it in step with AppShell and the pages themselves: a confident wrong
#: direction wastes more of someone's time than "I am not sure" ever does.
NAVIGATION_BRIEF = """HOW TO USE THE PORTAL (these are the words on screen; the \
menu is on the left, and on a phone it opens from the button at the top left. \
Pages with several parts show a row of section names under the title — tap one \
to jump to it):

- Dashboard — the first page. Shortcuts, what is coming up, unpaid bills, \
current medicines, and the latest report explained in plain words.

- Appointments — "Book an appointment" starts it: choose a doctor (filter by \
city and speciality), then a day, then a free time, then confirm. A new \
booking sits under "Awaiting confirmation" until the clinic accepts it; \
accepted ones move to "Upcoming", where "Reschedule" and "Cancel" are. Both \
of those disappear once you have checked in at the clinic — after that the \
visit belongs to the clinic. Finished and cancelled visits are under "Past".

- Health assistant — this conversation. The microphone button records instead \
of typing. The attach button sends a photo of a report or a prescription to \
be read. Symptoms described here are shown back for correction before they \
are saved, and saving them is a separate press — nothing is recorded from \
the conversation on its own.

- Medical records — four parts: current medicines, consultation notes doctors \
have written, what you told this assistant (each line says whether a doctor \
has read it yet), and medicines no longer being taken.

- Documents — upload a lab report, a prescription photo or a scan, and see \
everything uploaded before. Links to open a document expire shortly after \
opening.

- Vitals — record a reading (blood pressure, sugar, weight, temperature, \
oxygen, pulse) and see the readings so far. "Alert thresholds" shows the \
limits that decide when a reading raises an alert.

- Billing — every invoice. Open one to see the breakdown and "Print". "Pay \
now" shows the hospital account to transfer to; make the transfer in your own \
banking app, then type the transaction ID exactly as it appears on your \
receipt and upload the screenshot. If the ID does not match the screenshot \
the submission is refused, so check it against the receipt. After submitting, \
the bill shows "Awaiting approval" until a person at the hospital confirms \
the money arrived.

- Settings — Profile (name, photo, phone, address), Security (password, \
two-factor sign-in, and where you are signed in), Notifications (what you are \
emailed about), Appearance (theme, text size, less motion, whether pages \
refresh themselves, and the language).

Also everywhere: the bell at the top right is notifications; the search box \
at the top (Ctrl+K) jumps to any page.

If somebody asks for something that is not in this list, say the portal does \
not have it rather than inventing a page or a button."""


def build_context(
    *,
    patient_name: str | None = None,
    patient_facts: list[str] | None = None,
    active_medications: list[str],
    upcoming_appointments: list[str],
    specialities: list[str],
    doctors: list[str] | None = None,
) -> str:
    """Everything the assistant is allowed to treat as true.

    Four kinds of fact, and the separation matters. **The patient's own record**
    is what lets it answer "what is my blood pressure tablet for" without
    guessing which tablet that is. **The doctors** are what let it answer "who
    can I see for my knee in Karachi" with real names instead of invented ones.
    **The specialities** are the kinds of doctor a patient can be sent to. **The platform
    brief** is what stops it inventing a policy when asked how billing works, and
    **the navigation brief** is what lets it answer "where do I pay this" with a
    place rather than a second explanation of the policy.

    Everything here is also the reference the safety checks use afterwards:
    anything named in an answer that is not on these lists was made up.
    """
    parts = ["FACTS AVAILABLE TO YOU (do not invent anything beyond these):"]

    if patient_name:
        parts.append(f"You are talking to: {patient_name}")
    for fact in patient_facts or []:
        parts.append(fact)

    parts.append(
        "Patient's current prescriptions: "
        + (", ".join(active_medications) if active_medications else "none on record")
    )
    parts.append(
        "Patient's upcoming appointments: "
        + (", ".join(upcoming_appointments) if upcoming_appointments else "none booked")
    )
    parts.append(
        "Specialities available on the platform: "
        + (", ".join(specialities) if specialities else "not listed")
    )

    if doctors:
        # One per line: a comma-joined run of "name — speciality, city, fee"
        # becomes unreadable at twenty doctors, and the model quotes fragments
        # of the wrong one.
        parts.append("Doctors available to book (name — speciality — where — fee):")
        parts.extend(f"  - {line}" for line in doctors)
    else:
        parts.append("Doctors available to book: none listed")

    parts.append("")
    parts.append(PLATFORM_BRIEF)
    parts.append(NAVIGATION_BRIEF)
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


#: The line the model appends when it wants to propose a booking.
#: Tolerant of spacing and case, because a model reproduces a format
#: approximately and a brittle regex turns "it booked nothing" into a silent,
#: unexplainable failure.
BOOK_LINE = re.compile(
    r"^\s*BOOK\s*:\s*doctor\s*=\s*(?P<doctor>[^;\n]+?)\s*;\s*date\s*=\s*(?P<date>\d{4}-\d{2}-\d{2})\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def extract_booking(answer: str) -> tuple[str, tuple[str, str] | None]:
    """Split a booking request out of an answer.

    Returns the answer with the machine line removed, and ``(doctor, date)`` if
    one was found. The line is always stripped whether or not it resolves: a
    patient should never be shown ``BOOK: doctor=...``, and a model that emits
    it into a sentence has still written a sentence worth reading.

    Only the *first* is honoured. A model that proposes two bookings has
    misunderstood, and acting on both would put two appointments in front of
    somebody who asked for one.
    """
    match = BOOK_LINE.search(answer)
    cleaned = BOOK_LINE.sub("", answer).strip()
    if match is None:
        return cleaned, None
    return cleaned, (match.group("doctor").strip(), match.group("date"))


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

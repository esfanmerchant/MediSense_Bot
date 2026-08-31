"""Deterministic clinical safety checks (spec §19).

**This layer does not ask the model anything.** That is the entire point.

An assistant built on a language model has a probabilistic component in the
middle of a safety path. Red-flag detection therefore runs *before* the provider
is called and *overrides* whatever comes back: if someone types "crushing chest
pain going down my left arm", this system escalates whether the model is
reachable, cooperative, correct, or having an unusually creative afternoon. The
model can add nuance on top; it cannot take an escalation away.

The spec puts it plainly: "Do not provide false reassurance." So where the model
and this module disagree, this module wins, and the disagreement is recorded.

**Over-triage is the safe direction.** A false emergency alert costs someone a
phone call. A missed one costs considerably more. The patterns below are
deliberately broad, and where a phrase is ambiguous it is treated as urgent.

None of this is a diagnosis. It is a decision about *how fast a human should be
involved*, which is a different and much safer question to answer automatically.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum


class Urgency(StrEnum):
    """How quickly a person should be involved. Never a diagnosis."""

    EMERGENCY = "EMERGENCY"
    URGENT = "URGENT"
    ROUTINE = "ROUTINE"
    INFORMATION = "INFORMATION"


@dataclass(frozen=True)
class RedFlag:
    """One pattern that forces escalation, and what to tell the person."""

    name: str
    pattern: re.Pattern[str]
    advice: str


#: Words allowed to appear *between* the words of a listed phrase.
#:
#: People do not type in the shape a keyword list expects. "throat closing" is
#: what a pattern author writes; "my throat is closing" is what someone having
#: an anaphylactic reaction actually types, and a literal match misses it. This
#: absorbs the grammar without loosening the match into nonsense: only copulas,
#: articles and possessives may intervene, so "chest pain" still cannot match
#: "chest x-ray showed no pain".
#: Ends with ``\s+`` because the separator between two words is always
#: required — the *filler* is what is optional, not the space.
_FILLER = (
    r"(?:\s+(?:is|are|was|were|feels?|felt|going|keeps?|my|the|a|an|has|have|had|been))*\s+"
)


def _flag(name: str, phrases: list[str], advice: str) -> RedFlag:
    """Build a matcher over several phrasings, tolerant of ordinary grammar.

    Word boundaries matter at the edges: matching "stroke" as a substring would
    fire on "stroked", and "fit" anywhere would fire on "fitness". Both would
    train people to ignore the warning, which is how a safety feature dies.
    """
    alternatives = "|".join(
        _FILLER.join(re.escape(word) for word in phrase.split()) for phrase in phrases
    )
    return RedFlag(
        name=name,
        pattern=re.compile(rf"(?<!\w)(?:{alternatives})(?!\w)", re.IGNORECASE),
        advice=advice,
    )


CALL_EMERGENCY = (
    "Call your local emergency number now, or go to the nearest emergency department."
)

#: Symptoms where minutes matter. Each entry is a condition where waiting for a
#: routine appointment can be fatal or disabling.
EMERGENCY_FLAGS: tuple[RedFlag, ...] = (
    _flag(
        "cardiac",
        [
            "chest pain", "chest pressure", "chest tightness", "chest tight",
            "crushing chest", "pain in my chest", "heart attack",
            "tightness in my chest",
            # The radiating quality is what distinguishes cardiac arm pain from
            # a pulled muscle, so the phrases require it rather than matching
            # arm pain on its own — which is common and usually benign.
            "pain radiating to my arm", "pain down my arm", "pain down my left arm",
            "pain in my left arm and chest",
        ],
        f"Chest symptoms can indicate a heart problem. {CALL_EMERGENCY}",
    ),
    _flag(
        "breathing",
        [
            "can't breathe", "cannot breathe", "cant breathe", "struggling to breathe",
            "difficulty breathing", "shortness of breath", "gasping", "choking",
            "turning blue", "stopped breathing",
        ],
        f"Difficulty breathing needs immediate assessment. {CALL_EMERGENCY}",
    ),
    _flag(
        "stroke",
        [
            "face drooping", "face is drooping", "slurred speech", "can't speak",
            "cannot speak", "sudden numbness", "weakness on one side",
            "one side of my body", "stroke", "sudden confusion",
            "worst headache of my life", "thunderclap headache",
        ],
        (
            "These can be signs of a stroke, where treatment is time-critical. "
            f"{CALL_EMERGENCY}"
        ),
    ),
    _flag(
        "bleeding",
        [
            "bleeding heavily", "heavy bleeding", "won't stop bleeding",
            "wont stop bleeding", "coughing up blood", "vomiting blood",
            "blood in my vomit", "severe bleeding",
        ],
        f"Heavy or unexplained bleeding needs urgent care. {CALL_EMERGENCY}",
    ),
    _flag(
        "consciousness",
        [
            "unconscious", "passed out", "fainted", "unresponsive", "seizure",
            "convulsing", "having a fit", "collapsed",
        ],
        f"Loss of consciousness or a seizure needs immediate assessment. {CALL_EMERGENCY}",
    ),
    _flag(
        "anaphylaxis",
        [
            "throat closing", "tongue swelling", "lips swelling", "anaphylaxis",
            "allergic reaction and swelling", "face swelling",
        ],
        f"This may be a severe allergic reaction. {CALL_EMERGENCY}",
    ),
    _flag(
        "self-harm",
        [
            "kill myself", "suicide", "suicidal", "end my life", "take my own life",
            "want to die", "hurt myself", "self harm",
        ],
        (
            "You deserve support from a person right now, not an app. Please contact "
            "your local emergency number or a crisis helpline immediately, and if you "
            "can, stay with someone you trust."
        ),
    ),
    _flag(
        "obstetric",
        [
            "bleeding and pregnant", "pregnant and bleeding", "baby not moving",
            "waters broke", "contractions",
        ],
        f"Pregnancy symptoms like these need urgent assessment. {CALL_EMERGENCY}",
    ),
    _flag(
        "abdominal",
        ["severe abdominal pain", "severe stomach pain", "rigid abdomen"],
        f"Severe abdominal pain can indicate a surgical emergency. {CALL_EMERGENCY}",
    ),
)

#: Not minutes, but not "book something next month" either.
URGENT_FLAGS: tuple[RedFlag, ...] = (
    _flag(
        "high fever",
        ["high fever", "fever of 40", "fever of 104", "burning up"],
        "A high fever should be assessed by a doctor today.",
    ),
    _flag(
        "dehydration",
        ["can't keep anything down", "cannot keep fluids down", "not urinating"],
        "Being unable to keep fluids down can lead to dehydration. See a doctor today.",
    ),
    _flag(
        "infection",
        ["spreading rash", "wound is infected", "red streaks"],
        "A spreading infection should be seen today.",
    ),
    _flag(
        "vision",
        ["sudden vision loss", "lost my vision", "double vision"],
        "Sudden vision changes should be assessed the same day.",
    ),
)


@dataclass(frozen=True)
class TriageResult:
    urgency: Urgency
    matched: tuple[str, ...]
    advice: tuple[str, ...]

    @property
    def is_emergency(self) -> bool:
        return self.urgency == Urgency.EMERGENCY

    @property
    def blocks_reassurance(self) -> bool:
        """Whether the model may be allowed to sound reassuring.

        Once anything urgent is on the table, a soothing answer is a hazard
        regardless of how well-phrased it is.
        """
        return self.urgency in (Urgency.EMERGENCY, Urgency.URGENT)


def assess(text: str) -> TriageResult:
    """Classify urgency from the patient's own words, without a model.

    Emergency patterns are checked first and short-circuit: if anything here
    matches, nothing downstream can lower the result.
    """
    if not text or not text.strip():
        return TriageResult(Urgency.INFORMATION, (), ())

    emergency = [flag for flag in EMERGENCY_FLAGS if flag.pattern.search(text)]
    if emergency:
        return TriageResult(
            Urgency.EMERGENCY,
            tuple(flag.name for flag in emergency),
            tuple(dict.fromkeys(flag.advice for flag in emergency)),
        )

    urgent = [flag for flag in URGENT_FLAGS if flag.pattern.search(text)]
    if urgent:
        return TriageResult(
            Urgency.URGENT,
            tuple(flag.name for flag in urgent),
            tuple(dict.fromkeys(flag.advice for flag in urgent)),
        )

    # Nothing matched, so this layer says nothing — it does not assert that the
    # message was clinical.
    #
    # This used to return ROUTINE, and because `combine` lets the model raise
    # urgency but never lower it, ROUTINE became a floor under *every* non-empty
    # sentence. "What is MediSense", "thanks", and "I do not want to book an
    # appointment" all came back as routine care, and the portal put a "see a
    # doctor" card under every single answer — which is how a recommendation
    # stops meaning anything, including on the answers where it matters.
    #
    # The safety property is untouched. It lives in the two branches above: a
    # message carrying an emergency or urgent signal still floors the model and
    # still cannot be reasoned down. What changes is only the case where this
    # module found no signal at all, and there the model — which has the
    # sentence, the history and the patient's record — is better placed to say
    # whether somebody should be seen.
    return TriageResult(Urgency.INFORMATION, (), ())


def combine(deterministic: TriageResult, model_urgency: str | None) -> Urgency:
    """Reconcile the model's view with this module's.

    The rule is one-directional: the model may *raise* urgency, never lower it.
    A model that decides chest pain sounds like indigestion must not be able to
    turn an escalation into reassurance — which is precisely the failure the
    spec's "do not provide false reassurance" is written against.
    """
    order = {
        Urgency.INFORMATION: 0,
        Urgency.ROUTINE: 1,
        Urgency.URGENT: 2,
        Urgency.EMERGENCY: 3,
    }
    try:
        proposed = Urgency(model_urgency) if model_urgency else deterministic.urgency
    except ValueError:
        proposed = deterministic.urgency

    return proposed if order[proposed] > order[deterministic.urgency] else deterministic.urgency

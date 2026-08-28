"""Turn OCR text into candidate prescription fields (spec §24).

Read the spec's own example before changing anything here:

    OCR detected:  Medicine: Amoxicillin  Dosage: 500mg  Frequency: 2/day
    Show:          Is this information correct?  [Edit] [Confirm]

That is the whole design. This module *proposes*; a clinician disposes. Nothing
it returns is written to a patient's medication list until a doctor has looked
at it, because the failure mode is not a garbled string that someone notices —
it is ``500 mg`` read as ``50 mg``, which is entirely plausible and wrong.

Three rules follow from that:

* **Every field carries a confidence, and low confidence is surfaced, not
  hidden.** A parse that "looks clean" is the dangerous one.
* **Ambiguity is reported, never resolved by guessing.** Where the text could
  mean two things, the field comes back needing review rather than picking one.
* **A missing field is missing.** It is never filled with a default, because a
  default dose is a prescription nobody wrote.

The parser is deliberately conservative: it recognises the common Indian
prescription shorthand (OD/BD/TID/QID/SOS/HS) and metric doses, and gives up
loudly on anything else.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

#: Dose frequency shorthand, mapped to what it means in plain words. Latin
#: abbreviations are what prescriptions actually carry, and expanding them is
#: itself a safety feature: "BD" and "BID" both mean twice a day, and a patient
#: reading their own record should not have to know that.
FREQUENCY_TERMS: dict[str, str] = {
    "od": "Once daily",
    "qd": "Once daily",
    "bd": "Twice daily",
    "bid": "Twice daily",
    "tid": "Three times daily",
    "tds": "Three times daily",
    "qid": "Four times daily",
    "qds": "Four times daily",
    "hs": "At bedtime",
    "sos": "As needed",
    "prn": "As needed",
    "stat": "Immediately, once",
}

#: Units a dose may be expressed in. Anything else is not recognised as a dose.
#:
#: Order is significant: the alternation is tried left to right, so a unit that
#: is a prefix of another must come *after* it or the longer one can never
#: match — "units" would be read as "unit" with a stray "s".
DOSE_UNITS = ("mcg", "mg", "ml", "iu", "units", "unit", "g", "%")

#: The trailing guard is a negative lookahead rather than ``\b`` because ``\b``
#: cannot match after "%": both "%" and end-of-string are non-word characters,
#: so there is no boundary between them and a percentage dose would never be
#: recognised. The lookahead means the same thing for letters and still works
#: for symbols.
_DOSE = re.compile(
    r"\b(\d+(?:\.\d+)?)\s*(" + "|".join(DOSE_UNITS) + r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_DURATION = re.compile(
    r"\b(?:x|for)\s*(\d+)\s*(day|days|week|weeks|month|months)\b", re.IGNORECASE
)
_FREQUENCY_WORDS = re.compile(
    r"\b(once|twice|thrice|three\s+times|four\s+times)\s+(?:a\s+|per\s+)?(day|daily)\b",
    re.IGNORECASE,
)
_NUMBERED_ITEM = re.compile(r"^\s*(\d+)[.)]\s*")
#: A drug name: letters, possibly hyphenated or multi-word, at the start of the
#: line before any dose. Deliberately not matched against a formulary — this
#: system has no drug database, and pretending otherwise would imply a safety
#: check it does not perform.
_NAME = re.compile(r"^([A-Za-z][A-Za-z\-']{2,}(?:\s+[A-Za-z][A-Za-z\-']{2,})?)")

#: Lines that are never medication, however they parse.
_NOISE = re.compile(
    r"\b(hospital|clinic|patient|age|date|mrn|dept|department|doctor|dr\.?|"
    r"review|signature|address|phone|rx)\b",
    re.IGNORECASE,
)


@dataclass
class ParsedField:
    """One extracted value and how much to trust it."""

    value: str | None
    confidence: float
    needs_review: bool

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ParsedMedication:
    medication: ParsedField
    dosage: ParsedField
    frequency: ParsedField
    duration: ParsedField
    #: The line this came from, so a reviewer can see what was actually read.
    source_text: str = ""
    line_confidence: float = 0.0

    @property
    def needs_review(self) -> bool:
        return any(
            f.needs_review
            for f in (self.medication, self.dosage, self.frequency, self.duration)
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "medication": self.medication.as_dict(),
            "dosage": self.dosage.as_dict(),
            "frequency": self.frequency.as_dict(),
            "duration": self.duration.as_dict(),
            "sourceText": self.source_text,
            "lineConfidence": round(self.line_confidence, 4),
            "needsReview": self.needs_review,
        }


@dataclass
class ParsedPrescription:
    medications: list[ParsedMedication] = field(default_factory=list)
    #: True when *anything* needs a human eye — which is the normal case.
    needs_review: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {
            "medications": [m.as_dict() for m in self.medications],
            "needsReview": self.needs_review,
            # Restated in the payload so a client cannot render this as settled
            # fact without having seen the warning.
            "disclaimer": (
                "Extracted automatically and not yet verified. Check every field "
                "against the original document before use."
            ),
        }


def expand_frequency(text: str | None) -> str | None:
    """Turn prescription shorthand into words, or return it unchanged.

    Shared by both extraction engines so a patient sees "Three times daily"
    whichever one read their prescription. Expanding is itself a safety feature:
    someone reading their own record should not have to know that TID and TDS
    mean the same thing, and "OD" is read by non-clinicians as "overdose" often
    enough to matter.

    Anything unrecognised is passed through untouched rather than guessed at.
    """
    if not text:
        return text
    key = text.strip().lower().rstrip(".")
    return FREQUENCY_TERMS.get(key, text.strip())


def _missing() -> ParsedField:
    """A field that was not found. Never a default value — a default dose is a
    prescription nobody wrote."""
    return ParsedField(value=None, confidence=0.0, needs_review=True)


def _found(value: str, line_confidence: float, penalty: float = 0.0) -> ParsedField:
    """A field that was found.

    Its confidence is the OCR line's confidence reduced by how much guessing the
    parse required — recognising "500 mg" is near-certain given the text, while
    picking a drug name out of free text is not.
    """
    confidence = max(0.0, line_confidence - penalty)
    return ParsedField(
        value=value,
        confidence=round(confidence, 4),
        needs_review=confidence < 0.90,
    )


def _normalize_frequency(text: str) -> tuple[str, float] | None:
    """Resolve a frequency, or None. Ambiguity is reported, not guessed."""
    lowered = text.lower()

    worded = _FREQUENCY_WORDS.search(lowered)
    if worded:
        counts = {
            "once": "Once daily",
            "twice": "Twice daily",
            "thrice": "Three times daily",
            "three times": "Three times daily",
            "four times": "Four times daily",
        }
        key = re.sub(r"\s+", " ", worded.group(1).strip())
        if key in counts:
            return counts[key], 0.0

    # Abbreviations are matched on word boundaries so "od" inside "codeine"
    # cannot be read as a frequency.
    matches = {
        term for term in FREQUENCY_TERMS if re.search(rf"\b{term}\b", lowered)
    }
    if len(matches) == 1:
        term = matches.pop()
        return FREQUENCY_TERMS[term], 0.05
    if len(matches) > 1:
        # Two different frequencies on one line: report the ambiguity rather
        # than pick one.
        return None
    return None


def _clean_name(candidate: str) -> str | None:
    name = candidate.strip(" .,-")
    if len(name) < 3:
        return None
    if _NOISE.search(name):
        return None
    return name.title()


def parse_line(text: str, line_confidence: float) -> ParsedMedication | None:
    """Parse one line into a medication candidate, or None if it is not one."""
    stripped = _NUMBERED_ITEM.sub("", text).strip()
    if not stripped or _NOISE.search(stripped):
        return None

    dose_match = _DOSE.search(stripped)
    if dose_match is None:
        # Without a dose it is prose, a heading, or a name we cannot verify.
        # Treating it as medication would invent a prescription.
        return None

    name_match = _NAME.match(stripped)
    name = _clean_name(name_match.group(1)) if name_match else None

    dosage = _found(
        f"{dose_match.group(1)} {dose_match.group(2).lower()}", line_confidence, penalty=0.0
    )

    frequency_result = _normalize_frequency(stripped)
    frequency = (
        _found(frequency_result[0], line_confidence, penalty=frequency_result[1])
        if frequency_result
        else _missing()
    )

    duration_match = _DURATION.search(stripped)
    duration = (
        _found(
            f"{duration_match.group(1)} {duration_match.group(2).lower()}",
            line_confidence,
            penalty=0.0,
        )
        if duration_match
        else _missing()
    )

    return ParsedMedication(
        # Picking a name out of free text is the least certain step here, so it
        # carries the largest penalty.
        medication=_found(name, line_confidence, penalty=0.15) if name else _missing(),
        dosage=dosage,
        frequency=frequency,
        duration=duration,
        source_text=stripped,
        line_confidence=line_confidence,
    )


def parse(lines: list[tuple[str, float]]) -> ParsedPrescription:
    """Extract medication candidates from OCR lines.

    ``needs_review`` starts true and is only cleared when every field of every
    candidate came back confident — which, on a real photograph of a
    handwritten-annotated prescription, essentially never happens. That default
    is the point (§24).
    """
    medications = [
        parsed
        for text, confidence in lines
        if (parsed := parse_line(text, confidence)) is not None
    ]

    return ParsedPrescription(
        medications=medications,
        needs_review=not medications or any(m.needs_review for m in medications),
    )

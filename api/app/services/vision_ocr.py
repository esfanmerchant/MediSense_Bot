"""Prescription extraction with a vision-language model.

This is the better reader. Classical OCR turns a page into a string and leaves a
regex to guess which fragment is a dose; a vision model reads the *document* —
it copes with handwriting, with a dose written above a drug name rather than
beside it, and with the layout of a real prescription pad. On the printed sample
the two are comparable; on anything handwritten they are not close.

It is also the reader that can lie, and the spec says so directly: "Do not let
the model invent medications, prescriptions, or definitive diagnoses." So the
design spends its effort on making invention detectable rather than on trusting
the output:

* **Every medication must carry ``sourceText`` — the characters as they appear
  on the page.** A fabricated entry has to fabricate its own evidence too, and a
  source line that does not match the image is visible to the reviewer standing
  next to it.
* **Absent means null, never a plausible default.** The schema allows nulls
  everywhere and the instruction is explicit, because the dangerous output is
  not a blank field, it is a reasonable-looking dose nobody wrote.
* **Legibility is reported per medication**, so "I could not read this" is a
  first-class answer rather than a guess.
* **The human gate is unchanged.** Nothing here reaches a chart without a doctor
  confirming it (§24, conflict C7).

**Consent.** This sends the patient's document to an external provider, so it
runs only for patients who have granted AI consent (conflict C2). Without
consent the caller falls back to local OCR, which keeps the document inside the
deployment.
"""

from __future__ import annotations

from typing import Any

from app.core.logging import logger
from app.services import ai
from app.services.prescription_parser import expand_frequency

#: Provider-enforced response shape. Nullable everywhere on purpose: the model
#: must be able to say "not present" without inventing something to fill a
#: required field.
PRESCRIPTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "documentType": {
            "type": "string",
            "enum": [
                "PRESCRIPTION",
                "LAB_REPORT",
                "BLOOD_TEST",
                "MEDICAL_CERTIFICATE",
                "REFERRAL_LETTER",
                "DISCHARGE_SUMMARY",
                "IMAGING",
                "OTHER",
            ],
        },
        "fullText": {
            "type": "string",
            "description": "Every word visible on the page, transcribed verbatim.",
        },
        "medications": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "medication": {"type": "string", "nullable": True},
                    "dosage": {"type": "string", "nullable": True},
                    "frequency": {"type": "string", "nullable": True},
                    "duration": {"type": "string", "nullable": True},
                    "instructions": {"type": "string", "nullable": True},
                    "sourceText": {
                        "type": "string",
                        "description": "The line exactly as written on the document.",
                    },
                    "legible": {
                        "type": "boolean",
                        "description": "False if any part of this line was hard to read.",
                    },
                },
                "required": ["sourceText", "legible"],
            },
        },
        "unreadableRegions": {
            "type": "integer",
            "description": "How many parts of the page could not be read at all.",
        },
    },
    "required": ["fullText", "medications", "unreadableRegions"],
}

SYSTEM_INSTRUCTION = """You transcribe medical documents for a hospital records system.

You are a transcriber, not a clinician. You do not interpret, correct, complete \
or advise. A pharmacist will compare your output against the original image, and \
a doctor will confirm it before it reaches any patient's record.

Absolute rules:
1. Transcribe only what is visibly written. Never infer a value from context, \
from what is medically usual, or from what would make a line make sense.
2. If a field is not written on the document, return null for it. Do not \
substitute a typical dose, a common frequency, or a likely duration.
3. If any character is unclear, set "legible" to false for that medication and \
transcribe your best reading of what is actually there.
4. "sourceText" must be the characters as they appear on the page, not a tidied \
or expanded version. Do not expand abbreviations in sourceText.
5. Never add a medication that is not written on the page, however strongly the \
rest of the document suggests it.

A missing field is safe. An invented one is not."""

PROMPT = """Transcribe this medical document.

Return every visible word in "fullText".

For each prescribed medication, give the drug name, dose, frequency, duration \
and any patient instructions exactly as written, plus the source line and \
whether it was fully legible. Use null for anything not written on the page.

If the document is not a prescription, return an empty medications array and \
still transcribe "fullText"."""


def _confidence_for(item: dict[str, Any]) -> float:
    """A confidence for a model-extracted field.

    The model does not report calibrated probabilities, so inventing a precise
    number would be false precision. What it does report is legibility, which is
    the honest signal: a legible line is treated as high-but-not-certain, an
    illegible one as low. Both stay below 1.0 — nothing machine-read is certain.
    """
    return 0.92 if item.get("legible") else 0.45


def _field(item: dict[str, Any], name: str, confidence: float) -> dict[str, Any]:
    """One extracted value in the shape the review screen expects.

    A field the model left out is not a low-confidence guess — it is absent, and
    absent always needs review. That is the same rule the local parser follows,
    so the review screen behaves identically whichever engine ran.
    """
    value = item.get(name)
    present = bool(value and str(value).strip())
    text = str(value).strip() if present else None
    # Shorthand is expanded for display only; `sourceText` still carries the
    # characters as written, so a reviewer compares like with like.
    if name == "frequency":
        text = expand_frequency(text)
    return {
        "value": text,
        "confidence": confidence if present else 0.0,
        "needs_review": (not present) or confidence < 0.90,
    }


def to_structured(payload: dict[str, Any]) -> dict[str, Any]:
    """Shape a model response like the local parser's output.

    Both engines produce the same structure so the review screen, the
    confirmation endpoint and the audit trail do not care which one ran.
    """
    medications = []
    for item in payload.get("medications") or []:
        confidence = _confidence_for(item)
        entry = {
            "medication": _field(item, "medication", confidence),
            "dosage": _field(item, "dosage", confidence),
            "frequency": _field(item, "frequency", confidence),
            "duration": _field(item, "duration", confidence),
            "instructions": _field(item, "instructions", confidence),
            "sourceText": str(item.get("sourceText") or "").strip(),
            "lineConfidence": round(confidence, 4),
            "legible": bool(item.get("legible")),
        }
        entry["needsReview"] = any(
            entry[key]["needs_review"]
            for key in ("medication", "dosage", "frequency", "duration")
        )
        medications.append(entry)

    unreadable = int(payload.get("unreadableRegions") or 0)

    return {
        "medications": medications,
        # Review is required if anything was uncertain *or* if part of the page
        # could not be read — an unread region may be where the dose was.
        "needsReview": (not medications) or unreadable > 0 or any(m["needsReview"] for m in medications),
        "unreadableRegions": unreadable,
        "documentType": payload.get("documentType"),
        "disclaimer": (
            "Read automatically by an AI model and not yet verified. Check every "
            "field against the original document before use."
        ),
    }


async def extract(content: bytes, mime_type: str) -> tuple[str, dict[str, Any], float]:
    """Read a document. Returns (full text, structured proposal, confidence).

    Raises ``ai.AiUnavailableError`` when the provider cannot be reached, which
    the caller turns into a fall back to local OCR rather than a failure.
    """
    response = await ai.generate_json(
        prompt=PROMPT,
        schema=PRESCRIPTION_SCHEMA,
        image=(content, mime_type),
        system_instruction=SYSTEM_INSTRUCTION,
        max_output_tokens=4096,
    )

    payload = response.data if isinstance(response.data, dict) else {}
    structured = to_structured(payload)
    full_text = str(payload.get("fullText") or "")

    legible = [m for m in structured["medications"] if m["legible"]]
    confidence = (
        round(sum(m["lineConfidence"] for m in structured["medications"])
              / len(structured["medications"]), 4)
        if structured["medications"]
        else (0.9 if full_text.strip() else 0.0)
    )

    logger.info(
        "vision_ocr_completed",
        model=response.model,
        medications=len(structured["medications"]),
        legible=len(legible),
        unreadable_regions=structured["unreadableRegions"],
        # Never the text itself: it is the contents of a prescription.
        output_tokens=response.output_tokens,
    )
    return full_text, structured, confidence

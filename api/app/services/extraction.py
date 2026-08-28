"""Choosing how to read a document.

Two engines, and the choice between them is a *privacy* decision before it is a
quality one.

**Vision model (preferred).** Reads handwriting, understands layout, extracts
structure directly. It also means sending the patient's prescription to Google.
That is exactly what AI consent covers (conflict C2), so it runs only for
patients who have granted it.

**Local OCR (PaddleOCR).** Weaker on handwriting and needs a regex pass to find
structure, but the document never leaves the deployment. This is the fallback
whenever consent is absent, the provider is unreachable, or AI is switched off —
so withdrawing consent degrades the feature rather than removing it.

The engine actually used is recorded on the document. A clinician re-checking a
dose months later should be able to see whether a model or a local engine read
it, because the failure modes differ: PaddleOCR garbles characters, a vision
model produces fluent text that may not be on the page.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.core.config import settings
from app.core.logging import logger
from app.db.enums import OcrEngine
from app.services import ai, ocr, vision_ocr
from app.services.prescription_parser import parse


@dataclass(frozen=True)
class Extraction:
    engine: OcrEngine
    text: str
    structured: dict[str, Any]
    confidence: float
    #: Why this engine was chosen, recorded so the decision is auditable.
    reason: str


def plan(*, patient_has_ai_consent: bool, mime_type: str) -> tuple[bool, str]:
    """Decide whether the vision model may read this document.

    Returns (use_vision, reason). The reason is recorded either way — "why did
    the weaker engine run" is a question worth being able to answer.
    """
    if not settings.AI_VISION_OCR_ENABLED:
        return False, "vision extraction disabled on this server"
    if not ai.is_available():
        return False, "AI provider not configured"
    if not patient_has_ai_consent:
        # The document would leave the deployment; consent is what permits that.
        return False, "patient has not granted AI consent"
    if mime_type not in vision_readable():
        return False, f"vision model does not accept {mime_type}"
    return True, "patient consented and provider available"


def vision_readable() -> frozenset[str]:
    """Types the vision model accepts inline. PDFs are rasterised first."""
    return frozenset({"image/jpeg", "image/png", "image/webp", "application/pdf"})


async def extract(
    content: bytes, mime_type: str, *, patient_has_ai_consent: bool
) -> Extraction:
    """Read a document with the best engine this patient has permitted."""
    use_vision, reason = plan(
        patient_has_ai_consent=patient_has_ai_consent, mime_type=mime_type
    )

    if use_vision:
        try:
            text, structured, confidence = await vision_ocr.extract(content, mime_type)
            return Extraction(
                engine=OcrEngine.GEMINI_VISION,
                text=text,
                structured=structured,
                confidence=confidence,
                reason=reason,
            )
        except Exception as exc:
            # A provider outage must not leave the clinician with nothing when a
            # local engine is sitting right there.
            logger.warning("vision_ocr_failed_falling_back", error=type(exc).__name__)
            reason = f"vision extraction failed ({type(exc).__name__}); used local OCR"

    result = await ocr.extract(content, mime_type)
    structured = parse([(line.text, line.confidence) for line in result.lines]).as_dict()
    return Extraction(
        engine=OcrEngine.PADDLE_OCR,
        text=result.text,
        structured=structured,
        confidence=result.mean_confidence,
        reason=reason,
    )


def availability() -> dict[str, Any]:
    """What can currently read a document, for the readiness endpoint."""
    vision_ready, vision_reason = ai.availability()
    local_ready, local_reason = ocr.availability()
    return {
        "vision": {"available": vision_ready and settings.AI_VISION_OCR_ENABLED,
                   "reason": vision_reason or None},
        "local": {"available": local_ready, "reason": local_reason or None},
        "any": (vision_ready and settings.AI_VISION_OCR_ENABLED) or local_ready,
    }

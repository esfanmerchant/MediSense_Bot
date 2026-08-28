"""Text extraction from uploaded documents (spec §23-24).

**OCR output is never authoritative.** Everything this module produces is a
*proposal* that a clinician confirms or corrects before it can influence care.
That is not a policy bolted on top — it is why ``MedicalDocument`` has a
``structuredData`` column separate from the ``prescriptions`` table, and why
confirming is a distinct action with its own audit entry (conflict C7).

The stakes are concrete: the spec's own example is a misread dose. An engine
that turns "500 mg" into "5OO mg", or drops a decimal point, produces something
that looks entirely plausible. So every field carries a confidence, anything
below the review threshold is flagged, and *nothing* is written to the record
without a human saying so.

**PaddleOCR is an optional dependency.** The API must start and serve every
other route when it is absent — a missing OCR engine disables one feature, it
does not take the hospital's portal offline. Hence the lazy import, the
``availability()`` probe, and the honest 503 rather than a crash.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

import anyio

from app.core.config import settings
from app.core.errors import AppError, ErrorCode
from app.core.logging import logger

#: Types the engine can read. A HEIC photo is stored happily but not machine
#: read — Pillow needs a plugin for it, and a wrong answer is worse than none.
READABLE_MIME_TYPES = frozenset(
    {"application/pdf", "image/jpeg", "image/png", "image/webp", "image/tiff"}
)

#: Only the first pages are read. A discharge summary can run to dozens of
#: pages; the clinically dense part is at the front, and reading all of them
#: would tie up the CPU for minutes per upload.
MAX_PDF_PAGES = 3

#: Rasterisation scale for PDF pages. 2.0 gives roughly 144 dpi, which is where
#: recognition of printed prescriptions stops improving in the smoke harness.
PDF_RENDER_SCALE = 2.0


class OcrUnavailableError(AppError):
    def __init__(self, message: str) -> None:
        super().__init__(503, ErrorCode.SERVICE_UNAVAILABLE, message)


@dataclass(frozen=True)
class OcrLine:
    text: str
    confidence: float


@dataclass
class OcrResult:
    text: str
    lines: list[OcrLine] = field(default_factory=list)
    mean_confidence: float = 0.0
    pages: int = 0
    duration_seconds: float = 0.0

    @property
    def is_empty(self) -> bool:
        return not self.text.strip()


# ---------------------------------------------------------------------------
# Engine lifecycle
# ---------------------------------------------------------------------------

_engine: Any = None
#: PaddleOCR is not documented as thread-safe and the model is expensive to
#: load, so one instance is shared and calls into it are serialised. Inference
#: is CPU-bound anyway; running several at once would only thrash.
_engine_lock = threading.Lock()


def availability() -> tuple[bool, str]:
    """Whether OCR can run, and why not when it cannot.

    Returns a reason rather than a bare bool so the API can tell an
    administrator what to install instead of failing opaquely.
    """
    if not settings.OCR_ENABLED:
        return False, "OCR is disabled on this server (OCR_ENABLED=false)."
    try:
        import paddleocr  # noqa: F401
    except ImportError:
        return False, 'OCR support is not installed. Run: pip install -e "api[ocr]"'
    return True, ""


def is_available() -> bool:
    return availability()[0]


def _require_available() -> None:
    ready, reason = availability()
    if not ready:
        raise OcrUnavailableError(reason)


def _load_engine() -> Any:
    """Build the PaddleOCR instance once.

    Every option here was settled by the feasibility harness in ``ocr/``:

    * PP-OCRv5 *mobile* — 4.2s/page on CPU against 11.3s for v6_medium and
      13.9s for v5_server, at higher mean confidence on printed documents. The
      bigger models are both slower and worse here.
    * oneDNN off — PaddlePaddle 3.3.1 on Windows CPU raises
      "ConvertPirAttribute2RuntimeAttribute not support" from the oneDNN
      executor. The plain kernels work.
    * Orientation and dewarping off — a model load each, and they buy nothing
      on flat scans.
    """
    global _engine
    if _engine is not None:
        return _engine

    from paddleocr import PaddleOCR

    started = time.perf_counter()
    _engine = PaddleOCR(
        text_detection_model_name=settings.OCR_DET_MODEL,
        text_recognition_model_name=settings.OCR_REC_MODEL,
        use_textline_orientation=False,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        lang="en",
        enable_mkldnn=settings.OCR_ENABLE_MKLDNN,
    )
    logger.info("ocr_engine_loaded", seconds=round(time.perf_counter() - started, 1))
    return _engine


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _pdf_to_images(content: bytes) -> list[bytes]:
    """Rasterise the first pages of a PDF to PNG bytes.

    pypdfium2 ships its own PDFium build, so this needs no system Poppler and
    works the same on Windows as in a container.
    """
    try:
        import pypdfium2
    except ImportError as exc:
        raise OcrUnavailableError(
            'Reading PDFs needs the OCR extra. Run: pip install -e "api[ocr]"'
        ) from exc

    import io

    images: list[bytes] = []
    document = pypdfium2.PdfDocument(content)
    try:
        for index in range(min(len(document), MAX_PDF_PAGES)):
            page = document[index]
            pil_image = page.render(scale=PDF_RENDER_SCALE).to_pil()
            buffer = io.BytesIO()
            pil_image.save(buffer, format="PNG")
            images.append(buffer.getvalue())
    finally:
        document.close()
    return images


def _run_sync(images: list[bytes]) -> OcrResult:
    """Blocking inference. Always called through a worker thread."""
    import io

    import numpy as np
    from PIL import Image

    engine = _load_engine()
    lines: list[OcrLine] = []
    started = time.perf_counter()

    with _engine_lock:
        for raw in images:
            # PaddleOCR takes a path or an array; an array avoids writing the
            # patient's document to a temp file on disk.
            image = Image.open(io.BytesIO(raw)).convert("RGB")
            pages = engine.predict(np.asarray(image))
            for page in pages:
                texts = page.get("rec_texts", [])
                scores = page.get("rec_scores", [])
                lines.extend(
                    OcrLine(text=text, confidence=float(score))
                    for text, score in zip(texts, scores, strict=False)
                )

    mean = sum(line.confidence for line in lines) / len(lines) if lines else 0.0
    return OcrResult(
        text="\n".join(line.text for line in lines),
        lines=lines,
        mean_confidence=round(mean, 4),
        pages=len(images),
        duration_seconds=round(time.perf_counter() - started, 2),
    )


async def extract(content: bytes, mime_type: str) -> OcrResult:
    """Read a document.

    Runs in a worker thread: inference takes seconds per page, and doing it on
    the event loop would stall every other request in the process — including
    the session checks that other clinicians are waiting on.
    """
    _require_available()

    if mime_type not in READABLE_MIME_TYPES:
        raise AppError(
            400,
            ErrorCode.UNSUPPORTED_FILE,
            "This file type cannot be read automatically. You can still view it.",
        )

    images = _pdf_to_images(content) if mime_type == "application/pdf" else [content]
    if not images:
        raise AppError(400, ErrorCode.UNSUPPORTED_FILE, "The document has no readable pages.")

    return await anyio.to_thread.run_sync(_run_sync, images)


def needs_review(confidence: float | None) -> bool:
    """Whether a field must be shown for confirmation regardless of type.

    Note the direction of the default: a missing confidence counts as needing
    review. An unknown is not a pass.
    """
    if confidence is None:
        return True
    return confidence < settings.OCR_CONFIDENCE_REVIEW_THRESHOLD

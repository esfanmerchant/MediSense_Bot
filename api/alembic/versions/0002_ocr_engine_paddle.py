"""Add PADDLE_OCR to the OcrEngine enum.

The enum was written when the plan was Tesseract with a Gemini Vision fallback.
The stack moved to PaddleOCR, and recording an extraction as ``TESSERACT``
because that value happens to exist would put a false claim in the record about
what read a prescription — exactly the sort of thing a clinician would rely on
when deciding whether to re-check a dose.

``TESSERACT`` is left in place: it costs nothing, and Postgres cannot remove a
value from an enum without rewriting the type.

Revision ID: 0002_ocr_engine_paddle
Revises: 0001_baseline
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0002_ocr_engine_paddle"
down_revision: str | None = "0001_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # IF NOT EXISTS makes this a no-op on a database that already has it, so the
    # migration is safe to re-run and safe against a hand-patched environment.
    op.execute("ALTER TYPE \"OcrEngine\" ADD VALUE IF NOT EXISTS 'PADDLE_OCR'")


def downgrade() -> None:
    """Deliberately a no-op.

    Postgres cannot drop a value from an enum type in place; undoing this would
    mean recreating the type and rewriting every column that uses it, which
    risks far more than leaving one unused label behind.
    """

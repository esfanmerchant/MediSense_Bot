"""OCR extraction and the review step that gates it (spec §23-24).

The flow is three explicit steps, and the separation between them is the safety
property:

1. ``POST /documents/{id}/ocr`` reads the file. What comes back is a
   *proposal* — stored on the document, not in anyone's medication list.
2. ``GET /documents/{id}/ocr`` shows it for review, every field carrying a
   confidence and a review flag.
3. ``POST /documents/{id}/ocr/confirm`` records a clinician's corrected version.

Even after step 3 nothing is prescribed. A confirmed extraction prefills the
prescribe form; a doctor still writes the prescription. That is conflict C7 held
end to end: machine output never acquires a clinical author by itself, and the
only way a drug reaches a patient's chart is a person choosing to put it there.

Confirmation is restricted to doctors. A patient may read the extraction of
their own document — it is their document — but confirming a *dose* is clinical
judgement, and the spec singles out prescriptions precisely because an OCR error
there changes medication.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.api.deps import CurrentAuth, DbSession, client_ip
from app.api.responses import ok
from app.core.config import settings
from app.core.errors import bad_request, conflict, forbidden, not_found
from app.db.base import utcnow
from app.db.enums import AuditAction, OcrStatus, Role
from app.db.models import MedicalDocument, Patient
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.records.access import require_clinical_access
from app.services import extraction, ocr, storage

router = APIRouter(prefix="/documents", tags=["ocr"])


class ConfirmedField(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    medication: Annotated[str, Field(min_length=1, max_length=200)]
    dosage: Annotated[str, Field(min_length=1, max_length=100)]
    frequency: Annotated[str, Field(min_length=1, max_length=100)]
    duration: Annotated[str, Field(max_length=100)] | None = None
    instructions: Annotated[str, Field(max_length=2000)] | None = None


class ConfirmRequest(BaseModel):
    """A clinician's corrected reading.

    Every field is required rather than patched over the extraction, so
    confirming is an act of stating what the document says — not of accepting
    whatever the machine proposed by leaving fields untouched.
    """

    model_config = ConfigDict(populate_by_name=True)

    medications: Annotated[list[ConfirmedField], Field(min_length=1, max_length=25)]


async def _load(db: DbSession, document_id: str) -> MedicalDocument:
    document = (
        await db.execute(
            select(MedicalDocument).where(
                MedicalDocument.id == document_id, MedicalDocument.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()
    if document is None:
        raise not_found("Document")
    return document


async def _audit(
    request: Request,
    db: DbSession,
    auth: CurrentAuth,
    action: AuditAction,
    document: MedicalDocument,
    metadata: dict[str, Any] | None = None,
) -> None:
    await record_audit(
        db,
        AuditEntry(
            action=action,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=document.patient_id,
            entity_type="MedicalDocument",
            entity_id=document.id,
            ip_address=client_ip(request),
            user_agent=request.headers.get("user-agent"),
            request_id=getattr(request.state, "request_id", None),
            emergency_access_id=auth.emergency_access_id,
            # Never the extracted text: it is the contents of a prescription,
            # and `record_audit` would strip it anyway.
            metadata=metadata,
        ),
    )


def _serialize_state(document: MedicalDocument) -> dict[str, Any]:
    return {
        "documentId": document.id,
        "status": str(document.ocr_status),
        "engine": str(document.ocr_engine) if document.ocr_engine else None,
        "confidence": document.ocr_confidence,
        "extractedText": document.extracted_text,
        "structured": document.structured_data,
        "confirmedAt": document.confirmed_at.isoformat() + "Z" if document.confirmed_at else None,
        "confirmedById": document.confirmed_by_id,
        "error": document.ocr_error,
        "reviewThreshold": settings.OCR_CONFIDENCE_REVIEW_THRESHOLD,
    }


@router.get("/{document_id}/ocr")
async def get_extraction(
    document_id: str, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """The current extraction for review."""
    document = await _load(db, document_id)
    await require_clinical_access(db, auth, request, document.patient_id, what="MedicalDocument")
    return ok(_serialize_state(document))


@router.post("/{document_id}/ocr")
async def run_extraction(
    document_id: str, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Read the document and store the proposal.

    Runs synchronously — a few seconds per page — rather than in a background
    queue, because the person who just uploaded a prescription is waiting to
    check it, and a queue would need infrastructure this deployment does not
    have. The inference itself is moved off the event loop.
    """
    document = await _load(db, document_id)
    await require_clinical_access(db, auth, request, document.patient_id, what="MedicalDocument")

    if document.ocr_status == OcrStatus.CONFIRMED:
        raise conflict("This extraction has already been confirmed by a clinician.")

    available = extraction.availability()
    if not available["any"]:
        raise ocr.OcrUnavailableError(
            available["local"]["reason"] or "No document reader is configured on this server."
        )

    # A type no engine can read is SKIPPED, not FAILED. "Failed" says something
    # went wrong and invites a retry; this document was never a candidate, and
    # the distinction is what the reviewer sees.
    if document.mime_type not in ocr.READABLE_MIME_TYPES:
        document.ocr_status = OcrStatus.SKIPPED
        await db.flush()
        return ok(_serialize_state(document))

    # Consent decides the engine: the vision model sends this document to an
    # external provider, and that is what the patient did or did not agree to.
    consent = (
        await db.execute(select(Patient).where(Patient.id == document.patient_id))
    ).scalar_one_or_none()
    has_consent = bool(consent and consent.ai_consent_active)

    document.ocr_status = OcrStatus.PROCESSING
    await db.flush()

    content = await storage.download(document.storage_bucket, document.storage_path)

    try:
        result = await extraction.extract(
            content, document.mime_type, patient_has_ai_consent=has_consent
        )
    except Exception as exc:
        document.ocr_status = OcrStatus.FAILED
        # A short reason, not a traceback: this string is shown to whoever
        # uploaded the file.
        document.ocr_error = str(exc)[:300]
        await db.flush()
        # The failure is part of the document's history, so it must survive the
        # error that produced it — `get_db` rolls back on exception.
        await db.commit()
        raise

    document.ocr_status = OcrStatus.EXTRACTED
    document.ocr_engine = result.engine
    document.ocr_confidence = result.confidence
    document.extracted_text = result.text
    document.structured_data = result.structured
    document.ocr_error = None
    await db.flush()

    await _audit(
        request,
        db,
        auth,
        AuditAction.OCR_PROCESSED,
        document,
        {
            "engine": str(result.engine),
            # Why this engine and not the other — including "the patient has not
            # granted AI consent", which is a decision worth being able to show.
            "engineReason": result.reason,
            "aiConsent": has_consent,
            "confidence": result.confidence,
            "medications": len(result.structured.get("medications", [])),
            "needsReview": result.structured.get("needsReview", True),
        },
    )

    return ok(_serialize_state(document))


@router.post("/{document_id}/ocr/confirm")
async def confirm_extraction(
    document_id: str,
    payload: ConfirmRequest,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
) -> dict[str, Any]:
    """Record a clinician's verified reading of the document.

    Confirming does **not** prescribe anything. It marks what the document
    actually says, so a doctor can then write a prescription from a checked
    source rather than retyping from a photograph. Creating the prescription
    stays an explicit, separately audited act (§24, conflict C7).
    """
    document = await _load(db, document_id)

    if auth.role != Role.DOCTOR or not auth.doctor_id:
        raise forbidden(
            "Only a doctor can confirm an extracted prescription. "
            "A misread dose is a clinical decision, not a data-entry one."
        )
    await require_clinical_access(db, auth, request, document.patient_id, what="MedicalDocument")

    if document.ocr_status not in (OcrStatus.EXTRACTED, OcrStatus.CONFIRMED):
        raise bad_request("Run extraction on this document before confirming it.")

    confirmed = {
        "medications": [
            {
                "medication": item.medication,
                "dosage": item.dosage,
                "frequency": item.frequency,
                "duration": item.duration,
                "instructions": item.instructions,
            }
            for item in payload.medications
        ],
        "needsReview": False,
        "confirmed": True,
    }

    # The machine's proposal is kept alongside the confirmed version rather than
    # overwritten: if a dose is later questioned, "what did the OCR say and what
    # did the clinician change it to" is the question that gets asked.
    document.structured_data = {
        "proposed": (document.structured_data or {}),
        "confirmed": confirmed,
    }
    document.ocr_status = OcrStatus.CONFIRMED
    document.confirmed_by_id = auth.user_id
    document.confirmed_at = utcnow()
    await db.flush()

    await _audit(
        request,
        db,
        auth,
        AuditAction.OCR_CONFIRMED,
        document,
        {
            "medicationCount": len(payload.medications),
            # Whether the clinician changed anything is worth knowing later.
            "engineConfidence": document.ocr_confidence,
        },
    )

    return ok(_serialize_state(document))

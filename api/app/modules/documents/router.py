"""Medical documents: upload, metadata, and signed retrieval (spec §25-27).

The retrieval model is the point of this module. A document has no public URL —
the bucket is private, and ``GET /documents/{id}/download`` mints a link that
lives for minutes only after the caller has passed the same clinical access
check that guards records. Possessing an id, or an old link, is not access
(conflict C8).

Deletion is soft. A document a doctor has already read is part of what informed
their decision, so the row and the object both survive; ``deletedAt`` hides it
from every list and refuses new downloads.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_any_permission
from app.api.responses import Page, ok, pagination
from app.core.config import settings
from app.core.errors import bad_request, forbidden, not_found
from app.db.base import new_id, utcnow
from app.db.enums import AuditAction, DocumentType, OcrStatus, Role
from app.db.models import MedicalDocument, MedicalRecord, User
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.records.access import clinical_scope, require_clinical_access
from app.services import storage
from app.services.files import FileRejectedError, inspect_upload

router = APIRouter(prefix="/documents", tags=["documents"])

RequireUpload = Annotated[
    object,
    Depends(
        require_any_permission(
            Permission.DOCUMENT_UPLOAD_OWN, Permission.DOCUMENT_UPLOAD_ANY
        )
    ),
]

#: OCR-able types. A PDF or photo of a prescription can be read in Phase 7; the
#: rest are stored and shown, never machine-read.
OCR_CANDIDATES = frozenset({"application/pdf", "image/jpeg", "image/png", "image/webp", "image/tiff"})


def serialize(document: MedicalDocument, uploaded_by: str | None = None) -> dict[str, Any]:
    """Metadata only.

    Never the storage path or bucket: those are server-side addressing, and
    publishing them would invite attempts to reach the object directly rather
    than through the check that mints a signed link.
    """
    return {
        "id": document.id,
        "patientId": document.patient_id,
        "medicalRecordId": document.medical_record_id,
        "documentType": str(document.document_type),
        "title": document.title,
        "fileName": document.original_file_name,
        "mimeType": document.mime_type,
        "fileSize": document.file_size,
        "checksumSha256": document.checksum_sha256,
        "ocrStatus": str(document.ocr_status),
        "uploadedById": document.uploaded_by_id,
        "uploadedBy": uploaded_by,
        "createdAt": document.created_at.isoformat() + "Z",
    }


def _columns() -> Any:
    return select(MedicalDocument, User.name).join(
        User, User.id == MedicalDocument.uploaded_by_id
    )


async def _load(db: DbSession, document_id: str) -> Any:
    row = (
        await db.execute(
            _columns().where(
                MedicalDocument.id == document_id, MedicalDocument.deleted_at.is_(None)
            )
        )
    ).first()
    if row is None:
        raise not_found("Document")
    return row


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
            # Type and size, never the extracted text or the file name's
            # contents — a document title can itself be clinical.
            metadata=metadata,
        ),
    )


@router.get("")
async def list_documents(
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    patient_id: Annotated[str | None, Query(alias="patientId", max_length=64)] = None,
    document_type: Annotated[DocumentType | None, Query(alias="documentType")] = None,
) -> dict[str, Any]:
    """Documents for one patient, or across the caller's own scope."""
    if patient_id:
        await require_clinical_access(db, auth, request, patient_id, what="MedicalDocument")
        filters: list[Any] = [MedicalDocument.patient_id == patient_id]
    else:
        filters = [clinical_scope(auth, MedicalDocument.patient_id)]

    filters.append(MedicalDocument.deleted_at.is_(None))
    if document_type:
        filters.append(MedicalDocument.document_type == document_type)

    total = (
        await db.execute(select(func.count(MedicalDocument.id)).where(*filters))
    ).scalar_one()
    rows = (
        await db.execute(
            _columns()
            .where(*filters)
            .order_by(MedicalDocument.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()

    return ok([serialize(document, name) for document, name in rows], page.meta(total))


@router.get("/{document_id}")
async def get_document(
    document_id: str, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    row = await _load(db, document_id)
    await require_clinical_access(db, auth, request, row[0].patient_id, what="MedicalDocument")
    return ok(serialize(row[0], row[1]))


@router.post("", status_code=201)
async def upload_document(
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireUpload,
    file: Annotated[UploadFile, File()],
    patient_id: Annotated[str, Form(alias="patientId")],
    document_type: Annotated[DocumentType, Form(alias="documentType")] = DocumentType.OTHER,
    title: Annotated[str | None, Form()] = None,
    medical_record_id: Annotated[str | None, Form(alias="medicalRecordId")] = None,
) -> dict[str, Any]:
    """Store a file and record it against a patient.

    The order here is deliberate: validate, then store, then write the row. If
    the row write fails the object is removed again, so a failed upload cannot
    leave an unreferenced file sitting in a bucket that nothing will ever clean
    up or account for.
    """
    # A patient uploads for themselves and the id comes from their session; a
    # `patientId` in the form is ignored rather than compared, because the only
    # value that cannot be tampered with is the one they never supplied.
    if auth.role == Role.PATIENT:
        if not auth.patient_id:
            raise forbidden("This account has no patient record.")
        target_patient = auth.patient_id
    else:
        target_patient = patient_id

    await require_clinical_access(db, auth, request, target_patient, what="MedicalDocument")

    content = await file.read()
    try:
        inspected = inspect_upload(
            content,
            declared_mime=file.content_type,
            original_name=file.filename,
            max_bytes=settings.MAX_UPLOAD_BYTES,
        )
    except FileRejectedError as exc:
        raise bad_request(str(exc)) from exc

    if medical_record_id:
        owner = (
            await db.execute(
                select(MedicalRecord.patient_id).where(MedicalRecord.id == medical_record_id)
            )
        ).scalar_one_or_none()
        if owner is None:
            raise bad_request("That medical record does not exist.")
        if owner != target_patient:
            raise bad_request("That medical record belongs to a different patient.")

    document_id = new_id()
    path = storage.object_path(target_patient, document_id, inspected.extension)
    bucket = settings.SUPABASE_DOCUMENTS_BUCKET

    await storage.upload(bucket, path, content, inspected.detected_mime)

    try:
        document = MedicalDocument(
            id=document_id,
            patient_id=target_patient,
            uploaded_by_id=auth.user_id,
            medical_record_id=medical_record_id,
            document_type=document_type,
            title=title,
            original_file_name=inspected.safe_name,
            mime_type=inspected.detected_mime,
            file_size=inspected.size,
            checksum_sha256=inspected.checksum_sha256,
            storage_bucket=bucket,
            storage_path=path,
            # Phase 7 picks these up. Anything we cannot machine-read is marked
            # SKIPPED now rather than left PENDING forever.
            ocr_status=(
                OcrStatus.PENDING
                if settings.OCR_ENABLED and inspected.detected_mime in OCR_CANDIDATES
                else OcrStatus.SKIPPED
            ),
        )
        db.add(document)
        await db.flush()
    except Exception:
        await storage.remove(bucket, path)
        raise

    await _audit(
        request,
        db,
        auth,
        AuditAction.DOCUMENT_UPLOADED,
        document,
        {
            "documentType": str(document_type),
            "mimeType": inspected.detected_mime,
            "fileSize": inspected.size,
        },
    )

    uploader = (
        await db.execute(select(User.name).where(User.id == auth.user_id))
    ).scalar_one_or_none()
    return ok(serialize(document, uploader))


@router.get("/{document_id}/download")
async def download_document(
    document_id: str, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Mint a short-lived link to the file.

    This is the whole of conflict C8: the URL is created *after* the access
    check, expires in minutes, and the act of creating it is audited. There is
    no long-lived link to leak, and holding an id gets you nothing.
    """
    row = await _load(db, document_id)
    document: MedicalDocument = row[0]

    await require_clinical_access(db, auth, request, document.patient_id, what="MedicalDocument")

    url = await storage.signed_url(document.storage_bucket, document.storage_path)

    await _audit(
        request,
        db,
        auth,
        AuditAction.DOCUMENT_VIEWED,
        document,
        {"ttlSeconds": settings.SUPABASE_SIGNED_URL_TTL_SECONDS},
    )

    return ok(
        {
            "url": url,
            "expiresInSeconds": settings.SUPABASE_SIGNED_URL_TTL_SECONDS,
            "fileName": document.original_file_name,
            "mimeType": document.mime_type,
        }
    )


@router.delete("/{document_id}")
async def delete_document(
    document_id: str, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Soft-delete a document.

    Allowed to whoever uploaded it — a patient who attached the wrong file
    should be able to withdraw it — or to an administrator holding
    ``document:delete``. The row and the stored object both remain: a document a
    clinician has already read is part of what informed their decision, and the
    audit trail must still be able to name it.
    """
    row = await _load(db, document_id)
    document: MedicalDocument = row[0]

    is_uploader = document.uploaded_by_id == auth.user_id
    if not is_uploader and not auth.has(Permission.DOCUMENT_DELETE):
        raise forbidden("You cannot remove this document.")

    document.deleted_at = utcnow()
    await db.flush()

    await _audit(
        request,
        db,
        auth,
        AuditAction.DOCUMENT_DELETED,
        document,
        {"byUploader": is_uploader},
    )
    return ok({"id": document_id, "removed": True})

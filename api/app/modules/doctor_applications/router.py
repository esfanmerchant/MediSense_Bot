"""A doctor's own registration: the form, its documents, and submitting it.

Every route here is scoped to the caller's own application. There is no
application id in any path — the row is found from the session — so there is no
identifier to tamper with and no way to read or edit somebody else's claim.

Credential files follow the same rule medical documents do: a private bucket, a
generated object path, and a link that is signed for minutes only after the
access check has passed. A scan of a national ID is not less sensitive than a
lab report.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import ok
from app.core.config import settings
from app.core.errors import bad_request, conflict, forbidden, not_found
from app.db.base import new_id
from app.db.enums import DoctorDocumentKind, Role
from app.db.models import DoctorApplication, DoctorApplicationDocument, User
from app.modules.auth.rbac import Permission
from app.modules.auth.service import RequestContext
from app.modules.doctor_applications import service
from app.modules.doctor_applications.schemas import ApplicationUpdate
from app.services import storage
from app.services.files import FileRejectedError, inspect_upload

router = APIRouter(prefix="/doctor/application", tags=["doctor-application"])

RequireApplicant = Annotated[
    object, Depends(require_permission(Permission.DOCTOR_APPLICATION_SUBMIT))
]

#: Enough for a certificate, a degree, an ID and a photograph, with room to
#: replace one. An unbounded count is a free upload endpoint.
MAX_DOCUMENTS = 12


def _ctx(request: Request) -> RequestContext:
    return RequestContext(
        ip_address=client_ip(request),
        user_agent=request.headers.get("user-agent"),
        request_id=getattr(request.state, "request_id", None),
    )


async def _self(db: DbSession, auth: CurrentAuth) -> User:
    if auth.role != Role.DOCTOR:
        raise forbidden("This endpoint is for doctors.")
    user = (await db.execute(select(User).where(User.id == auth.user_id))).scalar_one_or_none()
    if user is None:
        raise not_found("User")
    return user


async def _documents(
    db: DbSession, application_id: str
) -> list[DoctorApplicationDocument]:
    return list(
        (
            await db.execute(
                select(DoctorApplicationDocument)
                .where(DoctorApplicationDocument.application_id == application_id)
                .order_by(DoctorApplicationDocument.uploaded_at)
            )
        )
        .scalars()
        .all()
    )


async def _view(db: DbSession, application: DoctorApplication) -> dict[str, Any]:
    return ok(service.serialize(application, await _documents(db, application.id)))


@router.get("")
async def get_application(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    """The caller's application, created as an empty DRAFT on first read."""
    user = await _self(db, auth)
    application = await service.load_or_create(db, user)
    return await _view(db, application)


@router.put("")
async def save_application(
    payload: ApplicationUpdate, auth: CurrentAuth, db: DbSession, _: RequireApplicant
) -> dict[str, Any]:
    """Save a partial draft. Safe to call on every keystroke or none."""
    user = await _self(db, auth)
    application = await service.load_or_create(db, user)
    await service.save_draft(db, application, payload)
    return await _view(db, application)


@router.post("/submit")
async def submit_application(
    request: Request, auth: CurrentAuth, db: DbSession, _: RequireApplicant
) -> dict[str, Any]:
    user = await _self(db, auth)
    application = await service.load_or_create(db, user)
    await service.submit(db, application, user, _ctx(request))
    return await _view(db, application)


# ---------------------------------------------------------------------------
# Credential documents
# ---------------------------------------------------------------------------


@router.post("/documents", status_code=201)
async def upload_document(
    auth: CurrentAuth,
    db: DbSession,
    _: RequireApplicant,
    file: Annotated[UploadFile, File()],
    kind: Annotated[DoctorDocumentKind, Form()],
) -> dict[str, Any]:
    """Attach one credential file.

    Validate, store, then write the row — and remove the object again if the row
    fails, so a half-finished upload cannot leave a file in a bucket that nothing
    references and nobody will ever account for.
    """
    user = await _self(db, auth)
    application = await service.load_or_create(db, user)
    service.require_editable(application)

    existing = await _documents(db, application.id)
    if len(existing) >= MAX_DOCUMENTS:
        raise conflict(f"An application may hold at most {MAX_DOCUMENTS} documents.")

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

    document_id = new_id()
    # Both halves generated by us, so a crafted filename cannot escape the
    # application's own prefix or collide with another applicant's object.
    path = f"{application.id}/{document_id}{inspected.extension}"
    bucket = settings.SUPABASE_CREDENTIALS_BUCKET

    await storage.upload(bucket, path, content, inspected.detected_mime)
    try:
        document = DoctorApplicationDocument(
            id=document_id,
            application_id=application.id,
            kind=kind,
            storage_bucket=bucket,
            storage_path=path,
            file_name=inspected.safe_name,
            mime_type=inspected.detected_mime,
            file_size=inspected.size,
            checksum_sha256=inspected.checksum_sha256,
        )
        db.add(document)
        await db.flush()
    except Exception:
        await storage.remove(bucket, path)
        raise

    return ok(service.serialize_document(document))


async def _own_document(
    db: DbSession, auth: CurrentAuth, document_id: str
) -> tuple[DoctorApplicationDocument, DoctorApplication]:
    row = (
        await db.execute(
            select(DoctorApplicationDocument, DoctorApplication)
            .join(
                DoctorApplication,
                DoctorApplication.id == DoctorApplicationDocument.application_id,
            )
            .where(
                DoctorApplicationDocument.id == document_id,
                # The join to the caller's own application is the access check:
                # another applicant's document id is simply not found.
                DoctorApplication.user_id == auth.user_id,
            )
        )
    ).first()
    if row is None:
        raise not_found("Document")
    return row[0], row[1]


@router.delete("/documents/{document_id}")
async def delete_document(
    document_id: str, auth: CurrentAuth, db: DbSession, _: RequireApplicant
) -> dict[str, Any]:
    """Remove a file the applicant uploaded.

    Deleted outright rather than soft-deleted, unlike a medical document: this
    is evidence somebody attached about themselves before anyone relied on it,
    and once the application is with a reviewer it can no longer be removed at
    all.
    """
    document, application = await _own_document(db, auth, document_id)
    service.require_editable(application)

    await db.delete(document)
    await db.flush()
    await storage.remove(document.storage_bucket, document.storage_path)
    return ok({"id": document_id, "removed": True})


@router.get("/documents/{document_id}/download")
async def download_document(
    document_id: str, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    document, _application = await _own_document(db, auth, document_id)
    url = await storage.signed_url(document.storage_bucket, document.storage_path)
    return ok(
        {
            "url": url,
            "expiresInSeconds": settings.SUPABASE_SIGNED_URL_TTL_SECONDS,
            "fileName": document.file_name,
            "mimeType": document.mime_type,
        }
    )


class EnquiryRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    #: Long enough to say something, short enough not to be a document. An
    #: applicant with more than this to say needs a conversation, not a form.
    message: Annotated[str, Field(min_length=10, max_length=2000)]


@router.post("/contact", status_code=202)
async def contact_administrators(
    payload: EnquiryRequest, auth: CurrentAuth, db: DbSession, _: RequireApplicant
) -> dict[str, Any]:
    """Send a message to the administrators reviewing this application.

    Replaces a ``mailto:`` link, and the reason is that a link is not a feature:
    it depends on the person having a mail client configured, it does nothing at
    all on most phones and on webmail, and whatever they eventually send arrives
    without the registration number the reviewer needs to find them by.

    The name, address and registration number are read from the applicant's own
    record rather than taken from the request. A form that lets the sender state
    who they are is a form that can be used to write to an administrator as
    somebody else.
    """
    user = await _self(db, auth)
    application = await service.load_or_create(db, user)
    await service.forward_enquiry(db, application, user, payload.message)
    return ok({"sent": True})

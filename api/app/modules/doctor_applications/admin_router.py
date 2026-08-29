"""The administrator's queue of doctor registrations.

Every route holds ``doctor:application:review``, which only ADMIN has. That is
the whole authorization story here and it is deliberately simple: reviewing a
colleague's credentials is an administrative act on an administrative record,
with no patient anywhere in it, so none of the clinical access machinery
applies.

What is not simple, and is the reason this module is separate from the
applicant's own, is that approving creates a ``Doctor`` row — a credential that
authorizes prescribing. So both decisions are audited naming the administrator
who made them, and neither can be made on an application that is not actually
waiting for one.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.config import settings
from app.core.errors import not_found
from app.db.enums import DoctorApplicationStatus
from app.db.models import DoctorApplication, DoctorApplicationDocument, User
from app.modules.auth.rbac import Permission
from app.modules.auth.service import RequestContext
from app.modules.doctor_applications import service
from app.modules.doctor_applications.schemas import (
    DocumentVerification,
    ReviewApprove,
    ReviewReject,
)
from app.services import storage

router = APIRouter(prefix="/admin/doctor-applications", tags=["doctor-application"])

RequireReviewer = Annotated[
    object, Depends(require_permission(Permission.DOCTOR_APPLICATION_REVIEW))
]


def _ctx(request: Request) -> RequestContext:
    return RequestContext(
        ip_address=client_ip(request),
        user_agent=request.headers.get("user-agent"),
        request_id=getattr(request.state, "request_id", None),
    )


async def _load(db: DbSession, application_id: str) -> tuple[DoctorApplication, User]:
    row = (
        await db.execute(
            select(DoctorApplication, User)
            .join(User, User.id == DoctorApplication.user_id)
            .where(DoctorApplication.id == application_id)
        )
    ).first()
    if row is None:
        raise not_found("Application")
    return row[0], row[1]


async def _documents(db: DbSession, application_id: str) -> list[DoctorApplicationDocument]:
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


async def _view(
    db: DbSession, application: DoctorApplication, applicant: User
) -> dict[str, Any]:
    return ok(
        service.serialize(
            application,
            await _documents(db, application.id),
            include_review_notes=True,
            applicant=applicant,
        )
    )


@router.get("")
async def list_applications(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    _: RequireReviewer,
    status: Annotated[DoctorApplicationStatus | None, Query()] = None,
) -> dict[str, Any]:
    """The queue, oldest submission first so the wait is fair.

    ``meta.pending`` is the count of everything still awaiting a decision, not
    of this page: it is the number the dashboard badge shows, and it must not
    change when somebody pages through.
    """
    filters = [DoctorApplication.status == status] if status else []

    total = (
        await db.execute(select(func.count(DoctorApplication.id)).where(*filters))
    ).scalar_one()
    pending = (
        await db.execute(
            select(func.count(DoctorApplication.id)).where(
                DoctorApplication.status == DoctorApplicationStatus.SUBMITTED
            )
        )
    ).scalar_one()

    rows = (
        await db.execute(
            select(DoctorApplication, User)
            .join(User, User.id == DoctorApplication.user_id)
            .where(*filters)
            .order_by(
                DoctorApplication.submitted_at.asc().nullslast(),
                DoctorApplication.updated_at.desc(),
            )
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()

    return ok(
        [
            service.serialize(application, [], include_review_notes=True, applicant=applicant)
            for application, applicant in rows
        ],
        {**page.meta(total), "pending": pending},
    )


@router.get("/{application_id}")
async def get_application(
    application_id: str, auth: CurrentAuth, db: DbSession, _: RequireReviewer
) -> dict[str, Any]:
    application, applicant = await _load(db, application_id)
    return await _view(db, application, applicant)


@router.patch("/{application_id}/documents/{document_id}")
async def set_document_verified(
    application_id: str,
    document_id: str,
    payload: DocumentVerification,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireReviewer,
) -> dict[str, Any]:
    """Mark one credential file as checked, or un-check it.

    Per document rather than per application, because a reviewer confirms a
    licence and a degree separately and may need to come back to one of them.
    """
    document = (
        await db.execute(
            select(DoctorApplicationDocument).where(
                DoctorApplicationDocument.id == document_id,
                DoctorApplicationDocument.application_id == application_id,
            )
        )
    ).scalar_one_or_none()
    if document is None:
        raise not_found("Document")

    document.verified = payload.verified
    # Recorded even when unsetting: "who last said this was fine" is the part a
    # later review needs.
    document.verified_by_id = auth.user_id if payload.verified else None
    await db.flush()
    return ok(service.serialize_document(document))


@router.get("/{application_id}/documents/{document_id}/download")
async def download_document(
    application_id: str,
    document_id: str,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireReviewer,
) -> dict[str, Any]:
    document = (
        await db.execute(
            select(DoctorApplicationDocument).where(
                DoctorApplicationDocument.id == document_id,
                DoctorApplicationDocument.application_id == application_id,
            )
        )
    ).scalar_one_or_none()
    if document is None:
        raise not_found("Document")

    url = await storage.signed_url(document.storage_bucket, document.storage_path)
    return ok(
        {
            "url": url,
            "expiresInSeconds": settings.SUPABASE_SIGNED_URL_TTL_SECONDS,
            "fileName": document.file_name,
            "mimeType": document.mime_type,
        }
    )


@router.post("/{application_id}/approve")
async def approve_application(
    application_id: str,
    payload: ReviewApprove,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireReviewer,
) -> dict[str, Any]:
    """Grant the credential: create or update the real ``Doctor`` row."""
    application, applicant = await _load(db, application_id)
    await service.approve(db, application, applicant, auth.user_id, payload.notes, _ctx(request))
    return await _view(db, application, applicant)


@router.post("/{application_id}/reject")
async def reject_application(
    application_id: str,
    payload: ReviewReject,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireReviewer,
) -> dict[str, Any]:
    """Send it back with a reason. The applicant may correct it and resubmit."""
    application, applicant = await _load(db, application_id)
    await service.reject(
        db, application, applicant, auth.user_id, payload.reason, payload.notes, _ctx(request)
    )
    return await _view(db, application, applicant)

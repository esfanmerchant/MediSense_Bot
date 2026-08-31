"""Doctor self-registration, and the administrator's decision on it.

**An application is a claim; a ``Doctor`` row is a credential.** Nothing a
person types about themselves ever becomes the second one without a named
administrator saying so, and the application stays behind afterwards recording
what was claimed, who checked it and when. That separation is the whole point of
this module: it is why "approve" is a deliberate copy of fields rather than a
status flip, and why nothing here ever writes a ``Doctor`` row except
``approve``.

The state machine is small and every transition is refused from the wrong place:

    DRAFT ──submit──▶ SUBMITTED ──approve──▶ APPROVED
      ▲                   │
      │                   └──reject──▶ REJECTED ──submit──▶ SUBMITTED

An APPROVED application is final and read-only. Editing one would let a doctor
change their own licence number after it was checked.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, ErrorCode, bad_request, conflict
from app.db.base import new_id, utcnow
from app.db.enums import (
    AuditAction,
    AuditSeverity,
    DoctorApplicationStatus,
    DoctorDocumentKind,
    NotificationType,
    Role,
    UserStatus,
)
from app.db.models import (
    Department,
    Doctor,
    DoctorApplication,
    DoctorApplicationDocument,
    User,
)
from app.modules.appointments.schedule import validate_windows
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.service import RequestContext
from app.modules.doctor_applications.schemas import ApplicationUpdate
from app.modules.notifications import service as notifications
from app.services import email as email_service
from app.services import email_templates

#: What an administrator needs in front of them before a decision is even
#: possible.
REQUIRED_FIELDS: tuple[tuple[str, str], ...] = (
    ("full_name", "fullName"),
    ("phone", "phone"),
    ("national_id", "nationalId"),
    ("address", "address"),
    ("registration_number", "registrationNumber"),
    ("specialization", "specialization"),
    ("years_experience", "yearsExperience"),
    ("consultation_fee", "consultationFee"),
    # Where they practise. Required because the directory is a list a patient
    # chooses from on reachability as much as on qualification, and a doctor
    # with no city cannot be filtered to, found, or travelled to. The pin is not
    # here: a coordinate is a convenience on top of an address, and refusing a
    # complete application because a map would not load would be absurd.
    ("clinic_name", "clinicName"),
    ("city", "city"),
    ("address_line", "addressLine"),
)

#: The files an administrator needs in hand, all four of them.
#:
#: This list used to be empty, on the reasoning that storage can be down and an
#: applicant stuck unable to submit because an upload failed is worse than a
#: reviewer who rejects with "we still need your certificate". The product owner
#: has decided the other way, and the reason is stronger: an administrator
#: cannot verify an identity or a qualification without the files, so an
#: application without them is not reviewable and should not exist. Each one
#: answers a different question — the certificate says the registration is live,
#: the degree says the qualification is real, the national ID says the person is
#: the one those two name, and the photograph is what a patient will see.
#:
#: The cost is accepted rather than avoided: a storage outage now blocks
#: submission outright, where before it only delayed a decision. That is
#: preferred to a queue of applications nobody can act on.
REQUIRED_DOCUMENTS: tuple[DoctorDocumentKind, ...] = (
    DoctorDocumentKind.REGISTRATION_CERTIFICATE,
    DoctorDocumentKind.DEGREE,
    DoctorDocumentKind.NATIONAL_ID,
    DoctorDocumentKind.PHOTO,
)

#: Nobody practising today holds a degree older than this, and the floor is what
#: turns a mistyped "195" or "20" into a message rather than a stored absurdity.
MIN_QUALIFICATION_YEAR = 1950

#: How far past today a year may still be plausible. A five-year degree started
#: this year finishes well after it, and people list the course they are on.
MAX_QUALIFICATION_YEARS_AHEAD = 7

#: Statuses an applicant may still edit. SUBMITTED is excluded so the version a
#: reviewer is reading cannot change under them; APPROVED because it has become
#: a credentialing record.
EDITABLE = (DoctorApplicationStatus.DRAFT, DoctorApplicationStatus.REJECTED)


def max_qualification_year() -> int:
    """Computed per call, not at import: a running process outlives a New Year."""
    return datetime.now(UTC).year + MAX_QUALIFICATION_YEARS_AHEAD


async def load_or_create(db: AsyncSession, user: User) -> DoctorApplication:
    """The caller's application, created empty on first read.

    Creating on read rather than making the client POST one first means the
    onboarding screen has somewhere to save to from the first keystroke.
    """
    application = (
        await db.execute(select(DoctorApplication).where(DoctorApplication.user_id == user.id))
    ).scalar_one_or_none()
    if application is not None:
        return application

    # A doctor an administrator created before self-registration existed already
    # holds the credential this process grants. Recording that as an APPROVED
    # application keeps one description of who may practise, rather than two
    # that can disagree.
    existing_doctor = (
        await db.execute(select(Doctor).where(Doctor.user_id == user.id))
    ).scalar_one_or_none()

    application = DoctorApplication(
        id=new_id(),
        user_id=user.id,
        status=(
            DoctorApplicationStatus.APPROVED if existing_doctor else DoctorApplicationStatus.DRAFT
        ),
        full_name=user.name,
        phone=user.phone,
        specialization=existing_doctor.specialization if existing_doctor else None,
        registration_number=existing_doctor.license_number if existing_doctor else None,
        department_id=existing_doctor.department_id if existing_doctor else None,
        years_experience=existing_doctor.years_experience if existing_doctor else None,
        consultation_fee=existing_doctor.consultation_fee if existing_doctor else None,
        availability=existing_doctor.availability if existing_doctor else [],
        submitted_at=utcnow() if existing_doctor else None,
        reviewed_at=utcnow() if existing_doctor else None,
    )
    db.add(application)
    await db.flush()
    return application


def require_editable(application: DoctorApplication) -> None:
    if application.status in EDITABLE:
        return
    if application.status == DoctorApplicationStatus.SUBMITTED:
        raise conflict(
            "Your application is being reviewed and cannot be changed. "
            "It will be returned to you if anything needs correcting.",
            ErrorCode.PENDING_APPROVAL,
        )
    raise conflict("Your registration has been approved and can no longer be edited.")


async def save_draft(
    db: AsyncSession, application: DoctorApplication, payload: ApplicationUpdate
) -> DoctorApplication:
    require_editable(application)

    changed = payload.model_dump(exclude_unset=True, by_alias=False)

    if "availability" in changed and payload.availability is not None:
        # Overlapping windows would generate the same slot time twice, and the
        # two patients who booked "09:00" would then collide on the unique slot
        # key with no way to explain which one was wrong.
        try:
            validate_windows(payload.availability)
        except ValueError as exc:
            raise bad_request(str(exc)) from exc
        changed["availability"] = [window.as_stored() for window in payload.availability]
    elif "availability" in changed:
        changed["availability"] = []

    if "qualifications" in changed:
        # Re-serialized from the parsed models rather than taken from the dump,
        # because ``model_dump`` gives snake_case and the stored JSONB speaks the
        # same camelCase the API does.
        changed["qualifications"] = [entry.as_stored() for entry in payload.qualifications or []]

    if "consultation_fee" in changed and changed["consultation_fee"] is not None:
        changed["consultation_fee"] = Decimal(str(changed["consultation_fee"]))

    if changed.get("department_id"):
        exists = (
            await db.execute(select(Department.id).where(Department.id == changed["department_id"]))
        ).scalar_one_or_none()
        if exists is None:
            raise bad_request("That department does not exist.")

    for field, value in changed.items():
        setattr(application, field, value)
    await db.flush()
    return application


def missing_fields(application: DoctorApplication) -> list[str]:
    missing = [
        alias for attr, alias in REQUIRED_FIELDS if getattr(application, attr) in (None, "")
    ]
    if not application.qualifications:
        missing.append("qualifications")
    return missing


def qualification_issues(entries: Iterable[Any]) -> list[dict[str, Any]]:
    """Years that are not years, and years that run backwards.

    **Asked here rather than on the draft model, and that placement is the whole
    point.** The form autosaves on a debounce while somebody is typing, so a
    person entering 2015 sends 2, then 20, then 201; a range check on the field
    would refuse each of those saves and tell them their draft was lost. A year
    that is wrong for a moment costs nothing, and it is only wrong at all if it
    is still wrong when they submit — which is exactly when this runs.

    Every issue is reported against ``qualifications`` rather than an indexed
    path, because that is the name of the step the client sends them back to.
    Entries that are not objects are skipped: a row written before the years
    existed has no year to be wrong about.
    """
    ceiling = max_qualification_year()
    issues: list[dict[str, Any]] = []

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        # The client prefixes each detail with its field label, so these read as
        # "Qualifications: <this>" and have to be whole sentences rather than
        # fragments. The title is quoted because a real one has commas in it.
        title = str(entry.get("title") or "").strip()
        name = f'"{title}"' if title else "This qualification"
        start, end = entry.get("startYear"), entry.get("endYear")
        years = [value for value in (start, end) if isinstance(value, int)]

        if any(not MIN_QUALIFICATION_YEAR <= year <= ceiling for year in years):
            issues.append(
                {
                    "field": "qualifications",
                    "message": (
                        f"{name} needs a year between {MIN_QUALIFICATION_YEAR} "
                        f"and {ceiling}."
                    ),
                }
            )
        elif isinstance(start, int) and isinstance(end, int) and start > end:
            # Only when both years are otherwise sound: telling somebody their
            # dates are out of order *and* out of range is two complaints about
            # one typo.
            issues.append(
                {
                    "field": "qualifications",
                    "message": f"{name} has a start year after its end year.",
                }
            )

    return issues


def missing_documents(kinds: Iterable[DoctorDocumentKind]) -> list[str]:
    """Which of the four required kinds are not attached.

    Returned in ``REQUIRED_DOCUMENTS`` order rather than the order they happen
    to be missing in, so the client points at the first gap in the same place
    every time.
    """
    held = set(kinds)
    return [str(kind) for kind in REQUIRED_DOCUMENTS if kind not in held]


async def _attached_kinds(db: AsyncSession, application_id: str) -> list[DoctorDocumentKind]:
    return list(
        (
            await db.execute(
                select(DoctorApplicationDocument.kind).where(
                    DoctorApplicationDocument.application_id == application_id
                )
            )
        )
        .scalars()
        .all()
    )


async def submit(
    db: AsyncSession, application: DoctorApplication, user: User, ctx: RequestContext
) -> DoctorApplication:
    """Hand the application to the administrators.

    Allowed from REJECTED as well as DRAFT: a rejection is a request for
    changes, so the way back is the same door.
    """
    require_editable(application)

    # One refusal listing everything, in the order the steps appear, rather than
    # a profile check that passes and an upload check that fails on the next
    # attempt.
    details: list[dict[str, Any]] = [
        {"field": field, "message": "This is required before you can submit."}
        for field in missing_fields(application)
    ]
    details += qualification_issues(application.qualifications or [])
    details += [
        {"field": kind, "message": "Upload this document before you can submit."}
        for kind in missing_documents(await _attached_kinds(db, application.id))
    ]
    if details:
        # VALIDATION_ERROR rather than PROFILE_INCOMPLETE: that code is one of
        # the three doctor-gate states, and the client routes on it globally.
        # "Your form is missing three things" is not "you may not use the
        # portal", and conflating them misleads the next reader of the code.
        raise AppError(
            422,
            ErrorCode.VALIDATION_ERROR,
            "Your application is not ready to submit yet.",
            details,
        )

    application.status = DoctorApplicationStatus.SUBMITTED
    application.submitted_at = utcnow()
    # Cleared so a resubmission does not show the previous decision as if it
    # still applied.
    application.reviewed_at = None
    application.reviewed_by_id = None
    application.rejection_reason = None
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.DOCTOR_APPLICATION_SUBMITTED,
            severity=AuditSeverity.NOTICE,
            user_id=user.id,
            actor_role=user.role,
            entity_type="DoctorApplication",
            entity_id=application.id,
            ip_address=ctx.ip_address,
            user_agent=ctx.user_agent,
            request_id=ctx.request_id,
            metadata={"specialization": application.specialization},
        ),
    )

    applicant = email_templates.doctor_application_received(name=user.name)
    await email_service.send(
        to=user.email,
        subject=applicant.subject,
        text_body=applicant.text,
        html_body=applicant.html,
    )
    await _tell_the_administrators(db, application, user)
    return application


async def _tell_the_administrators(
    db: AsyncSession, application: DoctorApplication, applicant: User
) -> None:
    """One in-app notification and one email per administrator.

    The email is sent here rather than queued through the notification
    dispatcher because it is not a copy of the in-app message — it is a
    different, thinner message that names the applicant and links to the queue.
    """
    admins = (
        (
            await db.execute(
                select(User).where(User.role == Role.ADMIN, User.status == UserStatus.ACTIVE)
            )
        )
        .scalars()
        .all()
    )
    message = email_templates.admin_new_doctor_request(
        applicant_name=applicant.name, specialization=application.specialization
    )
    for admin in admins:
        await notifications.notify(
            db,
            user_id=admin.id,
            notification_type=NotificationType.DOCTOR_APPLICATION,
            title="A doctor registration is waiting",
            body=f"{applicant.name} has applied to register as a doctor.",
            link=f"/admin/doctor-applications/{application.id}",
            # Sent directly below. Queuing one too would deliver it twice.
            email=False,
        )
        await email_service.send(
            to=admin.email,
            subject=message.subject,
            text_body=message.text,
            html_body=message.html,
        )


# ---------------------------------------------------------------------------
# Review
# ---------------------------------------------------------------------------


#: A year range is a range, not a subtraction, so it takes an en dash. Written as
#: an escape because in source an en dash and a hyphen look alike.
_EN_DASH = "\u2013"


def render_qualification(entry: Any) -> str:
    """One stored qualification as a line of free text.

    Forgiving about what it is handed, for the same reason ``parse_windows`` is:
    this column is JSONB, and a row written before the years existed — or by
    hand in the database — must not be able to fail an approval. A bare string
    is still a qualification and comes back as itself.

    Half a date is worth showing, so a missing year degrades rather than hides
    the entry: an end year alone reads as that year on its own, a start year
    alone reads as an open-ended range — which is what a course still being
    taken is — and an entry with neither is simply its title.
    """
    if isinstance(entry, str):
        return entry.strip()
    if not isinstance(entry, dict):
        return ""

    title = str(entry.get("title") or "").strip()
    if not title:
        return ""

    start, end = entry.get("startYear"), entry.get("endYear")
    if start and end:
        return f"{title} ({start}{_EN_DASH}{end})"
    if start:
        return f"{title} ({start}{_EN_DASH})"
    if end:
        return f"{title} ({end})"
    return title


def render_qualifications(entries: Iterable[Any]) -> str | None:
    """The whole list as the one free-text line ``Doctor.qualifications`` holds.

    ``None`` rather than an empty string when there is nothing, so the column
    says "not stated" instead of "stated to be blank".
    """
    rendered = [line for line in (render_qualification(entry) for entry in entries) if line]
    return ", ".join(rendered) or None


def require_reviewable(application: DoctorApplication) -> None:
    if application.status != DoctorApplicationStatus.SUBMITTED:
        raise conflict(
            f"This application is {str(application.status).lower()} and is not awaiting review."
        )


async def approve(
    db: AsyncSession,
    application: DoctorApplication,
    applicant: User,
    reviewer_id: str,
    notes: str | None,
    ctx: RequestContext,
) -> Doctor:
    """Turn the claim into a credential.

    The fields are copied rather than referenced, so a later edit to the
    application — if one were ever possible — could not silently change what a
    doctor is licensed to do.
    """
    require_reviewable(application)

    registration = (application.registration_number or "").strip()
    clash = (
        await db.execute(
            select(Doctor.id).where(
                Doctor.license_number == registration, Doctor.user_id != applicant.id
            )
        )
    ).scalar_one_or_none()
    if clash:
        # Two clinicians cannot hold one registration number. Caught here with
        # an explanation rather than at the unique index with a 409 that says
        # "that record already exists".
        raise conflict("Another doctor is already registered with that registration number.")

    doctor = (
        await db.execute(select(Doctor).where(Doctor.user_id == applicant.id))
    ).scalar_one_or_none()
    if doctor is None:
        doctor = Doctor(id=new_id(), user_id=applicant.id, specialization="", license_number="")
        db.add(doctor)

    doctor.specialization = application.specialization or "General Medicine"
    doctor.license_number = registration
    doctor.department_id = application.department_id
    # Doctor.qualifications is free text — that is the shape the original schema
    # has — so the list an applicant built one entry at a time, years and all, is
    # rendered down to one line here.
    doctor.qualifications = render_qualifications(application.qualifications or [])
    doctor.years_experience = application.years_experience
    doctor.consultation_fee = application.consultation_fee or Decimal("0")
    doctor.availability = application.availability or []
    # The practice location travels with everything else, so what a patient sees
    # in the directory is exactly what an administrator approved.
    doctor.clinic_name = application.clinic_name
    doctor.city = application.city
    doctor.address_line = application.address_line
    doctor.latitude = application.latitude
    doctor.longitude = application.longitude

    application.status = DoctorApplicationStatus.APPROVED
    application.reviewed_at = utcnow()
    application.reviewed_by_id = reviewer_id
    application.review_notes = notes
    application.rejection_reason = None

    # Approval is also what lets them in: a doctor who registered and verified
    # their address has been sitting at ACTIVE-but-refused until now.
    applicant.status = UserStatus.ACTIVE
    await db.flush()

    await _audit_decision(
        db,
        AuditAction.DOCTOR_APPLICATION_APPROVED,
        application,
        reviewer_id,
        ctx,
        {"applicantUserId": applicant.id, "doctorId": doctor.id},
    )

    message = email_templates.doctor_approved(name=applicant.name)
    await email_service.send(
        to=applicant.email,
        subject=message.subject,
        text_body=message.text,
        html_body=message.html,
    )
    await notifications.notify(
        db,
        user_id=applicant.id,
        notification_type=NotificationType.DOCTOR_APPLICATION,
        title="Your registration is approved",
        body="You can now sign in and start work.",
        link="/doctor",
        email=False,
    )
    return doctor


async def reject(
    db: AsyncSession,
    application: DoctorApplication,
    applicant: User,
    reviewer_id: str,
    reason: str,
    notes: str | None,
    ctx: RequestContext,
) -> DoctorApplication:
    """Send it back with a reason. The applicant may correct it and resubmit."""
    require_reviewable(application)

    application.status = DoctorApplicationStatus.REJECTED
    application.reviewed_at = utcnow()
    application.reviewed_by_id = reviewer_id
    application.rejection_reason = reason
    application.review_notes = notes
    await db.flush()

    await _audit_decision(
        db,
        AuditAction.DOCTOR_APPLICATION_REJECTED,
        application,
        reviewer_id,
        ctx,
        {"applicantUserId": applicant.id},
    )

    message = email_templates.doctor_rejected(name=applicant.name, reason=reason)
    await email_service.send(
        to=applicant.email,
        subject=message.subject,
        text_body=message.text,
        html_body=message.html,
    )
    await notifications.notify(
        db,
        user_id=applicant.id,
        notification_type=NotificationType.DOCTOR_APPLICATION,
        title="Your registration needs changes",
        body="Sign in to see what to correct, then submit it again.",
        link="/doctor/onboarding",
        email=False,
    )
    return application


async def _audit_decision(
    db: AsyncSession,
    action: AuditAction,
    application: DoctorApplication,
    reviewer_id: str,
    ctx: RequestContext,
    metadata: dict[str, Any],
) -> None:
    """Names the administrator who decided.

    ``user_id`` is the reviewer, not the applicant: the question this entry
    answers later is "who let this person in?".
    """
    await record_audit(
        db,
        AuditEntry(
            action=action,
            severity=AuditSeverity.NOTICE,
            user_id=reviewer_id,
            actor_role=Role.ADMIN,
            entity_type="DoctorApplication",
            entity_id=application.id,
            ip_address=ctx.ip_address,
            user_agent=ctx.user_agent,
            request_id=ctx.request_id,
            metadata=metadata,
        ),
    )


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() + "Z" if value else None


def serialize_document(document: DoctorApplicationDocument) -> dict[str, Any]:
    """Metadata only — never the storage path.

    Publishing where the object lives would invite attempts to reach it directly
    rather than through the check that mints a signed link.
    """
    return {
        "id": document.id,
        "kind": str(document.kind),
        "fileName": document.file_name,
        "mimeType": document.mime_type,
        "fileSize": document.file_size,
        "checksumSha256": document.checksum_sha256,
        "verified": document.verified,
        "uploadedAt": _iso(document.uploaded_at),
    }


def serialize(
    application: DoctorApplication,
    documents: list[DoctorApplicationDocument],
    *,
    include_review_notes: bool = False,
    applicant: User | None = None,
) -> dict[str, Any]:
    """The application as JSON.

    ``review_notes`` is internal and is returned only to a reviewer. The
    applicant sees ``rejectionReason``, which is written for them.
    """
    body: dict[str, Any] = {
        "id": application.id,
        "userId": application.user_id,
        "status": str(application.status),
        "fullName": application.full_name,
        "phone": application.phone,
        "nationalId": application.national_id,
        "address": application.address,
        "registrationNumber": application.registration_number,
        "specialization": application.specialization,
        "departmentId": application.department_id,
        "qualifications": list(application.qualifications or []),
        "yearsExperience": application.years_experience,
        "previousHospital": application.previous_hospital,
        "clinicName": application.clinic_name,
        "city": application.city,
        "addressLine": application.address_line,
        "latitude": float(application.latitude) if application.latitude is not None else None,
        "longitude": float(application.longitude) if application.longitude is not None else None,
        "consultationFee": float(application.consultation_fee)
        if application.consultation_fee is not None
        else None,
        "availability": list(application.availability or []),
        "submittedAt": _iso(application.submitted_at),
        "reviewedAt": _iso(application.reviewed_at),
        "rejectionReason": application.rejection_reason,
        "missingFields": missing_fields(application),
        "canEdit": application.status in EDITABLE,
        "documents": [serialize_document(document) for document in documents],
        "updatedAt": _iso(application.updated_at),
    }
    if include_review_notes:
        body["reviewNotes"] = application.review_notes
        body["reviewedById"] = application.reviewed_by_id
    if applicant is not None:
        body["applicant"] = {
            "id": applicant.id,
            "name": applicant.name,
            "email": applicant.email,
            "status": str(applicant.status),
        }
    return body

"""Patient profile and directory.

Every route here is guarded twice: a permission decides whether the caller may
read patients *at all*, and ``require_patient_access`` decides whether they may
read *this* patient. The patient's own id always comes from their session, never
from the path — spec §8.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Row, func, or_, select

from app.api.deps import (
    CurrentAuth,
    DbSession,
    client_ip,
    require_patient_access,
    require_permission,
)
from app.api.responses import Page, ok, pagination
from app.core.errors import forbidden, not_found
from app.core.ratelimit import limit
from app.db.enums import AuditAction, AuditSeverity, Gender, Role
from app.db.models import Patient, User
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.patients.export import build_export

router = APIRouter(prefix="/patients", tags=["patients"])

#: An export is the heaviest read a patient can ask for — eight queries and the
#: whole history in one response. Five an hour is more than anyone taking a copy
#: of their record needs, and few enough that a stolen session cannot sit there
#: pulling the same chart repeatedly while the owner is still signed in.
ExportRateLimit = Annotated[None, Depends(limit(times=5, seconds=3600, scope="patient_export"))]

_PHONE = r"^\+?[\d\s-]{7,20}$"


class PatientProfileUpdate(BaseModel):
    """What a patient may change about themselves.

    Deliberately excludes allergies and chronic conditions: those are clinical
    facts a doctor records. A patient reports them through the symptom /
    document flow, where they land in the staging tier for review (conflict C7).
    """

    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True)

    phone: Annotated[str, Field(pattern=_PHONE)] | None = None
    address: Annotated[str, Field(max_length=500)] | None = None
    date_of_birth: datetime | None = Field(default=None, alias="dateOfBirth")
    gender: Gender | None = None
    blood_group: (
        Annotated[str, Field(pattern=r"^(A|B|AB|O)[+-]$")] | None
    ) = Field(default=None, alias="bloodGroup")
    emergency_contact_name: Annotated[str, Field(max_length=120)] | None = Field(
        default=None, alias="emergencyContactName"
    )
    emergency_contact_phone: Annotated[str, Field(pattern=_PHONE)] | None = Field(
        default=None, alias="emergencyContactPhone"
    )


class ConsentUpdate(BaseModel):
    """AI / speech processing consent (conflict C2).

    Withdrawal disables only those features; the rest of the portal keeps working.
    """

    granted: bool


def _serialize(patient: Patient, user: User, include_clinical: bool = True) -> dict[str, Any]:
    """Shape a patient for the caller.

    ``include_clinical`` is false for administrators. An admin passes the
    resource check through ``patient:read:any`` — which exists so they can run
    the hospital, not so they can read charts. Allergies and chronic conditions
    are clinical facts and stay behind a care relationship, matching the split
    the permission catalogue already draws.
    """
    payload = {
        "id": patient.id,
        "name": user.name,
        "email": user.email,
        "phone": user.phone,
        "medicalRecordNumber": patient.medical_record_number,
        "dateOfBirth": patient.date_of_birth.date().isoformat() if patient.date_of_birth else None,
        "gender": str(patient.gender),
        "bloodGroup": patient.blood_group,
        "address": patient.address,
        "emergencyContactName": patient.emergency_contact_name,
        "emergencyContactPhone": patient.emergency_contact_phone,
        "aiConsentGranted": patient.ai_consent_active,
    }
    if include_clinical:
        payload["allergies"] = patient.allergies
        payload["chronicConditions"] = patient.chronic_conditions
    return payload


async def _load(db: DbSession, patient_id: str) -> Row[tuple[Patient, User]]:
    row = (
        await db.execute(
            select(Patient, User).join(User, User.id == Patient.user_id).where(Patient.id == patient_id)
        )
    ).first()
    if row is None:
        raise not_found("Patient")
    return row


@router.get("/me")
async def my_profile(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    if auth.role != Role.PATIENT or not auth.patient_id:
        raise forbidden("This endpoint is for patients.")
    patient, user = await _load(db, auth.patient_id)
    return ok(_serialize(patient, user))


@router.patch("/me")
async def update_my_profile(
    payload: PatientProfileUpdate, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    if auth.role != Role.PATIENT or not auth.patient_id:
        raise forbidden("This endpoint is for patients.")

    patient, user = await _load(db, auth.patient_id)
    changed = payload.model_dump(exclude_none=True)

    if "phone" in changed:
        user.phone = changed.pop("phone")
    for field, value in changed.items():
        if field == "date_of_birth" and isinstance(value, datetime):
            value = value.replace(tzinfo=None)
        setattr(patient, field, value)
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.USER_UPDATED,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=patient.id,
            entity_type="Patient",
            entity_id=patient.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            # Field names only — the values are the patient's personal data.
            metadata={"fields": sorted(changed) + (["phone"] if "phone" not in changed else [])},
        ),
    )
    return ok(_serialize(patient, user))


@router.put("/me/ai-consent")
async def set_ai_consent(
    payload: ConsentUpdate, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    if auth.role != Role.PATIENT or not auth.patient_id:
        raise forbidden("This endpoint is for patients.")

    patient, _user = await _load(db, auth.patient_id)
    now = datetime.utcnow().replace(microsecond=0)
    if payload.granted:
        patient.ai_consent_granted_at = now
    else:
        patient.ai_consent_withdrawn_at = now
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.CONFIG_CHANGED,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=patient.id,
            entity_type="Patient",
            entity_id=patient.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"setting": "aiConsent", "granted": payload.granted},
        ),
    )
    return ok({"aiConsentGranted": patient.ai_consent_active})


@router.get("/me/export")
async def export_my_record(
    request: Request, auth: CurrentAuth, db: DbSession, _: ExportRateLimit
) -> dict[str, Any]:
    """A patient's whole record, for them to keep.

    Declared before ``/{patient_id}`` because FastAPI matches in order and
    ``me`` would otherwise be read as a patient id.

    There is no ``patientId`` here and no administrative variant. The subject is
    the session's own patient, which is what makes this safe to leave
    unparameterised: the only record you can export is yours.

    Recorded at NOTICE rather than INFO. Reading one chart and taking a copy of
    every diagnosis the hospital holds about a person are different events, and
    an access report that files them under the same heading cannot tell the
    difference later — including when the person doing it is not the patient but
    somebody who has their session.
    """
    if auth.role != Role.PATIENT or not auth.patient_id:
        raise forbidden("This endpoint is for patients.")

    patient, user = await _load(db, auth.patient_id)
    bundle = await build_export(db, patient, user)

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.PATIENT_DATA_EXPORTED,
            user_id=auth.user_id,
            actor_role=auth.role,
            severity=AuditSeverity.NOTICE,
            patient_id=patient.id,
            entity_type="Patient",
            entity_id=patient.id,
            ip_address=client_ip(request),
            user_agent=request.headers.get("user-agent"),
            request_id=getattr(request.state, "request_id", None),
            # Counts, never content. How much left the building is the useful
            # fact; copying the diagnoses into the audit log to say so would put
            # a second plaintext copy of them in the one table nobody can delete
            # from (C5).
            metadata={"counts": bundle["counts"], "truncated": bundle["truncated"]},
        ),
    )
    return ok(bundle)


@router.get("")
async def list_patients(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    _: Annotated[object, Depends(require_permission(Permission.PATIENT_READ_ANY))],
    search: str | None = Query(default=None, max_length=100),
) -> dict[str, Any]:
    """Administrative roster.

    Requires ``patient:read:any``, which only ADMIN holds — and note what an
    admin sees here: identity and contact details for running the hospital, not
    allergies, conditions or any clinical content.
    """
    filters = []
    if search:
        filters.append(
            or_(
                User.name.ilike(f"%{search}%"),
                User.email.ilike(f"%{search}%"),
                Patient.medical_record_number.ilike(f"%{search}%"),
            )
        )

    total = (
        await db.execute(
            select(func.count(Patient.id)).join(User, User.id == Patient.user_id).where(*filters)
        )
    ).scalar_one()

    rows = (
        await db.execute(
            select(Patient, User)
            .join(User, User.id == Patient.user_id)
            .where(*filters)
            .order_by(User.name)
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()

    return ok(
        [
            {
                "id": patient.id,
                "name": user.name,
                "email": user.email,
                "phone": user.phone,
                "medicalRecordNumber": patient.medical_record_number,
                "status": str(user.status),
            }
            for patient, user in rows
        ],
        page.meta(total),
    )


@router.get("/{patient_id}")
async def get_patient(
    patient_id: str,
    request: Request,
    db: DbSession,
    auth: Annotated[Any, Depends(require_patient_access)],
) -> dict[str, Any]:
    """Read one patient.

    ``require_patient_access`` has already established that this caller has a
    real relationship to this patient — ownership, an active care relationship,
    an administrative permission, or a live break-glass grant — and has audited
    the attempt either way.
    """
    patient, user = await _load(db, patient_id)

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.PATIENT_RECORD_VIEW,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=patient_id,
            entity_type="Patient",
            entity_id=patient_id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            emergency_access_id=auth.emergency_access_id,
        ),
    )
    return ok(_serialize(patient, user, include_clinical=auth.role != Role.ADMIN))

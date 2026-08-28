"""Prescriptions.

Medication is the part of the record where a mistake reaches the patient
fastest, so two rules differ from the rest of the clinical write model:

* **Nothing is ever deleted.** A prescription is discontinued, which keeps it in
  the history with an end date. Deleting it would erase the fact that someone
  was taking it, which is exactly what the next clinician needs to know.
* **Stopping is wider than editing.** Only the prescriber may change a
  prescription's details, but any doctor treating the patient may discontinue
  it — noticing a dangerous interaction should not have to wait for the original
  prescriber to be on shift. Who stopped it, and why, is recorded.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.errors import bad_request, conflict, forbidden
from app.db.base import new_id, utcnow
from app.db.enums import AuditAction, Role
from app.db.models import MedicalRecord, Prescription
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.records import service
from app.modules.records.access import clinical_scope, require_clinical_access

router = APIRouter(prefix="/prescriptions", tags=["prescriptions"])

RequirePrescribe = Annotated[
    object, Depends(require_permission(Permission.PRESCRIPTION_WRITE))
]


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(UTC).replace(tzinfo=None)
    return value.replace(microsecond=0)


class PrescriptionCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    patient_id: str = Field(alias="patientId", min_length=1, max_length=64)
    medical_record_id: str | None = Field(default=None, alias="medicalRecordId", max_length=64)
    #: Free text rather than a coded drug list. A formulary with interaction
    #: checking is a different system; this one must not imply it has one.
    medication: Annotated[str, Field(min_length=1, max_length=200)]
    dosage: Annotated[str, Field(min_length=1, max_length=100)]
    frequency: Annotated[str, Field(min_length=1, max_length=100)]
    duration: Annotated[str, Field(min_length=1, max_length=100)]
    instructions: Annotated[str, Field(max_length=2000)] | None = None
    start_date: datetime | None = Field(default=None, alias="startDate")
    end_date: datetime | None = Field(default=None, alias="endDate")

    @field_validator("start_date", "end_date")
    @classmethod
    def _normalize(cls, value: datetime | None) -> datetime | None:
        return _naive_utc(value)

    @model_validator(mode="after")
    def _dates_are_ordered(self) -> PrescriptionCreate:
        if self.start_date and self.end_date and self.end_date <= self.start_date:
            raise ValueError("endDate must be later than startDate")
        return self


class PrescriptionUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    dosage: Annotated[str, Field(min_length=1, max_length=100)] | None = None
    frequency: Annotated[str, Field(min_length=1, max_length=100)] | None = None
    duration: Annotated[str, Field(min_length=1, max_length=100)] | None = None
    instructions: Annotated[str, Field(max_length=2000)] | None = None
    end_date: datetime | None = Field(default=None, alias="endDate")

    @field_validator("end_date")
    @classmethod
    def _normalize(cls, value: datetime | None) -> datetime | None:
        return _naive_utc(value)


class DiscontinueRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    reason: Annotated[str, Field(max_length=500)] | None = None


async def _audit(
    request: Request,
    db: DbSession,
    auth: CurrentAuth,
    action: AuditAction,
    prescription: Prescription,
    metadata: dict[str, Any] | None = None,
) -> None:
    await record_audit(
        db,
        AuditEntry(
            action=action,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=prescription.patient_id,
            entity_type="Prescription",
            entity_id=prescription.id,
            ip_address=client_ip(request),
            user_agent=request.headers.get("user-agent"),
            request_id=getattr(request.state, "request_id", None),
            emergency_access_id=auth.emergency_access_id,
            # The drug name is clinical content and stays out of the log; the
            # ids are enough to find the row it describes.
            metadata=metadata,
        ),
    )


@router.get("")
async def list_prescriptions(
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    patient_id: Annotated[str | None, Query(alias="patientId", max_length=64)] = None,
    active_only: Annotated[bool, Query(alias="activeOnly")] = False,
) -> dict[str, Any]:
    """Current and past medication.

    ``activeOnly`` answers "what is this patient taking right now", which is the
    question a prescriber needs answered before adding anything.
    """
    if patient_id:
        await require_clinical_access(db, auth, request, patient_id, what="Prescription")
        filters: list[Any] = [Prescription.patient_id == patient_id]
    else:
        filters = [clinical_scope(auth, Prescription.patient_id)]

    if active_only:
        filters.append(Prescription.active.is_(True))

    total = (await db.execute(select(func.count(Prescription.id)).where(*filters))).scalar_one()
    rows = (
        await db.execute(
            service.prescription_columns()
            .where(*filters)
            .order_by(Prescription.active.desc(), Prescription.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()

    return ok([service.serialize_prescription_row(row) for row in rows], page.meta(total))


@router.get("/{prescription_id}")
async def get_prescription(
    prescription_id: str, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    row = await service.load_prescription(db, prescription_id)
    await require_clinical_access(db, auth, request, row[0].patient_id, what="Prescription")
    return ok(service.serialize_prescription_row(row))


@router.post("", status_code=201)
async def prescribe(
    payload: PrescriptionCreate,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequirePrescribe,
) -> dict[str, Any]:
    if auth.role != Role.DOCTOR or not auth.doctor_id:
        raise bad_request("Only a doctor can prescribe.")

    await require_clinical_access(db, auth, request, payload.patient_id, what="Prescription")

    if payload.medical_record_id:
        # A prescription filed under a record must belong to the same patient,
        # or a chart would show medication that was never for them.
        record_patient = (
            await db.execute(
                select(MedicalRecord.patient_id).where(
                    MedicalRecord.id == payload.medical_record_id
                )
            )
        ).scalar_one_or_none()
        if record_patient is None:
            raise bad_request("That medical record does not exist.")
        if record_patient != payload.patient_id:
            raise bad_request("That medical record belongs to a different patient.")

    prescription = Prescription(
        id=new_id(),
        patient_id=payload.patient_id,
        doctor_id=auth.doctor_id,
        medical_record_id=payload.medical_record_id,
        medication=payload.medication,
        dosage=payload.dosage,
        frequency=payload.frequency,
        duration=payload.duration,
        instructions=payload.instructions,
        start_date=payload.start_date or utcnow(),
        end_date=payload.end_date,
        active=True,
    )
    db.add(prescription)
    await db.flush()

    await _audit(
        request,
        db,
        auth,
        AuditAction.PRESCRIPTION_CREATED,
        prescription,
        {"medicalRecordId": payload.medical_record_id},
    )

    row = await service.load_prescription(db, prescription.id)
    return ok(service.serialize_prescription_row(row))


@router.patch("/{prescription_id}")
async def update_prescription(
    prescription_id: str,
    payload: PrescriptionUpdate,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequirePrescribe,
) -> dict[str, Any]:
    """Adjust a prescription. The prescriber only, and only while it is active.

    Notably absent: ``medication``. Changing which drug a prescription is for
    turns one medication's history into another's. Stop this one and write a new
    prescription instead.
    """
    row = await service.load_prescription(db, prescription_id)
    prescription: Prescription = row[0]

    service.require_prescriber(auth, prescription)
    await require_clinical_access(db, auth, request, prescription.patient_id, what="Prescription")

    if not prescription.active:
        raise conflict("This prescription has been discontinued. Write a new one instead.")

    changed = payload.model_dump(exclude_unset=True, by_alias=False)
    if not changed:
        raise bad_request("Provide at least one field to change.")

    if (
        "end_date" in changed
        and changed["end_date"]
        and prescription.start_date
        and changed["end_date"] <= prescription.start_date
    ):
        raise bad_request("endDate must be later than the start date.")

    for field, value in changed.items():
        setattr(prescription, field, value)
    await db.flush()

    await _audit(
        request,
        db,
        auth,
        AuditAction.PRESCRIPTION_UPDATED,
        prescription,
        {"fields": sorted(changed)},
    )

    updated = await service.load_prescription(db, prescription.id)
    return ok(service.serialize_prescription_row(updated))


@router.post("/{prescription_id}/discontinue")
async def discontinue(
    prescription_id: str,
    payload: DiscontinueRequest,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequirePrescribe,
) -> dict[str, Any]:
    """Stop a medication.

    Deliberately open to any doctor treating the patient, not just the
    prescriber: spotting an interaction should not wait for whoever wrote it to
    be on shift. The row stays — with ``active`` false and an end date — because
    the fact that a patient was on this drug is itself clinical history.
    """
    row = await service.load_prescription(db, prescription_id)
    prescription: Prescription = row[0]

    if auth.role != Role.DOCTOR or not auth.doctor_id:
        raise forbidden("Only a doctor can discontinue a prescription.")
    await require_clinical_access(db, auth, request, prescription.patient_id, what="Prescription")

    if not prescription.active:
        raise conflict("This prescription has already been discontinued.")

    prescription.active = False
    prescription.end_date = utcnow()
    await db.flush()

    await _audit(
        request,
        db,
        auth,
        AuditAction.PRESCRIPTION_UPDATED,
        prescription,
        {
            "operation": "discontinue",
            # Worth recording explicitly: a doctor stopping someone else's
            # prescription is a normal but noteworthy clinical event.
            "byPrescriber": auth.doctor_id == prescription.doctor_id,
            "hasReason": bool(payload.reason),
        },
    )

    updated = await service.load_prescription(db, prescription.id)
    return ok(service.serialize_prescription_row(updated))

"""Medical records — the physician-authored clinical history (spec §13).

Reads are gated by ``require_clinical_access``, which is narrower than the
patient gate used elsewhere: an administrator holds ``patient:read:any`` and
still gets 403 here, because running the hospital is not a reason to read a
diagnosis (R2). Writes need ``record:write``, which no patient role holds, so
"patients must not be able to modify physician-authored records" is a property
of the catalogue rather than a check someone has to remember.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import func, select, update

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.errors import bad_request
from app.db.base import new_id
from app.db.enums import AuditAction, DataSource, Role
from app.db.models import MedicalRecord, ReportedSymptom
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.records import service
from app.modules.records.access import clinical_scope, require_clinical_access

router = APIRouter(prefix="/records", tags=["records"])

RequireRecordWrite = Annotated[object, Depends(require_permission(Permission.RECORD_WRITE))]


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(UTC).replace(tzinfo=None)
    return value.replace(microsecond=0)


class RecordCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    patient_id: str = Field(alias="patientId", min_length=1, max_length=64)
    #: The consultation this note came from, when there was one.
    appointment_id: str | None = Field(default=None, alias="appointmentId", max_length=64)
    symptoms: Annotated[str, Field(max_length=4000)] | None = None
    diagnosis: Annotated[str, Field(max_length=4000)] | None = None
    treatment_plan: Annotated[str, Field(max_length=8000)] | None = Field(
        default=None, alias="treatmentPlan"
    )
    notes: Annotated[str, Field(max_length=8000)] | None = None
    follow_up_date: datetime | None = Field(default=None, alias="followUpDate")
    follow_up_notes: Annotated[str, Field(max_length=2000)] | None = Field(
        default=None, alias="followUpNotes"
    )
    #: Patient-reported rows this note accounts for. Naming them here is what
    #: "a doctor validated this" means in practice: the words the patient typed
    #: stop being an open question and point at the record that answered them.
    reported_symptom_ids: list[Annotated[str, Field(max_length=64)]] = Field(
        default_factory=list, alias="reportedSymptomIds", max_length=50
    )

    @field_validator("follow_up_date")
    @classmethod
    def _normalize(cls, value: datetime | None) -> datetime | None:
        return _naive_utc(value)

    @model_validator(mode="after")
    def _not_entirely_empty(self) -> RecordCreate:
        # An empty record is not a record. Without this a stray POST would put a
        # blank entry in a patient's permanent history.
        if not any(
            (self.symptoms, self.diagnosis, self.treatment_plan, self.notes, self.follow_up_notes)
        ):
            raise ValueError(
                "a record needs at least one of: symptoms, diagnosis, treatmentPlan, notes"
            )
        return self


class RecordUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    symptoms: Annotated[str, Field(max_length=4000)] | None = None
    diagnosis: Annotated[str, Field(max_length=4000)] | None = None
    treatment_plan: Annotated[str, Field(max_length=8000)] | None = Field(
        default=None, alias="treatmentPlan"
    )
    notes: Annotated[str, Field(max_length=8000)] | None = None
    follow_up_date: datetime | None = Field(default=None, alias="followUpDate")
    follow_up_notes: Annotated[str, Field(max_length=2000)] | None = Field(
        default=None, alias="followUpNotes"
    )

    @field_validator("follow_up_date")
    @classmethod
    def _normalize(cls, value: datetime | None) -> datetime | None:
        return _naive_utc(value)


async def _audit_record(
    request: Request,
    db: DbSession,
    auth: CurrentAuth,
    action: AuditAction,
    record: MedicalRecord,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Audit a record event.

    Metadata names fields, never their contents: an audit log readable by
    administrators must not become a second copy of the chart they are not
    allowed to read.
    """
    await record_audit(
        db,
        AuditEntry(
            action=action,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=record.patient_id,
            entity_type="MedicalRecord",
            entity_id=record.id,
            ip_address=client_ip(request),
            user_agent=request.headers.get("user-agent"),
            request_id=getattr(request.state, "request_id", None),
            emergency_access_id=auth.emergency_access_id,
            metadata=metadata,
        ),
    )


@router.get("")
async def list_records(
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    patient_id: Annotated[str | None, Query(alias="patientId", max_length=64)] = None,
    include_prescriptions: Annotated[bool, Query(alias="includePrescriptions")] = False,
) -> dict[str, Any]:
    """A patient's chart, or the caller's own history.

    With ``patientId`` the request is gated per patient, which is what lets a
    doctor open one chart and a nurse holding a break-glass grant open exactly
    the patient it was issued for. Without it the caller sees their own scope:
    their records if they are a patient, their caseload if they are a doctor.
    """
    if patient_id:
        await require_clinical_access(db, auth, request, patient_id)
        filters = [MedicalRecord.patient_id == patient_id]
    else:
        filters = [clinical_scope(auth, MedicalRecord.patient_id)]

    total = (
        await db.execute(select(func.count(MedicalRecord.id)).where(*filters))
    ).scalar_one()

    rows = (
        await db.execute(
            service.record_columns()
            .where(*filters)
            .order_by(MedicalRecord.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()

    grouped = (
        await service.prescriptions_for_records(db, [row[0].id for row in rows])
        if include_prescriptions
        else {}
    )

    if patient_id:
        # One entry for the chart view rather than one per row: the event is
        # "this clinician opened this patient's history". Logged against the
        # patient, not a record, so an empty chart is audited too — otherwise
        # looking at someone with no history would leave no trace at all.
        await record_audit(
            db,
            AuditEntry(
                action=AuditAction.PATIENT_RECORD_VIEW,
                user_id=auth.user_id,
                actor_role=auth.role,
                patient_id=patient_id,
                entity_type="MedicalRecord",
                ip_address=client_ip(request),
                user_agent=request.headers.get("user-agent"),
                request_id=getattr(request.state, "request_id", None),
                emergency_access_id=auth.emergency_access_id,
                metadata={"scope": "chart", "returned": len(rows)},
            ),
        )

    return ok(
        [
            service.serialize_record_row(
                row, grouped.get(row[0].id, []) if include_prescriptions else None
            )
            for row in rows
        ],
        page.meta(total),
    )


@router.get("/reported-symptoms")
async def list_reported_symptoms(
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    patient_id: Annotated[str | None, Query(alias="patientId", max_length=64)] = None,
) -> dict[str, Any]:
    """What the patient said, before any clinician touched it.

    These rows are the missing half of the symptom checker. They were being
    written and never read: a patient described their symptoms to the assistant,
    the words were stored with their provenance, and no screen anywhere showed
    them to the doctor who would sit down with that patient an hour later.

    Gated exactly like the chart, because that is what they are part of. What
    they are *not* is clinical findings — every row carries the source it came
    from and whether a doctor has since promoted it into a record, so nothing
    here can be mistaken for a diagnosis somebody made.
    """
    if patient_id:
        await require_clinical_access(db, auth, request, patient_id)
        filters = [ReportedSymptom.patient_id == patient_id]
    else:
        filters = [clinical_scope(auth, ReportedSymptom.patient_id)]

    total = (
        await db.execute(select(func.count(ReportedSymptom.id)).where(*filters))
    ).scalar_one()

    rows = (
        await db.execute(
            select(ReportedSymptom)
            .where(*filters)
            .order_by(ReportedSymptom.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).scalars().all()

    return ok([service.serialize_reported_symptom(row) for row in rows], page.meta(total))


@router.get("/{record_id}")
async def get_record(
    record_id: str, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    row = await service.load_record(db, record_id)
    record: MedicalRecord = row[0]

    await require_clinical_access(db, auth, request, record.patient_id)

    grouped = await service.prescriptions_for_records(db, [record.id])
    await _audit_record(request, db, auth, AuditAction.PATIENT_RECORD_VIEW, record)
    return ok(service.serialize_record_row(row, grouped.get(record.id, [])))


@router.post("", status_code=201)
async def create_record(
    payload: RecordCreate,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireRecordWrite,
) -> dict[str, Any]:
    """File a new record against a patient.

    ``record:write`` is held only by doctors, and the clinical-access check
    below then requires a real care relationship — so holding the role is not
    enough to write into a stranger's history.
    """
    if auth.role != Role.DOCTOR or not auth.doctor_id:
        raise bad_request("Only a doctor can author a medical record.")

    await require_clinical_access(db, auth, request, payload.patient_id)

    if payload.appointment_id:
        await service.validate_appointment_link(
            db, payload.appointment_id, payload.patient_id, auth.doctor_id
        )

    record = MedicalRecord(
        id=new_id(),
        patient_id=payload.patient_id,
        doctor_id=auth.doctor_id,
        appointment_id=payload.appointment_id,
        symptoms=payload.symptoms,
        diagnosis=payload.diagnosis,
        treatment_plan=payload.treatment_plan,
        notes=payload.notes,
        follow_up_date=payload.follow_up_date,
        follow_up_notes=payload.follow_up_notes,
        # Authored by a clinician, by construction: there is no code path that
        # writes any other source into this table.
        source=DataSource.PHYSICIAN,
    )
    db.add(record)
    await db.flush()

    if payload.reported_symptom_ids:
        # Scoped to this patient on purpose. The ids arrive from a client, and
        # without the patient filter a doctor with access to one chart could
        # stamp somebody else's rows as reviewed by naming their ids.
        await db.execute(
            update(ReportedSymptom)
            .where(
                ReportedSymptom.id.in_(payload.reported_symptom_ids),
                ReportedSymptom.patient_id == payload.patient_id,
            )
            .values(
                promoted_to_record_id=record.id,
                promoted_by_id=auth.doctor_id,
                promoted_at=datetime.now(UTC).replace(tzinfo=None),
            )
        )

    await _audit_record(
        request,
        db,
        auth,
        AuditAction.PATIENT_RECORD_CREATE,
        record,
        {
            "appointmentId": payload.appointment_id,
            "fields": sorted(
                key
                for key, value in payload.model_dump(
                    exclude={"patient_id", "appointment_id", "reported_symptom_ids"}
                ).items()
                if value is not None
            ),
            # Counted rather than listed: which rows a doctor closed out is on
            # the rows themselves, and the audit entry only needs to say that
            # this note answered some.
            "reportedSymptomsPromoted": len(payload.reported_symptom_ids),
        },
    )

    row = await service.load_record(db, record.id)
    return ok(service.serialize_record_row(row, []))


@router.patch("/{record_id}")
async def amend_record(
    record_id: str,
    payload: RecordUpdate,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireRecordWrite,
) -> dict[str, Any]:
    """Amend a record.

    Author-only: a second opinion is a second record, not an edit to someone
    else's clinical judgement under their name. The change is audited by field
    name so the trail shows what moved without copying the content into a log
    that administrators can read.
    """
    row = await service.load_record(db, record_id)
    record: MedicalRecord = row[0]

    service.require_author(auth, record)
    await require_clinical_access(db, auth, request, record.patient_id)

    changed = payload.model_dump(exclude_unset=True, by_alias=False)
    if not changed:
        raise bad_request("Provide at least one field to amend.")

    for field, value in changed.items():
        setattr(record, field, value)
    await db.flush()

    await _audit_record(
        request,
        db,
        auth,
        AuditAction.PATIENT_RECORD_UPDATE,
        record,
        {"fields": sorted(changed)},
    )

    updated = await service.load_record(db, record.id)
    grouped = await service.prescriptions_for_records(db, [record.id])
    return ok(service.serialize_record_row(updated, grouped.get(record.id, [])))

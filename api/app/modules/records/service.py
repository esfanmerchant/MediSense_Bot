"""Medical records and prescriptions: shaping, validation and write rules.

The governing rule (spec §13) is that a medical record is *physician-authored*.
Patients read their records and cannot write them — enforced by the permission
catalogue, where no patient role holds ``record:write``. What a patient reports
about themselves is not a record: it belongs in the staging tier, and only a
doctor's act of promoting it gives the statement a clinical author.

Records are also amended, never rewritten by whoever happens to be logged in.
Only the authoring doctor may edit their own note; a second opinion is a second
record. Every edit is audited by field name, so the trail says what changed
without copying clinical values into the audit log.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AuthContext
from app.core.errors import bad_request, forbidden, not_found
from app.db.enums import Role
from app.db.models import (
    Appointment,
    Doctor,
    MedicalRecord,
    Prescription,
    ReportedSymptom,
    User,
)
from app.modules.appointments.schedule import iso_utc


def iso_or_none(value: datetime | None) -> str | None:
    return iso_utc(value) if value else None


#: How far ``updatedAt`` may sit past ``createdAt`` while still meaning "never
#: amended". The two columns default to separate ``utcnow()`` calls, so a row
#: written across a millisecond boundary has ``updatedAt`` marginally later than
#: ``createdAt`` through no edit at all. Comparing them directly would put an
#: "Amended" badge on a brand-new note — on a medical record that is a
#: meaningful and false claim, so the comparison is given room.
AMENDMENT_THRESHOLD = timedelta(seconds=1)


def was_amended(record: MedicalRecord) -> bool:
    return record.updated_at - record.created_at > AMENDMENT_THRESHOLD


# ---------------------------------------------------------------------------
# Medical records
# ---------------------------------------------------------------------------


def record_columns() -> Select[Any]:
    """Every record read joins its author, so a chart never shows a bare id."""
    return (
        select(MedicalRecord, User.name, Doctor.specialization)
        .join(Doctor, Doctor.id == MedicalRecord.doctor_id)
        .join(User, User.id == Doctor.user_id)
    )


def serialize_record(
    record: MedicalRecord,
    doctor_name: str | None = None,
    specialization: str | None = None,
    prescriptions: list[Prescription] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": record.id,
        "patientId": record.patient_id,
        "doctorId": record.doctor_id,
        "doctorName": doctor_name,
        "specialization": specialization,
        "appointmentId": record.appointment_id,
        "symptoms": record.symptoms,
        "diagnosis": record.diagnosis,
        "treatmentPlan": record.treatment_plan,
        "notes": record.notes,
        "followUpDate": iso_or_none(record.follow_up_date),
        "followUpNotes": record.follow_up_notes,
        # Always PHYSICIAN for a record. Carried on the wire anyway so a client
        # can never present machine output as a clinician's finding (conflict C7).
        "source": str(record.source),
        "createdAt": iso_utc(record.created_at),
        "updatedAt": iso_utc(record.updated_at),
        "amended": was_amended(record),
    }
    if prescriptions is not None:
        payload["prescriptions"] = [serialize_prescription(p) for p in prescriptions]
    return payload


def serialize_record_row(row: Any, prescriptions: list[Prescription] | None = None) -> dict[str, Any]:
    record, doctor_name, specialization = row
    return serialize_record(record, doctor_name, specialization, prescriptions)


def require_author(auth: AuthContext, record: MedicalRecord) -> None:
    """Only the doctor who wrote a note may amend it.

    Another doctor disagreeing writes their own record; they do not edit someone
    else's clinical judgement under that person's name. This is also why an
    administrator cannot reach here at all — they hold no ``record:write``.
    """
    if auth.role != Role.DOCTOR or auth.doctor_id != record.doctor_id:
        raise forbidden("Only the doctor who wrote this record can amend it.")


async def load_record(db: AsyncSession, record_id: str) -> Any:
    row = (await db.execute(record_columns().where(MedicalRecord.id == record_id))).first()
    if row is None:
        raise not_found("Medical record")
    return row


async def validate_appointment_link(
    db: AsyncSession, appointment_id: str, patient_id: str, doctor_id: str
) -> None:
    """A record may only be filed against the consultation it came from.

    Without this a doctor could attach a note to any appointment id they knew,
    which would misattribute the encounter and, once billing lands, bill the
    wrong visit.
    """
    appointment = (
        await db.execute(
            select(Appointment.patient_id, Appointment.doctor_id).where(
                Appointment.id == appointment_id
            )
        )
    ).first()
    if appointment is None:
        raise not_found("Appointment")
    if appointment.patient_id != patient_id or appointment.doctor_id != doctor_id:
        raise bad_request("That appointment is not this doctor's consultation with this patient.")


async def prescriptions_for_records(
    db: AsyncSession, record_ids: list[str]
) -> dict[str, list[Prescription]]:
    """Prescriptions grouped by record, fetched in one query.

    A chart is a list, so loading these per row would issue a query per record.
    """
    if not record_ids:
        return {}
    rows = (
        (
            await db.execute(
                select(Prescription)
                .where(Prescription.medical_record_id.in_(record_ids))
                .order_by(Prescription.created_at)
            )
        )
        .scalars()
        .all()
    )
    grouped: dict[str, list[Prescription]] = {}
    for row in rows:
        if row.medical_record_id:
            grouped.setdefault(row.medical_record_id, []).append(row)
    return grouped


# ---------------------------------------------------------------------------
# Prescriptions
# ---------------------------------------------------------------------------


def serialize_prescription(
    prescription: Prescription, doctor_name: str | None = None
) -> dict[str, Any]:
    return {
        "id": prescription.id,
        "patientId": prescription.patient_id,
        "doctorId": prescription.doctor_id,
        "doctorName": doctor_name,
        "medicalRecordId": prescription.medical_record_id,
        "medication": prescription.medication,
        "dosage": prescription.dosage,
        "frequency": prescription.frequency,
        "duration": prescription.duration,
        "instructions": prescription.instructions,
        "startDate": iso_or_none(prescription.start_date),
        "endDate": iso_or_none(prescription.end_date),
        "active": prescription.active,
        "createdAt": iso_utc(prescription.created_at),
        "updatedAt": iso_utc(prescription.updated_at),
    }


def prescription_columns() -> Select[Any]:
    return (
        select(Prescription, User.name)
        .join(Doctor, Doctor.id == Prescription.doctor_id)
        .join(User, User.id == Doctor.user_id)
    )


def serialize_prescription_row(row: Any) -> dict[str, Any]:
    prescription, doctor_name = row
    return serialize_prescription(prescription, doctor_name)


async def load_prescription(db: AsyncSession, prescription_id: str) -> Any:
    row = (
        await db.execute(prescription_columns().where(Prescription.id == prescription_id))
    ).first()
    if row is None:
        raise not_found("Prescription")
    return row


def require_prescriber(auth: AuthContext, prescription: Prescription) -> None:
    """Editing the details of a prescription is the prescriber's alone.

    Discontinuing is different and deliberately wider — see the router: any
    doctor treating the patient may stop a medication, because noticing an
    interaction should not wait for the original prescriber to be on shift.
    """
    if auth.role != Role.DOCTOR or auth.doctor_id != prescription.doctor_id:
        raise forbidden("Only the prescribing doctor can change this prescription.")


def serialize_reported_symptom(row: ReportedSymptom) -> dict[str, Any]:
    """One thing a patient said about themselves, with where it came from.

    ``source`` and ``inputType`` travel with every row because the whole point
    of this table is that it is *not* a clinical finding. ``promotedAt`` is how
    a doctor tells what they have already dealt with from what is still new —
    without it the same three symptoms would sit at the top of the panel
    forever, and a panel that never empties stops being read.
    """
    return {
        "id": row.id,
        "patientId": row.patient_id,
        "symptom": row.symptom,
        "severity": row.severity,
        "duration": row.duration_text,
        "rawText": row.raw_text,
        "source": str(row.source),
        "inputType": str(row.input_type),
        "confidence": row.confidence,
        "promotedToRecordId": row.promoted_to_record_id,
        "promotedAt": iso_or_none(row.promoted_at),
        "createdAt": iso_utc(row.created_at),
    }

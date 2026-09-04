"""Everything the hospital holds about one patient, in one file they own.

A portal that shows a person their record but never lets them leave with it
makes the hospital the record's owner. This is the endpoint that says otherwise:
a patient changing hospital, seeing a doctor outside the platform, or applying
for insurance can take the whole thing with them, and needs nobody's permission
to do it.

**Scoped to the caller, always.** The patient id comes from the session and
nowhere else. There is no ``patientId`` parameter to get wrong, and no admin
form of this endpoint — an administrator who needs a patient's data has the
chart and the audit log, both of which record that they looked.

**Metadata for documents, not the files.** Uploads are scans and photographs;
inlining them would turn a 40 KB export into a 200 MB one and put base64 in a
file people open in a text editor. Each document is listed with its name, type,
size and checksum, and stays one signed link away in the portal.

**Bounded, and honest when it truncates.** Each collection has a ceiling. A
patient with forty thousand device readings should get a file that opens rather
than a request that runs out of memory, and ``truncated`` says plainly which
lists were cut — a silently short export of a medical record is worse than no
export, because it looks complete.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models import (
    Appointment,
    Invoice,
    MedicalDocument,
    MedicalRecord,
    MedicationReminder,
    Patient,
    Prescription,
    ReportedSymptom,
    User,
    Vital,
)
from app.modules.appointments import service as appointments
from app.modules.appointments.schedule import iso_utc
from app.modules.billing import service as billing
from app.modules.billing.router import under_review
from app.modules.documents.router import serialize as serialize_document
from app.modules.records import service as records
from app.modules.vitals.service import serialize_vital

#: The shape a reader can rely on. Bumped if a field is removed or its meaning
#: changes — a file somebody saved two years ago should still say what it is.
FORMAT = "medisense.patient-export"
FORMAT_VERSION = 1

#: Ceilings per collection, newest first. Clinical history is generous; device
#: readings are the one thing that can run to tens of thousands, so they get a
#: larger cap and are the list most likely to reach one.
LIMITS = {
    "appointments": 1000,
    "medicalRecords": 1000,
    "prescriptions": 1000,
    "medicationReminders": 200,
    "vitals": 5000,
    "reportedSymptoms": 1000,
    "documents": 1000,
    "invoices": 1000,
}


def _serialize_reminder(reminder: MedicationReminder, medication: str | None) -> dict[str, Any]:
    hours, minutes = divmod(reminder.at_minutes, 60)
    return {
        "id": reminder.id,
        "prescriptionId": reminder.prescription_id,
        "medication": medication,
        # Both forms: the stored integer, and the clock time it means in the
        # clinic's zone. A reader holding neither this codebase nor that
        # timezone cannot turn 1230 into half past eight in the evening.
        "atMinutes": reminder.at_minutes,
        "at": f"{hours:02d}:{minutes:02d}",
        "timezone": settings.CLINIC_TIMEZONE,
        "active": reminder.active,
        "createdAt": iso_utc(reminder.created_at),
    }


async def build_export(db: AsyncSession, patient: Patient, user: User) -> dict[str, Any]:
    """Assemble the bundle. One query per collection, never one per row."""
    truncated: list[str] = []

    def cap(name: str, rows: list[Any]) -> list[Any]:
        # Reaching the limit and being exactly at it are indistinguishable from
        # here, so both are reported. Overstating a truncation costs a sentence;
        # understating one hands somebody an incomplete medical history that
        # claims to be complete.
        if len(rows) >= LIMITS[name]:
            truncated.append(name)
        return rows

    appointment_rows = cap(
        "appointments",
        list(
            (
                await db.execute(
                    appointments.visible_columns()
                    .where(Appointment.patient_id == patient.id)
                    .order_by(Appointment.start_time.desc())
                    .limit(LIMITS["appointments"])
                )
            ).all()
        ),
    )

    record_rows = cap(
        "medicalRecords",
        list(
            (
                await db.execute(
                    records.record_columns()
                    .where(MedicalRecord.patient_id == patient.id)
                    .order_by(MedicalRecord.created_at.desc())
                    .limit(LIMITS["medicalRecords"])
                )
            ).all()
        ),
    )
    by_record = await records.prescriptions_for_records(db, [row[0].id for row in record_rows])

    # Every prescription, not only those hanging off a record: one written
    # without a note attached is still a medicine somebody was told to take.
    prescription_rows = cap(
        "prescriptions",
        list(
            (
                await db.execute(
                    records.prescription_columns()
                    .where(Prescription.patient_id == patient.id)
                    .order_by(Prescription.created_at.desc())
                    .limit(LIMITS["prescriptions"])
                )
            ).all()
        ),
    )

    reminder_rows = cap(
        "medicationReminders",
        list(
            (
                await db.execute(
                    select(MedicationReminder, Prescription.medication)
                    .join(Prescription, Prescription.id == MedicationReminder.prescription_id)
                    .where(MedicationReminder.patient_id == patient.id)
                    .order_by(MedicationReminder.at_minutes)
                    .limit(LIMITS["medicationReminders"])
                )
            ).all()
        ),
    )

    vitals = cap(
        "vitals",
        list(
            (
                await db.execute(
                    select(Vital)
                    .where(Vital.patient_id == patient.id)
                    .order_by(Vital.recorded_at.desc())
                    .limit(LIMITS["vitals"])
                )
            )
            .scalars()
            .all()
        ),
    )

    symptoms = cap(
        "reportedSymptoms",
        list(
            (
                await db.execute(
                    select(ReportedSymptom)
                    .where(ReportedSymptom.patient_id == patient.id)
                    .order_by(ReportedSymptom.created_at.desc())
                    .limit(LIMITS["reportedSymptoms"])
                )
            )
            .scalars()
            .all()
        ),
    )

    document_rows = cap(
        "documents",
        list(
            (
                await db.execute(
                    select(MedicalDocument, User.name)
                    .join(User, User.id == MedicalDocument.uploaded_by_id)
                    .where(
                        MedicalDocument.patient_id == patient.id,
                        MedicalDocument.deleted_at.is_(None),
                    )
                    .order_by(MedicalDocument.created_at.desc())
                    .limit(LIMITS["documents"])
                )
            ).all()
        ),
    )

    invoices = cap(
        "invoices",
        list(
            (
                await db.execute(
                    select(Invoice)
                    .where(Invoice.patient_id == patient.id)
                    .order_by(Invoice.created_at.desc())
                    .limit(LIMITS["invoices"])
                )
            )
            .scalars()
            .all()
        ),
    )
    waiting = await under_review(db, [invoice.id for invoice in invoices])

    bundle: dict[str, Any] = {
        "format": FORMAT,
        "formatVersion": FORMAT_VERSION,
        "exportedAt": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": {"system": "MediSense", "timezone": settings.CLINIC_TIMEZONE},
        "patient": {
            "id": patient.id,
            "name": user.name,
            "email": user.email,
            "phone": user.phone,
            "cnic": user.cnic,
            "medicalRecordNumber": patient.medical_record_number,
            "dateOfBirth": (
                patient.date_of_birth.date().isoformat() if patient.date_of_birth else None
            ),
            "gender": str(patient.gender),
            "bloodGroup": patient.blood_group,
            "address": patient.address,
            "allergies": patient.allergies,
            "chronicConditions": patient.chronic_conditions,
            "emergencyContactName": patient.emergency_contact_name,
            "emergencyContactPhone": patient.emergency_contact_phone,
            "registeredAt": iso_utc(user.created_at),
        },
        "appointments": [appointments.serialize_row(row) for row in appointment_rows],
        "medicalRecords": [
            records.serialize_record_row(row, by_record.get(row[0].id, [])) for row in record_rows
        ],
        "prescriptions": [records.serialize_prescription_row(row) for row in prescription_rows],
        "medicationReminders": [
            _serialize_reminder(reminder, medication) for reminder, medication in reminder_rows
        ],
        "vitals": [serialize_vital(vital) for vital in vitals],
        "reportedSymptoms": [records.serialize_reported_symptom(row) for row in symptoms],
        "documents": [serialize_document(document, name) for document, name in document_rows],
        "invoices": [
            billing.serialize(invoice, awaiting_review=invoice.id in waiting)
            for invoice in invoices
        ],
        # Said in the file itself, because the file outlives this conversation
        # and whoever opens it will wonder where the scans are.
        "documentsNote": (
            "Documents are listed by name, type and checksum. The files themselves "
            "stay in the portal — open each one there to download it."
        ),
    }

    bundle["counts"] = {key: len(value) for key, value in bundle.items() if isinstance(value, list)}
    bundle["truncated"] = sorted(truncated)
    if truncated:
        bundle["truncatedNote"] = (
            "These lists reached their per-export ceiling and hold only the most "
            "recent entries. Ask the hospital for the remainder."
        )
    return bundle

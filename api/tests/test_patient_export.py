"""Building a patient's export bundle.

This runs ``build_export`` for real — the same statements, the same serializers,
the same model instances — against a session that answers from memory instead of
Postgres. So it catches a column that does not exist, a serializer given the
wrong row shape, and a collection that quietly stopped being included, none of
which a test that reads the source would notice. What it does not cover is
whether the *rows* are correctly scoped to the caller; that is the endpoint's
job and the integration test's.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from app.db.enums import (
    AppointmentStatus,
    DataSource,
    DocumentType,
    Gender,
    InputType,
    InvoiceStatus,
    OcrStatus,
    Role,
)
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
from app.modules.patients.export import FORMAT, FORMAT_VERSION, LIMITS, build_export

NOW = datetime(2026, 9, 3, 9, 30)

#: Every list the bundle promises. Named here rather than derived from the
#: bundle, so *dropping* one from the export is a failing test — a check that
#: reads the output can only see what is there.
COLLECTIONS = (
    "appointments",
    "medicalRecords",
    "prescriptions",
    "medicationReminders",
    "vitals",
    "reportedSymptoms",
    "documents",
    "invoices",
)


# ---------------------------------------------------------------------------
# A session that answers from a dict
# ---------------------------------------------------------------------------


class Result:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def all(self) -> list[Any]:
        return list(self._rows)

    def scalars(self) -> Result:
        return self

    def first(self) -> Any:
        return self._rows[0] if self._rows else None


class Session:
    """Routes each statement to canned rows by what it selects.

    Keying on the leading ORM entity plus the number of selected columns, which
    is what separates the two queries over ``prescriptions``: the chart's join
    selects ``(Prescription, User.name)``, and the one that groups them under a
    record selects ``Prescription`` alone.
    """

    def __init__(self, rows: dict[tuple[str, int], list[Any]]) -> None:
        self.rows = rows
        self.asked: list[tuple[str, int]] = []

    async def execute(self, statement: Any, *args: Any, **kwargs: Any) -> Result:
        descriptions = statement.column_descriptions
        entity = descriptions[0]["entity"]
        key = (getattr(entity, "__name__", str(entity)), len(descriptions))
        self.asked.append(key)
        return Result(self.rows.get(key, []))


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user() -> User:
    return User(
        id="u1",
        name="Ayesha Khan",
        email="ayesha@example.com",
        phone="+92 300 1234567",
        cnic="4210112345671",
        password_hash="scrypt$x",
        role=Role.PATIENT,
        created_at=NOW - timedelta(days=400),
        updated_at=NOW,
    )


@pytest.fixture
def patient() -> Patient:
    return Patient(
        id="p1",
        user_id="u1",
        medical_record_number="MRN-000123",
        date_of_birth=datetime(1991, 4, 12),
        gender=Gender.FEMALE,
        blood_group="B+",
        address="Block 4, Gulshan-e-Iqbal, Karachi",
        allergies="Penicillin",
        chronic_conditions="Type 2 diabetes",
        emergency_contact_name="Bilal Khan",
        emergency_contact_phone="+92 321 7654321",
        created_at=NOW - timedelta(days=400),
        updated_at=NOW,
    )


def a_record() -> MedicalRecord:
    return MedicalRecord(
        id="r1",
        patient_id="p1",
        doctor_id="d1",
        appointment_id="a1",
        symptoms="Polyuria, fatigue for two weeks",
        diagnosis="Type 2 diabetes mellitus",
        treatment_plan="Metformin 500 mg twice daily; review HbA1c in 3 months",
        notes="Discussed diet and foot care.",
        follow_up_date=NOW + timedelta(days=90),
        follow_up_notes="Bring fasting sugar readings.",
        source=DataSource.PHYSICIAN,
        created_at=NOW - timedelta(days=10),
        updated_at=NOW - timedelta(days=10),
    )


def a_prescription() -> Prescription:
    return Prescription(
        id="rx1",
        patient_id="p1",
        doctor_id="d1",
        medical_record_id="r1",
        medication="Metformin",
        dosage="500 mg",
        frequency="Twice daily",
        duration="90 days",
        instructions="After food",
        start_date=NOW - timedelta(days=10),
        end_date=NOW + timedelta(days=80),
        active=True,
        created_at=NOW - timedelta(days=10),
        updated_at=NOW - timedelta(days=10),
    )


def an_invoice() -> Invoice:
    return Invoice(
        id="inv1",
        patient_id="p1",
        appointment_id="a1",
        invoice_number="INV-0001",
        amount=Decimal("2500.00"),
        tax_amount=Decimal("0.00"),
        total_amount=Decimal("2500.00"),
        platform_fee=Decimal("0.00"),
        tax_percent=Decimal("0.00"),
        late_fee=Decimal("250.00"),
        currency="PKR",
        status=InvoiceStatus.ISSUED,
        line_items=[{"description": "Consultation", "amount": "2500.00"}],
        notes=None,
        issued_at=NOW - timedelta(days=9),
        due_at=NOW + timedelta(days=5),
        created_at=NOW - timedelta(days=9),
        updated_at=NOW - timedelta(days=9),
    )


def full_rows() -> dict[tuple[str, int], list[Any]]:
    """One row in every collection, shaped exactly as each query selects it."""
    appointment = Appointment(
        id="a1",
        patient_id="p1",
        doctor_id="d1",
        appointment_date=NOW - timedelta(days=10),
        start_time=NOW - timedelta(days=10),
        end_time=NOW - timedelta(days=10) + timedelta(minutes=30),
        status=AppointmentStatus.COMPLETED,
        reason="Persistent thirst and fatigue",
        notes=None,
        slot_key="d1|x",
        completed_at=NOW - timedelta(days=10),
        created_at=NOW - timedelta(days=20),
        updated_at=NOW - timedelta(days=10),
    )
    reminder = MedicationReminder(
        id="mr1",
        prescription_id="rx1",
        patient_id="p1",
        at_minutes=1230,
        active=True,
        created_at=NOW - timedelta(days=9),
        updated_at=NOW - timedelta(days=9),
    )
    vital = Vital(
        id="v1",
        patient_id="p1",
        recorded_by_id="u2",
        source=DataSource.DEVICE,
        heart_rate=78,
        systolic_bp=128,
        diastolic_bp=82,
        oxygen_saturation=98.0,
        temperature=36.8,
        respiratory_rate=16,
        recorded_at=NOW - timedelta(days=1),
        created_at=NOW - timedelta(days=1),
    )
    symptom = ReportedSymptom(
        id="s1",
        patient_id="p1",
        symptom="Thirst",
        severity="moderate",
        duration_text="two weeks",
        raw_text="I feel thirsty all the time",
        source=DataSource.PATIENT_REPORTED,
        input_type=InputType.TEXT,
        confidence=0.9,
        promoted_to_record_id="r1",
        promoted_at=NOW - timedelta(days=10),
        created_at=NOW - timedelta(days=12),
    )
    document = MedicalDocument(
        id="doc1",
        patient_id="p1",
        uploaded_by_id="u1",
        medical_record_id="r1",
        document_type=DocumentType.LAB_REPORT,
        title="HbA1c",
        original_file_name="hba1c.pdf",
        mime_type="application/pdf",
        file_size=48_120,
        checksum_sha256="a" * 64,
        storage_bucket="medical-documents",
        storage_path="p1/doc1.pdf",
        ocr_status=OcrStatus.EXTRACTED,
        created_at=NOW - timedelta(days=11),
        updated_at=NOW - timedelta(days=11),
    )
    return {
        # (leading entity, columns selected)
        ("Appointment", 5): [(appointment, "Dr Abdul Rafay", "Endocrinology", "Ayesha Khan", "MRN-000123")],
        ("MedicalRecord", 3): [(a_record(), "Dr Abdul Rafay", "Endocrinology")],
        ("Prescription", 1): [a_prescription()],
        ("Prescription", 2): [(a_prescription(), "Dr Abdul Rafay")],
        ("MedicationReminder", 2): [(reminder, "Metformin")],
        ("Vital", 1): [vital],
        ("ReportedSymptom", 1): [symptom],
        ("MedicalDocument", 2): [(document, "Ayesha Khan")],
        ("Invoice", 1): [an_invoice()],
        ("Payment", 1): [],
    }


# ---------------------------------------------------------------------------


class TestTheBundle:
    async def test_it_says_what_it_is(self, patient: Patient, user: User) -> None:
        """A file somebody keeps for ten years has to identify itself.

        Without a format name and version, an export is an anonymous blob of
        JSON that only this codebase can interpret — which is most of the way
        back to not being able to take your record anywhere.
        """
        bundle = await build_export(Session(full_rows()), patient, user)
        assert bundle["format"] == FORMAT
        assert bundle["formatVersion"] == FORMAT_VERSION
        assert bundle["exportedAt"].endswith("Z")
        assert bundle["source"]["timezone"]

    async def test_every_collection_is_present(self, patient: Patient, user: User) -> None:
        bundle = await build_export(Session(full_rows()), patient, user)
        for collection in COLLECTIONS:
            assert collection in bundle, f"the export no longer includes {collection}"
            assert len(bundle[collection]) == 1, collection

    async def test_the_clinical_text_arrives_as_prose(
        self, patient: Patient, user: User
    ) -> None:
        """Encryption is at rest, not in the export.

        The point of sealing the columns is that the *database* cannot read
        them. A patient's own copy of their own record must be readable, or the
        export is a file of ciphertext nobody can use.
        """
        bundle = await build_export(Session(full_rows()), patient, user)
        record = bundle["medicalRecords"][0]
        assert record["diagnosis"] == "Type 2 diabetes mellitus"
        assert record["symptoms"].startswith("Polyuria")
        assert not record["diagnosis"].startswith("v1$")

    async def test_prescriptions_are_attached_to_their_record(
        self, patient: Patient, user: User
    ) -> None:
        bundle = await build_export(Session(full_rows()), patient, user)
        nested = bundle["medicalRecords"][0]["prescriptions"]
        assert [p["medication"] for p in nested] == ["Metformin"]

    async def test_a_reminder_carries_a_clock_time_and_its_zone(
        self, patient: Patient, user: User
    ) -> None:
        """1230 means nothing to a reader who does not have this codebase."""
        bundle = await build_export(Session(full_rows()), patient, user)
        reminder = bundle["medicationReminders"][0]
        assert reminder["at"] == "20:30"
        assert reminder["atMinutes"] == 1230
        assert reminder["timezone"]
        assert reminder["medication"] == "Metformin"

    async def test_documents_carry_metadata_and_never_a_storage_path(
        self, patient: Patient, user: User
    ) -> None:
        bundle = await build_export(Session(full_rows()), patient, user)
        document = bundle["documents"][0]
        assert document["fileName"] == "hba1c.pdf"
        assert document["checksumSha256"]
        assert "storagePath" not in document
        assert "medical-documents" not in str(document)
        assert bundle["documentsNote"]

    async def test_the_identity_a_new_hospital_would_need(
        self, patient: Patient, user: User
    ) -> None:
        bundle = await build_export(Session(full_rows()), patient, user)
        assert bundle["patient"]["medicalRecordNumber"] == "MRN-000123"
        assert bundle["patient"]["allergies"] == "Penicillin"
        assert bundle["patient"]["bloodGroup"] == "B+"
        assert bundle["patient"]["cnic"] == "4210112345671"

    async def test_counts_match_the_lists(self, patient: Patient, user: User) -> None:
        """The counts go into the audit log, so they had better be the truth."""
        bundle = await build_export(Session(full_rows()), patient, user)
        for name, count in bundle["counts"].items():
            assert count == len(bundle[name]), name


class TestAnEmptyRecord:
    async def test_a_new_patient_gets_a_valid_empty_bundle(
        self, patient: Patient, user: User
    ) -> None:
        """Somebody who registered yesterday can still export.

        Returning an error, or a bundle missing its lists, would make the
        feature look broken to exactly the people most likely to try it first.
        """
        bundle = await build_export(Session({}), patient, user)
        assert all(bundle[name] == [] for name in COLLECTIONS)
        assert bundle["truncated"] == []
        assert bundle["patient"]["name"] == "Ayesha Khan"


class TestTruncationIsAdmitted:
    async def test_a_capped_list_says_so(self, patient: Patient, user: User) -> None:
        """A short export that claims to be complete is the dangerous outcome."""
        vitals = [
            Vital(
                id=f"v{n}",
                patient_id="p1",
                source=DataSource.DEVICE,
                heart_rate=70 + (n % 20),
                recorded_at=NOW - timedelta(minutes=n),
                created_at=NOW - timedelta(minutes=n),
            )
            for n in range(LIMITS["vitals"])
        ]
        bundle = await build_export(Session({("Vital", 1): vitals}), patient, user)
        assert bundle["truncated"] == ["vitals"]
        assert bundle["truncatedNote"]
        assert bundle["counts"]["vitals"] == LIMITS["vitals"]

    async def test_nothing_is_claimed_when_nothing_was_cut(
        self, patient: Patient, user: User
    ) -> None:
        bundle = await build_export(Session(full_rows()), patient, user)
        assert bundle["truncated"] == []
        assert "truncatedNote" not in bundle


class TestItCostsOneQueryPerCollection:
    async def test_no_query_per_row(self, patient: Patient, user: User) -> None:
        """A chart is a list. A serializer that lazy-loads turns this endpoint
        into hundreds of round trips to a database in another region — the
        single most expensive mistake available in this codebase."""
        session = Session(full_rows())
        await build_export(session, patient, user)
        # Nine collection reads plus the two grouped lookups (prescriptions by
        # record, payments under review). Never a multiple of the row count.
        assert len(session.asked) <= 11, session.asked

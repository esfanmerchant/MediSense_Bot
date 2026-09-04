"""Encryption at rest and the patient's export, against the real database.

Two things can only be proved here.

**That Postgres cannot read a diagnosis.** The unit tests prove the type seals
and opens; only a real round trip proves that what is actually sitting in the
column is ciphertext. So this writes a record through the ORM, then reads the
same cell back over a raw connection that bypasses the type entirely, and looks
at the bytes.

**That the export is the caller's own record and nobody else's.** A patient gets
theirs; a doctor and an administrator get a 403 rather than somebody else's
chart, because there is no version of this endpoint for them.

The record written here is deleted afterwards. Audit entries are not: the log is
append-only and hash-chained, so removing rows is the tampering it exists to
detect — and this suite's own exports are among the entries it leaves behind.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, text

from app.db.models import Doctor, MedicalRecord, Patient, User
from app.db.session import SessionFactory
from tests.conftest import ADMIN_EMAIL, password_for, requires_db

pytestmark = requires_db

DEMO_PASSWORD = "Demo@Pass123"
ADMIN = ADMIN_EMAIL
DOCTOR = "doctor@example.com"
PATIENT = "patient@example.com"

#: Distinctive enough that finding it in a raw column is unambiguous, and
#: obviously synthetic so a stray row is recognisable as a test's.
DIAGNOSIS = "ZZTEST sealed-column probe — acute pharyngitis"
SYMPTOMS = "ZZTEST sore throat for three days"


def sign_in(client: TestClient, email: str) -> dict[str, Any]:
    if not email:
        pytest.skip("set TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD for the administrator tests")
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": email, "password": password_for(email)})
    assert response.status_code == 200, f"{email}: {response.text}"
    return response.json()["data"]["user"]


async def ids_for(patient_email: str, doctor_email: str) -> tuple[str, str]:
    async with SessionFactory() as session:
        patient_id = (
            await session.execute(
                select(Patient.id).join(User, User.id == Patient.user_id).where(
                    User.email == patient_email
                )
            )
        ).scalar_one()
        doctor_id = (
            await session.execute(
                select(Doctor.id).join(User, User.id == Doctor.user_id).where(
                    User.email == doctor_email
                )
            )
        ).scalar_one()
        return patient_id, doctor_id


@pytest.fixture
async def sealed_record() -> AsyncIterator[str]:
    """A record written through the ORM, removed however the test ends."""
    patient_id, doctor_id = await ids_for(PATIENT, DOCTOR)
    async with SessionFactory() as session:
        record = MedicalRecord(
            patient_id=patient_id,
            doctor_id=doctor_id,
            symptoms=SYMPTOMS,
            diagnosis=DIAGNOSIS,
        )
        session.add(record)
        await session.commit()
        record_id = record.id

    try:
        yield record_id
    finally:
        async with SessionFactory() as session:
            await session.execute(delete(MedicalRecord).where(MedicalRecord.id == record_id))
            await session.commit()


class TestWhatIsActuallyInTheColumn:
    async def test_postgres_holds_ciphertext(self, sealed_record: str) -> None:
        """Read past the ORM, so the type cannot open it on the way out.

        This is the assertion the whole feature exists for: a leaked connection
        string, a misdirected backup, a support query — all of them land here,
        and all of them see this.
        """
        async with SessionFactory() as session:
            stored = (
                await session.execute(
                    text('select diagnosis, symptoms from medical_records where id = :id'),
                    {"id": sealed_record},
                )
            ).one()

        for column, value in zip(("diagnosis", "symptoms"), stored, strict=True):
            assert value is not None
            assert value.startswith("v1$"), f"{column} is not sealed: {value[:60]}"
            assert "pharyngitis" not in value.lower(), column
            assert "ZZTEST" not in value, column

    async def test_the_application_still_reads_it_as_prose(self, sealed_record: str) -> None:
        async with SessionFactory() as session:
            record = (
                await session.execute(
                    select(MedicalRecord).where(MedicalRecord.id == sealed_record)
                )
            ).scalar_one()
            assert record.diagnosis == DIAGNOSIS
            assert record.symptoms == SYMPTOMS


class TestTheExport:
    def test_a_patient_gets_their_own_record(self, client: TestClient) -> None:
        sign_in(client, PATIENT)
        response = client.get("/api/patients/me/export")
        assert response.status_code == 200, response.text
        bundle = response.json()["data"]

        assert bundle["format"] == "medisense.patient-export"
        assert bundle["patient"]["email"] == PATIENT
        for collection in (
            "appointments",
            "medicalRecords",
            "prescriptions",
            "medicationReminders",
            "vitals",
            "reportedSymptoms",
            "documents",
            "invoices",
        ):
            assert isinstance(bundle[collection], list), collection
            assert bundle["counts"][collection] == len(bundle[collection])

    def test_the_bundle_is_readable_prose(self, client: TestClient, sealed_record: str) -> None:
        """The seal is at rest. A patient's own copy must not be ciphertext."""
        sign_in(client, PATIENT)
        bundle = client.get("/api/patients/me/export").json()["data"]
        mine = [r for r in bundle["medicalRecords"] if r["id"] == sealed_record]
        assert mine, "the record just written is missing from the export"
        assert mine[0]["diagnosis"] == DIAGNOSIS

    def test_every_row_belongs_to_the_caller(self, client: TestClient) -> None:
        user = sign_in(client, PATIENT)
        bundle = client.get("/api/patients/me/export").json()["data"]
        mine = bundle["patient"]["id"]
        assert user["email"] == PATIENT
        for collection in ("appointments", "medicalRecords", "prescriptions", "vitals", "invoices"):
            for row in bundle[collection]:
                assert row["patientId"] == mine, f"{collection} carries somebody else's row"

    def test_a_doctor_cannot_export(self, client: TestClient) -> None:
        """Not "cannot export a patient's" — cannot export at all.

        There is no id to pass, so the only thing a doctor could be asking for
        is a record their account does not have.
        """
        sign_in(client, DOCTOR)
        assert client.get("/api/patients/me/export").status_code == 403

    def test_an_administrator_cannot_export(self, client: TestClient) -> None:
        sign_in(client, ADMIN)
        assert client.get("/api/patients/me/export").status_code == 403

    def test_a_stranger_cannot_export(self, client: TestClient) -> None:
        client.cookies.clear()
        assert client.get("/api/patients/me/export").status_code == 401

    def test_the_export_is_recorded_without_its_contents(self, client: TestClient) -> None:
        """Counts in the trail, never clinical values (C5).

        The audit log is the one table nobody can delete from, so writing a
        diagnosis into it would create a second permanent plaintext copy of the
        thing the columns were just sealed to protect.
        """
        sign_in(client, PATIENT)
        assert client.get("/api/patients/me/export").status_code == 200

        sign_in(client, ADMIN)
        entries = client.get(
            "/api/audit-logs", params={"action": "PATIENT_DATA_EXPORTED", "limit": 5}
        )
        assert entries.status_code == 200, entries.text
        rows = entries.json()["data"]
        assert rows, "the export left no audit entry"

        latest = rows[0]
        assert latest["action"] == "PATIENT_DATA_EXPORTED"
        assert "counts" in (latest.get("metadata") or {})
        assert "pharyngitis" not in str(latest).lower()

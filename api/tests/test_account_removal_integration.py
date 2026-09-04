"""Removing an account, against the real database.

The unit tests prove the plan counts correctly. Only this can prove the two
things the feature exists for: that the rows are actually gone, and that the
address and CNIC can be used again afterwards. Both are claims about a database,
and neither can be checked without one.

Everything here works on accounts this file creates, with a random address per
run so a repeat cannot collide with a leftover. No demo account is touched. The
audit entries these leave behind are permanent, which is correct — an account
was destroyed, and that is exactly what the trail is for.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, text

from app.core.security import hash_password
from app.db.base import new_id, utcnow
from app.db.enums import InvoiceStatus, Role, UserStatus
from app.db.models import Doctor, Invoice, MedicalRecord, Patient, User
from app.db.session import SessionFactory
from tests.conftest import ADMIN_EMAIL, password_for, requires_db

pytestmark = requires_db

ADMIN = ADMIN_EMAIL
PASSWORD = "Removal@Test123"

#: Unique per run, so a failed run leaves nothing that breaks the next one.
STAMP = uuid.uuid4().hex[:10]
PATIENT_EMAIL = f"zz-removal-patient-{STAMP}@example.com"
DOCTOR_EMAIL = f"zz-removal-doctor-{STAMP}@example.com"
CNIC = "4210199999999"


def sign_in(client: TestClient, email: str) -> dict[str, Any]:
    if not email:
        pytest.skip("set TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD for the administrator tests")
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": email, "password": password_for(email)})
    assert response.status_code == 200, f"{email}: {response.text}"
    return response.json()["data"]["user"]


async def _scrub(emails: list[str]) -> None:
    """Remove anything this file made, however the test ended."""
    async with SessionFactory() as session:
        for email in emails:
            user = (
                await session.execute(select(User).where(User.email == email))
            ).scalar_one_or_none()
            if user is None:
                continue
            patient = (
                await session.execute(select(Patient).where(Patient.user_id == user.id))
            ).scalar_one_or_none()
            if patient is not None:
                await session.execute(
                    delete(Invoice).where(Invoice.patient_id == patient.id)
                )
                await session.execute(
                    delete(MedicalRecord).where(MedicalRecord.patient_id == patient.id)
                )
                await session.execute(delete(Patient).where(Patient.id == patient.id))
            await session.execute(delete(Doctor).where(Doctor.user_id == user.id))
            await session.execute(delete(User).where(User.id == user.id))
        # Invoices this file anonymised have no patient to find them by.
        await session.execute(
            text("delete from invoices where \"patientId\" is null and \"invoiceNumber\" like :p"),
            {"p": f"ZZ-{STAMP}%"},
        )
        await session.commit()


@pytest.fixture
async def people() -> AsyncIterator[dict[str, str]]:
    """A throwaway patient with a settled bill, and a doctor who wrote them a note."""
    await _scrub([PATIENT_EMAIL, DOCTOR_EMAIL])
    ids: dict[str, str] = {}

    async with SessionFactory() as session:
        patient_user = User(
            id=new_id(),
            name="ZZ Removal Patient",
            email=PATIENT_EMAIL,
            password_hash=hash_password(PASSWORD),
            role=Role.PATIENT,
            status=UserStatus.ACTIVE,
            cnic=CNIC,
            email_verified_at=utcnow(),
        )
        doctor_user = User(
            id=new_id(),
            name="ZZ Removal Doctor",
            email=DOCTOR_EMAIL,
            password_hash=hash_password(PASSWORD),
            role=Role.DOCTOR,
            status=UserStatus.ACTIVE,
            email_verified_at=utcnow(),
        )
        session.add_all([patient_user, doctor_user])
        await session.flush()

        patient = Patient(
            id=new_id(), user_id=patient_user.id, medical_record_number=f"ZZ-{STAMP}"
        )
        doctor = Doctor(
            id=new_id(),
            user_id=doctor_user.id,
            specialization="Cardiology",
            license_number=f"ZZ-PMC-{STAMP}",
            availability=[],
        )
        session.add_all([patient, doctor])
        await session.flush()

        session.add(
            MedicalRecord(
                id=new_id(),
                patient_id=patient.id,
                doctor_id=doctor.id,
                diagnosis="ZZTEST removal probe",
            )
        )
        session.add(
            Invoice(
                id=new_id(),
                patient_id=patient.id,
                invoice_number=f"ZZ-{STAMP}-1",
                amount=Decimal("2500.00"),
                total_amount=Decimal("2500.00"),
                status=InvoiceStatus.PAID,
                paid_at=utcnow(),
            )
        )
        await session.commit()

        ids = {
            "patient_user": patient_user.id,
            "doctor_user": doctor_user.id,
            "patient": patient.id,
            "doctor": doctor.id,
        }

    try:
        yield ids
    finally:
        await _scrub([PATIENT_EMAIL, DOCTOR_EMAIL])


async def row_count(sql: str, params: dict[str, Any]) -> int:
    async with SessionFactory() as session:
        return int((await session.execute(text(sql), params)).scalar_one())


class TestRemovingAPatient:
    async def test_the_rows_and_the_account_are_gone(
        self, client: TestClient, people: dict[str, str]
    ) -> None:
        sign_in(client, ADMIN)
        response = client.delete(f"/api/users/{people['patient_user']}")
        assert response.status_code == 200, response.text
        assert response.json()["data"]["mode"] == "DELETE"

        assert await row_count(
            "select count(*) from users where id = :id", {"id": people["patient_user"]}
        ) == 0
        assert await row_count(
            "select count(*) from patients where id = :id", {"id": people["patient"]}
        ) == 0
        assert await row_count(
            'select count(*) from medical_records where "patientId" = :id',
            {"id": people["patient"]},
        ) == 0

    async def test_the_settled_invoice_survives_without_a_patient(
        self, client: TestClient, people: dict[str, str]
    ) -> None:
        """Money that changed hands is the hospital's record, not the patient's.

        Deleting it would move a past quarter's revenue with nothing anywhere
        saying why.
        """
        sign_in(client, ADMIN)
        assert client.delete(f"/api/users/{people['patient_user']}").status_code == 200

        async with SessionFactory() as session:
            row = (
                await session.execute(
                    text(
                        'select "patientId", "totalAmount", status from invoices '
                        'where "invoiceNumber" = :n'
                    ),
                    {"n": f"ZZ-{STAMP}-1"},
                )
            ).one_or_none()

        assert row is not None, "the settled invoice was deleted"
        assert row[0] is None, "the invoice still names a patient"
        assert Decimal(str(row[1])) == Decimal("2500.00")

    async def test_the_email_and_cnic_can_register_again(
        self, client: TestClient, people: dict[str, str]
    ) -> None:
        """The whole point of the feature.

        `users.email` is UNIQUE, so if anything of the old account survived,
        this request is the one that would say so.
        """
        sign_in(client, ADMIN)
        assert client.delete(f"/api/users/{people['patient_user']}").status_code == 200

        client.cookies.clear()
        again = client.post(
            "/api/auth/register",
            json={
                "name": "ZZ Removal Patient Again",
                "email": PATIENT_EMAIL,
                "password": PASSWORD,
                "cnic": CNIC,
                "acceptedTerms": True,
            },
        )
        assert again.status_code == 201, again.text

    async def test_the_removal_is_in_the_trail_without_clinical_content(
        self, client: TestClient, people: dict[str, str]
    ) -> None:
        """`audit_logs.userId` is not a foreign key, so the trail outlives them.

        It has to say *who* was removed — that is the exception to "references,
        never values". It must not say what they were diagnosed with.
        """
        sign_in(client, ADMIN)
        assert client.delete(f"/api/users/{people['patient_user']}").status_code == 200

        entries = client.get("/api/audit-logs", params={"action": "USER_REMOVED", "limit": 5})
        assert entries.status_code == 200, entries.text
        rows = entries.json()["data"]
        assert rows, "removing an account left no audit entry"

        latest = rows[0]
        assert latest["action"] == "USER_REMOVED"
        assert PATIENT_EMAIL in str(latest["metadata"])
        assert "ZZTEST removal probe" not in str(latest)


class TestRemovingADoctorWhoWroteNotes:
    async def test_the_patient_keeps_their_consultation(
        self, client: TestClient, people: dict[str, str]
    ) -> None:
        """The record belongs to the patient. Removing its author must not take it."""
        sign_in(client, ADMIN)
        response = client.delete(f"/api/users/{people['doctor_user']}")
        assert response.status_code == 200, response.text
        assert response.json()["data"]["mode"] == "ANONYMISE"

        async with SessionFactory() as session:
            record = (
                await session.execute(
                    select(MedicalRecord).where(MedicalRecord.patient_id == people["patient"])
                )
            ).scalar_one_or_none()

        assert record is not None, "the patient's consultation went with the doctor"
        assert record.diagnosis == "ZZTEST removal probe"
        assert record.doctor_id == people["doctor"], "the record lost its author"

    async def test_the_account_is_emptied_and_the_address_released(
        self, client: TestClient, people: dict[str, str]
    ) -> None:
        sign_in(client, ADMIN)
        assert client.delete(f"/api/users/{people['doctor_user']}").status_code == 200

        async with SessionFactory() as session:
            user = (
                await session.execute(select(User).where(User.id == people["doctor_user"]))
            ).scalar_one()
            doctor = (
                await session.execute(select(Doctor).where(Doctor.id == people["doctor"]))
            ).scalar_one()

        assert user.removed_at is not None
        assert user.email != DOCTOR_EMAIL
        assert "ZZ Removal Doctor" not in user.name
        assert user.status == UserStatus.DEACTIVATED
        # UNIQUE, and checked when a doctor applies — leaving it would block
        # this same person from ever registering again.
        assert doctor.license_number != f"ZZ-PMC-{STAMP}"
        assert doctor.accepting_patients is False

    async def test_a_removed_doctor_cannot_sign_in(
        self, client: TestClient, people: dict[str, str]
    ) -> None:
        sign_in(client, ADMIN)
        assert client.delete(f"/api/users/{people['doctor_user']}").status_code == 200

        client.cookies.clear()
        refused = client.post(
            "/api/auth/login", json={"email": DOCTOR_EMAIL, "password": PASSWORD}
        )
        assert refused.status_code >= 400

    async def test_a_removed_doctor_is_not_in_the_directory(
        self, client: TestClient, people: dict[str, str]
    ) -> None:
        """DEACTIVATED already drops them from the bookable list.

        Worth an assertion rather than an assumption: a tombstone that stayed
        bookable would let a patient book an appointment with nobody.
        """
        sign_in(client, ADMIN)
        assert client.delete(f"/api/users/{people['doctor_user']}").status_code == 200

        sign_in(client, ADMIN)
        listing = client.get("/api/doctors", params={"limit": 100})
        assert listing.status_code == 200, listing.text
        assert people["doctor"] not in [d["id"] for d in listing.json()["data"]]


class TestWhatIsRefused:
    def test_an_administrator_cannot_remove_themselves(self, client: TestClient) -> None:
        me = sign_in(client, ADMIN)
        refused = client.delete(f"/api/users/{me['id']}")
        assert refused.status_code == 403
        assert "your own account" in refused.text

    def test_a_patient_cannot_remove_anybody(
        self, client: TestClient, people: dict[str, str]
    ) -> None:
        client.cookies.clear()
        client.post(
            "/api/auth/login", json={"email": "patient@example.com", "password": "Demo@Pass123"}
        )
        assert client.delete(f"/api/users/{people['doctor_user']}").status_code == 403

    def test_a_stranger_cannot_remove_anybody(
        self, client: TestClient, people: dict[str, str]
    ) -> None:
        client.cookies.clear()
        assert client.delete(f"/api/users/{people['doctor_user']}").status_code == 401


class TestThePreview:
    def test_it_counts_before_anything_happens(
        self, client: TestClient, people: dict[str, str]
    ) -> None:
        sign_in(client, ADMIN)
        preview = client.get(f"/api/users/{people['doctor_user']}/removal")
        assert preview.status_code == 200, preview.text
        plan = preview.json()["data"]

        assert plan["mode"] == "ANONYMISE"
        assert plan["keeps"]["consultationNotesWritten"] >= 1
        assert plan["allowed"] is True

        # And nothing was destroyed by looking.
        async def still_there() -> int:
            return await row_count(
                "select count(*) from users where id = :id", {"id": people["doctor_user"]}
            )

        assert client.get(f"/api/users/{people['doctor_user']}/removal").status_code == 200

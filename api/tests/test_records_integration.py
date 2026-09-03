"""Medical records and prescriptions, end to end (spec §13).

The rule these tests exist to prove is the one that separates this from a CRUD
app: clinical content is reachable only through a *care relationship*. Holding a
role is not enough, and holding an administrative permission over a patient is
specifically not enough — an admin can see that Priya has an appointment
tomorrow and cannot see what she was diagnosed with.

Records created here are deleted afterwards. Audit entries are not: the log is
append-only and hash-chained, so removing rows is the tampering it exists to
detect.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.db.models import Doctor, MedicalRecord, Patient, Prescription, User
from app.db.session import SessionFactory
from tests.conftest import ADMIN_EMAIL, password_for, requires_db

pytestmark = requires_db

DEMO_PASSWORD = "Demo@Pass123"

#: Supplied by the environment — see `requires_admin` in conftest.
ADMIN = ADMIN_EMAIL
DOCTOR = "doctor@example.com"  # Cardiology — treats Priya and Vikram
OTHER_DOCTOR = "doctor3@example.com"  # General Medicine — treats Meera
SECOND_DOCTOR = "doctor2@example.com"  # No standing assignment to Priya
PATIENT = "patient@example.com"  # Priya
OTHER_PATIENT = "patient3@example.com"  # Meera
NURSE = "nurse@example.com"


def sign_in(client: TestClient, email: str) -> dict[str, Any]:
    # An unset administrator skips rather than fails. Marking whole files would
    # skip the patient and doctor tests in them too, and those are most of each
    # file and need no administrator at all.
    if not email:
        pytest.skip(
            "set TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD to run the tests that "
            "act as an administrator"
        )
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": email, "password": password_for(email)})
    assert response.status_code == 200, f"{email}: {response.text}"
    return response.json()["data"]["user"]


async def patient_id_for(email: str) -> str:
    async with SessionFactory() as session:
        return (
            await session.execute(
                select(Patient.id).join(User, User.id == Patient.user_id).where(User.email == email)
            )
        ).scalar_one()


async def doctor_id_for(email: str) -> str:
    async with SessionFactory() as session:
        return (
            await session.execute(
                select(Doctor.id).join(User, User.id == Doctor.user_id).where(User.email == email)
            )
        ).scalar_one()


class Written:
    """Tracks records and prescriptions a test creates, for teardown."""

    def __init__(self) -> None:
        self.records: set[str] = set()
        self.prescriptions: set[str] = set()

    def record(self, response: Any) -> dict[str, Any]:
        assert response.status_code in (200, 201), response.text
        data = response.json()["data"]
        self.records.add(data["id"])
        return data

    def prescription(self, response: Any) -> dict[str, Any]:
        assert response.status_code in (200, 201), response.text
        data = response.json()["data"]
        self.prescriptions.add(data["id"])
        return data


@pytest.fixture
async def written() -> AsyncIterator[Written]:
    registry = Written()
    yield registry
    async with SessionFactory() as session:
        # Prescriptions first: they reference records.
        if registry.prescriptions:
            await session.execute(
                delete(Prescription).where(Prescription.id.in_(registry.prescriptions))
            )
        if registry.records:
            await session.execute(
                delete(Prescription).where(Prescription.medical_record_id.in_(registry.records))
            )
            await session.execute(delete(MedicalRecord).where(MedicalRecord.id.in_(registry.records)))
        await session.commit()


def write_record(client: TestClient, patient_id: str, **fields: Any) -> Any:
    body = {"patientId": patient_id, "diagnosis": "Seasonal rhinitis", **fields}
    return client.post("/api/records", json=body)


def write_prescription(client: TestClient, patient_id: str, **fields: Any) -> Any:
    body = {
        "patientId": patient_id,
        "medication": "Cetirizine",
        "dosage": "10 mg",
        "frequency": "Once daily",
        "duration": "14 days",
        **fields,
    }
    return client.post("/api/prescriptions", json=body)


class TestAuthoring:
    async def test_a_treating_doctor_writes_a_record(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)

        data = written.record(
            write_record(
                client,
                priya,
                symptoms="Sneezing, itchy eyes for two weeks",
                treatmentPlan="Antihistamine, review in a month",
                followUpNotes="Review if symptoms persist",
            )
        )
        client.cookies.clear()

        assert data["diagnosis"] == "Seasonal rhinitis"
        assert data["doctorId"] == await doctor_id_for(DOCTOR)
        assert data["doctorName"]
        # Machine output can never masquerade as a clinician's finding.
        assert data["source"] == "PHYSICIAN"
        assert data["amended"] is False

    async def test_an_empty_record_is_refused(self, client: TestClient) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        response = client.post("/api/records", json={"patientId": priya})
        client.cookies.clear()

        assert response.status_code == 422

    async def test_a_doctor_cannot_write_into_an_unrelated_patients_history(
        self, client: TestClient
    ) -> None:
        # doctor@example.com treats Priya and Vikram, never Meera.
        sign_in(client, DOCTOR)
        meera = await patient_id_for(OTHER_PATIENT)
        response = write_record(client, meera)
        client.cookies.clear()

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN_RESOURCE"

    async def test_a_patient_cannot_author_a_record(self, client: TestClient) -> None:
        """The rule from spec §13, held by the permission catalogue rather than
        by a check someone has to remember."""
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        response = write_record(client, priya)
        client.cookies.clear()

        assert response.status_code == 403

    async def test_an_admin_cannot_author_a_record(self, client: TestClient) -> None:
        sign_in(client, ADMIN)
        priya = await patient_id_for(PATIENT)
        response = write_record(client, priya)
        client.cookies.clear()

        assert response.status_code == 403

    async def test_a_record_can_be_filed_against_a_consultation(
        self, client: TestClient, written: Written
    ) -> None:
        from tests.test_appointments_integration import a_free_slot, book

        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        slot = a_free_slot(client, doctor)
        appointment = book(client, doctor, slot).json()["data"]

        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        data = written.record(write_record(client, priya, appointmentId=appointment["id"]))

        assert data["appointmentId"] == appointment["id"]

        # Tidy up the appointment this test created.
        client.post(f"/api/appointments/{appointment['id']}/cancel", json={})
        async with SessionFactory() as session:
            from app.db.models import Appointment

            await session.execute(delete(Appointment).where(Appointment.id == appointment["id"]))
            await session.commit()
        client.cookies.clear()

    async def test_a_record_cannot_be_filed_against_someone_elses_consultation(
        self, client: TestClient
    ) -> None:
        from tests.test_appointments_integration import a_free_slot, book

        other_doctor = await doctor_id_for(OTHER_DOCTOR)
        sign_in(client, OTHER_PATIENT)
        slot = a_free_slot(client, other_doctor)
        appointment = book(client, other_doctor, slot).json()["data"]

        # A different doctor, a different patient, but a real appointment id.
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        response = write_record(client, priya, appointmentId=appointment["id"])

        sign_in(client, OTHER_PATIENT)
        client.post(f"/api/appointments/{appointment['id']}/cancel", json={})
        async with SessionFactory() as session:
            from app.db.models import Appointment

            await session.execute(delete(Appointment).where(Appointment.id == appointment["id"]))
            await session.commit()
        client.cookies.clear()

        assert response.status_code == 400


class TestReading:
    async def test_a_patient_reads_their_own_history(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))

        sign_in(client, PATIENT)
        listed = client.get("/api/records")
        direct = client.get(f"/api/records/{record['id']}")
        client.cookies.clear()

        assert listed.status_code == 200
        assert record["id"] in {row["id"] for row in listed.json()["data"]}
        assert direct.status_code == 200
        assert direct.json()["data"]["diagnosis"] == "Seasonal rhinitis"

    async def test_a_patient_cannot_read_another_patients_history(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, OTHER_DOCTOR)
        meera = await patient_id_for(OTHER_PATIENT)
        record = written.record(write_record(client, meera))

        sign_in(client, PATIENT)
        direct = client.get(f"/api/records/{record['id']}")
        by_filter = client.get("/api/records", params={"patientId": meera})
        client.cookies.clear()

        assert direct.status_code == 403
        assert by_filter.status_code == 403

    async def test_an_administrator_cannot_read_a_chart(
        self, client: TestClient, written: Written
    ) -> None:
        """R2 in one test.

        The admin passes ``resolve_patient_access`` — they hold
        ``patient:read:any`` and the patient endpoint serves them identity and
        contact details. Clinical content is a separate gate, and it refuses
        them.
        """
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))

        sign_in(client, ADMIN)
        # Administrative access to the patient still works...
        assert client.get(f"/api/patients/{priya}").status_code == 200
        # ...and buys nothing clinical.
        direct = client.get(f"/api/records/{record['id']}")
        listed = client.get("/api/records", params={"patientId": priya})
        prescriptions = client.get("/api/prescriptions", params={"patientId": priya})
        client.cookies.clear()

        assert direct.status_code == 403
        assert listed.status_code == 403
        assert prescriptions.status_code == 403

    async def test_a_nurse_reaches_no_records_without_a_grant(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))

        sign_in(client, NURSE)
        response = client.get(f"/api/records/{record['id']}")
        client.cookies.clear()

        assert response.status_code == 403

    async def test_a_doctor_reads_the_chart_of_a_patient_they_treat(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))

        chart = client.get("/api/records", params={"patientId": priya})
        client.cookies.clear()

        assert chart.status_code == 200
        assert record["id"] in {row["id"] for row in chart.json()["data"]}

    async def test_a_doctor_cannot_read_an_unrelated_patients_chart(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, OTHER_DOCTOR)
        meera = await patient_id_for(OTHER_PATIENT)
        record = written.record(write_record(client, meera))

        sign_in(client, DOCTOR)
        response = client.get(f"/api/records/{record['id']}")
        client.cookies.clear()

        assert response.status_code == 403

    async def test_the_unscoped_list_shows_a_doctor_their_caseload(
        self, client: TestClient, written: Written
    ) -> None:
        """The positive half of the caseload scope.

        Without this, a subquery that matched nothing would still pass every
        exclusion test below — failing closed looks identical to working.
        """
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        mine = written.record(write_record(client, priya))

        listed = {row["id"] for row in client.get("/api/records").json()["data"]}
        client.cookies.clear()

        assert mine["id"] in listed

    async def test_the_unscoped_list_shows_a_doctor_only_their_caseload(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, OTHER_DOCTOR)
        meera = await patient_id_for(OTHER_PATIENT)
        elsewhere = written.record(write_record(client, meera))

        sign_in(client, DOCTOR)
        listed = {row["id"] for row in client.get("/api/records").json()["data"]}
        client.cookies.clear()

        assert elsewhere["id"] not in listed

    async def test_the_unscoped_prescription_list_is_scoped_the_same_way(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, OTHER_DOCTOR)
        meera = await patient_id_for(OTHER_PATIENT)
        theirs = written.prescription(write_prescription(client, meera))

        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        mine = written.prescription(write_prescription(client, priya))
        listed = {row["id"] for row in client.get("/api/prescriptions").json()["data"]}
        client.cookies.clear()

        assert mine["id"] in listed
        assert theirs["id"] not in listed

    async def test_opening_an_empty_chart_is_still_audited(
        self, client: TestClient
    ) -> None:
        """A chart with no records must not be a way to look without a trace."""
        from app.db.enums import AuditAction
        from app.db.models import AuditLog

        sign_in(client, DOCTOR)
        vikram_like = await patient_id_for(PATIENT)
        response = client.get("/api/records", params={"patientId": vikram_like})
        client.cookies.clear()
        assert response.status_code == 200

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog)
                    .where(
                        AuditLog.action == AuditAction.PATIENT_RECORD_VIEW,
                        AuditLog.patient_id == vikram_like,
                        AuditLog.entity_id.is_(None),
                    )
                    .order_by(AuditLog.timestamp.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()

        assert entry is not None
        assert entry.audit_metadata["scope"] == "chart"

    async def test_reading_a_chart_is_audited(
        self, client: TestClient, written: Written
    ) -> None:
        from app.db.enums import AuditAction
        from app.db.models import AuditLog

        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))
        client.get(f"/api/records/{record['id']}")
        client.cookies.clear()

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog)
                    .where(
                        AuditLog.action == AuditAction.PATIENT_RECORD_VIEW,
                        AuditLog.entity_id == record["id"],
                    )
                    .limit(1)
                )
            ).scalar_one_or_none()

        assert entry is not None
        assert entry.patient_id == priya

    async def test_a_refused_chart_read_is_recorded_as_a_security_event(
        self, client: TestClient, written: Written
    ) -> None:
        from app.db.enums import AuditAction, AuditSeverity
        from app.db.models import AuditLog

        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))

        sign_in(client, ADMIN)
        assert client.get(f"/api/records/{record['id']}").status_code == 403
        client.cookies.clear()

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog)
                    .where(
                        AuditLog.action == AuditAction.ACCESS_DENIED,
                        AuditLog.entity_type == "MedicalRecord",
                        AuditLog.patient_id == priya,
                    )
                    .order_by(AuditLog.timestamp.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()

        assert entry is not None
        assert entry.severity == AuditSeverity.SECURITY


class TestAmending:
    async def test_the_author_amends_their_own_record(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))

        amended = client.patch(
            f"/api/records/{record['id']}",
            json={"diagnosis": "Allergic rhinitis", "notes": "Skin prick test ordered"},
        )
        client.cookies.clear()

        assert amended.status_code == 200
        assert amended.json()["data"]["diagnosis"] == "Allergic rhinitis"
        assert amended.json()["data"]["amended"] is True

    async def test_another_doctor_cannot_edit_someone_elses_note(
        self, client: TestClient, written: Written
    ) -> None:
        """A second opinion is a second record, not an edit under another
        clinician's name."""
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))

        sign_in(client, SECOND_DOCTOR)
        response = client.patch(
            f"/api/records/{record['id']}", json={"diagnosis": "Something else"}
        )
        client.cookies.clear()

        assert response.status_code == 403

    async def test_a_patient_cannot_amend_their_record(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))

        sign_in(client, PATIENT)
        response = client.patch(f"/api/records/{record['id']}", json={"diagnosis": "I am fine"})
        client.cookies.clear()

        assert response.status_code == 403

    async def test_an_amendment_is_audited_by_field_name_only(
        self, client: TestClient, written: Written
    ) -> None:
        from app.db.enums import AuditAction
        from app.db.models import AuditLog

        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))
        secret = "Suspected lymphoma, urgent referral"
        client.patch(f"/api/records/{record['id']}", json={"diagnosis": secret})
        client.cookies.clear()

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog).where(
                        AuditLog.action == AuditAction.PATIENT_RECORD_UPDATE,
                        AuditLog.entity_id == record["id"],
                    )
                )
            ).scalar_one()

        assert entry.audit_metadata == {"fields": ["diagnosis"]}
        # The audit log is readable by administrators, who cannot read charts.
        # It must not become a second copy of the one they are refused.
        assert secret not in str(entry.audit_metadata)


class TestPrescribing:
    async def test_a_doctor_prescribes_for_a_patient_they_treat(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)

        data = written.prescription(
            write_prescription(client, priya, instructions="Take at night")
        )
        client.cookies.clear()

        assert data["medication"] == "Cetirizine"
        assert data["active"] is True
        assert data["startDate"]  # defaulted to now rather than left empty
        assert data["doctorName"]

    async def test_a_patient_cannot_prescribe(self, client: TestClient) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        response = write_prescription(client, priya)
        client.cookies.clear()

        assert response.status_code == 403

    async def test_an_admin_cannot_prescribe(self, client: TestClient) -> None:
        sign_in(client, ADMIN)
        priya = await patient_id_for(PATIENT)
        response = write_prescription(client, priya)
        client.cookies.clear()

        assert response.status_code == 403

    async def test_a_doctor_cannot_prescribe_for_an_unrelated_patient(
        self, client: TestClient
    ) -> None:
        sign_in(client, DOCTOR)
        meera = await patient_id_for(OTHER_PATIENT)
        response = write_prescription(client, meera)
        client.cookies.clear()

        assert response.status_code == 403

    async def test_a_patient_sees_their_own_medication(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        prescription = written.prescription(write_prescription(client, priya))

        sign_in(client, PATIENT)
        listed = client.get("/api/prescriptions", params={"activeOnly": True})
        client.cookies.clear()

        assert listed.status_code == 200
        assert prescription["id"] in {row["id"] for row in listed.json()["data"]}

    async def test_a_prescriber_can_see_what_a_patient_is_already_taking(
        self, client: TestClient, written: Written
    ) -> None:
        """The catalogue gap this phase closed: a doctor who cannot read current
        medication is a drug interaction waiting to happen."""
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        prescription = written.prescription(write_prescription(client, priya))

        current = client.get(
            "/api/prescriptions", params={"patientId": priya, "activeOnly": True}
        )
        client.cookies.clear()

        assert current.status_code == 200
        assert prescription["id"] in {row["id"] for row in current.json()["data"]}

    async def test_a_prescription_filed_under_another_patients_record_is_refused(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, OTHER_DOCTOR)
        meera = await patient_id_for(OTHER_PATIENT)
        meeras_record = written.record(write_record(client, meera))

        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        response = write_prescription(client, priya, medicalRecordId=meeras_record["id"])
        client.cookies.clear()

        assert response.status_code == 400

    async def test_the_prescriber_adjusts_the_dose(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        prescription = written.prescription(write_prescription(client, priya))

        adjusted = client.patch(
            f"/api/prescriptions/{prescription['id']}", json={"dosage": "5 mg"}
        )
        client.cookies.clear()

        assert adjusted.status_code == 200
        assert adjusted.json()["data"]["dosage"] == "5 mg"

    async def test_the_medication_itself_cannot_be_swapped(
        self, client: TestClient, written: Written
    ) -> None:
        """Changing the drug would turn one medication's history into another's.

        ``medication`` is absent from the update schema, so the field is
        discarded and the request ends up asking for no change at all.
        """
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        prescription = written.prescription(write_prescription(client, priya))

        response = client.patch(
            f"/api/prescriptions/{prescription['id']}", json={"medication": "Warfarin"}
        )
        after = client.get(f"/api/prescriptions/{prescription['id']}")
        client.cookies.clear()

        assert response.status_code == 400
        assert after.json()["data"]["medication"] == "Cetirizine"

    async def test_another_doctor_cannot_edit_a_prescription(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        prescription = written.prescription(write_prescription(client, priya))

        sign_in(client, SECOND_DOCTOR)
        response = client.patch(
            f"/api/prescriptions/{prescription['id']}", json={"dosage": "20 mg"}
        )
        client.cookies.clear()

        assert response.status_code == 403


class TestDiscontinuing:
    async def test_discontinuing_keeps_the_row(
        self, client: TestClient, written: Written
    ) -> None:
        """A stopped medication stays in the history — the fact that a patient
        was taking it is itself clinical information."""
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        prescription = written.prescription(write_prescription(client, priya))

        stopped = client.post(
            f"/api/prescriptions/{prescription['id']}/discontinue",
            json={"reason": "Symptoms resolved"},
        )
        still_there = client.get(f"/api/prescriptions/{prescription['id']}")
        client.cookies.clear()

        assert stopped.status_code == 200
        assert stopped.json()["data"]["active"] is False
        assert stopped.json()["data"]["endDate"]
        assert still_there.status_code == 200

    async def test_a_discontinued_prescription_cannot_be_edited(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        prescription = written.prescription(write_prescription(client, priya))
        client.post(f"/api/prescriptions/{prescription['id']}/discontinue", json={})

        response = client.patch(
            f"/api/prescriptions/{prescription['id']}", json={"dosage": "5 mg"}
        )
        client.cookies.clear()

        assert response.status_code == 409

    async def test_it_cannot_be_discontinued_twice(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        prescription = written.prescription(write_prescription(client, priya))
        client.post(f"/api/prescriptions/{prescription['id']}/discontinue", json={})

        repeat = client.post(f"/api/prescriptions/{prescription['id']}/discontinue", json={})
        client.cookies.clear()

        assert repeat.status_code == 409

    async def test_a_patient_cannot_stop_their_own_medication(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        prescription = written.prescription(write_prescription(client, priya))

        sign_in(client, PATIENT)
        response = client.post(f"/api/prescriptions/{prescription['id']}/discontinue", json={})
        client.cookies.clear()

        assert response.status_code == 403

    async def test_discontinuing_records_whether_it_was_the_prescriber(
        self, client: TestClient, written: Written
    ) -> None:
        from app.db.enums import AuditAction
        from app.db.models import AuditLog

        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        prescription = written.prescription(write_prescription(client, priya))
        client.post(f"/api/prescriptions/{prescription['id']}/discontinue", json={})
        client.cookies.clear()

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog)
                    .where(
                        AuditLog.action == AuditAction.PRESCRIPTION_UPDATED,
                        AuditLog.entity_id == prescription["id"],
                    )
                    .order_by(AuditLog.timestamp.desc())
                    .limit(1)
                )
            ).scalar_one()

        assert entry.audit_metadata["operation"] == "discontinue"
        assert entry.audit_metadata["byPrescriber"] is True
        # The drug name is clinical content and stays out of the log.
        assert "Cetirizine" not in str(entry.audit_metadata)


class TestChartAssembly:
    async def test_a_record_carries_the_prescriptions_written_under_it(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))
        written.prescription(write_prescription(client, priya, medicalRecordId=record["id"]))

        detail = client.get(f"/api/records/{record['id']}")
        client.cookies.clear()

        medications = [p["medication"] for p in detail.json()["data"]["prescriptions"]]
        assert medications == ["Cetirizine"]

    async def test_a_patient_sees_medication_alongside_their_history(
        self, client: TestClient, written: Written
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)
        record = written.record(write_record(client, priya))
        written.prescription(write_prescription(client, priya, medicalRecordId=record["id"]))

        sign_in(client, PATIENT)
        chart = client.get("/api/records", params={"includePrescriptions": True})
        client.cookies.clear()

        entry = next(row for row in chart.json()["data"] if row["id"] == record["id"])
        assert entry["prescriptions"][0]["medication"] == "Cetirizine"

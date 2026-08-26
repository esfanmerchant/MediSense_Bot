"""Resource-level authorization, end to end against the seeded database.

These are the tests that matter most in a healthcare system: they assert that
holding a role is *not* the same as being allowed to read a particular patient.
Run `npm run db:seed`-equivalent data first — the demo accounts from the seed
are used as fixtures.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Patient, User
from tests.conftest import requires_db

pytestmark = requires_db

DEMO_PASSWORD = "Demo@Pass123"

ADMIN = "admin@example.com"
DOCTOR = "doctor@example.com"  # Cardiology — assigned Priya and Vikram
OTHER_DOCTOR = "doctor3@example.com"  # General Medicine — assigned Meera only
PATIENT = "patient@example.com"  # Priya
OTHER_PATIENT = "patient3@example.com"  # Meera
NURSE = "nurse@example.com"


def sign_in(client: TestClient, email: str) -> dict:
    """Sign in and leave the session cookies on the client."""
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": email, "password": DEMO_PASSWORD})
    assert response.status_code == 200, f"{email}: {response.text}"
    return response.json()["data"]["user"]


@pytest.fixture
def signed_out(client: TestClient) -> Iterator[TestClient]:
    yield client
    client.cookies.clear()


async def _patient_id_for(db: AsyncSession, email: str) -> str:
    return (
        await db.execute(select(Patient.id).join(User, User.id == Patient.user_id).where(User.email == email))
    ).scalar_one()


class TestPatientIsolation:
    """A patient reaches their own records and nothing else (R7, spec §8)."""

    async def test_patient_can_read_their_own_record(
        self, signed_out: TestClient, db: AsyncSession
    ) -> None:
        user = sign_in(signed_out, PATIENT)
        own_id = await _patient_id_for(db, PATIENT)
        assert user["patientId"] == own_id

        response = signed_out.get(f"/api/patients/{own_id}")
        assert response.status_code == 200
        assert response.json()["data"]["id"] == own_id

    async def test_patient_cannot_read_another_patient(
        self, signed_out: TestClient, db: AsyncSession
    ) -> None:
        sign_in(signed_out, PATIENT)
        other_id = await _patient_id_for(db, OTHER_PATIENT)

        response = signed_out.get(f"/api/patients/{other_id}")
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN_RESOURCE"

    async def test_a_forged_path_id_does_not_widen_access(
        self, signed_out: TestClient, db: AsyncSession
    ) -> None:
        # The patient id in the URL is never trusted; identity comes from the
        # session. /patients/me must ignore anything the client claims.
        sign_in(signed_out, PATIENT)
        own_id = await _patient_id_for(db, PATIENT)
        assert signed_out.get("/api/patients/me").json()["data"]["id"] == own_id

    def test_patient_cannot_list_all_patients(self, signed_out: TestClient) -> None:
        sign_in(signed_out, PATIENT)
        assert signed_out.get("/api/patients").status_code == 403

    def test_patient_cannot_reach_the_admin_dashboard(self, signed_out: TestClient) -> None:
        sign_in(signed_out, PATIENT)
        assert signed_out.get("/api/dashboard/admin").status_code == 403

    def test_patient_cannot_manage_users(self, signed_out: TestClient) -> None:
        sign_in(signed_out, PATIENT)
        assert signed_out.get("/api/users").status_code == 403
        created = signed_out.post(
            "/api/users",
            json={"name": "Escalate", "email": "esc@medisensetests.org", "role": "ADMIN"},
        )
        assert created.status_code == 403


class TestDoctorScoping:
    """A doctor reaches patients they have a care relationship with — not all."""

    async def test_doctor_can_read_an_assigned_patient(
        self, signed_out: TestClient, db: AsyncSession
    ) -> None:
        sign_in(signed_out, DOCTOR)
        assigned = await _patient_id_for(db, PATIENT)

        response = signed_out.get(f"/api/patients/{assigned}")
        assert response.status_code == 200
        # A treating doctor does see clinical fields.
        assert "allergies" in response.json()["data"]

    async def test_doctor_cannot_read_an_unassigned_patient(
        self, signed_out: TestClient, db: AsyncSession
    ) -> None:
        # doctor@example.com covers Priya and Vikram, never Meera.
        sign_in(signed_out, DOCTOR)
        unassigned = await _patient_id_for(db, OTHER_PATIENT)

        response = signed_out.get(f"/api/patients/{unassigned}")
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN_RESOURCE"

    def test_the_caseload_lists_only_assigned_patients(self, signed_out: TestClient) -> None:
        sign_in(signed_out, DOCTOR)
        response = signed_out.get("/api/doctors/me/patients")
        assert response.status_code == 200

        names = {row["name"] for row in response.json()["data"]}
        assert "Priya Sharma" in names
        assert "Meera Nair" not in names

    def test_doctor_cannot_list_every_patient(self, signed_out: TestClient) -> None:
        sign_in(signed_out, DOCTOR)
        assert signed_out.get("/api/patients").status_code == 403

    def test_doctor_cannot_read_the_admin_dashboard(self, signed_out: TestClient) -> None:
        sign_in(signed_out, DOCTOR)
        assert signed_out.get("/api/dashboard/admin").status_code == 403


class TestAdminBoundaries:
    """Administration is separate from clinical content (R2)."""

    def test_admin_can_manage_users_and_see_analytics(self, signed_out: TestClient) -> None:
        sign_in(signed_out, ADMIN)
        assert signed_out.get("/api/users").status_code == 200
        assert signed_out.get("/api/dashboard/admin").status_code == 200
        assert signed_out.get("/api/patients").status_code == 200

    async def test_admin_sees_identity_but_not_clinical_detail(
        self, signed_out: TestClient, db: AsyncSession
    ) -> None:
        sign_in(signed_out, ADMIN)
        patient_id = await _patient_id_for(db, PATIENT)

        data = signed_out.get(f"/api/patients/{patient_id}").json()["data"]
        assert data["name"]  # identity, for running the hospital
        assert "allergies" not in data
        assert "chronicConditions" not in data

    def test_admin_has_no_clinical_dashboard(self, signed_out: TestClient) -> None:
        sign_in(signed_out, ADMIN)
        assert signed_out.get("/api/dashboard/doctor").status_code == 403
        assert signed_out.get("/api/dashboard/patient").status_code == 403


class TestNurseHasNoStandingAccess:
    """R3 / conflict C1: a nurse holds no patient access until a grant exists."""

    async def test_nurse_cannot_read_a_patient_without_a_grant(
        self, signed_out: TestClient, db: AsyncSession
    ) -> None:
        sign_in(signed_out, NURSE)
        patient_id = await _patient_id_for(db, PATIENT)

        response = signed_out.get(f"/api/patients/{patient_id}")
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN_RESOURCE"

    def test_nurse_reaches_no_dashboard(self, signed_out: TestClient) -> None:
        sign_in(signed_out, NURSE)
        for path in ("/api/dashboard/admin", "/api/dashboard/doctor", "/api/dashboard/patient"):
            assert signed_out.get(path).status_code == 403

    def test_nurse_permissions_advertise_only_emergency_request(
        self, signed_out: TestClient
    ) -> None:
        sign_in(signed_out, NURSE)
        permissions = signed_out.get("/api/users/permissions").json()["data"]["permissions"]
        assert "emergency:request" in permissions
        assert not any(p.startswith("patient:read") for p in permissions)
        assert not any(p.startswith("record:read") for p in permissions)


class TestDeniedAccessIsAudited:
    async def test_a_rejected_chart_read_writes_a_security_event(
        self, signed_out: TestClient, db: AsyncSession
    ) -> None:
        from app.db.enums import AuditAction, AuditSeverity
        from app.db.models import AuditLog

        sign_in(signed_out, PATIENT)
        other_id = await _patient_id_for(db, OTHER_PATIENT)
        assert signed_out.get(f"/api/patients/{other_id}").status_code == 403

        entry = (
            await db.execute(
                select(AuditLog)
                .where(AuditLog.action == AuditAction.ACCESS_DENIED, AuditLog.patient_id == other_id)
                .order_by(AuditLog.timestamp.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

        assert entry is not None
        assert entry.severity == AuditSeverity.SECURITY


class TestDashboards:
    def test_patient_dashboard_returns_their_own_summary(self, signed_out: TestClient) -> None:
        sign_in(signed_out, PATIENT)
        data = signed_out.get("/api/dashboard/patient").json()["data"]
        assert set(data["counts"]) >= {
            "upcomingAppointments",
            "activePrescriptions",
            "documents",
            "unpaidInvoices",
        }

    def test_doctor_dashboard_counts_the_caseload(self, signed_out: TestClient) -> None:
        sign_in(signed_out, DOCTOR)
        data = signed_out.get("/api/dashboard/doctor").json()["data"]
        assert data["counts"]["assignedPatients"] >= 1

    def test_admin_dashboard_surfaces_unreviewed_emergency_grants(
        self, signed_out: TestClient
    ) -> None:
        sign_in(signed_out, ADMIN)
        counts = signed_out.get("/api/dashboard/admin").json()["data"]["counts"]
        assert "unreviewedEmergencyGrants" in counts
        assert counts["patients"] >= 3


class TestDirectory:
    def test_any_signed_in_user_can_browse_doctors_to_book(self, signed_out: TestClient) -> None:
        sign_in(signed_out, PATIENT)
        response = signed_out.get("/api/doctors")
        assert response.status_code == 200
        assert len(response.json()["data"]) >= 1

    def test_the_doctor_directory_leaks_no_patient_information(
        self, signed_out: TestClient
    ) -> None:
        sign_in(signed_out, PATIENT)
        body = signed_out.get("/api/doctors").text
        # Who a doctor treats is itself confidential.
        for leaked in ("patient", "Priya", "medicalRecordNumber"):
            assert leaked not in body

    def test_departments_are_readable_but_not_writable_by_patients(
        self, signed_out: TestClient
    ) -> None:
        sign_in(signed_out, PATIENT)
        assert signed_out.get("/api/departments").status_code == 200
        created = signed_out.post("/api/departments", json={"name": "Rogue", "code": "ROGUE"})
        assert created.status_code == 403

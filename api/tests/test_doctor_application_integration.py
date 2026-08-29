"""Doctor self-registration end to end: draft, submit, review, approve.

The property that matters here is the one the module exists for: **a claim never
becomes a credential without a named administrator deciding so.** So these tests
check that a ``Doctor`` row appears on approval and at no earlier point, that
the login gate names the right state at every step, and that the audit entry for
a decision names the administrator who made it.

The reviewer is the demo administrator, and signing in is the only thing done
with that account — nothing is written to it beyond the notification rows the
flow produces, and those are removed again. The applicant is created by these
tests and deleted afterwards, taking its application, documents and sessions
with it.

Document upload is not exercised here: it needs Supabase Storage, and a test
that puts real objects in a real bucket to prove a database transition is a test
that leaves litter behind. ``test_file_validation.py`` covers the inspection
every upload goes through.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import ratelimit
from app.db.base import utcnow
from app.db.enums import AuditAction, DoctorApplicationStatus, UserStatus
from app.db.models import AuditLog, Doctor, DoctorApplication, Notification, User
from app.modules.auth import twofactor
from tests.conftest import requires_db

pytestmark = requires_db

PASSWORD = "ApplicantPass123"
KNOWN_CODE = "424242"

ADMIN = "admin@example.com"
DEMO_PASSWORD = "Demo@Pass123"

#: A complete application. Anything missing from this is what ``submit`` refuses.
COMPLETE: dict[str, Any] = {
    "fullName": "Ayesha Iqbal",
    "phone": "+92 300 1234567",
    "nationalId": "35202-1234567-8",
    "address": "12 Jail Road, Lahore",
    "registrationNumber": "",  # filled per test so it stays unique
    "specialization": "Cardiology",
    "qualifications": ["MBBS, King Edward Medical University", "FCPS Cardiology"],
    "yearsExperience": 9,
    "previousHospital": "Services Hospital",
    "consultationFee": 2500,
    "availability": [{"dayOfWeek": 2, "startTime": "09:00", "endTime": "13:00", "slotMinutes": 30}],
}


def unique_email(prefix: str = "applicant") -> str:
    return f"{prefix}-{uuid.uuid4()}@medisensetests.org"


def unique_registration() -> str:
    """Unique because ``doctors.licenseNumber`` is, and approval copies it across."""
    return f"PMC-TEST-{uuid.uuid4().hex[:10].upper()}"


@pytest.fixture(autouse=True)
def _fresh_rate_limits() -> None:
    ratelimit.reset()


def sign_in(client: TestClient, email: str, password: str) -> dict[str, Any]:
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return dict(response.json()["data"])


@pytest.fixture
async def applicant(client: TestClient, db: AsyncSession) -> AsyncIterator[dict[str, Any]]:
    """A verified doctor account holding an empty DRAFT application, signed in.

    Created through the real registration and verification endpoints rather than
    by writing rows, so what these tests drive is the flow an applicant actually
    walks.
    """
    email = unique_email()
    created = client.post(
        "/api/auth/register",
        json={"name": "Ayesha Iqbal", "email": email, "password": PASSWORD, "role": "DOCTOR"},
    )
    assert created.status_code == 201, created.text

    await db.execute(
        update(User)
        .where(User.email == email)
        .values(
            email_verification_code_hash=twofactor.hash_code(KNOWN_CODE),
            email_verification_expires_at=utcnow() + timedelta(minutes=10),
            email_verification_attempts=0,
        )
    )
    await db.commit()

    verified = client.post(
        "/api/auth/verify-email",
        json={"email": email, "code": KNOWN_CODE, "deviceClass": "PERSONAL"},
    )
    assert verified.status_code == 200, verified.text

    user_id = verified.json()["data"]["user"]["id"]
    yield {"email": email, "id": user_id, "registration": unique_registration()}

    client.cookies.clear()
    application_id = (
        await db.execute(select(DoctorApplication.id).where(DoctorApplication.user_id == user_id))
    ).scalar_one_or_none()
    if application_id:
        # The administrator's notifications hang off *their* user row, so they
        # do not cascade with the applicant and have to go explicitly.
        await db.execute(
            delete(Notification).where(
                Notification.link.like(f"%doctor-applications/{application_id}")
            )
        )
    await db.execute(delete(User).where(User.id == user_id))
    await db.commit()


async def _application(db: AsyncSession, user_id: str) -> DoctorApplication:
    row = (
        await db.execute(select(DoctorApplication).where(DoctorApplication.user_id == user_id))
    ).scalar_one()
    await db.refresh(row)
    return row


def _complete_payload(registration: str) -> dict[str, Any]:
    return {**COMPLETE, "registrationNumber": registration}


def _submit_complete(client: TestClient, applicant: dict[str, Any]) -> dict[str, Any]:
    saved = client.put("/api/doctor/application", json=_complete_payload(applicant["registration"]))
    assert saved.status_code == 200, saved.text
    submitted = client.post("/api/doctor/application/submit")
    assert submitted.status_code == 200, submitted.text
    return dict(submitted.json()["data"])


class TestTheDraft:
    def test_reading_it_creates_it(self, client: TestClient, applicant: dict) -> None:
        response = client.get("/api/doctor/application")
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["status"] == "DRAFT"
        assert data["canEdit"] is True
        # The form knows what it still needs without having to try submitting.
        assert "registrationNumber" in data["missingFields"]

    def test_a_partial_save_keeps_what_it_was_given(
        self, client: TestClient, applicant: dict
    ) -> None:
        first = client.put("/api/doctor/application", json={"specialization": "Cardiology"})
        assert first.status_code == 200
        assert first.json()["data"]["specialization"] == "Cardiology"

        # A second save mentioning a different field leaves the first alone.
        second = client.put("/api/doctor/application", json={"yearsExperience": 9})
        assert second.json()["data"]["specialization"] == "Cardiology"
        assert second.json()["data"]["yearsExperience"] == 9

    def test_saving_the_same_thing_twice_changes_nothing(
        self, client: TestClient, applicant: dict
    ) -> None:
        payload = {"specialization": "Cardiology", "yearsExperience": 9}
        first = client.put("/api/doctor/application", json=payload).json()["data"]
        second = client.put("/api/doctor/application", json=payload).json()["data"]
        assert first["specialization"] == second["specialization"]
        assert first["id"] == second["id"]

    def test_a_malformed_availability_window_is_refused(
        self, client: TestClient, applicant: dict
    ) -> None:
        """These windows become the slot grid patients book against."""
        response = client.put(
            "/api/doctor/application",
            json={
                "availability": [
                    {"dayOfWeek": 2, "startTime": "17:00", "endTime": "09:00", "slotMinutes": 30}
                ]
            },
        )
        assert response.status_code == 422

    def test_submitting_an_incomplete_application_says_what_is_missing(
        self, client: TestClient, applicant: dict
    ) -> None:
        client.put("/api/doctor/application", json={"specialization": "Cardiology"})
        response = client.post("/api/doctor/application/submit")
        assert response.status_code == 422
        body = response.json()["error"]
        assert body["code"] == "PROFILE_INCOMPLETE"
        assert {detail["field"] for detail in body["details"]} >= {
            "registrationNumber",
            "nationalId",
        }


class TestSubmission:
    async def test_it_moves_to_submitted_and_locks(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        data = _submit_complete(client, applicant)
        assert data["status"] == "SUBMITTED"
        assert data["canEdit"] is False
        assert data["submittedAt"]

        row = await _application(db, applicant["id"])
        assert row.status == DoctorApplicationStatus.SUBMITTED

        # The version the reviewer is reading cannot change under them.
        blocked = client.put("/api/doctor/application", json={"specialization": "Neurology"})
        assert blocked.status_code == 409
        assert blocked.json()["error"]["code"] == "PENDING_APPROVAL"

    async def test_it_still_creates_no_doctor_row(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        _submit_complete(client, applicant)
        credential = (
            await db.execute(select(Doctor.id).where(Doctor.user_id == applicant["id"]))
        ).scalar_one_or_none()
        assert credential is None

    async def test_the_administrators_are_told(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        _submit_complete(client, applicant)
        application = await _application(db, applicant["id"])

        waiting = (
            (
                await db.execute(
                    select(Notification).where(
                        Notification.link == f"/admin/doctor-applications/{application.id}"
                    )
                )
            )
            .scalars()
            .all()
        )
        assert waiting
        # The notification names the applicant and nothing else about them.
        assert all("Ayesha" in row.body for row in waiting)

    def test_the_applicant_can_still_sign_in_and_lands_on_the_waiting_screen(
        self, client: TestClient, applicant: dict
    ) -> None:
        """Waiting for a decision is not a reason to lock somebody out."""
        _submit_complete(client, applicant)
        data = sign_in(client, applicant["email"], PASSWORD)
        assert data["redirectTo"] == "/doctor/pending"
        client.cookies.clear()

    def test_but_the_role_still_buys_nothing_clinical(
        self, client: TestClient, applicant: dict
    ) -> None:
        _submit_complete(client, applicant)
        sign_in(client, applicant["email"], PASSWORD)

        refused = client.get("/api/doctors/me/patients")
        assert refused.status_code == 403
        assert refused.json()["error"]["code"] == "PENDING_APPROVAL"
        client.cookies.clear()


class TestTheOnboardingGate:
    """An unapproved doctor holds the DOCTOR role without being credentialed.

    So the role has to buy them their own application and nothing else. The
    refusal lives in the request dependency rather than in login, which fails in
    the safe direction: the worst case is a doctor who cannot reach a page they
    have no business on yet, never a doctor who reaches a chart before anybody
    checked their licence.
    """

    def test_a_draft_applicant_can_sign_in(self, client: TestClient, applicant: dict) -> None:
        """The failure this replaced: locked out of your own half-finished form."""
        data = sign_in(client, applicant["email"], PASSWORD)
        assert data["requires2FA"] is False
        assert data["redirectTo"] == "/doctor/onboarding"
        client.cookies.clear()

    def test_a_draft_applicant_reaches_their_own_application(
        self, client: TestClient, applicant: dict
    ) -> None:
        sign_in(client, applicant["email"], PASSWORD)

        assert client.get("/api/auth/me").status_code == 200
        assert client.get("/api/doctor/application").status_code == 200

        saved = client.put("/api/doctor/application", json={"specialization": "Cardiology"})
        assert saved.status_code == 200
        assert saved.json()["data"]["specialization"] == "Cardiology"

        # The onboarding form has to be able to populate its department list.
        assert client.get("/api/departments").status_code == 200
        # And they must be able to secure the account they just made.
        assert client.get("/api/account/2fa").status_code == 200
        client.cookies.clear()

    @pytest.mark.parametrize(
        "path",
        [
            "/api/doctors/me/patients",
            "/api/patients",
            "/api/appointments",
            "/api/documents",
        ],
    )
    def test_a_draft_applicant_reaches_nothing_clinical(
        self, client: TestClient, applicant: dict, path: str
    ) -> None:
        sign_in(client, applicant["email"], PASSWORD)
        response = client.get(path)
        assert response.status_code == 403, f"{path} let an uncredentialed doctor in"
        # Named, so the client can route them to the right screen.
        assert response.json()["error"]["code"] == "PROFILE_INCOMPLETE"
        client.cookies.clear()

    async def test_approval_lifts_the_gate(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        _submit_complete(client, applicant)
        application = await _application(db, applicant["id"])

        sign_in(client, ADMIN, DEMO_PASSWORD)
        client.post(f"/api/admin/doctor-applications/{application.id}/approve", json={})
        client.cookies.clear()

        sign_in(client, applicant["email"], PASSWORD)
        assert client.get("/api/doctors/me/patients").status_code == 200
        client.cookies.clear()

    @pytest.mark.parametrize("email", ["doctor@example.com", "doctor3@example.com"])
    def test_the_seeded_doctors_are_untouched(self, client: TestClient, email: str) -> None:
        """They hold a Doctor row, so the migration's backfill approved them.

        This is the regression that would have shipped silently: a gate keyed on
        an application row, applied to accounts that predate applications
        entirely.
        """
        data = sign_in(client, email, DEMO_PASSWORD)
        assert data["redirectTo"] == "/doctor"
        assert data["user"]["doctorId"]
        assert client.get("/api/doctors/me/patients").status_code == 200
        assert client.get("/api/appointments").status_code == 200
        client.cookies.clear()


class TestWhoMayReview:
    def test_an_applicant_cannot_reach_the_review_queue(
        self, client: TestClient, applicant: dict
    ) -> None:
        assert client.get("/api/admin/doctor-applications").status_code == 403

    async def test_an_applicant_cannot_approve_themselves(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        """The obvious attack, and the one the whole module exists to refuse."""
        _submit_complete(client, applicant)
        application = await _application(db, applicant["id"])

        response = client.post(
            f"/api/admin/doctor-applications/{application.id}/approve", json={}
        )
        assert response.status_code == 403

        credential = (
            await db.execute(select(Doctor.id).where(Doctor.user_id == applicant["id"]))
        ).scalar_one_or_none()
        assert credential is None

    def test_an_anonymous_caller_is_refused(self, client: TestClient) -> None:
        client.cookies.clear()
        assert client.get("/api/admin/doctor-applications").status_code == 401


class TestReview:
    async def test_the_queue_reports_how_many_are_waiting(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        _submit_complete(client, applicant)
        sign_in(client, ADMIN, DEMO_PASSWORD)

        response = client.get("/api/admin/doctor-applications", params={"status": "SUBMITTED"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["meta"]["pending"] >= 1
        assert applicant["id"] in [row["userId"] for row in body["data"]]
        client.cookies.clear()

    async def test_rejecting_returns_it_with_a_reason(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        _submit_complete(client, applicant)
        application = await _application(db, applicant["id"])

        sign_in(client, ADMIN, DEMO_PASSWORD)
        response = client.post(
            f"/api/admin/doctor-applications/{application.id}/reject",
            json={"reason": "The registration certificate is not legible.", "notes": "internal"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["data"]["status"] == "REJECTED"
        client.cookies.clear()

        # They can get back in — the whole point of a rejection is that it can be
        # corrected — and they land on the form.
        data = sign_in(client, applicant["email"], PASSWORD)
        assert data["redirectTo"] == "/doctor/onboarding"

        refused = client.get("/api/doctors/me/patients")
        assert refused.status_code == 403
        assert refused.json()["error"]["code"] == "APPLICATION_REJECTED"
        client.cookies.clear()

    async def test_a_rejected_applicant_may_correct_and_resubmit(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        """A rejection is a request for changes, so the way back is the same door."""
        _submit_complete(client, applicant)
        application = await _application(db, applicant["id"])

        sign_in(client, ADMIN, DEMO_PASSWORD)
        client.post(
            f"/api/admin/doctor-applications/{application.id}/reject",
            json={"reason": "The registration certificate is not legible."},
        )
        client.cookies.clear()

        sign_in(client, applicant["email"], PASSWORD)

        current = client.get("/api/doctor/application").json()["data"]
        assert current["status"] == "REJECTED"
        assert current["canEdit"] is True
        assert current["rejectionReason"]
        # Internal review notes are never shown to the applicant.
        assert "reviewNotes" not in current

        edited = client.put("/api/doctor/application", json={"specialization": "Neurology"})
        assert edited.status_code == 200

        resubmitted = client.post("/api/doctor/application/submit")
        assert resubmitted.status_code == 200
        assert resubmitted.json()["data"]["status"] == "SUBMITTED"
        # The previous decision no longer looks current.
        assert resubmitted.json()["data"]["rejectionReason"] is None
        client.cookies.clear()

    async def test_approving_creates_the_doctor_row_from_the_application(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        _submit_complete(client, applicant)
        application = await _application(db, applicant["id"])

        sign_in(client, ADMIN, DEMO_PASSWORD)
        admin_id = client.get("/api/auth/me").json()["data"]["user"]["id"]
        response = client.post(
            f"/api/admin/doctor-applications/{application.id}/approve",
            json={"notes": "Certificate checked against the register."},
        )
        assert response.status_code == 200, response.text
        assert response.json()["data"]["status"] == "APPROVED"
        client.cookies.clear()

        doctor = (
            await db.execute(select(Doctor).where(Doctor.user_id == applicant["id"]))
        ).scalar_one()
        assert doctor.specialization == "Cardiology"
        # The registration number becomes the licence number.
        assert doctor.license_number == applicant["registration"]
        assert doctor.years_experience == 9
        assert float(doctor.consultation_fee) == 2500
        assert doctor.availability[0]["startTime"] == "09:00"
        assert "MBBS" in (doctor.qualifications or "")

        user = (await db.execute(select(User).where(User.id == applicant["id"]))).scalar_one()
        await db.refresh(user)
        assert user.status == UserStatus.ACTIVE

        entry = (
            await db.execute(
                select(AuditLog)
                .where(
                    AuditLog.action == AuditAction.DOCTOR_APPLICATION_APPROVED,
                    AuditLog.entity_id == application.id,
                )
                .order_by(AuditLog.timestamp.desc())
                .limit(1)
            )
        ).scalar_one()
        # The question this entry answers later is "who let this person in?".
        assert entry.user_id == admin_id

    async def test_an_approved_doctor_can_sign_in_and_lands_on_their_dashboard(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        _submit_complete(client, applicant)
        application = await _application(db, applicant["id"])

        sign_in(client, ADMIN, DEMO_PASSWORD)
        client.post(f"/api/admin/doctor-applications/{application.id}/approve", json={})
        client.cookies.clear()

        response = client.post(
            "/api/auth/login", json={"email": applicant["email"], "password": PASSWORD}
        )
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["redirectTo"] == "/doctor"
        assert data["user"]["doctorId"]
        client.cookies.clear()

    async def test_an_approved_application_can_no_longer_be_edited(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        _submit_complete(client, applicant)
        application = await _application(db, applicant["id"])

        sign_in(client, ADMIN, DEMO_PASSWORD)
        client.post(f"/api/admin/doctor-applications/{application.id}/approve", json={})
        client.cookies.clear()

        sign_in(client, applicant["email"], PASSWORD)
        blocked = client.put("/api/doctor/application", json={"registrationNumber": "FORGED-1"})
        assert blocked.status_code == 409
        client.cookies.clear()

    async def test_a_decision_cannot_be_made_twice(
        self, client: TestClient, db: AsyncSession, applicant: dict
    ) -> None:
        _submit_complete(client, applicant)
        application = await _application(db, applicant["id"])

        sign_in(client, ADMIN, DEMO_PASSWORD)
        assert (
            client.post(
                f"/api/admin/doctor-applications/{application.id}/approve", json={}
            ).status_code
            == 200
        )
        again = client.post(
            f"/api/admin/doctor-applications/{application.id}/reject",
            json={"reason": "Changed my mind about this one."},
        )
        assert again.status_code == 409
        client.cookies.clear()

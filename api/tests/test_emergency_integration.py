"""Break-glass access, end to end (requirement R3, conflict C1).

The property under test is uncomfortable but correct: **a grant is issued
immediately, without approval.** Break-glass that waits for a human has failed
at the moment it exists for, and staff who cannot get in during an emergency
start sharing logins — which defeats every control in this system rather than
just this one.

So these tests are mostly about what makes that safe: the grant opens exactly
one chart, expires on a clock, counts and audits every read, tells the patient,
and lands in a review queue nobody can quietly empty.

Written for the Phase 15 test pass; not run during development.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update

from app.db.base import utcnow
from app.db.enums import EmergencyAccessStatus
from app.db.models import AuditLog, EmergencyAccess, Notification, Patient, User
from app.db.session import SessionFactory
from app.modules.emergency import service
from tests.conftest import ADMIN_EMAIL, password_for, requires_db

pytestmark = requires_db

DEMO_PASSWORD = "Demo@Pass123"

NURSE = "nurse@example.com"
#: Supplied by the environment — see `requires_admin` in conftest.
ADMIN = ADMIN_EMAIL
DOCTOR = "doctor@example.com"  # treats Priya
OTHER_DOCTOR = "doctor3@example.com"
PATIENT = "patient@example.com"  # Priya
OTHER_PATIENT = "patient3@example.com"  # Meera

REASON = "Unresponsive patient in resus, no assigned clinician available."


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


@pytest.fixture
async def priya() -> str:
    return await patient_id_for(PATIENT)


@pytest.fixture(autouse=True)
async def clean_grants() -> AsyncIterator[None]:
    """Removes grants and their notifications.

    Audit entries stay: the log is append-only, and a test that could delete
    from it would be testing something other than the system in use.
    """
    yield
    async with SessionFactory() as session:
        ids = (
            (await session.execute(select(EmergencyAccess.id))).scalars().all()
        )
        if ids:
            await session.execute(
                delete(Notification).where(
                    Notification.notification_metadata["emergencyAccessId"].astext.in_(ids)
                )
            )
        await session.execute(delete(EmergencyAccess))
        await session.commit()


def request_access(client: TestClient, patient_id: str, reason: str = REASON) -> Any:
    return client.post(
        "/api/emergency/request", json={"patientId": patient_id, "reason": reason}
    )


class TestGranting:
    def test_a_nurse_gets_access_immediately(self, client: TestClient, priya: str) -> None:
        """No approval queue. That is the point of break-glass."""
        sign_in(client, NURSE)
        response = request_access(client, priya)

        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert data["status"] == "ACTIVE"
        assert data["live"] is True
        assert data["created"] is True

    def test_the_grant_actually_opens_the_chart(self, client: TestClient, priya: str) -> None:
        """A nurse holds no standing clinical access at all (conflict C1)."""
        sign_in(client, NURSE)
        assert client.get(f"/api/records?patientId={priya}").status_code == 403

        request_access(client, priya)
        # The response set a new access cookie carrying the grant.
        assert client.get(f"/api/records?patientId={priya}").status_code == 200

    async def test_it_opens_only_that_chart(self, client: TestClient, priya: str) -> None:
        """Scoped to one patient — it opens a chart, not the hospital."""
        meera = await patient_id_for(OTHER_PATIENT)
        sign_in(client, NURSE)
        request_access(client, priya)

        assert client.get(f"/api/records?patientId={priya}").status_code == 200
        assert client.get(f"/api/records?patientId={meera}").status_code == 403

    def test_a_reason_is_required(self, client: TestClient, priya: str) -> None:
        """The reason is the only part of this record that explains the rest."""
        sign_in(client, NURSE)
        assert request_access(client, priya, reason="x").status_code == 422
        assert client.post("/api/emergency/request", json={"patientId": priya}).status_code == 422

    def test_an_unknown_patient_is_refused(self, client: TestClient) -> None:
        sign_in(client, NURSE)
        assert request_access(client, "no-such-patient").status_code == 404

    def test_a_patient_cannot_break_glass(self, client: TestClient, priya: str) -> None:
        sign_in(client, PATIENT)
        assert request_access(client, priya).status_code == 403

    def test_requesting_twice_reuses_the_grant(self, client: TestClient, priya: str) -> None:
        """A session dropped mid-emergency must not create a second record of
        one event — a pile of near-identical grants makes the review harder."""
        sign_in(client, NURSE)
        first = request_access(client, priya).json()["data"]
        second = request_access(client, priya).json()["data"]

        assert second["id"] == first["id"]
        assert second["created"] is False


class TestExpiry:
    async def test_an_expired_grant_stops_working(
        self, client: TestClient, priya: str
    ) -> None:
        """Enforced at the moment of use, never by a background sweeper.

        A sweeper that stopped running would silently extend every outstanding
        grant, which is the one failure a time-boxed credential cannot afford.
        """
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]
        assert client.get(f"/api/records?patientId={priya}").status_code == 200

        # Wind the clock back on the grant itself; the cookie is untouched.
        async with SessionFactory() as session:
            await session.execute(
                update(EmergencyAccess)
                .where(EmergencyAccess.id == grant_id)
                .values(expires_at=utcnow() - timedelta(minutes=1))
            )
            await session.commit()

        assert client.get(f"/api/records?patientId={priya}").status_code == 403

    async def test_an_expired_grant_reads_as_expired(
        self, client: TestClient, priya: str
    ) -> None:
        """`status` still says ACTIVE in the column until something writes to
        it, so the effective status is computed from the clock as well."""
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]

        async with SessionFactory() as session:
            await session.execute(
                update(EmergencyAccess)
                .where(EmergencyAccess.id == grant_id)
                .values(expires_at=utcnow() - timedelta(minutes=1))
            )
            await session.commit()
            grant = (
                await session.execute(
                    select(EmergencyAccess).where(EmergencyAccess.id == grant_id)
                )
            ).scalar_one()

        assert grant.status == EmergencyAccessStatus.ACTIVE, "the column is untouched"
        assert str(service.effective_status(grant)) == "EXPIRED"
        assert service.is_live(grant) is False


class TestRevocation:
    def test_the_holder_may_hand_it_back(self, client: TestClient, priya: str) -> None:
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]

        assert client.post(f"/api/emergency/{grant_id}/revoke").status_code == 200
        # The cookie still names the grant; the grant no longer authorises.
        assert client.get(f"/api/records?patientId={priya}").status_code == 403

    def test_an_administrator_may_take_it_away(self, client: TestClient, priya: str) -> None:
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]

        sign_in(client, ADMIN)
        assert client.post(f"/api/emergency/{grant_id}/revoke").status_code == 200

    def test_a_third_party_may_not(self, client: TestClient, priya: str) -> None:
        """Revoking someone's access mid-emergency is its own safety problem."""
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]

        sign_in(client, OTHER_DOCTOR)
        assert client.post(f"/api/emergency/{grant_id}/revoke").status_code == 403

    def test_revocation_is_immediate_not_on_token_expiry(
        self, client: TestClient, priya: str
    ) -> None:
        """The token is a pointer, not the authority.

        `resolve_patient_access` re-reads the grant on every request, so a
        revoked grant stops working on the next call even though the browser
        still holds a token naming it.
        """
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]
        client.post(f"/api/emergency/{grant_id}/revoke")

        assert client.get(f"/api/records?patientId={priya}").status_code == 403


class TestAccounting:
    async def test_every_read_is_counted(self, client: TestClient, priya: str) -> None:
        """A grant used once looks very different from one used ninety times,
        and that difference is the first thing a reviewer should see."""
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]

        for _ in range(3):
            client.get(f"/api/records?patientId={priya}")

        async with SessionFactory() as session:
            grant = (
                await session.execute(
                    select(EmergencyAccess).where(EmergencyAccess.id == grant_id)
                )
            ).scalar_one()

        assert grant.access_count >= 3

    async def test_the_grant_is_audited_with_its_reason(
        self, client: TestClient, priya: str
    ) -> None:
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog).where(
                        AuditLog.entity_type == "EmergencyAccess",
                        AuditLog.entity_id == grant_id,
                    )
                )
            ).scalars().first()

        assert entry is not None
        assert str(entry.severity) == "BREAK_GLASS"
        # Copied into the append-only log, so it cannot be edited later even if
        # the grant row somehow could be.
        assert entry.audit_metadata["reason"] == REASON

    async def test_each_read_writes_a_break_glass_entry(
        self, client: TestClient, priya: str
    ) -> None:
        sign_in(client, NURSE)
        request_access(client, priya)
        client.get(f"/api/records?patientId={priya}")

        async with SessionFactory() as session:
            used = (
                (
                    await session.execute(
                        select(AuditLog).where(
                            AuditLog.action == "EMERGENCY_ACCESS_USED",
                            AuditLog.patient_id == priya,
                        )
                    )
                )
                .scalars()
                .all()
            )
        assert used, "a read under a grant must leave its own record"


class TestTransparency:
    async def test_the_patient_is_told(self, client: TestClient, priya: str) -> None:
        """Finding out from an audit request months later is not transparency."""
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]

        async with SessionFactory() as session:
            patient_user_id = (
                await session.execute(select(Patient.user_id).where(Patient.id == priya))
            ).scalar_one()
            notification = (
                await session.execute(
                    select(Notification).where(
                        Notification.user_id == patient_user_id,
                        Notification.notification_metadata["emergencyAccessId"].astext
                        == grant_id,
                    )
                )
            ).scalars().first()

        assert notification is not None
        assert "emergency access" in notification.title.lower()

    async def test_administrators_are_told_to_review(
        self, client: TestClient, priya: str
    ) -> None:
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]

        async with SessionFactory() as session:
            admin_notifications = (
                (
                    await session.execute(
                        select(Notification)
                        .join(User, User.id == Notification.user_id)
                        .where(
                            User.role == "ADMIN",
                            Notification.notification_metadata["emergencyAccessId"].astext
                            == grant_id,
                        )
                    )
                )
                .scalars()
                .all()
            )
        assert admin_notifications, "a review nobody is prompted to do does not happen"


class TestReview:
    def test_the_queue_shows_what_is_outstanding(
        self, client: TestClient, priya: str
    ) -> None:
        sign_in(client, NURSE)
        request_access(client, priya)

        sign_in(client, ADMIN)
        body = client.get("/api/emergency").json()
        assert body["meta"]["unreviewed"] >= 1
        assert body["data"][0]["requesterName"]

    def test_reviewing_records_who_and_what(self, client: TestClient, priya: str) -> None:
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]

        sign_in(client, ADMIN)
        body = client.post(
            f"/api/emergency/{grant_id}/review",
            json={"notes": "Checked against the resus log. Appropriate."},
        ).json()["data"]

        assert body["reviewedAt"]
        assert body["reviewedById"]
        assert "resus log" in body["reviewNotes"]

    def test_reviewing_twice_is_refused(self, client: TestClient, priya: str) -> None:
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]

        sign_in(client, ADMIN)
        client.post(f"/api/emergency/{grant_id}/review", json={"notes": "Appropriate."})
        second = client.post(
            f"/api/emergency/{grant_id}/review", json={"notes": "Changed my mind."}
        )
        assert second.status_code == 409

    def test_a_nurse_cannot_review_their_own(self, client: TestClient, priya: str) -> None:
        """The deterrent is the review. Reviewing yourself is not a review."""
        sign_in(client, NURSE)
        grant_id = request_access(client, priya).json()["data"]["id"]

        assert (
            client.post(f"/api/emergency/{grant_id}/review", json={"notes": "Fine."}).status_code
            == 403
        )

    def test_a_doctor_cannot_see_the_queue(self, client: TestClient) -> None:
        sign_in(client, DOCTOR)
        assert client.get("/api/emergency").status_code == 403

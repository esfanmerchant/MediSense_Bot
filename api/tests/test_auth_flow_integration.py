"""End-to-end authentication against the real database."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import utcnow
from app.db.enums import AuditAction, AuditSeverity
from app.db.models import AuditLog, Session, User
from app.modules.audit.service import verify_audit_chain
from app.modules.auth import twofactor
from tests.conftest import requires_db

pytestmark = requires_db

PASSWORD = "IntegrationPass123"
#: A syntactically valid CNIC. Registration requires one of every account;
#: it identifies the person at the hospital and is never a credential.
CNIC = "42101-7536622-3"
#: Registration emails a code and stores only its hash, so a test cannot read
#: the real one. A known hash is stamped onto the row instead and the ordinary
#: endpoint is driven with it — see `test_email_verification_integration.py`,
#: where that flow is what is actually under test. Here it is only the doorway
#: to the sessions these tests are about.
VERIFICATION_CODE = "424242"


def unique_email(prefix: str = "test") -> str:
    # Not example.invalid: email-validator rejects reserved/special-use domains,
    # so the request would fail validation before reaching any of the logic
    # these tests are actually about.
    return f"{prefix}-{uuid.uuid4()}@medisensetests.org"


async def _delete_user(db: AsyncSession, user_id: str) -> None:
    await db.execute(delete(User).where(User.id == user_id))
    await db.commit()


async def register_and_verify(
    client: TestClient, db: AsyncSession, email: str, name: str = "Integration Test Patient"
) -> dict:
    """Sign up and prove the address, returning the user payload."""
    created = client.post(
        "/api/auth/register",
        json={"name": name, "email": email, "password": PASSWORD, "cnic": CNIC},
    )
    assert created.status_code == 201, created.text
    assert created.json()["data"]["pendingVerification"] is True

    await db.execute(
        update(User)
        .where(User.email == email)
        .values(
            email_verification_code_hash=twofactor.hash_code(VERIFICATION_CODE),
            email_verification_expires_at=utcnow() + timedelta(minutes=10),
            email_verification_attempts=0,
        )
    )
    await db.commit()

    verified = client.post(
        "/api/auth/verify-email", json={"email": email, "code": VERIFICATION_CODE}
    )
    assert verified.status_code == 200, verified.text
    # Verification signs them in; these tests do their own logins.
    client.cookies.clear()
    return dict(verified.json()["data"]["user"])


@pytest.fixture
async def registered(client: TestClient, db: AsyncSession):
    """A freshly registered, verified patient, removed afterwards."""
    email = unique_email()
    user = await register_and_verify(client, db, email)
    yield {"email": email, "id": user["id"], "user": user}
    await _delete_user(db, user["id"])


class TestRegistration:
    def test_creates_a_patient_with_a_linked_patient_record(self, registered: dict) -> None:
        user = registered["user"]
        assert user["role"] == "PATIENT"
        assert user["patientId"]
        assert "record:read:own" in user["permissions"]
        assert "record:write" not in user["permissions"]

    def test_never_returns_the_password_hash(self, registered: dict) -> None:
        import json

        assert "passwordHash" not in json.dumps(registered["user"])
        assert "password_hash" not in json.dumps(registered["user"])

    def test_refuses_a_duplicate_email(self, client: TestClient, registered: dict) -> None:
        response = client.post(
            "/api/auth/register",
            json={
                "name": "Duplicate",
                "email": registered["email"],
                "password": PASSWORD,
                "cnic": CNIC,
            },
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "CONFLICT"


class TestLogin:
    def test_wrong_password_and_unknown_email_are_indistinguishable(
        self, client: TestClient, registered: dict
    ) -> None:
        wrong = client.post(
            "/api/auth/login", json={"email": registered["email"], "password": "WrongPass123"}
        )
        unknown = client.post(
            "/api/auth/login", json={"email": unique_email("nobody"), "password": "WrongPass123"}
        )
        assert wrong.status_code == unknown.status_code == 401
        # Identical responses: the login form must not enumerate accounts.
        assert wrong.json()["error"] == unknown.json()["error"]

    def test_issues_httponly_cookies_and_no_token_in_the_body(
        self, client: TestClient, registered: dict
    ) -> None:
        response = client.post("/api/auth/login", json={"email": registered["email"], "password": PASSWORD})
        assert response.status_code == 200
        assert response.json()["data"]["session"]["idleTimeoutSeconds"] == 120

        set_cookie = response.headers.get("set-cookie", "")
        assert "ms_at=" in set_cookie
        assert "HttpOnly" in set_cookie

        # The token itself is never in the body for page script to read. Checked
        # by value rather than by key name, since the body legitimately contains
        # "accessTokenExpiresInSeconds".
        access_cookie = client.cookies.get("ms_at")
        assert access_cookie
        assert access_cookie not in response.text

    def test_me_returns_the_signed_in_user(self, client: TestClient, registered: dict) -> None:
        client.post("/api/auth/login", json={"email": registered["email"], "password": PASSWORD})
        response = client.get("/api/auth/me")
        assert response.status_code == 200
        assert response.json()["data"]["user"]["email"] == registered["email"]
        client.cookies.clear()


class TestSessionExpiry:
    async def test_expires_after_the_inactivity_window(
        self, client: TestClient, db: AsyncSession, registered: dict
    ) -> None:
        """R8, proven against the database rather than a client timer."""
        login = client.post("/api/auth/login", json={"email": registered["email"], "password": PASSWORD})
        session_id = login.json()["data"]["session"]["sessionId"]

        # Backdate the last activity past the 2-minute limit rather than waiting.
        await db.execute(
            update(Session)
            .where(Session.id == session_id)
            .values(last_seen_at=utcnow() - timedelta(seconds=121))
        )
        await db.commit()

        response = client.get("/api/auth/me")
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "SESSION_EXPIRED"

        # The session is revoked, so the same cookie cannot be reused.
        session = (await db.execute(select(Session).where(Session.id == session_id))).scalar_one()
        await db.refresh(session)
        assert session.revoked_at is not None
        assert session.revoked_reason == "IDLE_TIMEOUT"
        client.cookies.clear()

    async def test_replaying_a_rotated_refresh_token_burns_the_session(
        self, client: TestClient, db: AsyncSession, registered: dict
    ) -> None:
        login = client.post("/api/auth/login", json={"email": registered["email"], "password": PASSWORD})
        session_id = login.json()["data"]["session"]["sessionId"]
        original_refresh = client.cookies.get("ms_rt")
        assert original_refresh

        assert client.post("/api/auth/refresh").status_code == 200

        # Replay the original token: treated as a leak, not a retry.
        client.cookies.set("ms_rt", original_refresh, path="/api/auth")
        assert client.post("/api/auth/refresh").status_code == 401

        session = (await db.execute(select(Session).where(Session.id == session_id))).scalar_one()
        await db.refresh(session)
        assert session.revoked_reason == "REFRESH_TOKEN_REUSE"
        client.cookies.clear()

    def test_logout_ends_the_session(self, client: TestClient, registered: dict) -> None:
        client.post("/api/auth/login", json={"email": registered["email"], "password": PASSWORD})
        assert client.post("/api/auth/logout").status_code == 200
        assert client.get("/api/auth/me").status_code == 401
        client.cookies.clear()


class TestLockout:
    def test_locks_the_account_after_repeated_failures(self, client: TestClient, registered: dict) -> None:
        for _ in range(5):
            client.post("/api/auth/login", json={"email": registered["email"], "password": "Nope12345678"})

        # Even the correct password is refused while the lock holds.
        response = client.post("/api/auth/login", json={"email": registered["email"], "password": PASSWORD})
        assert response.status_code == 423
        assert response.json()["error"]["code"] == "ACCOUNT_LOCKED"


class TestAuditLog:
    """R6 — verified against what actually landed in Postgres."""

    async def test_records_a_login(self, client: TestClient, db: AsyncSession, registered: dict) -> None:
        client.post("/api/auth/login", json={"email": registered["email"], "password": PASSWORD})
        client.cookies.clear()

        entry = (
            await db.execute(
                select(AuditLog)
                .where(AuditLog.action == AuditAction.LOGIN, AuditLog.user_id == registered["id"])
                .order_by(AuditLog.timestamp.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        assert entry is not None
        assert len(entry.entry_hash) == 64

    async def test_records_failed_logins_as_security_events(
        self, client: TestClient, db: AsyncSession, registered: dict
    ) -> None:
        client.post("/api/auth/login", json={"email": registered["email"], "password": "Nope12345678"})
        entry = (
            await db.execute(
                select(AuditLog)
                .where(
                    AuditLog.action == AuditAction.LOGIN_FAILED,
                    AuditLog.user_id == registered["id"],
                )
                .order_by(AuditLog.timestamp.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        assert entry is not None
        assert entry.severity == AuditSeverity.SECURITY
        # Metadata explains why without recording what was typed.
        assert "Nope12345678" not in str(entry.audit_metadata)

    async def test_never_stores_a_password_or_token_in_metadata(self, db: AsyncSession) -> None:
        rows = (
            (await db.execute(select(AuditLog).order_by(AuditLog.timestamp.desc()).limit(200)))
            .scalars()
            .all()
        )
        serialized = str([r.audit_metadata for r in rows])
        for forbidden in ("password", "passwordHash", "tokenHash", "refreshToken"):
            assert forbidden not in serialized

    async def test_the_actor_survives_deletion_of_the_user(
        self, client: TestClient, db: AsyncSession
    ) -> None:
        email = unique_email("doomed")
        user = await register_and_verify(client, db, email, name="Deleted Later")
        user_id = user["id"]

        await _delete_user(db, user_id)

        # The trail must outlive its subject: a foreign key that nulled this out
        # would erase who did what, and break the hash chain with it.
        entry = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.user_id == user_id, AuditLog.action == AuditAction.USER_CREATED
                )
            )
        ).scalar_one_or_none()
        assert entry is not None
        assert entry.user_id == user_id

    async def test_verifies_as_an_unbroken_chain(self, db: AsyncSession) -> None:
        result = await verify_audit_chain(db, 500)
        assert result.broken_at_id is None
        assert result.checked > 0
        assert result.valid

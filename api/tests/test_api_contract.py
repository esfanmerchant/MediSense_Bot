from __future__ import annotations

import json
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.security import AccessTokenPayload, sign_access_token
from app.db.models import User
from app.db.session import SessionFactory
from tests.conftest import requires_db


class TestHealth:
    def test_reports_liveness(self, client: TestClient) -> None:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json()["data"]["status"] == "ok"

    def test_never_echoes_secrets_in_the_readiness_payload(self, client: TestClient) -> None:
        body = json.dumps(client.get("/api/health/ready").json())
        assert "SECRET" not in body
        assert "service_role" not in body
        assert "eyJ" not in body  # no JWT-shaped key leaked


class TestErrorEnvelope:
    def test_unknown_route_uses_the_documented_shape(self, client: TestClient) -> None:
        response = client.get("/api/does-not-exist")
        body = response.json()
        assert response.status_code == 404
        assert body["success"] is False
        assert body["error"]["code"] == "NOT_FOUND"
        assert isinstance(body["error"]["message"], str)
        assert body["requestId"]

    def test_never_leaks_a_stack_trace(self, client: TestClient) -> None:
        body = json.dumps(client.get("/api/does-not-exist").json())
        assert "Traceback" not in body
        assert "  File " not in body

    def test_malformed_json_is_rejected_readably(self, client: TestClient) -> None:
        response = client.post(
            "/api/auth/login",
            content='{"email": ',
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code in (400, 422)
        assert response.json()["success"] is False

    def test_every_response_carries_a_correlation_id(self, client: TestClient) -> None:
        assert client.get("/api/health").headers["x-request-id"]

    def test_an_inbound_correlation_id_is_echoed_back(self, client: TestClient) -> None:
        response = client.get("/api/health", headers={"X-Request-Id": "trace-123"})
        assert response.headers["x-request-id"] == "trace-123"


class TestAuthenticationGate:
    def test_rejects_an_unauthenticated_request(self, client: TestClient) -> None:
        response = client.get("/api/auth/me")
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHENTICATED"

    def test_rejects_an_unverifiable_token(self, client: TestClient) -> None:
        response = client.get("/api/auth/me", headers={"Authorization": "Bearer not.a.real.jwt"})
        assert response.status_code == 401

    def test_rejects_a_well_signed_token_whose_session_does_not_exist(self, client: TestClient) -> None:
        # Forging a correctly signed token is not enough: the session row decides.
        forged = sign_access_token(AccessTokenPayload(sub="ghost", sid="no-such-session", role="ADMIN"), 120)
        response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {forged}"})
        assert response.status_code >= 401
        assert response.json()["success"] is False


class TestRequestValidation:
    def test_rejects_a_malformed_email_before_touching_the_database(self, client: TestClient) -> None:
        response = client.post("/api/auth/login", json={"email": "not-an-email", "password": "x"})
        assert response.status_code == 422
        body = response.json()
        assert body["error"]["code"] == "VALIDATION_ERROR"
        assert body["error"]["details"][0]["field"] == "email"

    def test_rejects_registration_with_a_weak_password(self, client: TestClient) -> None:
        response = client.post(
            "/api/auth/register",
            json={"name": "Demo Patient", "email": "demo@example.com", "password": "short"},
        )
        assert response.status_code == 422

    @requires_db
    async def test_a_caller_cannot_choose_a_role_nobody_may_grant_themselves(
        self, client: TestClient
    ) -> None:
        """Registration offers PATIENT and DOCTOR. ADMIN and NURSE it refuses.

        DOCTOR is on the list because asking to be one creates an *application*
        an administrator has to approve, not a credential. ADMIN and NURSE have
        no such gate, so they stay accounts only an administrator creates.

        The address is unique per run, and the point of the assertion below is
        that nothing was created at all — a request refused at validation must
        not leave a half-made account behind.
        """
        email = f"escalate-{uuid.uuid4()}@medisensetests.org"
        response = client.post(
            "/api/auth/register",
            json={
                "name": "Role Escalation",
                "email": email,
                "password": "ValidPass123",
                "role": "ADMIN",
            },
        )
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"

        async with SessionFactory() as session:
            created = (
                await session.execute(select(User.id).where(User.email == email))
            ).scalar_one_or_none()
        assert created is None


class TestSecurityHeaders:
    def test_sets_the_configured_headers(self, client: TestClient) -> None:
        headers = client.get("/api/health").headers
        assert headers["x-content-type-options"] == "nosniff"
        assert headers["referrer-policy"] == "no-referrer"
        assert headers["x-frame-options"] == "DENY"

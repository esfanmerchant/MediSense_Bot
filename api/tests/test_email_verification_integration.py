"""Registration, email verification and the login gate, against the real database.

The property under test is that **an account is worth nothing until its address
is proved**. Registering issues no session and no cookie; the password alone
does not open a door; and the code that does is short-lived, stored only as a
hash, and burned after five wrong guesses.

The code itself is never readable — that is the point of hashing it — so these
tests stamp a known hash onto the row and then drive the real endpoint. That
exercises the verification path exactly as a person would, without giving the
application a dev-only way to echo a live credential back over HTTP.

Every row these tests create is removed afterwards. Nothing here touches a demo
account.
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
from app.db.enums import DoctorApplicationStatus, UserStatus
from app.db.models import Doctor, DoctorApplication, User
from app.modules.auth import twofactor
from tests.conftest import requires_db

pytestmark = requires_db

PASSWORD = "VerifyPass123"
KNOWN_CODE = "424242"


def unique_email(prefix: str = "verify") -> str:
    # Not example.invalid: email-validator rejects reserved domains, so the
    # request would fail validation before reaching the logic under test.
    return f"{prefix}-{uuid.uuid4()}@medisensetests.org"


@pytest.fixture(autouse=True)
def _fresh_rate_limits() -> None:
    """The limiter counts in this process and is shared by the whole suite.

    Without this, a file that deliberately makes several attempts in a row would
    fail on the limit rather than on the behaviour it is checking — and would
    fail differently depending on what ran before it.
    """
    ratelimit.reset()


async def _user_by_email(db: AsyncSession, email: str) -> User:
    user = (await db.execute(select(User).where(User.email == email))).scalar_one()
    await db.refresh(user)
    return user


async def _stamp_code(
    db: AsyncSession, email: str, *, code: str = KNOWN_CODE, ttl_minutes: int = 10
) -> None:
    """Put a code we know the plaintext of onto the row."""
    await db.execute(
        update(User)
        .where(User.email == email)
        .values(
            email_verification_code_hash=twofactor.hash_code(code),
            email_verification_expires_at=utcnow() + timedelta(minutes=ttl_minutes),
            email_verification_attempts=0,
        )
    )
    await db.commit()


async def _remove(db: AsyncSession, email: str) -> None:
    # Patients, applications, sessions, refresh tokens, challenges and
    # notifications all cascade from the user row.
    await db.execute(delete(User).where(User.email == email))
    await db.commit()


@pytest.fixture
async def unverified(client: TestClient, db: AsyncSession) -> AsyncIterator[dict[str, Any]]:
    """A registered patient who has not proved their address yet."""
    email = unique_email()
    response = client.post(
        "/api/auth/register",
        json={"name": "Verification Test Patient", "email": email, "password": PASSWORD},
    )
    assert response.status_code == 201, response.text
    yield {"email": email, "body": response.json()["data"]}
    client.cookies.clear()
    await _remove(db, email)


class TestRegistration:
    def test_issues_no_session_and_asks_for_a_code(self, unverified: dict) -> None:
        assert unverified["body"] == {
            "pendingVerification": True,
            "email": unverified["email"],
            "resendAfterSeconds": 60,
        }

    def test_sets_no_cookies(self, client: TestClient, unverified: dict) -> None:
        # Registering must not sign anybody in: the address is still a claim.
        assert client.cookies.get("ms_at") is None
        assert client.cookies.get("ms_rt") is None

    async def test_the_account_is_pending_and_unverified(
        self, db: AsyncSession, unverified: dict
    ) -> None:
        user = await _user_by_email(db, unverified["email"])
        assert user.status == UserStatus.PENDING_VERIFICATION
        assert user.email_verified_at is None
        assert user.email_verification_code_hash
        assert user.email_verification_sent_at is not None

    async def test_only_the_hash_of_the_code_is_stored(
        self, db: AsyncSession, unverified: dict
    ) -> None:
        user = await _user_by_email(db, unverified["email"])
        assert user.email_verification_code_hash is not None
        assert user.email_verification_code_hash.startswith("scrypt$")

    def test_refuses_a_duplicate_address(self, client: TestClient, unverified: dict) -> None:
        response = client.post(
            "/api/auth/register",
            json={"name": "Someone Else", "email": unverified["email"], "password": PASSWORD},
        )
        assert response.status_code == 409

    @pytest.mark.parametrize("role", ["ADMIN", "NURSE", "SUPERUSER"])
    def test_refuses_a_role_nobody_may_grant_themselves(
        self, client: TestClient, db: AsyncSession, role: str
    ) -> None:
        """Only PATIENT and DOCTOR are on offer, and DOCTOR still needs approval."""
        response = client.post(
            "/api/auth/register",
            json={
                "name": "Would Be Admin",
                "email": unique_email("escalate"),
                "password": PASSWORD,
                "role": role,
            },
        )
        assert response.status_code == 422


class TestLoginBeforeVerification:
    def test_the_password_alone_opens_nothing(
        self, client: TestClient, unverified: dict
    ) -> None:
        response = client.post(
            "/api/auth/login", json={"email": unverified["email"], "password": PASSWORD}
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "EMAIL_NOT_VERIFIED"
        # The message has to say what to do about it.
        assert "inbox" in response.json()["error"]["message"].lower()

    def test_a_wrong_password_is_still_a_wrong_password(
        self, client: TestClient, unverified: dict
    ) -> None:
        """The verification gate must not become a way to test passwords.

        It runs after the password check, so a bad password gets the same 401 it
        always did rather than a 403 that would confirm the address exists.
        """
        response = client.post(
            "/api/auth/login", json={"email": unverified["email"], "password": "WrongPass123"}
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"


class TestVerification:
    async def test_a_wrong_code_is_refused_and_counted(
        self, client: TestClient, db: AsyncSession, unverified: dict
    ) -> None:
        await _stamp_code(db, unverified["email"])
        response = client.post(
            "/api/auth/verify-email", json={"email": unverified["email"], "code": "000000"}
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "INVALID_CODE"

        user = await _user_by_email(db, unverified["email"])
        assert user.email_verification_attempts == 1
        # Still unverified, and still holding the same code.
        assert user.email_verified_at is None

    async def test_five_wrong_codes_burn_the_code(
        self, client: TestClient, db: AsyncSession, unverified: dict
    ) -> None:
        await _stamp_code(db, unverified["email"])
        for _ in range(5):
            client.post(
                "/api/auth/verify-email", json={"email": unverified["email"], "code": "000000"}
            )

        user = await _user_by_email(db, unverified["email"])
        assert user.email_verification_code_hash is None

        # Even the right code is now worthless — a new one has to be requested.
        response = client.post(
            "/api/auth/verify-email", json={"email": unverified["email"], "code": KNOWN_CODE}
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "INVALID_CODE"

    async def test_an_expired_code_says_so(
        self, client: TestClient, db: AsyncSession, unverified: dict
    ) -> None:
        await _stamp_code(db, unverified["email"], ttl_minutes=-1)
        response = client.post(
            "/api/auth/verify-email", json={"email": unverified["email"], "code": KNOWN_CODE}
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "CODE_EXPIRED"

    async def test_an_unknown_address_looks_exactly_like_a_wrong_code(
        self, client: TestClient
    ) -> None:
        response = client.post(
            "/api/auth/verify-email",
            json={"email": unique_email("nobody"), "code": KNOWN_CODE},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "INVALID_CODE"

    async def test_the_right_code_activates_the_account_and_signs_them_in(
        self, client: TestClient, db: AsyncSession, unverified: dict
    ) -> None:
        await _stamp_code(db, unverified["email"])
        response = client.post(
            "/api/auth/verify-email",
            json={"email": unverified["email"], "code": KNOWN_CODE, "deviceClass": "PERSONAL"},
        )
        assert response.status_code == 200, response.text
        data = response.json()["data"]

        assert data["user"]["role"] == "PATIENT"
        assert data["user"]["patientId"]
        assert data["user"]["status"] == "ACTIVE"
        assert data["redirectTo"] == "/patient"
        assert data["session"]["sessionId"]

        # The same cookies a login issues, so the client needs no special case.
        assert client.cookies.get("ms_at")
        assert client.cookies.get("ms_rt")
        assert "HttpOnly" in response.headers.get("set-cookie", "")

        user = await _user_by_email(db, unverified["email"])
        assert user.status == UserStatus.ACTIVE
        assert user.email_verified_at is not None
        # The code is gone: it cannot be replayed.
        assert user.email_verification_code_hash is None

        client.cookies.clear()

    async def test_the_same_code_cannot_be_used_twice(
        self, client: TestClient, db: AsyncSession, unverified: dict
    ) -> None:
        await _stamp_code(db, unverified["email"])
        first = client.post(
            "/api/auth/verify-email", json={"email": unverified["email"], "code": KNOWN_CODE}
        )
        assert first.status_code == 200
        client.cookies.clear()

        second = client.post(
            "/api/auth/verify-email", json={"email": unverified["email"], "code": KNOWN_CODE}
        )
        assert second.status_code == 400

    async def test_login_works_once_the_address_is_proved(
        self, client: TestClient, db: AsyncSession, unverified: dict
    ) -> None:
        await _stamp_code(db, unverified["email"])
        client.post(
            "/api/auth/verify-email", json={"email": unverified["email"], "code": KNOWN_CODE}
        )
        client.cookies.clear()

        response = client.post(
            "/api/auth/login", json={"email": unverified["email"], "password": PASSWORD}
        )
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["requires2FA"] is False
        assert data["user"]["email"] == unverified["email"]
        assert data["redirectTo"] == "/patient"
        client.cookies.clear()


class TestResend:
    async def test_it_issues_a_new_code(
        self, client: TestClient, db: AsyncSession, unverified: dict
    ) -> None:
        before = (await _user_by_email(db, unverified["email"])).email_verification_code_hash
        # Clear the cooldown rather than waiting a minute for it.
        await db.execute(
            update(User)
            .where(User.email == unverified["email"])
            .values(email_verification_sent_at=utcnow() - timedelta(seconds=120))
        )
        await db.commit()

        response = client.post("/api/auth/resend-code", json={"email": unverified["email"]})
        assert response.status_code == 200
        assert response.json()["data"] == {"sent": True, "resendAfterSeconds": 60}

        after = await _user_by_email(db, unverified["email"])
        assert after.email_verification_code_hash != before
        assert after.email_verification_send_count >= 2

    async def test_the_cooldown_is_enforced_against_the_stored_timestamp(
        self, client: TestClient, db: AsyncSession, unverified: dict
    ) -> None:
        """Registering just sent one, so an immediate resend sends nothing."""
        before = await _user_by_email(db, unverified["email"])
        client.post("/api/auth/resend-code", json={"email": unverified["email"]})

        after = await _user_by_email(db, unverified["email"])
        assert after.email_verification_code_hash == before.email_verification_code_hash
        assert after.email_verification_send_count == before.email_verification_send_count

    def test_an_unknown_address_gets_the_same_answer(
        self, client: TestClient, unverified: dict
    ) -> None:
        """Anything else would make this an account-enumeration oracle."""
        known = client.post("/api/auth/resend-code", json={"email": unverified["email"]})
        unknown = client.post("/api/auth/resend-code", json={"email": unique_email("nobody")})
        assert known.status_code == unknown.status_code == 200
        assert known.json()["data"] == unknown.json()["data"]


class TestDoctorRegistration:
    async def test_it_creates_a_draft_application_and_no_doctor_row(
        self, client: TestClient, db: AsyncSession
    ) -> None:
        """Signing up as a doctor is a claim, never a credential."""
        email = unique_email("doctor")
        created = client.post(
            "/api/auth/register",
            json={
                "name": "Applicant Doctor",
                "email": email,
                "password": PASSWORD,
                "role": "DOCTOR",
            },
        )
        assert created.status_code == 201, created.text

        try:
            user = await _user_by_email(db, email)
            assert user.role == "DOCTOR"

            application = (
                await db.execute(
                    select(DoctorApplication).where(DoctorApplication.user_id == user.id)
                )
            ).scalar_one()
            assert application.status == DoctorApplicationStatus.DRAFT
            credential = (
                await db.execute(select(Doctor.id).where(Doctor.user_id == user.id))
            ).scalar_one_or_none()
            assert credential is None

            await _stamp_code(db, email)
            verified = client.post(
                "/api/auth/verify-email", json={"email": email, "code": KNOWN_CODE}
            )
            assert verified.status_code == 200
            # Straight to the form: nothing else is open to them yet.
            assert verified.json()["data"]["redirectTo"] == "/doctor/onboarding"
        finally:
            client.cookies.clear()
            await _remove(db, email)

    async def test_an_unsubmitted_doctor_can_sign_in_again_and_finish(
        self, client: TestClient, db: AsyncSession
    ) -> None:
        """Verification is not the only session an applicant ever gets.

        It expires in minutes; a registration takes longer than that to
        assemble. What an unapproved doctor may *reach* is narrowed per request
        instead — see `test_doctor_application_integration.py`.
        """
        email = unique_email("draft-doctor")
        client.post(
            "/api/auth/register",
            json={"name": "Draft Doctor", "email": email, "password": PASSWORD, "role": "DOCTOR"},
        )
        try:
            await _stamp_code(db, email)
            client.post("/api/auth/verify-email", json={"email": email, "code": KNOWN_CODE})
            client.cookies.clear()

            response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
            assert response.status_code == 200, response.text
            assert response.json()["data"]["redirectTo"] == "/doctor/onboarding"
            assert client.get("/api/doctor/application").status_code == 200
        finally:
            client.cookies.clear()
            await _remove(db, email)

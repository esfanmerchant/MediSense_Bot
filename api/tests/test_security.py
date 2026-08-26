from __future__ import annotations

import time

import pytest

from app.core.security import (
    AccessTokenPayload,
    check_password_policy,
    generate_opaque_token,
    hash_password,
    hash_token,
    needs_rehash,
    sign_access_token,
    verify_access_token,
    verify_password,
)


class TestPasswordHashing:
    def test_never_stores_the_plaintext(self) -> None:
        stored = hash_password("CorrectHorse9")
        assert "CorrectHorse9" not in stored
        assert stored.startswith("scrypt$")

    def test_accepts_the_correct_password(self) -> None:
        assert verify_password("CorrectHorse9", hash_password("CorrectHorse9"))

    @pytest.mark.parametrize("wrong", ["correcthorse9", "CorrectHorse8", "", "CorrectHorse9 "])
    def test_rejects_a_wrong_password(self, wrong: str) -> None:
        assert not verify_password(wrong, hash_password("CorrectHorse9"))

    def test_salts_each_hash(self) -> None:
        a, b = hash_password("SamePass123"), hash_password("SamePass123")
        assert a != b
        assert verify_password("SamePass123", a)
        assert verify_password("SamePass123", b)

    @pytest.mark.parametrize("stored", ["not-a-hash", "bcrypt$1$2$3$4$5", "", "scrypt$a$b$c$d$e"])
    def test_rejects_malformed_stored_hashes_without_raising(self, stored: str) -> None:
        assert not verify_password("anything", stored)

    def test_flags_weak_parameters_for_rehash(self) -> None:
        assert not needs_rehash(hash_password("CorrectHorse9"))
        assert needs_rehash("scrypt$1024$8$1$AAAA$AAAA")
        assert needs_rehash("legacy-md5-hash")


class TestPasswordPolicy:
    def test_accepts_a_password_meeting_every_rule(self) -> None:
        assert check_password_policy("Recovery2024").valid

    @pytest.mark.parametrize("password", ["Short1", "alllowercase1", "ALLUPPERCASE1", "NoDigitsAtAll"])
    def test_rejects_weak_passwords(self, password: str) -> None:
        assert not check_password_policy(password).valid

    def test_rejects_a_password_containing_the_email_local_part(self) -> None:
        result = check_password_policy("Priyasharma12", "priyasharma@example.com")
        assert not result.valid
        assert "email" in " ".join(result.problems)


PAYLOAD = AccessTokenPayload(sub="user_1", sid="session_1", role="PATIENT")


class TestAccessTokens:
    def test_round_trips_a_signed_payload(self) -> None:
        decoded = verify_access_token(sign_access_token(PAYLOAD, 120))
        assert decoded is not None
        assert (decoded.sub, decoded.sid, decoded.role) == ("user_1", "session_1", "PATIENT")

    def test_rejects_a_tampered_token(self) -> None:
        token = sign_access_token(PAYLOAD, 120)
        assert verify_access_token(token[:-3] + "abc") is None

    def test_rejects_a_token_signed_with_another_secret(self) -> None:
        foreign = (
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJzdWIiOiJ1c2VyXzEiLCJzaWQiOiJzXzEiLCJyb2xlIjoiQURNSU4ifQ.ZmFrZS1zaWduYXR1cmU"
        )
        assert verify_access_token(foreign) is None

    def test_rejects_an_expired_token(self) -> None:
        token = sign_access_token(PAYLOAD, 1)
        time.sleep(1.2)
        assert verify_access_token(token) is None

    @pytest.mark.parametrize("garbage", ["", "not.a.jwt", "a.b.c"])
    def test_rejects_garbage(self, garbage: str) -> None:
        assert verify_access_token(garbage) is None

    def test_carries_an_emergency_grant_id(self) -> None:
        token = sign_access_token(AccessTokenPayload(sub="u", sid="s", role="NURSE", eag="grant_9"), 120)
        decoded = verify_access_token(token)
        assert decoded is not None
        assert decoded.eag == "grant_9"


class TestOpaqueTokens:
    def test_produces_unpredictable_values(self) -> None:
        assert len({generate_opaque_token() for _ in range(50)}) == 50

    def test_hashes_deterministically_and_irreversibly(self) -> None:
        token = generate_opaque_token()
        digest = hash_token(token)
        assert hash_token(token) == digest
        assert token not in digest
        assert len(digest) == 64

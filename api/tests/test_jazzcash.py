"""Signing a payment request, and refusing a response that was not signed.

The integrity salt is the entire security model of a redirect gateway: the hash
it produces is what tells JazzCash a request came from this merchant, and what
tells us a "payment succeeded" came from JazzCash rather than from somebody who
found the callback URL. So the cases that matter here are the adversarial ones.

Nothing reaches the network. `build_request` and `verify` are pure functions
over a dict, which is exactly why they were written that way.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import pytest

from app.core.config import settings
from app.services import jazzcash

SALT = "TestIntegritySalt123"


@pytest.fixture(autouse=True)
def merchant(monkeypatch: pytest.MonkeyPatch) -> None:
    """Credentials that are obviously not real, in a value that is not committed."""
    monkeypatch.setattr(settings, "JAZZCASH_MERCHANT_ID", "MC00000", raising=False)
    monkeypatch.setattr(settings, "JAZZCASH_PASSWORD", "test_password", raising=False)
    monkeypatch.setattr(settings, "JAZZCASH_INTEGRITY_SALT", SALT, raising=False)
    monkeypatch.setattr(
        settings, "JAZZCASH_RETURN_URL", "https://example.test/api/payments/jazzcash/callback",
        raising=False,
    )


def a_request() -> dict[str, str]:
    return jazzcash.build_request(
        reference="MS250830120000ABC123",
        amount=Decimal("2750.00"),
        description="Invoice INV-1",
        bill_reference="INV-1",
        now=datetime(2026, 8, 30, 12, 0, 0),
    )


class TestAmounts:
    def test_rupees_become_whole_paisa(self) -> None:
        # JazzCash takes no decimal point. Sending rupees where paisa are
        # expected undercharges by a factor of a hundred.
        assert jazzcash.to_paisa(Decimal("2750.00")) == "275000"
        assert jazzcash.to_paisa(Decimal("0.01")) == "1"

    def test_a_half_paisa_rounds_up_not_away(self) -> None:
        # Truncating would drop a fraction in the payer's favour on every single
        # transaction — an error that only ever costs the hospital.
        assert jazzcash.to_paisa(Decimal("10.005")) == "1001"

    def test_the_amount_reaches_the_form_in_paisa(self) -> None:
        assert a_request()["pp_Amount"] == "275000"


class TestSigning:
    def test_a_request_carries_a_hash(self) -> None:
        fields = a_request()
        assert len(fields["pp_SecureHash"]) == 64
        assert fields["pp_SecureHash"].isupper()

    def test_the_salt_is_never_one_of_the_posted_fields(self) -> None:
        # The form is posted from the payer's browser. The salt appearing in it
        # would hand every visitor the ability to forge a paid callback.
        assert SALT not in a_request().values()

    def test_the_same_request_signs_the_same_way_twice(self) -> None:
        assert a_request()["pp_SecureHash"] == a_request()["pp_SecureHash"]

    def test_changing_the_amount_changes_the_hash(self) -> None:
        other = jazzcash.build_request(
            reference="MS250830120000ABC123",
            amount=Decimal("1.00"),
            description="Invoice INV-1",
            bill_reference="INV-1",
            now=datetime(2026, 8, 30, 12, 0, 0),
        )
        assert other["pp_SecureHash"] != a_request()["pp_SecureHash"]

    def test_the_request_expires(self) -> None:
        fields = a_request()
        assert fields["pp_TxnDateTime"] == "20260830120000"
        assert fields["pp_TxnExpiryDateTime"] > fields["pp_TxnDateTime"]


class TestVerifying:
    def signed_response(self, **overrides: str) -> dict[str, str]:
        """A response hashed the way JazzCash hashes one."""
        body = {
            "pp_TxnRefNo": "MS250830120000ABC123",
            "pp_Amount": "275000",
            "pp_ResponseCode": "000",
            "pp_ResponseMessage": "Success",
            **overrides,
        }
        body["pp_SecureHash"] = jazzcash._signature(body)
        return body

    def test_a_genuine_response_verifies(self) -> None:
        assert jazzcash.verify(self.signed_response())
        assert jazzcash.succeeded(self.signed_response())

    def test_a_response_with_no_hash_at_all_is_refused(self) -> None:
        # Precisely what somebody posting straight at the callback would send.
        body = self.signed_response()
        del body["pp_SecureHash"]
        assert not jazzcash.verify(body)

    def test_a_tampered_amount_is_refused(self) -> None:
        body = self.signed_response()
        body["pp_Amount"] = "1"
        assert not jazzcash.verify(body)

    def test_a_forged_success_is_refused(self) -> None:
        # The whole attack: take a real failed callback and change the verdict.
        body = self.signed_response(pp_ResponseCode="124", pp_ResponseMessage="Declined")
        body["pp_ResponseCode"] = "000"
        assert not jazzcash.verify(body)

    def test_a_response_signed_with_the_wrong_salt_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        body = self.signed_response()
        monkeypatch.setattr(settings, "JAZZCASH_INTEGRITY_SALT", "a-different-salt")
        assert not jazzcash.verify(body)

    def test_a_declined_payment_verifies_but_did_not_succeed(self) -> None:
        # Both facts matter: the message is genuine, and the money did not move.
        body = self.signed_response(pp_ResponseCode="124", pp_ResponseMessage="Declined")
        assert jazzcash.verify(body)
        assert not jazzcash.succeeded(body)


class TestConfiguration:
    def test_missing_credentials_mean_not_configured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "JAZZCASH_INTEGRITY_SALT", "")
        assert not settings.jazzcash_configured

    def test_anything_other_than_live_uses_the_sandbox(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A typo in this value must not bill somebody real, so the check is for
        # the one word that means live rather than against a list of words that
        # do not.
        for value in ("sandbox", "", "production", "LIVEE", "l1ve"):
            monkeypatch.setattr(settings, "JAZZCASH_ENVIRONMENT", value)
            assert "sandbox.jazzcash.com.pk" in settings.jazzcash_endpoint

    @pytest.mark.parametrize("value", ["live", "LIVE", " Live "])
    def test_live_is_live_however_it_was_typed(
        self, value: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Case and stray whitespace are env-file noise, not intent: somebody who
        # wrote "Live " meant live, and refusing them would be its own surprise.
        monkeypatch.setattr(settings, "JAZZCASH_ENVIRONMENT", value)
        assert "payments.jazzcash.com.pk" in settings.jazzcash_endpoint

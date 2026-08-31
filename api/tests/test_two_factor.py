"""Codes, TOTP, backup codes, sealing and masking — no database, no network.

These are the rules a second factor rests on, so they are checked exhaustively
and in milliseconds rather than once inside an integration test that also needs
Postgres, a mail server and a browser session. If one of these is wrong, every
flow built on it is wrong in a way no endpoint test would attribute correctly.
"""

from __future__ import annotations

import time

import pyotp
import pytest

from app.core.security import SealError, seal_secret, unseal_secret
from app.modules.auth import twofactor

#: Backup codes are scrypt-hashed and every one in the list is checked on every
#: attempt, so a test that used the real eight would spend most of its time
#: proving the same property three more times. Three is enough to show that the
#: right one is consumed and the others are not.
_FEW = 3


class TestOneTimeCodes:
    def test_a_code_is_six_digits(self) -> None:
        for _ in range(50):
            code = twofactor.generate_code()
            assert len(code) == twofactor.CODE_LENGTH
            assert code.isdigit()

    def test_leading_zeros_survive_the_round_trip(self) -> None:
        """``000123`` is a valid code and must not become ``123`` anywhere.

        Every sixth code or so starts with a zero, so a normalisation step that
        dropped one would fail for a sixth of users and look like bad luck.
        """
        assert twofactor.normalize_code(" 000123 ") == "000123"
        assert twofactor.verify_code("000123", twofactor.hash_code("000123"))
        assert not twofactor.verify_code("123", twofactor.hash_code("000123"))

    def test_codes_differ(self) -> None:
        # A million values; fifty draws colliding would mean the generator is
        # not random rather than that we were unlucky.
        assert len({twofactor.generate_code() for _ in range(50)}) > 40

    def test_the_hash_never_contains_the_code(self) -> None:
        stored = twofactor.hash_code("123456")
        assert "123456" not in stored
        assert stored.startswith("scrypt$")

    def test_verifies_the_right_code(self) -> None:
        assert twofactor.verify_code("123456", twofactor.hash_code("123456"))

    @pytest.mark.parametrize("wrong", ["123457", "12345", "1234567", "", "abcdef"])
    def test_rejects_a_wrong_code(self, wrong: str) -> None:
        assert not twofactor.verify_code(wrong, twofactor.hash_code("123456"))

    def test_an_absent_hash_never_verifies(self) -> None:
        """"No code issued" must not be a code that anything matches."""
        assert not twofactor.verify_code("123456", None)
        assert not twofactor.verify_code("123456", "")

    @pytest.mark.parametrize("typed", ["123 456", " 123456 ", "123-456", "12 34 56"])
    def test_accepts_a_code_the_way_people_paste_it(self, typed: str) -> None:
        assert twofactor.verify_code(typed, twofactor.hash_code("123456"))

    def test_normalisation_upper_cases_backup_codes(self) -> None:
        assert twofactor.normalize_code("ab12cd34ef") == "AB12CD34EF"


class TestBackupCodes:
    def test_issues_eight_distinct_codes(self) -> None:
        codes = twofactor.generate_backup_codes()
        assert len(codes) == twofactor.BACKUP_CODE_COUNT == 8
        assert len(set(codes)) == 8

    def test_a_code_matches_its_own_hash(self) -> None:
        codes = twofactor.generate_backup_codes(_FEW)
        hashes = twofactor.hash_backup_codes(codes)
        for code in codes:
            assert twofactor.consume_backup_code(code, hashes) is not None

    def test_using_a_code_removes_exactly_that_one(self) -> None:
        codes = twofactor.generate_backup_codes(_FEW)
        hashes = twofactor.hash_backup_codes(codes)

        remaining = twofactor.consume_backup_code(codes[1], hashes)
        assert remaining is not None
        assert len(remaining) == _FEW - 1
        # Every other code still works; only the one used is gone.
        assert twofactor.consume_backup_code(codes[1], remaining) is None
        assert twofactor.consume_backup_code(codes[0], remaining) is not None

    def test_a_code_is_single_use(self) -> None:
        codes = twofactor.generate_backup_codes(_FEW)
        hashes = twofactor.hash_backup_codes(codes)
        first = twofactor.consume_backup_code(codes[0], hashes)
        assert first is not None
        assert twofactor.consume_backup_code(codes[0], first) is None

    def test_an_unknown_code_consumes_nothing(self) -> None:
        hashes = twofactor.hash_backup_codes(twofactor.generate_backup_codes(_FEW))
        assert twofactor.consume_backup_code("DEADBEEF01", hashes) is None

    def test_an_empty_list_never_matches(self) -> None:
        assert twofactor.consume_backup_code("DEADBEEF01", []) is None

    def test_a_hash_does_not_contain_its_code(self) -> None:
        code = twofactor.generate_backup_codes(1)[0]
        assert code not in twofactor.hash_backup_codes([code])[0]


class TestTotp:
    def test_accepts_the_current_code(self) -> None:
        secret = twofactor.generate_totp_secret()
        assert twofactor.verify_totp(secret, pyotp.TOTP(secret).now())

    def test_accepts_one_step_either_side(self) -> None:
        """Phone clocks drift, and people start typing on the last second.

        Refusing those is a support ticket, not security — the window is one
        step, which is 30 seconds each way.
        """
        secret = twofactor.generate_totp_secret()
        totp = pyotp.TOTP(secret)
        now = time.time()
        assert twofactor.verify_totp(secret, totp.at(int(now) - 30))
        assert twofactor.verify_totp(secret, totp.at(int(now) + 30))

    def test_refuses_two_steps_away(self) -> None:
        secret = twofactor.generate_totp_secret()
        totp = pyotp.TOTP(secret)
        assert not twofactor.verify_totp(secret, totp.at(int(time.time()) - 120))

    def test_refuses_another_authenticators_code(self) -> None:
        mine = twofactor.generate_totp_secret()
        theirs = twofactor.generate_totp_secret()
        assert not twofactor.verify_totp(mine, pyotp.TOTP(theirs).now())

    @pytest.mark.parametrize("code", ["", "abcdef", "12345", "000000"])
    def test_rubbish_does_not_raise(self, code: str) -> None:
        # A malformed code is a sign-in attempt, not a 500.
        assert twofactor.verify_totp(twofactor.generate_totp_secret(), code) in (True, False)

    def test_a_malformed_secret_is_refused_rather_than_raised(self) -> None:
        assert not twofactor.verify_totp("not-base-32!", "123456")

    def test_secrets_differ(self) -> None:
        assert len({twofactor.generate_totp_secret() for _ in range(20)}) == 20


class TestEnrolment:
    def test_the_uri_names_the_issuer_and_the_account(self) -> None:
        secret = twofactor.generate_totp_secret()
        uri = twofactor.provisioning_uri(secret, "priya@example.com")
        assert uri.startswith("otpauth://totp/")
        assert "MediSense" in uri
        assert "priya%40example.com" in uri
        assert secret in uri

    def test_the_qr_is_inline_svg_and_carries_no_external_reference(self) -> None:
        """The secret is inside that QR.

        An image fetched from anywhere — a CDN, an endpoint, a cache — would be a
        copy of a credential sitting somewhere nobody is watching.
        """
        svg = twofactor.qr_svg(twofactor.provisioning_uri(twofactor.generate_totp_secret(), "a@b.co"))
        assert svg.startswith("<svg")
        assert "</svg>" in svg
        assert "http://" not in svg and "https://" not in svg
        assert "<script" not in svg


class TestSealedSecrets:
    def test_round_trips(self) -> None:
        secret = twofactor.generate_totp_secret()
        assert unseal_secret(seal_secret(secret)) == secret

    def test_the_sealed_form_does_not_contain_the_secret(self) -> None:
        secret = twofactor.generate_totp_secret()
        assert secret not in seal_secret(secret)

    def test_sealing_twice_gives_different_ciphertext(self) -> None:
        """A fresh nonce each time, so equal secrets are not visibly equal."""
        secret = twofactor.generate_totp_secret()
        assert seal_secret(secret) != seal_secret(secret)

    def test_a_tampered_ciphertext_is_refused(self) -> None:
        sealed = seal_secret("JBSWY3DPEHPK3PXP")
        version, nonce, ciphertext, tag = sealed.split("$")
        flipped = ("A" if ciphertext[0] != "A" else "B") + ciphertext[1:]
        with pytest.raises(SealError):
            unseal_secret("$".join((version, nonce, flipped, tag)))

    def test_a_tampered_tag_is_refused(self) -> None:
        # The guard matters, and its absence is why this test used to fail
        # roughly once in sixty-four runs: substituting a fixed "A" for the
        # first character changes nothing when the character is already an "A",
        # so the tag was passed back untouched and the seal opened correctly.
        # A flaky security test is worse than none — it teaches people to re-run
        # until it passes.
        sealed = seal_secret("JBSWY3DPEHPK3PXP")
        version, nonce, ciphertext, tag = sealed.split("$")
        flipped = ("A" if tag[0] != "A" else "B") + tag[1:]
        assert flipped != tag
        with pytest.raises(SealError):
            unseal_secret("$".join((version, nonce, ciphertext, flipped)))

    @pytest.mark.parametrize("value", ["", "plaintext", "v1$only$three", "v2$a$b$c"])
    def test_a_value_that_is_not_sealed_is_refused(self, value: str) -> None:
        with pytest.raises(SealError):
            unseal_secret(value)

    def test_a_secret_sealed_for_another_purpose_does_not_open(self) -> None:
        """The purpose is bound into the key, so a sealed value cannot be moved
        from the column it was written for into one that means something else."""
        sealed = seal_secret("JBSWY3DPEHPK3PXP", purpose="totp")
        with pytest.raises(SealError):
            unseal_secret(sealed, purpose="something-else")


class TestMasking:
    @pytest.mark.parametrize(
        ("address", "expected"),
        [
            ("priya.sharma@example.com", "p•••a@example.com"),
            ("ab@example.com", "a•••@example.com"),
            ("a@example.com", "a•••@example.com"),
            ("abc@example.com", "a•••c@example.com"),
        ],
    )
    def test_shows_enough_to_recognise_and_no_more(self, address: str, expected: str) -> None:
        assert twofactor.mask_email(address) == expected

    def test_the_local_part_is_never_readable(self) -> None:
        masked = twofactor.mask_email("priya.sharma@example.com")
        assert "priya" not in masked
        assert "sharma" not in masked
        # The domain stays, so somebody with two addresses can tell them apart.
        assert masked.endswith("@example.com")

    def test_something_that_is_not_an_address_leaks_nothing(self) -> None:
        assert twofactor.mask_email("not-an-address") == "•••"


class TestPolicyConstants:
    """The numbers the flows and the UI both depend on."""

    def test_an_emailed_code_lasts_ten_minutes(self) -> None:
        assert twofactor.EMAIL_CODE_TTL_MINUTES == 10

    def test_a_login_challenge_is_shorter(self) -> None:
        # The person is sitting at the form; five minutes is generous.
        assert twofactor.CHALLENGE_TTL_MINUTES <= 5

    def test_five_guesses(self) -> None:
        assert twofactor.MAX_VERIFICATION_ATTEMPTS == 5

    def test_a_remembered_device_lasts_thirty_days(self) -> None:
        assert twofactor.TRUSTED_DEVICE_DAYS == 30

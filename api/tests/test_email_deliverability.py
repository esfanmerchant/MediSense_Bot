"""The parts of an email a filter reads before anybody reads the words.

Most of what decides whether a message reaches an inbox is not the writing. It
is whether the sending server is authorised for the address in `From`, whether
the message identifies itself, and whether there is a way to stop receiving it
that actually works. Two of those three are settable from here, and this pins
them so a later change cannot quietly undo one.

The header everything else hangs off is `List-Unsubscribe`. Gmail and Yahoo
have required one-click unsubscribe of bulk senders since 2024 and read its
absence as a signal either way — but only when it is honest: a header offering
one-click that then asks for a password is worse than no header at all, which
is why the token here needs no session and the endpoint takes it without one.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from app.core.config import settings
from app.core.security import seal_secret
from app.services import email_links
from app.services import email_templates as templates
from app.services.email import _build

UNSUB = "https://medisense.example/unsubscribe?token=abc"


class TestTheHeadersAMessageCarries:
    @staticmethod
    def build(unsubscribe: str | None = UNSUB):
        return _build("someone@example.org", "Subject", "plain text", "<p>html</p>", unsubscribe=unsubscribe)

    def test_it_identifies_itself(self) -> None:
        message = self.build()
        # A message with no Message-ID and no Date looks assembled by a script,
        # because usually it is.
        assert message["Message-ID"]
        assert message["Message-ID"].startswith("<")
        assert message["Date"]

    def test_it_offers_one_click_unsubscribe(self) -> None:
        message = self.build()
        assert message["List-Unsubscribe"] == f"<{UNSUB}>"
        assert message["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"

    def test_a_message_that_cannot_be_stopped_offers_nothing(self) -> None:
        # A code is the only way into an account and a break-glass notice is
        # not switchable. Offering to stop either would be an offer this system
        # will not honour, and an unhonoured offer is the thing being guarded
        # against in the first place.
        message = self.build(unsubscribe=None)
        assert "List-Unsubscribe" not in message
        assert "List-Unsubscribe-Post" not in message

    def test_there_is_somewhere_for_a_reply_to_go(self) -> None:
        assert self.build()["Reply-To"]

    def test_it_is_marked_as_not_a_reply(self) -> None:
        # Stops a vacation responder looping against the mailbox.
        assert self.build()["Auto-Submitted"] == "auto-generated"

    def test_it_does_not_claim_urgency(self) -> None:
        # `X-Priority` and `Importance: high` on routine mail are read as a
        # sender trying to jump a queue, which is a spam signal rather than a
        # delivery advantage.
        message = self.build()
        assert "X-Priority" not in message
        assert "Importance" not in message

    def test_it_is_not_labelled_bulk(self) -> None:
        # This is transactional mail about somebody's own care. `Precedence:
        # bulk` would tell a filter otherwise.
        assert "Precedence" not in self.build()


class TestTheFromAddressIsOneTheServerMaySend:
    """Alignment is the single fastest way into or out of a spam folder."""

    def test_it_uses_the_authenticated_account(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "SMTP_USER", "bot@sender.example", raising=False)
        monkeypatch.setattr(settings, "SMTP_FROM", "MediSense <noreply@other.example>", raising=False)
        message = _build("a@b.example", "s", "t", None)
        # A From the sending server is not authorised for fails SPF and DKIM,
        # so the configured-but-unaligned address is overridden rather than
        # honoured — and the mismatch is logged rather than hidden.
        assert "bot@sender.example" in message["From"]
        assert "other.example" not in message["From"]

    def test_the_display_name_survives(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "SMTP_USER", "bot@sender.example", raising=False)
        monkeypatch.setattr(settings, "SMTP_FROM", "Karachi Clinic <bot@sender.example>", raising=False)
        assert _build("a@b.example", "s", "t", None)["From"].startswith("Karachi Clinic")


class TestBothPartsAreSent:
    def test_html_mail_still_carries_plain_text(self) -> None:
        message = _build("a@b.example", "s", "the plain version", "<p>the html one</p>")
        assert message.is_multipart()
        parts = {p.get_content_type() for p in message.walk() if not p.is_multipart()}
        # An HTML-only message is less accessible and more likely to be junked;
        # the text part is what a screen reader and a filter both read.
        assert "text/plain" in parts
        assert "text/html" in parts


class TestTheUnsubscribeLinkSurvivesBeingAUrl:
    def test_a_sealed_token_round_trips_through_a_query_string(self) -> None:
        # The seal contains `+`, `/` and `$`. A `+` in a query string is a
        # space by the time it is read, so an unencoded token arrives
        # corrupted: the link looks right, does nothing, and sends somebody to
        # the spam button instead.
        url = email_links.unsubscribe_url("Priya@Example.com")
        token = parse_qs(urlparse(url).query)["token"][0]
        assert email_links.read_unsubscribe_token(token) == "priya@example.com"

    def test_the_address_is_normalised(self) -> None:
        upper = email_links.unsubscribe_token("PRIYA@EXAMPLE.COM")
        lower = email_links.unsubscribe_token("priya@example.com")
        assert email_links.read_unsubscribe_token(upper) == email_links.read_unsubscribe_token(lower)

    @pytest.mark.parametrize("bad", ["", "not-a-token", "v1$nonsense$nonsense$nonsense", "x" * 400])
    def test_anything_else_reads_as_nothing(self, bad: str) -> None:
        # These arrive from the open internet — a truncated link, a mail client
        # that rewrote a URL, somebody guessing. None of them may raise.
        assert email_links.read_unsubscribe_token(bad) is None

    def test_a_token_minted_for_something_else_does_not_work_here(self) -> None:
        # The purpose is part of the key, so a seal from another feature cannot
        # be presented as an unsubscribe.
        assert email_links.read_unsubscribe_token(seal_secret("priya@example.com", purpose="totp")) is None


class TestTheFooterSaysTheThreeThings:
    def test_it_names_the_sender(self) -> None:
        html = templates.account_registered(name="Priya", role="PATIENT").html
        assert templates.SENDER_IDENTITY in html

    def test_it_says_why_this_arrived(self) -> None:
        # Deliverability guidance asks for this in as many words, and a reader
        # who cannot tell why they received something reports it.
        html = templates.account_registered(name="Priya", role="PATIENT").html
        assert "You are receiving this because" in html

    def test_it_no_longer_claims_the_mailbox_is_unread(self) -> None:
        # There is a Reply-To now. Advertising a reply path and telling
        # somebody their reply goes nowhere is a contradiction a filter can see
        # and a person will resent.
        html = templates.account_registered(name="Priya", role="PATIENT").html
        assert "not monitored" not in html

    def test_the_link_is_filled_in_when_there_is_one(self) -> None:
        html = templates.fill_unsubscribe(
            templates.account_registered(name="Priya", role="PATIENT").html, UNSUB
        )
        assert UNSUB in html
        assert templates.UNSUBSCRIBE_MARKER not in html

    def test_and_removed_when_there_is_not(self) -> None:
        # A dead "unsubscribe" is worse than none: it is an offer that fails.
        html = templates.fill_unsubscribe(
            templates.account_registered(name="Priya", role="PATIENT").html, None
        )
        assert "Stop these emails" not in html
        assert templates.UNSUBSCRIBE_MARKER not in html

    def test_no_message_ever_ships_the_marker(self) -> None:
        # It is an HTML comment, so it would not be visible — it would just
        # mean the link never arrived.
        for message in (
            templates.verify_email(name="Priya", code="123456"),
            templates.two_factor_code(name="Priya", code="123456"),
            templates.account_registered(name="Priya", role="PATIENT"),
            templates.doctor_approved(name="Ayesha Iqbal"),
        ):
            assert templates.fill_unsubscribe(message.html, None).count(templates.UNSUBSCRIBE_MARKER) == 0
            assert templates.fill_unsubscribe(message.html, UNSUB).count(templates.UNSUBSCRIBE_MARKER) == 0


class TestNoTrackingAndNoImages:
    def test_there_is_no_remote_image(self) -> None:
        # A one-pixel image is how open-tracking works and how filters
        # recognise bulk mail. This sends none at all — the header is type, not
        # a picture — so there is nothing to load and nothing to block.
        html = templates.account_registered(name="Priya", role="PATIENT").html
        assert "<img" not in html.lower()

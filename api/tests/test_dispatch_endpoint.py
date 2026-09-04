"""The dispatcher pass, driven from outside.

This endpoint exists so a platform that cannot hold a background loop — a
serverless one, chiefly — can still deliver queued email and fire medication
reminders. That makes it the one place in the application where something with
no session does real work, so what it refuses matters as much as what it does.

Three things are pinned here, and each of them is a hole if it goes wrong
quietly:

* an unset secret **refuses**, rather than accepting an empty header;
* a wrong secret is rejected in **constant time**, so the comparison cannot be
  used to learn the secret a character at a time;
* the endpoint does nothing at all until the credential has been checked.
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.modules.notifications import dispatch_router

SECRET = "a-dispatch-secret-only-the-scheduler-holds"
PATH = "/api/internal/dispatch"


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "DISPATCH_SECRET", SECRET)


@pytest.fixture
def unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "DISPATCH_SECRET", "")


@pytest.fixture
def ran(monkeypatch: pytest.MonkeyPatch) -> list[bool]:
    """Records whether a pass actually happened, without doing one."""
    calls: list[bool] = []

    async def fake_run_once() -> dict[str, int]:
        calls.append(True)
        return {"reminders": 1, "medication": 2, "invoices": 0, "sent": 3, "pushed": 4}

    monkeypatch.setattr(dispatch_router.dispatcher, "run_once", fake_run_once)
    monkeypatch.setattr(dispatch_router.dispatcher, "should_run", lambda: True)
    return calls


class TestWhatItRefuses:
    def test_an_unset_secret_refuses_every_call(
        self, client: TestClient, unconfigured: None, ran: list[bool]
    ) -> None:
        """The default, and the important one.

        Any deployment that runs the loop has no reason to set a secret — so the
        empty value must not become a usable credential. `compare_digest("", "")`
        is true, which is exactly the mistake this test exists to prevent.
        """
        response = client.post(PATH, headers={"X-Dispatch-Secret": ""})
        assert response.status_code == 503, response.text
        assert ran == [], "a pass ran on an unconfigured deployment"

    def test_no_header_at_all_is_refused(
        self, client: TestClient, configured: None, ran: list[bool]
    ) -> None:
        assert client.post(PATH).status_code == 401
        assert ran == []

    def test_a_wrong_secret_is_refused(
        self, client: TestClient, configured: None, ran: list[bool]
    ) -> None:
        response = client.post(PATH, headers={"X-Dispatch-Secret": "not-it"})
        assert response.status_code == 401
        assert ran == []

    def test_a_prefix_of_the_secret_is_refused(
        self, client: TestClient, configured: None, ran: list[bool]
    ) -> None:
        """The shape an attack takes when a comparison short-circuits."""
        response = client.post(PATH, headers={"X-Dispatch-Secret": SECRET[:-1]})
        assert response.status_code == 401
        assert ran == []

    def test_the_secret_is_never_echoed(
        self, client: TestClient, configured: None, ran: list[bool]
    ) -> None:
        response = client.post(PATH, headers={"X-Dispatch-Secret": "guess"})
        assert SECRET not in response.text
        assert "guess" not in response.text


class TestWhatItDoes:
    def test_the_right_secret_runs_one_pass(
        self, client: TestClient, configured: None, ran: list[bool]
    ) -> None:
        response = client.post(PATH, headers={"X-Dispatch-Secret": SECRET})
        assert response.status_code == 200, response.text
        assert ran == [True], "the pass did not run exactly once"

    def test_it_reports_what_it_delivered(
        self, client: TestClient, configured: None, ran: list[bool]
    ) -> None:
        """The counts are the point.

        A scheduler's history showing `200 OK` proves the endpoint answered. It
        does not prove anything was sent — and "the cron is green but nobody is
        getting reminders" is the failure this endpoint exists to prevent, not
        to reproduce.
        """
        body = client.post(PATH, headers={"X-Dispatch-Secret": SECRET}).json()["data"]
        assert body["ran"] is True
        assert body["medication"] == 2
        assert body["sent"] == 3
        assert body["pushed"] == 4

    def test_it_says_so_when_there_is_no_transport(
        self, client: TestClient, configured: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A deployment with neither email nor push configured.

        Reporting a successful pass of zero would read exactly like a working
        deployment with an empty queue, which is the wrong thing to tell somebody
        wondering why nothing arrives.
        """
        monkeypatch.setattr(dispatch_router.dispatcher, "should_run", lambda: False)
        body = client.post(PATH, headers={"X-Dispatch-Secret": SECRET}).json()["data"]
        assert body["ran"] is False
        assert "transport" in body["reason"]


class TestTheCredentialCheckIsSound:
    def test_it_compares_in_constant_time(self) -> None:
        """`==` on a secret leaks its length and its prefix through timing.

        Asserted against the source because the property is invisible in
        behaviour: both comparisons return False, and only one of them takes a
        different amount of time doing it.
        """
        source = inspect.getsource(dispatch_router)
        assert "compare_digest" in source
        assert "== settings.DISPATCH_SECRET" not in source

    def test_the_endpoint_is_rate_limited(self) -> None:
        assert "RateLimit" in inspect.getsource(dispatch_router.dispatch)

    def test_overlapping_passes_cannot_double_send(self) -> None:
        """Two schedulers, or one that fires before the last finished.

        Safe because the queue is claimed with `FOR UPDATE SKIP LOCKED`, so
        concurrent passes take disjoint batches. That was built for multiple
        workers; this endpoint depends on it too, so it is asserted here as
        well — the guarantee now has a second caller relying on it.
        """
        from app.modules.notifications import dispatcher

        for claim in (dispatcher.claim_pending, dispatcher.claim_pending_push):
            source = inspect.getsource(claim)
            assert "with_for_update" in source and "skip_locked=True" in source, claim.__name__


class TestItIsReachable:
    def test_the_route_is_registered(self) -> None:
        import sys

        sys.path.insert(0, "tests")
        from test_access_control_review import api_routes

        assert any(p == PATH and "POST" in m for m, p, _ in api_routes())

    def test_it_is_a_declared_public_path(self) -> None:
        """It has no session, so the review file must say why in writing."""
        import sys

        sys.path.insert(0, "tests")
        from test_access_control_review import PUBLIC_PATHS

        assert PATH in PUBLIC_PATHS


def test_the_setting_defaults_to_closed() -> None:
    """A deployment that never heard of this endpoint has not opened it."""
    from app.core.config import Settings

    assert Settings.model_fields["DISPATCH_SECRET"].default == ""

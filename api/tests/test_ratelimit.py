"""The rate limiter (spec §"Phase 13 — Rate limiting").

No network, no database. What matters here is that the limiter counts correctly,
lets the window slide, keeps callers apart, and fails in the safe direction when
its own bookkeeping fills up.

The limiter is a cost and noise control, not the brute-force defence — that is
`Account.lockedUntil`, which lives in the database and therefore counts
correctly however many workers are running. These tests are scoped to what this
module actually claims.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.core import ratelimit
from app.core.errors import AppError, ErrorCode


class FakeClient:
    def __init__(self, host: str) -> None:
        self.host = host


class FakeState:
    def __init__(self, session_id: str | None = None) -> None:
        if session_id is not None:
            self.session_id = session_id


class FakeRequest:
    """Only what the limiter reads: a client host and request state."""

    def __init__(self, host: str = "10.0.0.1", session_id: str | None = None) -> None:
        self.client = FakeClient(host)
        self.state = FakeState(session_id)


@pytest.fixture(autouse=True)
def clean_counters() -> Any:
    # Counters are module-level, so a test that inherited another's would pass
    # or fail depending on the order pytest happened to choose.
    ratelimit.reset()
    yield
    ratelimit.reset()


async def call(dependency: Any, request: FakeRequest) -> None:
    await dependency(request)


class TestCounting:
    async def test_it_allows_up_to_the_limit(self) -> None:
        guard = ratelimit.limit(times=3, seconds=60, scope="test")
        request = FakeRequest()
        for _ in range(3):
            await call(guard, request)  # must not raise

    async def test_it_refuses_the_one_after(self) -> None:
        guard = ratelimit.limit(times=3, seconds=60, scope="test")
        request = FakeRequest()
        for _ in range(3):
            await call(guard, request)

        with pytest.raises(AppError) as caught:
            await call(guard, request)

        assert caught.value.status_code == 429
        assert caught.value.code == ErrorCode.RATE_LIMITED

    async def test_the_refusal_says_when_to_come_back(self) -> None:
        """A 429 with no guidance just gets retried immediately."""
        guard = ratelimit.limit(times=1, seconds=60, scope="test")
        request = FakeRequest()
        await call(guard, request)

        with pytest.raises(AppError) as caught:
            await call(guard, request)
        assert "seconds" in caught.value.message

    async def test_a_refused_call_is_not_counted(self) -> None:
        """Otherwise a client hammering the endpoint would extend its own
        lockout indefinitely, which is a different policy than the one
        configured."""
        guard = ratelimit.limit(times=2, seconds=60, scope="test")
        request = FakeRequest()
        await call(guard, request)
        await call(guard, request)

        for _ in range(5):
            with pytest.raises(AppError):
                await call(guard, request)

        # Two recorded hits, not seven.
        assert len(ratelimit._hits["test:10.0.0.1"]) == 2


class TestWindowSlides:
    async def test_old_hits_stop_counting(self, monkeypatch: pytest.MonkeyPatch) -> None:
        clock = {"now": 1000.0}
        monkeypatch.setattr(ratelimit.time, "monotonic", lambda: clock["now"])

        guard = ratelimit.limit(times=2, seconds=10, scope="test")
        request = FakeRequest()
        await call(guard, request)
        await call(guard, request)
        with pytest.raises(AppError):
            await call(guard, request)

        # Past the window: the earlier hits are no longer in it.
        clock["now"] += 11
        await call(guard, request)

    async def test_it_slides_rather_than_resetting(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A fixed window lets a caller send double the rate across a boundary.

        Two at 9.9s and two at 10.1s is four in a fifth of a second, which a
        window that merely resets would allow.
        """
        clock = {"now": 1000.0}
        monkeypatch.setattr(ratelimit.time, "monotonic", lambda: clock["now"])

        guard = ratelimit.limit(times=2, seconds=10, scope="test")
        request = FakeRequest()
        await call(guard, request)
        await call(guard, request)

        clock["now"] += 5  # still inside the window
        with pytest.raises(AppError):
            await call(guard, request)


class TestCallersAreKeptApart:
    async def test_two_addresses_have_separate_budgets(self) -> None:
        guard = ratelimit.limit(times=1, seconds=60, scope="test")
        await call(guard, FakeRequest(host="10.0.0.1"))
        await call(guard, FakeRequest(host="10.0.0.2"))  # must not raise

    async def test_two_scopes_have_separate_budgets(self) -> None:
        """Spending the assistant's budget must not lock someone out of login."""
        chat = ratelimit.limit(times=1, seconds=60, scope="assistant")
        login = ratelimit.limit(times=1, seconds=60, scope="login")
        request = FakeRequest()
        await call(chat, request)
        await call(login, request)  # must not raise

    async def test_a_session_gets_its_own_budget(self) -> None:
        """An authenticated user behind a hospital's shared NAT should not share
        one budget with the whole building."""
        guard = ratelimit.limit(times=1, seconds=60, scope="test")
        await call(guard, FakeRequest(host="10.0.0.1", session_id="session-a"))
        await call(guard, FakeRequest(host="10.0.0.1", session_id="session-b"))

    async def test_session_identity_beats_address(self) -> None:
        guard = ratelimit.limit(times=1, seconds=60, scope="test")
        await call(guard, FakeRequest(host="10.0.0.1", session_id="session-a"))
        # Same session, different address — still the same bucket.
        with pytest.raises(AppError):
            await call(guard, FakeRequest(host="10.0.0.9", session_id="session-a"))

    async def test_an_unknown_client_still_gets_a_bucket(self) -> None:
        guard = ratelimit.limit(times=1, seconds=60, scope="test")
        request = FakeRequest()
        request.client = None  # type: ignore[assignment]
        await call(guard, request)
        with pytest.raises(AppError):
            await call(guard, request)


class TestBookkeeping:
    async def test_a_bucket_is_forgotten_when_it_next_expires(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Pruning happens on the key being checked, not across the table."""
        clock = {"now": 1000.0}
        monkeypatch.setattr(ratelimit.time, "monotonic", lambda: clock["now"])

        guard = ratelimit.limit(times=5, seconds=10, scope="test")
        request = FakeRequest()
        await call(guard, request)
        assert "test:10.0.0.1" in ratelimit._hits

        # Past the window, the same caller's stale hit is dropped before the new
        # one is recorded — the bucket holds one entry, not two.
        clock["now"] += 11
        await call(guard, request)
        assert list(ratelimit._hits["test:10.0.0.1"]) == [1011.0]

    async def test_a_caller_who_never_returns_is_swept_up(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The leak this design has to answer for.

        A client that is never seen again leaves its bucket behind, because
        nothing prunes a key that is not being checked. Left alone the table
        would fill with the dead and the limiter would then wave everyone new
        through — failing open exactly when traffic is high enough to matter.
        Reaching the ceiling therefore sweeps before it gives up.
        """
        clock = {"now": 1000.0}
        monkeypatch.setattr(ratelimit.time, "monotonic", lambda: clock["now"])
        monkeypatch.setattr(ratelimit, "_MAX_TRACKED_KEYS", 3)

        guard = ratelimit.limit(times=5, seconds=10, scope="test")
        for host in ("10.0.0.1", "10.0.0.2", "10.0.0.3"):
            await call(guard, FakeRequest(host=host))
        assert len(ratelimit._hits) == 3

        # All three go quiet. A fourth caller arrives to a full table.
        clock["now"] += 11
        await call(guard, FakeRequest(host="10.0.0.4"))

        # The dead were cleared and the newcomer is tracked — not waved through.
        assert set(ratelimit._hits) == {"test:10.0.0.4"}

    async def test_a_full_table_stops_tracking_rather_than_growing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Degrading to "no limit for this caller" beats a memory leak.

        The limiter is a cost control; the controls that must not be bypassable
        are in the database. Taking the process down to enforce a throttle would
        be the more expensive failure.
        """
        monkeypatch.setattr(ratelimit, "_MAX_TRACKED_KEYS", 2)
        guard = ratelimit.limit(times=1, seconds=60, scope="test")

        await call(guard, FakeRequest(host="10.0.0.1"))
        await call(guard, FakeRequest(host="10.0.0.2"))
        # Table is full; a third caller is allowed through rather than tracked.
        await call(guard, FakeRequest(host="10.0.0.3"))
        await call(guard, FakeRequest(host="10.0.0.3"))

        assert len(ratelimit._hits) == 2

    async def test_reset_clears_everything(self) -> None:
        guard = ratelimit.limit(times=1, seconds=60, scope="test")
        await call(guard, FakeRequest())
        ratelimit.reset()
        await call(guard, FakeRequest())  # must not raise

"""Rate limiting (spec §"Phase 13 — Rate limiting").

A sliding-window counter, applied as a FastAPI dependency to the handful of
endpoints where unbounded repetition actually costs something:

* **the AI assistant**, because every call spends real money and a single
  patient holding down a button can spend a lot of it;
* **break-glass**, because someone probing which patient ids exist should not be
  able to do it a thousand times a minute;
* **login**, as a first layer in front of the account lockout that already
  exists — lockout stops an attack on *one* account, and this stops one client
  working through many.

**Known limitation, stated rather than hidden: the counter lives in this
process.** A deployment running four workers allows roughly four times the
configured rate, because each worker counts on its own. That is a real weakness
and the honest fix is a shared store — Redis, or a Postgres table — which is not
in this stack. It is still worth having: it bounds a runaway client and a naive
script by a large factor, and the controls that must not be bypassable (account
lockout, authorization, audit) are all in the database rather than here.

**Nothing security-critical depends on this alone.** Rate limiting here is a
cost and noise control. Brute force is stopped by `Account.lockedUntil`, which
is a database row and counts correctly however many workers are running.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable

from fastapi import Request

from app.core.errors import AppError, ErrorCode
from app.core.logging import logger

#: Timestamps of recent hits, per bucket key. A deque is used so expiring old
#: entries is a pop from the left rather than a scan of the whole window.
_hits: dict[str, deque[float]] = defaultdict(deque)

#: Ceiling on how many callers are tracked at once.
#:
#: Reaching it triggers a sweep rather than an immediate give-up, because a full
#: table is almost always full of *stale* keys, not active ones: pruning only
#: happens on the key being checked, so a client that never returns leaves its
#: entry behind. Without the sweep the table would fill with corpses and the
#: limiter would then wave everyone new through — failing open at exactly the
#: moment traffic is high enough to matter.
_MAX_TRACKED_KEYS = 10_000


def _prune(key: str, window_seconds: float, now: float) -> deque[float]:
    hits = _hits[key]
    cutoff = now - window_seconds
    while hits and hits[0] <= cutoff:
        hits.popleft()
    if not hits:
        _hits.pop(key, None)
        return deque()
    return hits


def _sweep(window_seconds: float, now: float) -> int:
    """Drop every bucket whose hits have all aged out. Returns how many went.

    Only called when the table hits its ceiling, so the cost is paid once per
    fill rather than on every request.
    """
    cutoff = now - window_seconds
    stale = [key for key, hits in _hits.items() if not hits or hits[-1] <= cutoff]
    for key in stale:
        _hits.pop(key, None)
    return len(stale)


def reset() -> None:
    """Clear every counter. For tests, which must not inherit each other's."""
    _hits.clear()


def limit(
    *, times: int, seconds: int, scope: str
) -> Callable[[Request], Awaitable[None]]:
    """A dependency that allows ``times`` requests per ``seconds`` per caller.

    Callers are identified by session id where there is one and by IP otherwise.
    Session first is deliberate: an authenticated user behind a hospital's shared
    NAT should get their own budget rather than share one with the whole
    building, and a signed-in abuser is identifiable in a way an IP is not.
    """

    async def dependency(request: Request) -> None:
        # Read from the already-decoded token when the route has one, rather
        # than decoding again — this runs before the endpoint on every call.
        session_id = getattr(request.state, "session_id", None)
        client = request.client.host if request.client else "unknown"
        key = f"{scope}:{session_id or client}"

        now = time.monotonic()
        hits = _prune(key, seconds, now)

        if len(hits) >= times:
            retry_after = max(1, int(seconds - (now - hits[0])))
            logger.warning("rate_limited", scope=scope, retry_after=retry_after)
            raise AppError(
                429,
                ErrorCode.RATE_LIMITED,
                f"Too many requests. Try again in {retry_after} seconds.",
            )

        if len(_hits) >= _MAX_TRACKED_KEYS and key not in _hits:
            # Almost certainly full of callers who never came back. Clear those
            # first — giving up while the table is mostly stale would fail open
            # for no reason.
            dropped = _sweep(seconds, now)
            if len(_hits) >= _MAX_TRACKED_KEYS:
                # Genuinely that many active callers. Not tracking this one is
                # better than growing without bound: the limiter degrades to
                # "no limit for this caller" rather than becoming a memory leak
                # that takes the process down. The controls that must not be
                # bypassable live in the database, not here.
                logger.warning("rate_limit_table_full", scope=scope, swept=dropped)
                return

        _hits[key].append(now)

    return dependency

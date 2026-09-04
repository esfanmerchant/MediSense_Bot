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

**The counter is shared when it can be.** With ``REDIS_URL`` set, the window
lives in Redis and four workers enforce one limit between them. Without it the
counter lives in this process, and a deployment running four workers allows
roughly four times the configured rate because each worker counts on its own.
That fallback is stated rather than hidden: it still bounds a runaway client
and a naive script by a large factor, and it is exactly correct on the single
worker most deployments of this size run.

**Redis being down is not an outage.** A failed call falls through to the local
counter for that request rather than raising. A limiter that 500s when its
store is unreachable turns a cache problem into a site problem.

**Nothing security-critical depends on this alone.** Rate limiting here is a
cost and noise control. Brute force is stopped by `Account.lockedUntil`, which
is a database row and counts correctly however many workers are running.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable

from fastapi import Request

from app.core import redis as redis_store
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



async def _shared_window(key: str, times: int, seconds: int) -> tuple[bool, int] | None:
    """Count this hit in Redis. Returns (allowed, retry_after), or None.

    ``None`` means "no shared store, or it did not answer" — the caller then
    counts locally, which is the pre-Redis behaviour.

    A sorted set of hit timestamps rather than a plain counter with an expiry,
    because a counter's window resets on a boundary: 20 requests at 11:59:59
    and 20 more at 12:00:01 would both pass a "20 per minute" limit. Trimming
    by score gives a window that actually slides.

    All four commands go in one pipeline, so the read cannot see a state that
    another worker is halfway through writing.
    """
    connection = await redis_store.client()
    if connection is None:
        return None

    now = time.time()
    cutoff = now - seconds
    member = f"{now:.6f}:{id(connection)}"

    try:
        pipe = connection.pipeline()
        pipe.zremrangebyscore(key, 0, cutoff)
        pipe.zadd(key, {member: now})
        pipe.zcard(key)
        # Expire slightly past the window so a key nobody touches again is
        # reclaimed by Redis rather than living forever.
        pipe.expire(key, seconds + 1)
        _, _, count, _ = await pipe.execute()
    except Exception:
        return None

    if count <= times:
        return True, 0

    # Over the limit. This hit was added before we knew that, so take it back
    # out — otherwise a client hammering the endpoint keeps pushing its own
    # window forward and is locked out for far longer than the window.
    try:
        await connection.zrem(key, member)
        oldest = await connection.zrange(key, 0, 0, withscores=True)
    except Exception:
        return False, seconds

    retry_after = max(1, int(seconds - (now - oldest[0][1]))) if oldest else seconds
    return False, retry_after


#: Whether the limiter is standing down. Never true outside a test run.
#:
#: The integration suite signs in several hundred times from one address in a
#: few minutes — which is precisely the traffic the login limit exists to
#: refuse. Left on, it trips a third of the way through and every test after it
#: fails on a 429 that has nothing to do with what that test was checking.
#:
#: A module-level flag rather than a setting, deliberately: a setting is a thing
#: a deployment can turn off, and this must be unreachable from configuration.
#: The only way in is ``bypass_for_tests()``, which lives in this module and is
#: called from ``conftest``.
_bypassed = False


def bypass_for_tests() -> None:
    """Stand the limiter down for the current test."""
    global _bypassed
    _bypassed = True


def enforce_for_tests() -> None:
    """Put the limiter back on.

    Paired with ``bypass_for_tests``, and kept separate from ``reset`` on
    purpose. Folding this into ``reset`` looked clever — the limiter's own tests
    already reset counters, so they would have re-enabled it for free — but it
    gave one function two meanings, and a second test file that reset counters
    for the ordinary reason silently turned the limiter back on for everything
    in it. A function that does a thing nobody reading the call site would
    expect is a bug with a delay on it.
    """
    global _bypassed
    _bypassed = False


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
        if _bypassed:
            return
        # Read from the already-decoded token when the route has one, rather
        # than decoding again — this runs before the endpoint on every call.
        session_id = getattr(request.state, "session_id", None)
        client = request.client.host if request.client else "unknown"
        key = f"{scope}:{session_id or client}"

        shared = await _shared_window(f"rl:{key}", times, seconds)
        if shared is not None:
            allowed, retry_after = shared
            if not allowed:
                logger.warning("rate_limited", scope=scope, retry_after=retry_after)
                raise AppError(
                    429,
                    ErrorCode.RATE_LIMITED,
                    f"Too many requests. Try again in {retry_after} seconds.",
                )
            return

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

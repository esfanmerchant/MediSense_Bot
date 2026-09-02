"""One optional Redis connection, shared by everything that needs one.

Two things in this API are correct in one process and wrong in four: the rate
limiter counts per worker, so N workers allow N times the configured rate; and
the live vitals feed fans out per worker, so an alert reaches only the browsers
connected to the worker that produced it. Both are documented where they live.
This module is the shared state that fixes them when it exists.

**Absence is a supported configuration, not a degraded one.** With no
``REDIS_URL`` nothing here is imported, every caller keeps its in-process
behaviour, and a single-worker deployment is completely correct as it stands.
That is deliberate: making Redis mandatory would add an operational dependency
— and a new way for the whole API to be down — to buy something a small
deployment does not need.

**A Redis that is configured but unreachable must never take the API down.**
Every helper here returns ``None`` rather than raising, and every caller treats
``None`` as "do it the local way". A cache or a fan-out that is temporarily
missing costs accuracy at the edges; an exception on the request path costs the
whole request.
"""

from __future__ import annotations

from contextlib import suppress
from typing import Any

from app.core.config import settings
from app.core.logging import logger

_client: Any | None = None
_tried = False
#: Set once when a configured Redis turns out to be unusable, so the log says
#: so exactly once rather than on every request that touches it.
_warned = False


def enabled() -> bool:
    return bool(settings.REDIS_URL)


async def client() -> Any | None:
    """The shared connection, or ``None`` when there is none to be had.

    Created lazily on first use rather than at startup: a deployment that never
    touches a rate-limited endpoint should not hold a connection open, and a
    Redis that is briefly down at boot must not stop the API from starting.
    """
    global _client, _tried, _warned

    if not enabled():
        return None
    if _client is not None:
        return _client
    if _tried and _client is None:
        # A previous attempt failed. Retrying on every call would turn a Redis
        # outage into a connection storm on top of it.
        return None

    _tried = True
    try:
        from redis.asyncio import Redis as RedisClient

        connection = RedisClient.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            # Bounded so a stalled Redis delays a request briefly rather than
            # holding a worker until something else times out.
            socket_connect_timeout=2,
            socket_timeout=2,
            health_check_interval=30,
        )
        await connection.ping()
    except Exception as exc:
        if not _warned:
            _warned = True
            logger.warning("redis_unavailable", error=type(exc).__name__)
        return None

    _client = connection
    logger.info("redis_connected")
    return _client


async def close() -> None:
    """Release the connection at shutdown."""
    global _client, _tried
    if _client is not None:
        # Shutdown. A connection that will not close cleanly is about to be
        # gone with the process anyway, and raising here would mask whatever
        # the process was actually shutting down for.
        with suppress(Exception):
            await _client.aclose()
    _client = None
    _tried = False


def reset() -> None:
    """Forget the cached connection. For tests, which must not share one."""
    global _client, _tried, _warned
    _client = None
    _tried = False
    _warned = False

"""Server-sent events for the live vitals dashboard (spec §16).

The spec asks for "WebSockets/SSE or another appropriate real-time mechanism"
and says not to rely solely on frontend timers. SSE is the right size for this
traffic: it is one-directional (the server has news, the browser does not),
survives proxies as ordinary HTTP, reconnects on its own, and — unlike a
WebSocket — carries the session cookie the rest of the API already
authenticates with, so a live feed needs no second authentication scheme.

**Scope is decided here, once, per subscriber.** A subscriber is created with
the exact set of patients its owner may see, resolved through the same clinical
access rules as every other read. Filtering in the browser would mean sending a
doctor alerts about patients who are not theirs and trusting the page not to
render them, which is the failure spec §34 is written against.

**Known limitation, stated rather than hidden:** this fan-out lives in one
process. A deployment running several workers would deliver each event only to
the subscribers connected to the worker that produced it. Fixing that needs a
shared bus — Redis, or Postgres LISTEN/NOTIFY, which is unavailable here because
the Supabase transaction pooler does not carry notifications. Until then the
dashboard also refetches on reconnect, so a missed event costs latency rather
than correctness.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from app.core.logging import logger

#: Events buffered per subscriber before the slowest one starts losing them. A
#: browser that has stopped reading must not be able to grow the server's memory
#: without bound, and for a live dashboard the newest state matters more than a
#: complete history — the client refetches on reconnect either way.
QUEUE_LIMIT = 50

#: Sent when nothing has happened, to keep proxies from closing an idle
#: connection and to let the client notice a dead link promptly.
HEARTBEAT_SECONDS = 25


@dataclass
class Subscriber:
    """One open connection, and the patients it is allowed to hear about."""

    patient_ids: frozenset[str]
    #: True for a caller whose scope is every patient (nobody today; kept so an
    #: operations dashboard cannot be added later by loosening the filter.)
    unrestricted: bool = False
    queue: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue(maxsize=QUEUE_LIMIT))
    dropped: int = 0

    def may_see(self, patient_id: str) -> bool:
        return self.unrestricted or patient_id in self.patient_ids


_subscribers: set[Subscriber] = set()


def subscribe(patient_ids: frozenset[str], *, unrestricted: bool = False) -> Subscriber:
    subscriber = Subscriber(patient_ids=patient_ids, unrestricted=unrestricted)
    _subscribers.add(subscriber)
    return subscriber


def unsubscribe(subscriber: Subscriber) -> None:
    _subscribers.discard(subscriber)


def subscriber_count() -> int:
    """For the readiness payload and tests. Never exposes who is connected."""
    return len(_subscribers)


def publish(event: str, patient_id: str, data: dict[str, Any]) -> None:
    """Offer an event to every subscriber entitled to it.

    Synchronous and non-blocking by design: this is called from inside a request
    that is recording a vital, and a slow or stalled reader must never hold up
    the write that produced the event. A subscriber whose queue is full loses
    the event and is counted, rather than applying backpressure to the ward.
    """
    payload = f"event: {event}\ndata: {json.dumps(data)}\n\n"
    for subscriber in list(_subscribers):
        if not subscriber.may_see(patient_id):
            continue
        try:
            subscriber.queue.put_nowait(payload)
        except asyncio.QueueFull:
            subscriber.dropped += 1
            logger.warning("sse_subscriber_lagging", dropped=subscriber.dropped)


async def events(subscriber: Subscriber) -> AsyncIterator[str]:
    """The response body: queued events, with a heartbeat through quiet spells."""
    # Sent immediately so the browser's EventSource resolves its connection
    # rather than sitting in "connecting" until the first alert of the shift.
    yield ": connected\n\n"
    try:
        while True:
            try:
                yield await asyncio.wait_for(subscriber.queue.get(), timeout=HEARTBEAT_SECONDS)
            except TimeoutError:
                yield ": keep-alive\n\n"
    finally:
        # Runs when the client disconnects, which is the only way this ends.
        unsubscribe(subscriber)

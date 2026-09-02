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

**Across workers, when there is a bus to cross on.** A browser holds its SSE
connection to one worker, but the vital that produces an alert may be recorded
on another — so with several workers and no shared bus, an alert reaches only
the subscribers that happen to be connected to the worker that produced it.
With ``REDIS_URL`` set, every event is also published to a channel each worker
relays back into its own subscriber set, and the feed is whole again. Postgres
``LISTEN/NOTIFY`` would have been the dependency-free answer, but the Supabase
transaction pooler does not carry notifications.

**Without it, nothing changes and nothing breaks.** Local delivery is
unconditional and happens first; the cross-worker publish is best-effort on top.
One worker is completely correct as it stands, and the dashboard refetches on
reconnect, so even a missed event costs latency rather than correctness.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from collections.abc import AsyncIterator
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any

from app.core import redis as redis_store
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


#: The channel workers relay events over, and who this worker is.
#:
#: The origin is checked on receipt so a worker ignores its own echo — it has
#: already delivered locally, and delivering again would show every alert twice
#: on the dashboards connected to whichever worker recorded the vital. The pid
#: is in there so the id is legible in a log; the random half is what actually
#: makes it unique, since two containers can share a pid.
CHANNEL = "medisense:vitals"
ORIGIN = f"{os.getpid()}-{secrets.token_hex(4)}"

#: The relay task, so lifespan can cancel it at shutdown.
_relay: asyncio.Task[None] | None = None


def _deliver_local(event: str, patient_id: str, data: dict[str, Any]) -> None:
    """Hand an event to every local subscriber entitled to it.

    Scope is re-checked here, not trusted from the wire: an event arriving over
    Redis carries a patient id, and which subscribers may see that patient is a
    decision this process makes from what it resolved at subscribe time.
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


async def _broadcast(event: str, patient_id: str, data: dict[str, Any]) -> None:
    """Best-effort publish to the other workers. Never raises."""
    connection = await redis_store.client()
    if connection is None:
        return
    try:
        await connection.publish(
            CHANNEL,
            json.dumps(
                {"origin": ORIGIN, "event": event, "patientId": patient_id, "data": data}
            ),
        )
    except Exception:
        # The local dashboards already have it, and the rest refetch on
        # reconnect. Not worth failing the vital that caused it.
        logger.debug("sse_broadcast_failed")


def publish(event: str, patient_id: str, data: dict[str, Any]) -> None:
    """Offer an event to every subscriber entitled to it, here and elsewhere.

    Synchronous and non-blocking by design: this is called from inside a request
    that is recording a vital, and a slow or stalled reader must never hold up
    the write that produced the event. A subscriber whose queue is full loses
    the event and is counted, rather than applying backpressure to the ward.

    Local delivery happens first and unconditionally. The cross-worker publish
    is scheduled, not awaited, for the same reason — a Redis round trip must not
    sit in the path of recording a patient's blood pressure.
    """
    _deliver_local(event, patient_id, data)

    if not redis_store.enabled():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # Called from outside the event loop — a test, or a script. Local
        # delivery has already happened, which is all that can be done here.
        return
    task = loop.create_task(_broadcast(event, patient_id, data))
    # Held until it finishes, then dropped: an un-referenced task can be
    # garbage-collected mid-flight, which is a genuinely baffling way to lose
    # an event.
    _pending.add(task)
    task.add_done_callback(_pending.discard)


#: Live `_broadcast` tasks, kept alive against garbage collection.
_pending: set[asyncio.Task[None]] = set()


async def relay() -> None:
    """Deliver events other workers published. Runs until cancelled.

    Every failure reconnects rather than exits: this task going quiet would be
    invisible — the dashboards would keep their connections and simply stop
    seeing alerts from other workers, which is the worst kind of broken.
    """
    while True:
        try:
            connection = await redis_store.client()
            if connection is None:
                await asyncio.sleep(5)
                continue

            pubsub = connection.pubsub()
            await pubsub.subscribe(CHANNEL)
            logger.info("sse_relay_connected", origin=ORIGIN)
            try:
                async for message in pubsub.listen():
                    if message.get("type") != "message":
                        continue
                    try:
                        body = json.loads(message["data"])
                    except (TypeError, ValueError):
                        continue
                    if body.get("origin") == ORIGIN:
                        continue  # our own echo; already delivered locally
                    _deliver_local(
                        str(body.get("event", "")),
                        str(body.get("patientId", "")),
                        body.get("data") or {},
                    )
            finally:
                await pubsub.aclose()
        except asyncio.CancelledError:
            logger.info("sse_relay_stopped")
            raise
        except Exception:
            logger.warning("sse_relay_reconnecting")
            await asyncio.sleep(5)


def start_relay() -> asyncio.Task[None] | None:
    """Start the relay, if there is anything to relay over."""
    global _relay
    if not redis_store.enabled() or _relay is not None:
        return _relay
    _relay = asyncio.create_task(relay())
    return _relay


async def stop_relay() -> None:
    global _relay
    if _relay is None:
        return
    _relay.cancel()
    # Cancelling is the expected end, and anything else it raises on the way
    # out is a shutdown detail — the process is stopping either way.
    with suppress(Exception):
        await _relay
    _relay = None


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

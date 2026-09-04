"""One dispatcher pass, triggered from outside.

The dispatcher normally runs as a loop inside the application's lifespan, once a
minute, and that is the right shape for a process that stays alive. A serverless
platform does not give you one: the function is invoked, it answers, and it is
frozen. The loop never gets a second tick, so queued email is never sent and a
medication reminder never fires — and none of that is visible, because every
request the browser makes still works perfectly.

So the same pass is also reachable over HTTP, for an external scheduler to call
on the cadence the loop would have used. It is not a workaround bolted on:
``run_once()`` was already separate from ``loop()`` so tests could drive it, and
this endpoint drives it exactly the same way.

**Overlapping calls are safe.** A scheduler that fires again before the last run
finished, or two of them, cannot double-send: the queue is claimed with
``SELECT … FOR UPDATE SKIP LOCKED``, so concurrent passes take disjoint batches.
That was built for multiple workers and holds here unchanged.

**It is not public.** The credential is a shared secret in a header, compared in
constant time. With no secret configured the endpoint refuses outright rather
than accepting an empty one — a deployment that has not set it has not opened
anything.
"""

from __future__ import annotations

import hmac
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header

from app.api.responses import ok
from app.core.config import settings
from app.core.errors import AppError, ErrorCode
from app.core.logging import logger
from app.core.ratelimit import limit
from app.modules.notifications import dispatcher

router = APIRouter(prefix="/internal", tags=["internal"])

#: Generous next to a once-a-minute schedule, and far too tight to be worth
#: pointing at. A pass is bounded by BATCH_SIZE either way, so the ceiling is on
#: the requests rather than on the work.
DispatchRateLimit = Annotated[None, Depends(limit(times=10, seconds=60, scope="dispatch"))]


@router.post("/dispatch")
async def dispatch(
    _: DispatchRateLimit,
    x_dispatch_secret: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """Run one dispatcher pass and report what it did.

    Returns the same counts the loop logs — reminders scheduled, messages sent,
    pushes delivered — so a scheduler's own history shows whether anything is
    actually being delivered, rather than only that the endpoint answered.
    """
    if not settings.DISPATCH_SECRET:
        # Not "unauthorised": there is nothing here to be authorised against.
        # Answering 404 would be quieter, and would also mean a deployment that
        # forgot to set the secret sees the same thing as one whose scheduler
        # has the wrong URL. This says which.
        raise AppError(
            503,
            ErrorCode.INTERNAL_ERROR,
            "Scheduled dispatch is not configured on this deployment.",
        )

    if not hmac.compare_digest(x_dispatch_secret or "", settings.DISPATCH_SECRET):
        logger.warning("dispatch_rejected")
        raise AppError(401, ErrorCode.UNAUTHORIZED, "Bad dispatch credential.")

    if not dispatcher.should_run():
        # Neither email nor push is configured, so a pass would do nothing. Said
        # plainly rather than reported as a successful run of zero, which reads
        # identically to a working deployment with an empty queue.
        return ok({"ran": False, "reason": "no email or push transport configured"})

    counts = await dispatcher.run_once()
    logger.info("dispatch_ran", **counts)
    return ok({"ran": True, **counts})

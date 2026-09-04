"""A signed-in user's own notification list.

Scoped entirely by session: there is no id in any path here and no way to name
another user, so the endpoints cannot be pointed at someone else's inbox.

**And scoped to the in-app channel, everywhere.** One event writes one row per
channel: the ``IN_APP`` row is the thing a person reads in the portal, and the
``EMAIL`` and ``PUSH`` rows are queue entries the dispatcher drains. Listing
all three showed every emailed notification twice in the bell — and every
emailed *and* pushed one three times.

The second consequence was worse and invisible. "Mark all read" set
``status = READ`` on every unread row of every channel, and the dispatcher
claims rows by ``status == PENDING`` — so pressing it silently cancelled every
email and push still waiting to go out. Both follow from the same missing
filter, so it is applied in one place and used by all three endpoints.
"""

from __future__ import annotations

from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import CursorResult, delete, func, select, update

from app.api.deps import CurrentAuth, DbSession
from app.api.responses import Page, ok, pagination
from app.core.config import settings
from app.core.errors import not_found
from app.core.ratelimit import limit
from app.db.base import utcnow
from app.db.enums import NotificationChannel, NotificationStatus
from app.db.models import Notification, PushSubscription, User
from app.modules.notifications.service import serialize
from app.services.email_links import read_unsubscribe_token

router = APIRouter(prefix="/notifications", tags=["notifications"])

#: The only unauthenticated write in the application. Its credential is a sealed
#: token, so it cannot be forged — but it is reached with no session at all, and
#: Gmail's one-click posts to it without a browser. Twenty an hour is far more
#: than anyone unsubscribing needs, and it bounds what an endpoint that takes no
#: session can be made to do to the database.
UnsubscribeRateLimit = Annotated[
    None, Depends(limit(times=20, seconds=3600, scope="unsubscribe"))
]


def _mine(auth: CurrentAuth) -> list[Any]:
    """This user's own portal notifications, and nothing else.

    Both halves matter and both are easy to leave out: without the user id an
    endpoint reads somebody else's inbox, and without the channel it reads the
    delivery queue and treats it as inbox.
    """
    return [
        Notification.user_id == auth.user_id,
        Notification.channel == NotificationChannel.IN_APP,
    ]


@router.get("")
async def list_notifications(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    unread_only: bool = Query(default=False, alias="unreadOnly"),
) -> dict[str, Any]:
    filters = _mine(auth)
    if unread_only:
        filters.append(Notification.read_at.is_(None))

    total = (await db.execute(select(func.count(Notification.id)).where(*filters))).scalar_one()
    unread = (
        await db.execute(
            select(func.count(Notification.id)).where(
                *_mine(auth), Notification.read_at.is_(None)
            )
        )
    ).scalar_one()

    rows = (
        (
            await db.execute(
                select(Notification)
                .where(*filters)
                .order_by(Notification.created_at.desc())
                .limit(page.limit)
                .offset(page.offset)
            )
        )
        .scalars()
        .all()
    )

    meta = page.meta(total) | {"unread": unread}
    return ok([serialize(row) for row in rows], meta)


@router.post("/{notification_id}/read")
async def mark_read(notification_id: str, auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    """Mark one notification read.

    The owner filter is part of the UPDATE rather than a check beforehand, so
    another user's id simply matches no rows.
    """
    result = await db.execute(
        update(Notification)
        .where(
            Notification.id == notification_id,
            *_mine(auth),
            Notification.read_at.is_(None),
        )
        .values(read_at=utcnow(), status=NotificationStatus.READ)
    )
    # `execute` is typed as returning `Result`, but a DML statement returns a
    # `CursorResult`, which is where `rowcount` lives.
    if cast("CursorResult[Any]", result).rowcount == 0:
        # Either it does not exist, is not theirs, or was already read. Confirm
        # it is theirs before deciding which — without revealing the others.
        exists = (
            await db.execute(
                select(Notification.id).where(
                    Notification.id == notification_id, *_mine(auth)
                )
            )
        ).first()
        if not exists:
            raise not_found("Notification")
    return ok({"id": notification_id, "read": True})


@router.post("/read-all")
async def mark_all_read(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    result = await db.execute(
        update(Notification)
        # The channel filter is what stops this cancelling the outbox: without
        # it, "mark all read" flipped every PENDING email and push to READ and
        # the dispatcher never sent them.
        .where(*_mine(auth), Notification.read_at.is_(None))
        .values(read_at=utcnow(), status=NotificationStatus.READ)
    )
    return ok({"markedRead": cast("CursorResult[Any]", result).rowcount})


# --- Web Push enrolment ------------------------------------------------------
#
# A subscription belongs to a browser, not to a person: the browser generates
# the keys and the endpoint, and hands them over once permission is granted.
# That shapes the two rules below.


class PushKeys(BaseModel):
    p256dh: Annotated[str, Field(min_length=1, max_length=255)]
    auth: Annotated[str, Field(min_length=1, max_length=255)]


class PushEnrol(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    endpoint: Annotated[str, Field(min_length=1, max_length=1000)]
    keys: PushKeys

    @field_validator("endpoint")
    @classmethod
    def _https_only(cls, value: str) -> str:
        # The endpoint is a URL this server will POST to. Anything but https to
        # a real host is either a mistake or an attempt to make us fetch
        # something internal, so it is refused at the door.
        if not value.startswith("https://"):
            raise ValueError("endpoint must be an https URL")
        return value


@router.get("/push")
async def push_status(auth: CurrentAuth, db: DbSession) -> dict[str, Any]:
    """What the browser needs to decide whether to offer push at all.

    ``publicKey`` is returned rather than only baked into the bundle so a
    deployment that rotates its VAPID keys does not need a rebuild — the two
    halves must match, and this is the half that is safe to hand out.
    """
    devices = (
        await db.execute(
            select(func.count(PushSubscription.id)).where(
                PushSubscription.user_id == auth.user_id,
                PushSubscription.failed_at.is_(None),
            )
        )
    ).scalar_one()
    return ok(
        {
            "enabled": settings.push_enabled,
            "publicKey": settings.VAPID_PUBLIC_KEY or None,
            "devices": devices,
        }
    )


@router.post("/push")
async def push_subscribe(
    payload: PushEnrol, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Enrol this browser, or re-confirm an enrolment.

    Called on every load, not only the first time: a push service may rotate an
    endpoint underneath the page, and a subscription that has gone quiet for
    months is worth touching so we know the device is still real.

    An endpoint already on file is **moved** to the current user rather than
    rejected. The alternative — refusing it — would silently keep sending a
    shared or handed-down device's reminders to whoever signed in first.
    """
    existing = (
        await db.execute(
            select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
        )
    ).scalar_one_or_none()

    now = utcnow()
    agent = (request.headers.get("user-agent") or "")[:400] or None

    if existing is not None:
        existing.user_id = auth.user_id
        existing.p256dh = payload.keys.p256dh
        existing.auth = payload.keys.auth
        existing.user_agent = agent
        existing.last_seen_at = now
        # A device that answers again has recovered; clear the tombstone so the
        # dispatcher stops skipping it.
        existing.failed_at = None
        row = existing
    else:
        row = PushSubscription(
            user_id=auth.user_id,
            endpoint=payload.endpoint,
            p256dh=payload.keys.p256dh,
            auth=payload.keys.auth,
            user_agent=agent,
            last_seen_at=now,
        )
        db.add(row)

    await db.flush()
    return ok({"id": row.id, "enabled": settings.push_enabled})


@router.delete("/push")
async def push_unsubscribe(
    auth: CurrentAuth,
    db: DbSession,
    endpoint: Annotated[str, Query(min_length=1, max_length=1000)],
) -> dict[str, Any]:
    """Forget this browser.

    Scoped to the caller, so knowing someone else's endpoint is not enough to
    turn their reminders off. Deleting rather than deactivating is right here:
    the row is a routing address, not a clinical fact, and the honest answer to
    "stop sending me these" is to no longer hold the address.
    """
    result = await db.execute(
        delete(PushSubscription).where(
            PushSubscription.endpoint == endpoint,
            PushSubscription.user_id == auth.user_id,
        )
    )
    return ok({"removed": cast("CursorResult[Any]", result).rowcount})


# --- Unsubscribing, from inside an email -------------------------------------


class UnsubscribeRequest(BaseModel):
    """The sealed token from the link. Nothing else — there is no session."""

    token: Annotated[str, Field(min_length=1, max_length=512)]


@router.post("/unsubscribe", status_code=200)
async def unsubscribe(
    payload: UnsubscribeRequest, db: DbSession, _: UnsubscribeRateLimit
) -> dict[str, Any]:
    """Turn email off for the account this token belongs to.

    **No session, on purpose.** This is reached from a mail client — either the
    person pressing "Unsubscribe" in Gmail, which POSTs here without opening a
    browser, or the link in the footer. Requiring a sign-in first would make
    the promise in the `List-Unsubscribe` header false, and a header that
    promises one-click and then asks for a password is worse than no header:
    it is the thing spam filters are checking for.

    **The token is the authorisation.** It is the user id sealed with a key
    derived from the server's own secret, so it cannot be forged or read, and
    it grants exactly one power — turning this account's email off. It cannot
    sign anybody in, cannot be replayed against another account, and turning
    email off is not a destructive act: the portal keeps every notification and
    the switch is one press to undo in settings.

    **The answer is the same whatever the token was.** A token that decodes to
    nothing gets the same 200 as one that worked, because a different answer
    would turn this into a way to test which sealed strings are real.
    """
    address = read_unsubscribe_token(payload.token)
    if address:
        await db.execute(
            update(User)
            .where(func.lower(User.email) == address.lower())
            .values(notify_by_email=False)
        )
        await db.flush()
    return ok({"unsubscribed": True})

"""A signed-in user's own notification list.

Scoped entirely by session: there is no id in any path here and no way to name
another user, so the endpoints cannot be pointed at someone else's inbox.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, update

from app.api.deps import CurrentAuth, DbSession
from app.api.responses import Page, ok, pagination
from app.core.errors import not_found
from app.db.base import utcnow
from app.db.enums import NotificationStatus
from app.db.models import Notification
from app.modules.notifications.service import serialize

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
async def list_notifications(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    unread_only: bool = Query(default=False, alias="unreadOnly"),
) -> dict[str, Any]:
    filters = [Notification.user_id == auth.user_id]
    if unread_only:
        filters.append(Notification.read_at.is_(None))

    total = (await db.execute(select(func.count(Notification.id)).where(*filters))).scalar_one()
    unread = (
        await db.execute(
            select(func.count(Notification.id)).where(
                Notification.user_id == auth.user_id, Notification.read_at.is_(None)
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
            Notification.user_id == auth.user_id,
            Notification.read_at.is_(None),
        )
        .values(read_at=utcnow(), status=NotificationStatus.READ)
    )
    if result.rowcount == 0:
        # Either it does not exist, is not theirs, or was already read. Confirm
        # it is theirs before deciding which — without revealing the others.
        exists = (
            await db.execute(
                select(Notification.id).where(
                    Notification.id == notification_id, Notification.user_id == auth.user_id
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
        .where(Notification.user_id == auth.user_id, Notification.read_at.is_(None))
        .values(read_at=utcnow(), status=NotificationStatus.READ)
    )
    return ok({"markedRead": result.rowcount})

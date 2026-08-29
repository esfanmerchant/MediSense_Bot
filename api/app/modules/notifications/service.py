"""The notification service (spec §31-32).

One entry point, two channels. ``notify()`` writes the in-app row every time,
and queues an email alongside it when the type warrants one — so no module has
to know how mail is sent, or whether it is sent at all.

    notify()
       ├── IN_APP   written SENT; the write *is* the delivery
       └── EMAIL    written PENDING; the dispatcher sends it

Three rules hold regardless of channel:

* **A notification body is not a medical record.** It says an appointment moved
  and links to it; it never carries a diagnosis, a prescription or a result.
  Notifications reach phones, lock screens and mail servers, none of which are
  inside the access-control boundary the rest of the system maintains. The email
  says *less* again — see ``templates.py``.
* **Failure here never fails the action.** A booking that succeeded must not be
  reported as failed because a notification row could not be written, or because
  a mail server was busy.
* **An email row is queued, never sent inline.** Sending during the request
  would put a booking behind an SMTP handshake, and a slow mail server would
  become a slow hospital.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import logger
from app.db.base import new_id, utcnow
from app.db.enums import (
    NotificationChannel,
    NotificationStatus,
    NotificationType,
)
from app.db.models import Doctor, Notification, Patient, User
from app.modules.notifications.templates import EMAILED_TYPES

#: Longest a notification body may be. Anything approaching this is carrying
#: detail that belongs behind authentication, not in a notification.
MAX_BODY_LENGTH = 400


async def user_id_for_patient(db: AsyncSession, patient_id: str) -> str | None:
    return (
        await db.execute(select(Patient.user_id).where(Patient.id == patient_id))
    ).scalar_one_or_none()


async def user_id_for_doctor(db: AsyncSession, doctor_id: str) -> str | None:
    return (
        await db.execute(select(Doctor.user_id).where(Doctor.id == doctor_id))
    ).scalar_one_or_none()


async def notify(
    db: AsyncSession,
    *,
    user_id: str | None,
    notification_type: NotificationType,
    title: str,
    body: str,
    link: str | None = None,
    metadata: dict[str, Any] | None = None,
    priority: int = 0,
    email: bool | None = None,
) -> Notification | None:
    """Notify one user, in-app and — where it is warranted — by email.

    Returns the in-app row. ``email`` overrides the per-type default from
    ``EMAILED_TYPES``: pass ``False`` to keep something in the portal only, or
    ``True`` to force a message out for a type that is not normally mailed.

    The in-app row is marked ``SENT`` immediately because the write *is* the
    delivery. The email row stays ``PENDING`` until the dispatcher claims it,
    which is what makes a mail outage a delayed email rather than a failed
    booking.
    """
    if not user_id:
        return None

    title = title[:120]
    body = body[:MAX_BODY_LENGTH]

    try:
        notification = Notification(
            id=new_id(),
            user_id=user_id,
            type=notification_type,
            channel=NotificationChannel.IN_APP,
            status=NotificationStatus.SENT,
            title=title,
            body=body,
            link=link,
            notification_metadata=metadata,
            priority=priority,
            sent_at=utcnow(),
        )
        db.add(notification)
        await db.flush()
    except Exception:
        # An unsent notification is a nuisance; a failed booking is an outage.
        logger.exception("notification_write_failed", notification_type=str(notification_type))
        return None

    wants_email = EMAILED_TYPES.__contains__(notification_type) if email is None else email
    if wants_email:
        await queue_email(
            db,
            user_id=user_id,
            notification_type=notification_type,
            title=title,
            body=body,
            link=link,
            metadata=metadata,
            priority=priority,
        )

    return notification


async def queue_email(
    db: AsyncSession,
    *,
    user_id: str,
    notification_type: NotificationType,
    title: str,
    body: str,
    link: str | None,
    metadata: dict[str, Any] | None,
    priority: int,
) -> Notification | None:
    """Add a ``PENDING`` email row for the dispatcher to pick up.

    Nothing is queued when delivery is switched off. A queue that can never
    drain is worse than no queue: it grows, it looks like a backlog somebody
    should investigate, and the first thing that happens when email is finally
    enabled is a flood of messages about things that happened weeks ago.
    """
    if not settings.email_configured:
        logger.debug("email_not_queued", notification_type=str(notification_type))
        return None

    address = (
        await db.execute(select(User.email).where(User.id == user_id))
    ).scalar_one_or_none()
    if not address:
        return None

    try:
        row = Notification(
            id=new_id(),
            user_id=user_id,
            type=notification_type,
            channel=NotificationChannel.EMAIL,
            status=NotificationStatus.PENDING,
            title=title,
            body=body,
            link=link,
            notification_metadata=metadata,
            priority=priority,
        )
        db.add(row)
        await db.flush()
        return row
    except Exception:
        logger.exception("email_queue_failed", notification_type=str(notification_type))
        return None


def serialize(notification: Notification) -> dict[str, Any]:
    return {
        "id": notification.id,
        "type": str(notification.type),
        "title": notification.title,
        "body": notification.body,
        "link": notification.link,
        "priority": notification.priority,
        "readAt": notification.read_at.isoformat() + "Z" if notification.read_at else None,
        "createdAt": notification.created_at.isoformat() + "Z",
    }

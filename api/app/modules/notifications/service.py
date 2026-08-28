"""In-app notifications.

Phase 4 needs appointment events to reach the people they concern, so this is
the in-app half: a row per recipient, readable from their own portal. Email
delivery, digests and per-user preferences are Phase 12 — the ``channel`` and
``status`` columns already model that, and an ``EMAIL`` row will simply be one
this module leaves ``PENDING`` for a sender to pick up.

Two rules hold regardless of channel:

* **A notification body is not a medical record.** It says an appointment moved
  and links to it; it never carries a diagnosis, a prescription or a result.
  Notifications reach phones, lock screens and mail servers, none of which are
  inside the access-control boundary the rest of the system maintains.
* **Failure here never fails the action.** A booking that succeeded must not be
  reported as failed because a notification row could not be written.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import logger
from app.db.base import new_id, utcnow
from app.db.enums import (
    NotificationChannel,
    NotificationStatus,
    NotificationType,
)
from app.db.models import Doctor, Notification, Patient

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
) -> Notification | None:
    """Queue one in-app notification.

    Marked ``SENT`` immediately because in-app delivery *is* the write — there
    is no downstream step that could still fail. An email row would stay
    ``PENDING`` until a sender claims it.
    """
    if not user_id:
        return None

    try:
        notification = Notification(
            id=new_id(),
            user_id=user_id,
            type=notification_type,
            channel=NotificationChannel.IN_APP,
            status=NotificationStatus.SENT,
            title=title[:120],
            body=body[:MAX_BODY_LENGTH],
            link=link,
            notification_metadata=metadata,
            priority=priority,
            sent_at=utcnow(),
        )
        db.add(notification)
        await db.flush()
        return notification
    except Exception:
        # An unsent notification is a nuisance; a failed booking is an outage.
        logger.exception("notification_write_failed", notification_type=str(notification_type))
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

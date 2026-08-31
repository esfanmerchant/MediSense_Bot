"""Background delivery and appointment reminders (spec §31-32).

Two jobs on one loop:

* **drain the queue** — take ``PENDING`` email rows and send them;
* **schedule reminders** — notify patients whose appointment is coming up.

**Claiming is done in the database, not in this process.** Rows are taken with
``FOR UPDATE SKIP LOCKED``, so several workers can run this loop and each
message still goes to exactly one of them. An in-process "is it mine" check
would send every email as many times as there are workers.

**Retry is bounded by age, not by a counter.** A transient failure leaves the
row ``PENDING`` so the next pass picks it up; once a row has been waiting longer
than ``GIVE_UP_AFTER`` it is marked ``FAILED`` and left alone. A permanent
failure — a refused mailbox, a rejected login — is marked ``FAILED`` at once,
because retrying it only delays the queue behind it.

**Reminders are idempotent by observation.** Before sending, the loop asks which
appointments already have a reminder notification, and skips those. There is no
"reminded" flag to fall out of step with reality: the notification itself is the
record that the reminder was sent.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import logger
from app.db.base import utcnow
from app.db.enums import (
    AppointmentStatus,
    InvoiceStatus,
    NotificationChannel,
    NotificationStatus,
    NotificationType,
    PaymentStatus,
)
from app.db.models import (
    Appointment,
    Doctor,
    Invoice,
    Notification,
    Patient,
    Payment,
    User,
)
from app.db.session import SessionFactory
from app.modules.appointments.schedule import to_clinic
from app.modules.notifications import templates
from app.services import email as email_service
from app.services import email_templates

#: How often the loop wakes. Email is not interactive; a message that goes out
#: within a minute is on time, and a tighter interval would spend connections
#: on an almost always empty queue.
INTERVAL_SECONDS = 60

#: Messages per pass. Bounded so one backlog cannot monopolise the loop and
#: starve reminders behind it.
BATCH_SIZE = 20

#: A message still undelivered after this is abandoned. An appointment reminder
#: that arrives a day late is worse than one that never arrives — it tells
#: someone about a slot they have already missed.
GIVE_UP_AFTER = timedelta(hours=6)

#: How far ahead a reminder is sent, and the width of the window scanned. The
#: window must exceed the interval, or an appointment could pass through the
#: gap between two passes and never be reminded about.
REMIND_BEFORE = timedelta(hours=24)
REMIND_WINDOW = timedelta(hours=2)


async def claim_pending(db: AsyncSession, limit: int = BATCH_SIZE) -> list[Notification]:
    """Take a batch of email rows, locked against other workers."""
    return list(
        (
            await db.execute(
                select(Notification)
                .where(
                    Notification.channel == NotificationChannel.EMAIL,
                    Notification.status == NotificationStatus.PENDING,
                )
                .order_by(Notification.priority.desc(), Notification.created_at)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        )
        .scalars()
        .all()
    )


async def deliver(db: AsyncSession, notification: Notification) -> bool:
    """Send one queued email and record what happened on its row."""
    address = (
        await db.execute(select(User.email).where(User.id == notification.user_id))
    ).scalar_one_or_none()

    if not address:
        notification.status = NotificationStatus.FAILED
        notification.failed_at = utcnow()
        notification.error = "no address on file"
        return False

    message = templates.render(
        notification.type,
        in_app_body=notification.body,
        link=notification.link,
        metadata=notification.notification_metadata,
    )
    result = await email_service.send(
        to=address,
        subject=message.subject,
        text_body=message.text,
        html_body=message.html,
    )

    if result.sent:
        notification.status = NotificationStatus.SENT
        notification.sent_at = utcnow()
        notification.error = None
        return True

    notification.error = result.detail
    notification.failed_at = utcnow()

    expired = utcnow() - notification.created_at > GIVE_UP_AFTER
    if result.retryable and not expired:
        # Left PENDING deliberately: the next pass will try again.
        return False

    notification.status = NotificationStatus.FAILED
    if expired and result.retryable:
        notification.error = f"{result.detail}; abandoned after {GIVE_UP_AFTER}"
    return False


async def send_pending() -> int:
    """One delivery pass. Returns how many messages went out."""
    ready, reason = email_service.is_configured()
    if not ready:
        logger.debug("email_dispatch_skipped", reason=reason)
        return 0

    sent = 0
    async with SessionFactory() as db:
        rows = await claim_pending(db)
        for row in rows:
            if await deliver(db, row):
                sent += 1
        await db.commit()

    if sent:
        logger.info("email_batch_sent", count=sent)
    return sent


async def due_for_reminder(db: AsyncSession) -> list[tuple[Appointment, str, str]]:
    """Appointments starting soon that nobody has been reminded about.

    Returns (appointment, patient user id, doctor name).
    """
    now = utcnow()
    window_start = now + REMIND_BEFORE - REMIND_WINDOW
    window_end = now + REMIND_BEFORE

    rows = (
        await db.execute(
            select(Appointment, Patient.user_id, User.name)
            .join(Patient, Patient.id == Appointment.patient_id)
            .join(Doctor, Doctor.id == Appointment.doctor_id)
            .join(User, User.id == Doctor.user_id)
            .where(
                Appointment.start_time >= window_start,
                Appointment.start_time < window_end,
                # Only a confirmed booking is worth reminding about: a request
                # nobody has accepted is not yet an appointment.
                Appointment.status == AppointmentStatus.CONFIRMED,
            )
            .limit(BATCH_SIZE)
        )
    ).all()
    if not rows:
        return []

    appointment_ids = [row[0].id for row in rows]
    already = set(
        (
            await db.execute(
                select(
                    Notification.notification_metadata["appointmentId"].astext
                ).where(
                    Notification.type == NotificationType.APPOINTMENT_REMINDER,
                    Notification.notification_metadata["appointmentId"].astext.in_(
                        appointment_ids
                    ),
                )
            )
        )
        .scalars()
        .all()
    )

    return [(row[0], row[1], row[2]) for row in rows if row[0].id not in already]


async def schedule_reminders() -> int:
    """One reminder pass. Returns how many reminders were created."""
    from app.modules.notifications.service import notify

    created = 0
    async with SessionFactory() as db:
        for appointment, user_id, doctor_name in await due_for_reminder(db):
            local = to_clinic(appointment.start_time)
            await notify(
                db,
                user_id=user_id,
                notification_type=NotificationType.APPOINTMENT_REMINDER,
                title="Appointment reminder",
                body=(
                    f"You have an appointment with {doctor_name} on "
                    f"{local.strftime('%d %b %Y at %H:%M')}."
                ),
                link="/patient/appointments",
                metadata={"appointmentId": appointment.id},
                priority=1,
            )
            created += 1
        await db.commit()

    if created:
        logger.info("appointment_reminders_created", count=created)
    return created


#: The two moments an unpaid invoice is worth mentioning, and the metadata key
#: that records having mentioned it. Both are held in one place because the
#: idempotence check and the sending loop have to agree on the spelling.
DUE_SOON = "due_soon"
OVERDUE = "overdue"


async def _already_reminded(db: AsyncSession, invoice_ids: list[str], kind: str) -> set[str]:
    """Which of these have had this particular reminder already.

    The notification row *is* the record. There is no "reminded" column to keep
    in step, and a pass that runs every minute must be able to ask "did I
    already say this" cheaply — asking the thing it wrote is the cheapest
    truthful answer available.

    Keyed on the pair, not on the invoice: an invoice that got the day-before
    nudge must still be able to get the overdue notice.
    """
    if not invoice_ids:
        return set()
    return set(
        (
            await db.execute(
                select(Notification.notification_metadata["invoiceId"].astext).where(
                    Notification.type == NotificationType.INVOICE_ISSUED,
                    Notification.notification_metadata["reminder"].astext == kind,
                    Notification.notification_metadata["invoiceId"].astext.in_(invoice_ids),
                )
            )
        )
        .scalars()
        .all()
    )


async def schedule_invoice_reminders() -> int:
    """Nudge before the due date, and report the charge once it has passed.

    Two passes over the same set. An invoice is eligible for the first while its
    due date is within the next day, and for the second once that date is behind
    it — so a bill created with less than a day to run can legitimately get both,
    in order, which is better than silently skipping the warning.

    Only ISSUED invoices, and only ones with nothing awaiting review: chasing
    somebody who has already transferred and is waiting on the hospital's own
    queue is the system blaming them for its own backlog.
    """
    from app.modules.billing import service as billing
    from app.modules.notifications.service import notify

    created = 0
    now = utcnow()

    async with SessionFactory() as db:
        rows = (
            await db.execute(
                select(Invoice, Patient.user_id, User.name, User.email)
                .join(Patient, Patient.id == Invoice.patient_id)
                .join(User, User.id == Patient.user_id)
                .where(
                    Invoice.status == InvoiceStatus.ISSUED,
                    Invoice.due_at.is_not(None),
                    # Nothing older than a week: an invoice nobody has paid in a
                    # month is a debt for a person to chase, not a mail loop.
                    Invoice.due_at > now - timedelta(days=7),
                    Invoice.due_at < now + timedelta(days=1),
                    ~select(Payment.id)
                    .where(
                        Payment.invoice_id == Invoice.id,
                        Payment.status == PaymentStatus.SUBMITTED,
                    )
                    .exists(),
                )
                .limit(BATCH_SIZE)
            )
        ).all()
        if not rows:
            return 0

        ids = [row[0].id for row in rows]
        sent_soon = await _already_reminded(db, ids, DUE_SOON)
        sent_late = await _already_reminded(db, ids, OVERDUE)

        for invoice, user_id, name, address in rows:
            overdue = billing.is_overdue(invoice)
            kind = OVERDUE if overdue else DUE_SOON
            if invoice.id in (sent_late if overdue else sent_soon):
                continue

            if overdue:
                message = email_templates.invoice_overdue(
                    name=name,
                    invoice_number=invoice.invoice_number,
                    currency=invoice.currency,
                    late_fee=str(billing.late_fee_applies(invoice)),
                    amount_due=str(billing.amount_due(invoice)),
                )
                body = (
                    f"Invoice {invoice.invoice_number} is overdue. "
                    f"{invoice.currency} {billing.amount_due(invoice)} is now due."
                )
            else:
                message = email_templates.invoice_due_tomorrow(
                    name=name,
                    invoice_number=invoice.invoice_number,
                    currency=invoice.currency,
                    amount=str(invoice.total_amount),
                    late_fee=str(invoice.late_fee),
                )
                body = (
                    f"Invoice {invoice.invoice_number} for {invoice.currency} "
                    f"{invoice.total_amount} is due tomorrow."
                )

            await notify(
                db,
                user_id=user_id,
                notification_type=NotificationType.INVOICE_ISSUED,
                title="Invoice overdue" if overdue else "Invoice due tomorrow",
                body=body,
                link="/patient/billing",
                # The metadata is the idempotence record. Written before the
                # mail goes out, so a crash between the two costs a reminder
                # rather than sending one every minute forever.
                metadata={"invoiceId": invoice.id, "reminder": kind},
                email=False,
            )
            await email_service.send(
                to=address,
                subject=message.subject,
                text_body=message.text,
                html_body=message.html,
            )
            created += 1

        await db.commit()

    if created:
        logger.info("invoice_reminders_sent", count=created)
    return created


async def run_once() -> dict[str, int]:
    """One full pass. Separate from the loop so a test can drive it directly."""
    reminders = await schedule_reminders()
    invoices = await schedule_invoice_reminders()
    sent = await send_pending()
    return {"reminders": reminders, "invoices": invoices, "sent": sent}


async def loop() -> None:
    """The background task. Runs until cancelled at shutdown.

    Every pass is wrapped: a failure here must not kill the loop, or one bad
    row would silently stop all delivery until the next restart.
    """
    logger.info("notification_dispatcher_started", interval_seconds=INTERVAL_SECONDS)
    try:
        while True:
            try:
                await run_once()
            except Exception:
                logger.exception("notification_dispatch_failed")
            await asyncio.sleep(INTERVAL_SECONDS)
    except asyncio.CancelledError:
        logger.info("notification_dispatcher_stopped")
        raise


def should_run() -> bool:
    """Whether to start the loop at all.

    Off in tests: a background task making SMTP connections during a test run
    would send real mail and make results depend on timing.
    """
    return settings.email_configured and not settings.is_test


def start() -> Any:
    """Start the dispatcher, returning the task so lifespan can cancel it."""
    return asyncio.create_task(loop())

"""What an email actually says (spec §31-32).

**An email says less than the in-app notification it accompanies, on purpose.**

This is the whole design of this module. An in-app notification is read inside
the session, behind authentication, by someone the access-control layer has
already checked — so it can say "Heart rate 150 bpm is above the configured
limit". An email is a different animal: it crosses to a mail provider, sits on
their servers, is indexed by their search, and lands on a lock screen that
anybody standing nearby can read. None of that is inside the boundary the rest
of this system maintains.

So the email says *that* something happened and where to go and see it. The
clinical content stays in the portal.

    in-app:  "Heart rate 150 bpm is above the configured limit of 120 bpm."
    email:   "A vital sign reading needs your attention. Sign in to review it."

Scheduling and billing details are treated differently, and deliberately:
an appointment time and an invoice number are what a reminder is *for*, they are
what every clinic and every biller already sends by email, and a reminder that
withholds the time is not a reminder. Diagnoses, medications, symptoms,
measurements and results are never in an email.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.core.config import settings
from app.db.enums import NotificationType

#: Types that are emailed as well as shown in the portal.
#:
#: Not every notification earns an email. A reminder someone must act on before
#: they next open the app does; an event they will see when they next sign in
#: does not. Emailing everything is how people learn to filter a sender out,
#: which costs the reminders that mattered.
EMAILED_TYPES: frozenset[NotificationType] = frozenset(
    {
        NotificationType.APPOINTMENT_BOOKED,
        NotificationType.APPOINTMENT_REMINDER,
        NotificationType.APPOINTMENT_CANCELLED,
        NotificationType.APPOINTMENT_RESCHEDULED,
        NotificationType.INVOICE_ISSUED,
        NotificationType.VITAL_ALERT,
        NotificationType.EMERGENCY_ACCESS,
        NotificationType.ACCOUNT_SECURITY,
    }
)


#: Types that also buzz a phone.
#:
#: Deliberately narrower than the emailed set. A push interrupts somebody
#: wherever they are, so it is reserved for the things that are useless if seen
#: later: a dose that is due now, a vital that has crossed a threshold, a
#: request to open somebody's record in an emergency, a sign-in they may not
#: have made. An invoice can wait for the inbox.
PUSHED_TYPES: frozenset[NotificationType] = frozenset(
    {
        NotificationType.MEDICATION_REMINDER,
        NotificationType.APPOINTMENT_REMINDER,
        NotificationType.APPOINTMENT_CANCELLED,
        NotificationType.VITAL_ALERT,
        NotificationType.EMERGENCY_ACCESS,
        NotificationType.ACCOUNT_SECURITY,
    }
)


@dataclass(frozen=True)
class Email:
    subject: str
    text: str
    html: str


def portal_url(link: str | None) -> str:
    """An absolute URL into the portal, for a mail client that has no context."""
    base = settings.CLIENT_ORIGIN.rstrip("/")
    if not link:
        return base
    return f"{base}/{link.lstrip('/')}"


#: Subject and lead sentence per type. Each is deliberately non-clinical: it
#: names the *kind* of thing that happened, never its content.
_COPY: dict[NotificationType, tuple[str, str]] = {
    NotificationType.APPOINTMENT_BOOKED: (
        "Your appointment is confirmed",
        "Your appointment has been confirmed.",
    ),
    NotificationType.APPOINTMENT_REMINDER: (
        "Reminder: your appointment is coming up",
        "This is a reminder about your upcoming appointment.",
    ),
    NotificationType.APPOINTMENT_CANCELLED: (
        "Your appointment has been cancelled",
        "An appointment has been cancelled.",
    ),
    NotificationType.APPOINTMENT_RESCHEDULED: (
        "Your appointment has moved",
        "An appointment has been rescheduled.",
    ),
    NotificationType.MEDICATION_REMINDER: (
        "A medication reminder is waiting",
        "You have a medication reminder in your portal.",
    ),
    NotificationType.INVOICE_ISSUED: (
        "A new invoice is available",
        "An invoice has been issued for a completed consultation.",
    ),
    NotificationType.REPORT_UPLOADED: (
        "A new document is available",
        "A document has been added to your record.",
    ),
    NotificationType.VITAL_ALERT: (
        "A vital sign reading needs attention",
        "A recorded reading has crossed its configured threshold.",
    ),
    NotificationType.EMERGENCY_ACCESS: (
        "Emergency access to your record",
        "Your record was accessed under emergency access.",
    ),
    NotificationType.ACCOUNT_SECURITY: (
        "A security event on your account",
        "There has been a security-related change to your account.",
    ),
}

#: Types whose in-app body is scheduling or billing information rather than
#: clinical content, and may therefore be carried into the email. Everything
#: absent from this set gets the generic lead sentence and nothing more.
_BODY_SAFE: frozenset[NotificationType] = frozenset(
    {
        NotificationType.APPOINTMENT_BOOKED,
        NotificationType.APPOINTMENT_REMINDER,
        NotificationType.APPOINTMENT_CANCELLED,
        NotificationType.APPOINTMENT_RESCHEDULED,
        NotificationType.INVOICE_ISSUED,
    }
)

_SIGNOFF = (
    "You are receiving this because you have a MediSense account. "
    "Do not reply to this message — this mailbox is not monitored."
)


def _escape(value: str) -> str:
    """Minimal HTML escaping.

    Notification text is composed by this application rather than by a user, so
    this guards against an apostrophe breaking the markup rather than against
    injection — but a name or a reason does reach these strings, and a template
    that trusts its input is a template that eventually does not.
    """
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def render(
    notification_type: NotificationType,
    *,
    in_app_body: str,
    link: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> Email:
    """Build the email for one notification.

    ``in_app_body`` is passed in but used only for the types listed in
    ``_BODY_SAFE``. For everything else it is deliberately discarded: the
    in-app body is written for a reader who is already authenticated, and
    forwarding it would undo the distinction this module exists to make.
    """
    subject, lead = _COPY.get(
        notification_type,
        ("An update from MediSense", "There is an update waiting in your portal."),
    )

    detail = in_app_body.strip() if notification_type in _BODY_SAFE else ""
    url = portal_url(link)

    text_parts = [lead]
    if detail:
        text_parts.append(detail)
    text_parts.append(f"Sign in to see the details: {url}")
    text_parts.append(_SIGNOFF)
    text = "\n\n".join(text_parts)

    detail_html = f"<p>{_escape(detail)}</p>" if detail else ""
    html = (
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;'
        'font-size:15px;line-height:1.5;color:#0f172a;max-width:34rem">'
        f"<p>{_escape(lead)}</p>"
        f"{detail_html}"
        f'<p><a href="{_escape(url)}" '
        'style="display:inline-block;background:#0f766e;color:#ffffff;'
        'padding:10px 18px;border-radius:6px;text-decoration:none">'
        "Open MediSense</a></p>"
        f'<p style="color:#475569;font-size:13px">{_escape(_SIGNOFF)}</p>'
        "</div>"
    )

    return Email(subject=subject, text=text, html=html)

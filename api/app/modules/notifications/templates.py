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

#: Types that are emailed as well as pushed and shown in the portal.
#:
#: The short list, on purpose. An email is worth sending when somebody may need
#: it without the app in front of them, or may need it months later: money, a
#: booked time, their record being opened, their account changing hands, and
#: the one message that says the account exists at all.
#:
#: Everything else — a report added, a dose due, a doctor's application moving
#: through a queue — is a push and a line in the portal. Mailing those too is
#: how a sender ends up in a filter, and the filter does not distinguish
#: between the notice about a scan and the notice about a break-glass access.
EMAILED_TYPES: frozenset[NotificationType] = frozenset(
    {
        NotificationType.ACCOUNT_REGISTERED,
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

#: Types no preference can switch off.
#:
#: Somebody who turns email off has said "stop telling me about appointments".
#: They have not said "do not tell me if my medical record is opened under
#: break-glass access, or if this account's password changed". Those two are
#: the notices a person needs precisely when they are not looking at the app,
#: and precisely when the person who would want them silenced is not them.
#:
#: The settings page says this plainly rather than accepting the switch and
#: ignoring it — a toggle that saves nowhere is the failure this file's
#: neighbour was written to avoid.
ALWAYS_SENT: frozenset[NotificationType] = frozenset(
    {
        NotificationType.EMERGENCY_ACCESS,
        NotificationType.ACCOUNT_SECURITY,
    }
)


#: Types that also reach a phone: all of them.
#:
#: The two channels answer different questions. A push is cheap to receive and
#: cheap to dismiss — it lands in a tray the person already scrolls, next to
#: everything else, and costs nothing if it is not interesting. An email lands
#: in an inbox somebody has to keep clean, and one sender that mails about
#: every small thing is a sender people filter out — which costs the messages
#: that mattered.
#:
#: So push is the default channel for events and email is the exception, and
#: `EMAILED_TYPES` below is the short list rather than this one. Anybody who
#: disagrees turns push off for their account; that switch is theirs, and it is
#: why widening this is safe.
PUSHED_TYPES: frozenset[NotificationType] = frozenset(NotificationType)


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

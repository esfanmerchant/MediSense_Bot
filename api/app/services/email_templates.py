"""Transactional emails: verification codes, and the doctor application trail.

Separate from ``modules/notifications/templates.py`` on purpose. That module
renders *notifications* — things that also exist in the portal, and which
deliberately say less by email than they do in the app. These are the messages
that have no in-app counterpart because the recipient cannot get into the app
yet: the code that proves an address, the second factor, and the four messages a
doctor's registration produces.

The same rule still holds and is the reason this module exists at all: **no
clinical content ever leaves in an email.** Nothing here has a patient, a
diagnosis or a measurement anywhere near it, and nothing here should ever grow
one.

**Inline CSS only.** Gmail strips ``<style>`` blocks, Outlook renders through
Word, and neither supports a stylesheet. Every rule is on the element it styles,
which is verbose and is the only thing that works. The gradient header degrades
to its first colour in clients that ignore ``linear-gradient`` — which is why
the strip also carries a solid ``background-color``.

Every message is built as HTML *and* plain text. The text part is what a screen
reader, a text-only client and a spam filter read, and an HTML-only message is
both less accessible and more likely to be junked.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.config import settings

BRAND = "MediSense"

#: The product gradient. Repeated as a literal in each place it is used because
#: an email cannot reference a variable, and kept here so there is one place to
#: change it.
GRADIENT = "linear-gradient(135deg,#0B3FA8,#1A8FC7 55%,#14C4C1)"
#: What a client that cannot render a gradient falls back to.
GRADIENT_FALLBACK = "#0B3FA8"

_INK = "#0f172a"
_MUTED = "#475569"
_CARD_BORDER = "#e2e8f0"
_PAGE = "#f1f5f9"
_FONT = "font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

_SIGNOFF = (
    "You are receiving this because someone used this address to sign up for "
    f"{BRAND}. Do not reply to this message — this mailbox is not monitored."
)


@dataclass(frozen=True)
class Email:
    subject: str
    text: str
    html: str


def portal_url(path: str | None = None) -> str:
    base = settings.CLIENT_ORIGIN.rstrip("/")
    if not path:
        return base
    return f"{base}/{path.lstrip('/')}"


def _escape(value: str) -> str:
    """Minimal escaping.

    A name, a rejection reason and a department all reach these strings from the
    database, and a template that trusts its input is a template that eventually
    does not.
    """
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _shell(heading: str, body_html: str) -> str:
    """White card on a tinted page, under the gradient strip.

    Tables are not used: every client this application targets handles a
    ``max-width`` block, and the nested-table layout that supports Outlook 2007
    is a lot of markup to maintain for a browser nobody in a clinic is running.
    """
    return (
        f'<div style="{_FONT};background:{_PAGE};padding:24px 12px;margin:0">'
        f'<div style="max-width:34rem;margin:0 auto;background:#ffffff;'
        f'border:1px solid {_CARD_BORDER};border-radius:14px;overflow:hidden">'
        f'<div style="background-color:{GRADIENT_FALLBACK};background:{GRADIENT};'
        'padding:22px 28px">'
        '<span style="color:#ffffff;font-size:19px;font-weight:700;'
        f'letter-spacing:.02em">{BRAND}</span>'
        "</div>"
        f'<div style="padding:28px">'
        f'<h1 style="margin:0 0 14px;font-size:19px;line-height:1.3;color:{_INK}">'
        f"{_escape(heading)}</h1>"
        f"{body_html}"
        "</div>"
        f'<div style="height:3px;background-color:{GRADIENT_FALLBACK};background:{GRADIENT}"></div>'
        f'<div style="padding:16px 28px;color:{_MUTED};font-size:12px;line-height:1.5">'
        f"{_escape(_SIGNOFF)}</div>"
        "</div></div>"
    )


def _paragraph(text: str) -> str:
    return f'<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:{_INK}">{_escape(text)}</p>'


def _note(text: str) -> str:
    return f'<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:{_MUTED}">{_escape(text)}</p>'


def _code_block(code: str) -> str:
    """The code itself, large, spaced and monospace.

    Letter spacing is not decoration: it is what stops someone reading a
    six-digit string off a phone from losing their place halfway through.
    """
    return (
        '<div style="margin:0 0 16px;padding:18px 12px;background:#f8fafc;'
        f'border:1px solid {_CARD_BORDER};border-radius:10px;text-align:center;'
        "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;"
        f'font-size:30px;font-weight:700;letter-spacing:.42em;color:{_INK}">'
        # The trailing space compensates for the letter-spacing that is applied
        # after the last digit and would otherwise push the string off centre.
        f"{_escape(code)}&nbsp;</div>"
    )


def _button(label: str, url: str) -> str:
    return (
        f'<p style="margin:0 0 14px"><a href="{_escape(url)}" '
        f'style="display:inline-block;background-color:{GRADIENT_FALLBACK};background:{GRADIENT};'
        'color:#ffffff;padding:11px 20px;border-radius:8px;text-decoration:none;'
        f'font-size:15px;font-weight:600">{_escape(label)}</a></p>'
    )


def _expiry_note(minutes: int) -> str:
    return f"This code expires in {minutes} minutes. If it was not you, ignore this message."


# ---------------------------------------------------------------------------
# Codes
# ---------------------------------------------------------------------------


def verify_email(*, name: str, code: str, expires_minutes: int = 10) -> Email:
    greeting = f"Hello {name.split()[0]}," if name.strip() else "Hello,"
    lead = f"Use this code to confirm your email address and finish setting up your {BRAND} account."
    expiry = _expiry_note(expires_minutes)

    return Email(
        subject=f"{code} is your {BRAND} verification code",
        text="\n\n".join([greeting, lead, code, expiry, _SIGNOFF]),
        html=_shell(
            "Confirm your email address",
            _paragraph(greeting) + _paragraph(lead) + _code_block(code) + _note(expiry),
        ),
    )


def two_factor_code(*, name: str, code: str, expires_minutes: int = 10) -> Email:
    greeting = f"Hello {name.split()[0]}," if name.strip() else "Hello,"
    lead = "Use this code to finish signing in."
    warning = (
        "If you did not just try to sign in, change your password — somebody else "
        "may know it."
    )
    expiry = _expiry_note(expires_minutes)

    return Email(
        subject=f"{code} is your {BRAND} sign-in code",
        text="\n\n".join([greeting, lead, code, expiry, warning, _SIGNOFF]),
        html=_shell(
            "Your sign-in code",
            _paragraph(greeting)
            + _paragraph(lead)
            + _code_block(code)
            + _note(expiry)
            + _note(warning),
        ),
    )


# ---------------------------------------------------------------------------
# Doctor registration
# ---------------------------------------------------------------------------


def doctor_application_received(*, name: str) -> Email:
    greeting = f"Hello Dr {name.split()[-1]}," if name.strip() else "Hello,"
    lead = (
        "Your registration has been submitted and is now with our administrators "
        "for review."
    )
    detail = (
        "We will email you as soon as a decision is made. You do not need to do "
        "anything else in the meantime."
    )

    return Email(
        subject=f"We have your {BRAND} registration",
        text="\n\n".join([greeting, lead, detail, _SIGNOFF]),
        html=_shell(
            "Registration received",
            _paragraph(greeting) + _paragraph(lead) + _note(detail),
        ),
    )


def doctor_approved(*, name: str) -> Email:
    greeting = f"Hello Dr {name.split()[-1]}," if name.strip() else "Hello,"
    lead = "Your registration has been approved. You can now sign in and start work."
    url = portal_url("/doctor")

    return Email(
        subject=f"Your {BRAND} registration is approved",
        text="\n\n".join([greeting, lead, f"Sign in: {url}", _SIGNOFF]),
        html=_shell(
            "You are approved",
            _paragraph(greeting) + _paragraph(lead) + _button(f"Sign in to {BRAND}", url),
        ),
    )


def doctor_rejected(*, name: str, reason: str) -> Email:
    greeting = f"Hello Dr {name.split()[-1]}," if name.strip() else "Hello,"
    lead = "Your registration has not been approved as submitted."
    detail = "You can correct your application and send it again."
    url = portal_url("/doctor/onboarding")

    return Email(
        subject=f"About your {BRAND} registration",
        text="\n\n".join([greeting, lead, f"Reason: {reason}", detail, f"Continue: {url}", _SIGNOFF]),
        html=_shell(
            "Your registration needs changes",
            _paragraph(greeting)
            + _paragraph(lead)
            # The reason is quoted rather than run into the paragraph so the
            # applicant can see exactly what the reviewer wrote.
            + '<blockquote style="margin:0 0 14px;padding:12px 16px;background:#f8fafc;'
            f'border-left:3px solid {GRADIENT_FALLBACK};border-radius:6px;font-size:15px;'
            f'line-height:1.6;color:{_INK}">{_escape(reason)}</blockquote>'
            + _paragraph(detail)
            + _button("Update your application", url),
        ),
    )


def admin_new_doctor_request(*, applicant_name: str, specialization: str | None) -> Email:
    """Sent to administrators. Names the applicant and nothing else about them.

    Deliberately thin: it is a prompt to open the queue, not a way to review a
    credential from an inbox. Everything a decision needs is behind
    authentication, where it can be audited.
    """
    field = specialization or "not stated"
    lead = f"{applicant_name} has applied to register as a doctor."
    detail = f"Specialization: {field}"
    url = portal_url("/admin/doctor-applications")

    return Email(
        subject=f"New doctor registration: {applicant_name}",
        text="\n\n".join([lead, detail, f"Review it here: {url}", _SIGNOFF]),
        html=_shell(
            "A doctor registration is waiting",
            _paragraph(lead) + _note(detail) + _button("Review the application", url),
        ),
    )

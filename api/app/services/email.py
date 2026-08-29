"""SMTP transport (spec §32).

Delivery only. What to say lives in ``notifications/templates.py``; who to say
it to lives in the notification rows. This module's whole job is to get one
message onto a mail server, and to be honest about whether it did.

**Nothing here logs a credential.** The password never appears in a log line, an
exception message, or an error returned upward. SMTP servers quote the command
they rejected back at you, so a naive ``str(exc)`` on an authentication failure
can echo the login exchange — every error is therefore summarised by *type*,
never by the server's own text.

**Blocking work runs off the event loop.** ``smtplib`` is synchronous, and a
25-second SMTP timeout inside an async handler would stall every other request
on that worker. ``asyncio.to_thread`` keeps the loop free.

No third-party mailer is used. The standard library covers SMTP over STARTTLS
with an App Password, which is exactly the deployment the spec describes, and a
dependency that exists only to wrap ``smtplib`` is a dependency that has to be
kept current for no benefit.
"""

from __future__ import annotations

import asyncio
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

from app.core.config import settings
from app.core.logging import logger

#: Long enough for a slow handshake, short enough that a dead server does not
#: hold a dispatcher slot for a minute.
TIMEOUT_SECONDS = 20


@dataclass(frozen=True)
class Delivery:
    """The outcome of one send attempt.

    ``retryable`` is the part that matters to the caller: a refused mailbox will
    be refused again forever, while a connection reset probably will not be.
    Retrying the first wastes work and delays the queue behind it; giving up on
    the second loses a message that would have gone through.
    """

    sent: bool
    #: A short, credential-free summary. Safe to store on the notification row.
    detail: str = ""
    retryable: bool = False


def is_configured() -> tuple[bool, str]:
    if not settings.EMAIL_ENABLED:
        return False, "email delivery is disabled on this server (EMAIL_ENABLED=false)"
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        return False, "no SMTP credentials are configured"
    return True, ""


def _build(to: str, subject: str, text_body: str, html_body: str | None) -> EmailMessage:
    """Assemble a message with a plain-text part and an optional HTML one.

    Plain text is set first and is never omitted. It is what a screen reader, a
    text-only client and a spam filter all read, and an HTML-only message is
    both less accessible and more likely to be junked.
    """
    message = EmailMessage()
    name, address = parseaddr(settings.SMTP_FROM)
    message["From"] = formataddr((name, address or settings.SMTP_USER))
    message["To"] = to
    message["Subject"] = subject
    # Tells bulk senders and auto-responders not to reply or auto-reply to this
    # address, which stops a vacation responder looping against the mailbox.
    message["Auto-Submitted"] = "auto-generated"
    message.set_content(text_body)
    if html_body:
        message.add_alternative(html_body, subtype="html")
    return message


def _send_blocking(message: EmailMessage) -> Delivery:
    """One synchronous send. Runs in a worker thread."""
    context = ssl.create_default_context()
    try:
        if settings.SMTP_SECURE:
            server: smtplib.SMTP = smtplib.SMTP_SSL(
                settings.SMTP_HOST, settings.SMTP_PORT, timeout=TIMEOUT_SECONDS, context=context
            )
        else:
            server = smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=TIMEOUT_SECONDS)
        with server:
            if not settings.SMTP_SECURE:
                server.starttls(context=context)
            server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            server.send_message(message)
        return Delivery(sent=True)

    except smtplib.SMTPAuthenticationError:
        # Deliberately not including the server's reply: it quotes the login
        # exchange back, which is the most likely way a password reaches a log.
        return Delivery(False, "authentication rejected", retryable=False)
    except smtplib.SMTPRecipientsRefused:
        return Delivery(False, "recipient refused", retryable=False)
    except smtplib.SMTPSenderRefused:
        return Delivery(False, "sender refused", retryable=False)
    except smtplib.SMTPResponseException as exc:
        # Must precede the OSError clause below: `smtplib.SMTPException` is a
        # subclass of OSError, so catching OSError first would classify every
        # response — including a permanent 5xx refusal — as retryable, and a
        # refused message would clog the queue for hours instead of failing.
        #
        # 4xx is "try later" by RFC; 5xx is a refusal that will not change.
        return Delivery(
            False,
            f"server returned {exc.smtp_code}",
            retryable=400 <= exc.smtp_code < 500,
        )
    except (smtplib.SMTPConnectError, smtplib.SMTPServerDisconnected, TimeoutError, OSError) as exc:
        # Transient by nature — the server was unreachable, not unwilling.
        return Delivery(False, f"connection failed ({type(exc).__name__})", retryable=True)
    except Exception as exc:  # pragma: no cover — defensive
        return Delivery(False, f"unexpected error ({type(exc).__name__})", retryable=True)


async def send(
    *, to: str, subject: str, text_body: str, html_body: str | None = None
) -> Delivery:
    """Deliver one message, or explain why not.

    Never raises. A caller sending a notification must not have its own
    operation fail because a mail server was busy.
    """
    ready, reason = is_configured()
    if not ready:
        return Delivery(False, reason, retryable=False)

    message = _build(to, subject, text_body, html_body)
    delivery = await asyncio.to_thread(_send_blocking, message)

    if delivery.sent:
        # The recipient is logged; the subject and body are not. A subject line
        # can carry clinical context, and logs are not inside the access-control
        # boundary the rest of the system maintains.
        logger.info("email_sent", to=to)
    else:
        logger.warning("email_failed", to=to, detail=delivery.detail, retryable=delivery.retryable)

    return delivery

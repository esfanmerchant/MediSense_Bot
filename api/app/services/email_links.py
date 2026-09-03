"""Links an email can carry that work without a session.

An email is read outside the application, often on a phone that is not signed
in. A link in one that leads to a sign-in form has not done its job — and in
the case of unsubscribing, a sign-in wall makes the `List-Unsubscribe` header a
false promise, which is exactly what the filters checking for that header are
guarding against.

**The token is the authorisation, and it grants one thing.** It is the user id
sealed with a key derived from the server's own secret, so it cannot be forged
and it cannot be read. What it permits is turning that account's email off —
nothing else. It cannot sign anybody in, it names no other account, and the act
it allows is reversible in one press from the settings page. Somebody who
intercepts one can stop somebody's emails; they cannot read a record.

**There is no expiry.** An unsubscribe link in a two-year-old email should
still work: the alternative is somebody pressing it, nothing happening, and
marking the message as spam instead — which is the outcome the whole mechanism
exists to avoid.
"""

from __future__ import annotations

from urllib.parse import quote

from app.core.config import settings
from app.core.logging import logger
from app.core.security import SealError, seal_secret, unseal_secret

#: Separate from every other sealed value, so a token minted here cannot be
#: presented anywhere else and a token from elsewhere cannot be presented here.
PURPOSE = "unsubscribe"


def unsubscribe_token(email: str) -> str:
    """A token for one address.

    The *address* rather than the user id, deliberately: `send` knows who it is
    writing to and nothing else, and threading an id through every one of the
    dozen places that send mail would mean each of them growing a lookup it
    does not otherwise need — and one of them forgetting.
    """
    return seal_secret(email.strip().lower(), purpose=PURPOSE)


def read_unsubscribe_token(token: str) -> str | None:
    """The address inside, or ``None`` for anything that does not open.

    Never raises. A malformed token arrives from the open internet — a
    truncated link, a mail client that rewrote a URL, somebody guessing — and
    an exception on that path would turn a bad link into a 500.
    """
    try:
        return unseal_secret(token, purpose=PURPOSE) or None
    except (SealError, ValueError):
        return None
    except Exception:
        logger.debug("unsubscribe_token_unreadable")
        return None


def unsubscribe_url(email: str) -> str:
    """Where the footer link and the one-click header both point.

    Percent-encoded, because the sealed token contains `+`, `/` and `$`. A `+`
    in a query string is a space by the time it is read, so an unencoded token
    arrives corrupted — the link would look right, do nothing, and send
    somebody to the spam button instead. Tested, not assumed.
    """
    token = quote(unsubscribe_token(email), safe="")
    return f"{settings.CLIENT_ORIGIN.rstrip('/')}/unsubscribe?token={token}"


def settings_url() -> str:
    """Where somebody goes to choose channels rather than switch one off.

    Offered beside the unsubscribe, because "stop emailing me about
    appointments" and "stop emailing me" are different wishes and only one of
    them is what the header can do.
    """
    return f"{settings.CLIENT_ORIGIN.rstrip('/')}/patient/settings"

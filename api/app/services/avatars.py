"""Profile pictures: what one may be, where it goes, and how it is linked to.

A picture of a face and a scan of a discharge summary are both "an upload", and
this module exists because that is where the resemblance ends. Documents take
seven types up to twenty megabytes because a lab report is a photographed page
of small print that has to stay legible. An avatar is drawn at fifty-six CSS
pixels. Reusing the document policy for it would mean the application accepts a
twenty-megabyte TIFF, stores it forever, signs a URL for it on every single
session response — and then paints it into a circle the size of a thumbnail.

So the bytes go through :func:`app.services.files.inspect_upload` exactly as a
document's do — size floor, magic-number identification, declared type made to
agree — and then through a second, tighter gate here.

Nothing in this module talks to the database. The two decisions worth testing —
"is this file allowed" and "where does it go" — are pure functions, and the one
call that touches the network is the signed-link helper, which is deliberately
the only thing here that can fail.
"""

from __future__ import annotations

from app.core.config import settings
from app.core.logging import logger
from app.services import storage
from app.services.files import FileRejectedError, InspectedFile, inspect_upload

#: The three types a browser will actually paint in an ``<img>``.
#:
#: TIFF and HEIC are absent although documents accept both, and their absence is
#: the point: a scanner emits TIFF and an iPhone emits HEIC, so a document
#: upload must take them, but no browser renders either. Accepting one here
#: would store a picture that is never shown — the person would upload their
#: face, get a success message, and keep seeing their initials. PDF is absent
#: for the reason it is obvious.
AVATAR_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})

#: Five megabytes: a quarter of the document limit, and chosen from both ends.
#:
#: *Why lower than a document.* Twenty megabytes buys a lab report several
#: legible pages at scanning resolution. It buys an avatar nothing at all — the
#: largest this is ever drawn is the 56-pixel ``lg`` circle, about 168 device
#: pixels on a dense phone screen, so anything past a few hundred kilobytes is
#: detail that is downscaled away before a human sees it. The cap also bounds
#: what one account can park in a bucket and what every session response has to
#: sign, and unlike a document there is no clinical reason to keep the original.
#:
#: *Why not lower still.* Nearly every profile picture in this product will come
#: straight off a phone's camera roll, unedited, and a modern 12-megapixel JPEG
#: is commonly three to five megabytes. A one- or two-megabyte cap would refuse
#: the ordinary case and leave people cropping photos in another app to get past
#: a healthcare portal, which is a worse failure than storing four megabytes
#: once per account.
MAX_AVATAR_BYTES = 5 * 1024 * 1024

#: Named in the refusal so the message says what to do, not merely that
#: something is wrong.
MAX_AVATAR_MB = MAX_AVATAR_BYTES // (1024 * 1024)


def object_path(user_id: str, avatar_id: str, extension: str) -> str:
    """Where one person's picture lives inside the private avatars bucket.

    Both halves are generated here — the user's own id, and an id minted for
    this upload — so a crafted filename cannot escape the prefix or land on
    another account's object, and the extension comes from what the bytes were
    detected to be rather than from what the file was called.

    The per-upload id is what makes replacement safe: a new picture is written
    to a new key and the old object is deleted afterwards, so a replacement that
    fails halfway leaves the previous picture intact rather than a half-written
    one under the name the column still points at.
    """
    return f"{user_id}/{avatar_id}{extension}"


def inspect_avatar(
    content: bytes,
    declared_mime: str | None,
    original_name: str | None,
) -> InspectedFile:
    """Validate an avatar upload, or raise ``FileRejectedError``.

    The size cap is applied by ``inspect_upload`` itself, so an oversized file is
    refused before its bytes are sniffed or hashed. The type narrowing happens
    afterwards, against the *detected* type — a HEIC renamed ``.png`` is refused
    here for being HEIC, not for being misnamed.

    Note that the ``avatars`` bucket is created at boot with the same permissive
    MIME list and size limit as every other bucket, so this function, not the
    bucket, is where avatar policy actually lives.
    """
    inspected = inspect_upload(
        content,
        declared_mime=declared_mime,
        original_name=original_name,
        max_bytes=MAX_AVATAR_BYTES,
    )

    if inspected.detected_mime not in AVATAR_MIME_TYPES:
        raise FileRejectedError(
            "A profile picture must be a JPEG, PNG or WebP image."
        )

    return inspected


async def signed_url_for(path: str | None) -> str | None:
    """A short-lived link to one stored picture, or ``None``.

    ``None`` for three different reasons, all of which the interface answers the
    same way — by drawing the person's initials, which is what it drew before
    any of this existed:

    * there is no picture,
    * storage is not configured on this server,
    * storage is unreachable right now.

    That tolerance is the reason this helper exists rather than callers reaching
    for ``storage.signed_url`` directly. This runs on **every** session response
    — login, email verification, the second factor, ``/auth/me`` — and a storage
    hiccup must not turn signing in into a failure. Refusing to authenticate a
    doctor because a picture could not be linked would be an outage caused
    entirely by decoration.

    The link is minted per response and expires in minutes, so nothing here ever
    hands out an address that outlives the session that asked for it.
    """
    if not path:
        return None
    try:
        return await storage.signed_url(settings.SUPABASE_AVATARS_BUCKET, path)
    except Exception as exc:
        # Type only. A storage error body can echo request context, and this one
        # is logged on a path that runs for every signed-in request.
        logger.warning("avatar_sign_failed", error=type(exc).__name__)
        return None

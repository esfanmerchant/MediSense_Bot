"""Upload validation (spec §27).

The rule that matters here: **the file's own bytes decide what it is.** A
browser's ``Content-Type`` and the extension in a filename are both supplied by
the caller, so neither is evidence. Every accepted upload is identified by its
magic number, and the declared type must agree with what the bytes say — a
``.pdf`` whose first bytes are ``MZ`` is rejected regardless of how it was
labelled.

Filenames get the same treatment. The stored path is built from ids we generate,
never from what the caller typed, so a name like ``../../etc/passwd`` cannot
escape its prefix. The original name is kept as *metadata* for display, with
separators and control characters stripped.

**Malware scanning is not implemented.** The spec asks for it "if available" and
no scanner is available here, so the honest position is to say so rather than
imply protection that does not exist: uploads are validated for type, size and
structure, and are not scanned for malicious content. ``scan_hook`` marks where
a scanner would go.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

#: One (offset, signature) fragment that must appear at a fixed position.
Fragment = tuple[int, bytes]
#: A pattern is a set of fragments that must **all** match — WebP is only a WebP
#: if it says ``RIFF`` at 0 *and* ``WEBP`` at 8.
Pattern = tuple[Fragment, ...]

#: Types a medical document may be, mapped to the magic numbers that prove it.
#: Kept in step with the buckets' own ``allowed_mime_types`` — a type accepted
#: here and refused by storage would fail after the patient waited for the
#: upload.
#:
#: Each type lists **alternative** patterns, any one of which identifies it.
#: The distinction matters: TIFF has two byte orders and HEIC has several
#: brands, and those are alternatives, whereas WebP's two markers are a
#: conjunction. Collapsing the two ideas makes every multi-signature type
#: undetectable.
MAGIC_NUMBERS: dict[str, tuple[Pattern, ...]] = {
    "application/pdf": (((0, b"%PDF-"),),),
    "image/png": (((0, b"\x89PNG\r\n\x1a\n"),),),
    "image/jpeg": (((0, b"\xff\xd8\xff"),),),
    # RIFF alone is also AVI and WAV, so the WEBP marker is required with it.
    "image/webp": (((0, b"RIFF"), (8, b"WEBP")),),
    # Little-endian ("Intel") or big-endian ("Motorola") byte order.
    "image/tiff": (((0, b"II*\x00"),), ((0, b"MM\x00*"),)),
    # The brand sits at offset 4, inside the ISO base-media box header.
    "image/heic": (
        ((4, b"ftypheic"),),
        ((4, b"ftypheix"),),
        ((4, b"ftypmif1"),),
        ((4, b"ftypmsf1"),),
    ),
}

#: Extensions offered to the file picker. Advisory only — the bytes decide.
EXTENSIONS: dict[str, tuple[str, ...]] = {
    "application/pdf": (".pdf",),
    "image/png": (".png",),
    "image/jpeg": (".jpg", ".jpeg"),
    "image/webp": (".webp",),
    "image/tiff": (".tif", ".tiff"),
    "image/heic": (".heic", ".heif"),
}

ALLOWED_MIME_TYPES = frozenset(MAGIC_NUMBERS)

#: Anything below this cannot be a real document; it is a truncated upload or an
#: empty file the browser sent because the user picked nothing.
MIN_UPLOAD_BYTES = 64

_UNSAFE_NAME = re.compile(r"[\\/:*?\"<>|\x00-\x1f\x7f]")


class FileRejectedError(Exception):
    """Raised with a message safe to show the person who uploaded the file."""


@dataclass(frozen=True)
class InspectedFile:
    detected_mime: str
    size: int
    checksum_sha256: str
    safe_name: str
    extension: str


def sanitize_filename(name: str, fallback: str = "document") -> str:
    """Make a caller-supplied name safe to store as metadata and show back.

    Path separators, control characters and Windows-reserved punctuation are
    removed rather than escaped: this value is only ever displayed, so there is
    nothing to gain by preserving them and a great deal to lose if it is ever
    interpolated somewhere that treats them as structure.
    """
    cleaned = _UNSAFE_NAME.sub("", name or "").strip().strip(".")
    # Leading dots would produce a hidden file and an empty stem.
    cleaned = cleaned.lstrip(".")
    if not cleaned:
        return fallback
    return cleaned[:120]


def extension_for(mime: str) -> str:
    """The canonical extension for a detected type.

    Derived from what the bytes are, never from the name the caller sent, so the
    stored object's extension cannot disagree with its content.
    """
    options = EXTENSIONS.get(mime, ())
    return options[0] if options else ".bin"


def _matches(content: bytes, pattern: Pattern) -> bool:
    return all(content[offset : offset + len(sig)] == sig for offset, sig in pattern)


def detect_mime(content: bytes) -> str | None:
    """Identify a file by its magic number, or None if it is not a type we take.

    Any one of a type's patterns is enough; every fragment within that pattern
    must match.
    """
    for mime, patterns in MAGIC_NUMBERS.items():
        if any(_matches(content, pattern) for pattern in patterns):
            return mime
    return None


def scan_hook(content: bytes) -> None:
    """Where malware scanning would run.

    Deliberately a no-op with a name that does not claim otherwise. If a scanner
    is introduced, this is the single place it attaches, and the call already
    sits on the upload path.
    """
    return None


def inspect_upload(
    content: bytes,
    declared_mime: str | None,
    original_name: str | None,
    max_bytes: int,
) -> InspectedFile:
    """Validate an upload and describe it, or raise ``FileRejectedError``.

    Order matters. Size is checked first because it is the cheapest rejection;
    content sniffing comes before any comparison against what the caller
    claimed, so the decision is never anchored to their claim.
    """
    size = len(content)
    if size == 0:
        raise FileRejectedError("The file is empty.")
    if size < MIN_UPLOAD_BYTES:
        raise FileRejectedError("That file is too small to be a document. It may not have uploaded fully.")
    if size > max_bytes:
        megabytes = max_bytes / (1024 * 1024)
        raise FileRejectedError(f"Files must be {megabytes:.0f} MB or smaller.")

    detected = detect_mime(content)
    if detected is None:
        readable = "PDF, JPEG, PNG, WebP, TIFF or HEIC"
        raise FileRejectedError(f"That file type is not supported. Upload a {readable} file.")

    # The declared type is only ever used to *disagree*. A mismatch means the
    # file is not what it says it is, which is worth refusing even when the
    # detected type would have been acceptable on its own.
    if declared_mime:
        declared = declared_mime.split(";")[0].strip().lower()
        if declared in ALLOWED_MIME_TYPES and declared != detected:
            raise FileRejectedError(
                "The file's contents do not match its type. Re-export it and try again."
            )

    scan_hook(content)

    return InspectedFile(
        detected_mime=detected,
        size=size,
        checksum_sha256=hashlib.sha256(content).hexdigest(),
        safe_name=sanitize_filename(original_name or ""),
        extension=extension_for(detected),
    )

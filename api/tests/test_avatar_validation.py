"""What may become a profile picture, and where it is put.

No database, no network. Everything here is a pure function, which is the point
of having extracted them: the two decisions that make an avatar upload safe —
"is this file allowed" and "where does it go" — are exactly the two that can be
tested exhaustively for nothing.

The neighbouring ``test_file_validation`` suite proves the general document
rules. What is proved here is only where avatars are *stricter*: three types
instead of seven, five megabytes instead of twenty.
"""

from __future__ import annotations

import pytest

from app.services.avatars import (
    AVATAR_MIME_TYPES,
    MAX_AVATAR_BYTES,
    inspect_avatar,
    object_path,
)
from app.services.files import ALLOWED_MIME_TYPES, FileRejectedError

PADDING = b"\x00" * 256

PNG = b"\x89PNG\r\n\x1a\n" + PADDING
JPEG = b"\xff\xd8\xff\xe0" + PADDING
WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + PADDING
PDF = b"%PDF-1.7" + PADDING
TIFF = b"II*\x00" + PADDING
HEIC = b"\x00\x00\x00\x18" + b"ftypheic" + PADDING


class TestAcceptedTypes:
    @pytest.mark.parametrize(
        ("content", "expected"),
        [(PNG, "image/png"), (JPEG, "image/jpeg"), (WEBP, "image/webp")],
    )
    def test_the_three_web_renderable_types_are_taken(
        self, content: bytes, expected: str
    ) -> None:
        assert inspect_avatar(content, expected, "me.png").detected_mime == expected

    def test_a_pdf_is_refused_even_though_documents_take_one(self) -> None:
        with pytest.raises(FileRejectedError) as refusal:
            inspect_avatar(PDF, "application/pdf", "cv.pdf")
        assert "JPEG, PNG or WebP" in str(refusal.value)

    @pytest.mark.parametrize(("content", "name"), [(TIFF, "scan.tif"), (HEIC, "IMG_0001.heic")])
    def test_types_no_browser_paints_are_refused(self, content: bytes, name: str) -> None:
        """A scanner's TIFF and an iPhone's HEIC are valid documents and useless here.

        Storing one would mean the person uploads their face, is told it worked,
        and goes on seeing their initials.
        """
        with pytest.raises(FileRejectedError):
            inspect_avatar(content, None, name)

    def test_the_avatar_set_is_a_strict_subset_of_the_document_set(self) -> None:
        """Nothing is accepted here that storage or the sniffer would then refuse."""
        assert AVATAR_MIME_TYPES < ALLOWED_MIME_TYPES

    def test_an_executable_named_as_a_picture_is_refused(self) -> None:
        with pytest.raises(FileRejectedError):
            inspect_avatar(b"MZ\x90\x00" + PADDING, "image/png", "me.png")

    def test_a_png_announced_as_a_jpeg_is_refused(self) -> None:
        """The bytes decide, and a disagreement is itself a reason to refuse."""
        with pytest.raises(FileRejectedError) as refusal:
            inspect_avatar(PNG, "image/jpeg", "me.jpg")
        assert "do not match" in str(refusal.value)


class TestSize:
    def test_a_picture_at_the_cap_is_taken(self) -> None:
        content = PNG + b"\x00" * (MAX_AVATAR_BYTES - len(PNG))
        assert len(content) == MAX_AVATAR_BYTES
        assert inspect_avatar(content, "image/png", "me.png").size == MAX_AVATAR_BYTES

    def test_one_byte_past_the_cap_is_refused_with_the_limit_named(self) -> None:
        content = PNG + b"\x00" * (MAX_AVATAR_BYTES - len(PNG) + 1)
        with pytest.raises(FileRejectedError) as refusal:
            inspect_avatar(content, "image/png", "me.png")
        # The message has to say what the limit is, or the person's only way to
        # find out is to keep guessing with smaller files.
        assert "5 MB" in str(refusal.value)

    def test_the_avatar_cap_is_far_below_the_document_cap(self) -> None:
        """A face is not a scan. The two limits must not drift back together."""
        from app.core.config import settings

        assert MAX_AVATAR_BYTES <= settings.MAX_UPLOAD_BYTES // 4

    def test_an_empty_file_is_refused(self) -> None:
        with pytest.raises(FileRejectedError):
            inspect_avatar(b"", "image/png", "me.png")


class TestObjectPath:
    def test_it_is_scoped_to_the_user_and_named_by_a_generated_id(self) -> None:
        assert object_path("usr_1", "av_9", ".png") == "usr_1/av_9.png"

    def test_the_filename_never_reaches_the_path(self) -> None:
        """A crafted name cannot escape the prefix, because it is never used.

        The extension comes from what the bytes were detected to be, and both
        ids are generated, so there is nothing in the key a caller supplied.
        """
        inspected = inspect_avatar(PNG, "image/png", "../../../../etc/passwd.png")
        path = object_path("usr_1", "av_9", inspected.extension)
        assert path == "usr_1/av_9.png"
        assert ".." not in path
        assert ".." not in inspected.safe_name

    def test_a_replacement_lands_on_a_new_key(self) -> None:
        """Which is what lets the old object be deleted only once the row moved."""
        assert object_path("usr_1", "av_1", ".png") != object_path("usr_1", "av_2", ".png")

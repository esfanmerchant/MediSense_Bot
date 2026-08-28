"""Upload validation (spec §27).

No database, no network. These are the checks that decide whether a byte string
is allowed to become a medical document, so they are worth testing exhaustively
and cheaply.
"""

from __future__ import annotations

import hashlib

import pytest

from app.services.files import (
    ALLOWED_MIME_TYPES,
    MAGIC_NUMBERS,
    MIN_UPLOAD_BYTES,
    FileRejectedError,
    detect_mime,
    extension_for,
    inspect_upload,
    sanitize_filename,
)
from app.services.storage import object_path

PADDING = b"\x00" * 256

PDF = b"%PDF-1.7" + PADDING
PNG = b"\x89PNG\r\n\x1a\n" + PADDING
JPEG = b"\xff\xd8\xff\xe0" + PADDING
WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + PADDING
TIFF_LE = b"II*\x00" + PADDING
TIFF_BE = b"MM\x00*" + PADDING
HEIC = b"\x00\x00\x00\x18" + b"ftypheic" + PADDING

MAX = 1024 * 1024


class TestDetection:
    @pytest.mark.parametrize(
        ("content", "expected"),
        [
            (PDF, "application/pdf"),
            (PNG, "image/png"),
            (JPEG, "image/jpeg"),
            (WEBP, "image/webp"),
            (TIFF_LE, "image/tiff"),
            (TIFF_BE, "image/tiff"),
            (HEIC, "image/heic"),
        ],
    )
    def test_it_identifies_each_supported_type(self, content: bytes, expected: str) -> None:
        assert detect_mime(content) == expected

    @pytest.mark.parametrize(
        "content",
        [
            b"MZ\x90\x00" + PADDING,  # a Windows executable
            b"\x7fELF" + PADDING,  # a Linux binary
            b"PK\x03\x04" + PADDING,  # a zip / office document
            b"#!/bin/sh\n" + PADDING,  # a shell script
            b"<html><body>hi</body></html>" + PADDING,
            b"\x00" * 300,
        ],
    )
    def test_it_refuses_everything_else(self, content: bytes) -> None:
        assert detect_mime(content) is None

    def test_webp_needs_both_of_its_markers(self) -> None:
        # RIFF alone is also AVI and WAV; only RIFF....WEBP is a WebP image.
        assert detect_mime(b"RIFF" + b"\x00\x00\x00\x00" + b"AVI " + PADDING) is None

    def test_every_declared_type_has_an_extension(self) -> None:
        for mime in MAGIC_NUMBERS:
            assert extension_for(mime).startswith(".")

    def test_the_allowed_set_is_derived_from_the_signatures(self) -> None:
        # Guards against a type being listed as allowed with no way to prove it.
        assert frozenset(MAGIC_NUMBERS) == ALLOWED_MIME_TYPES


class TestInspection:
    def test_it_accepts_a_real_pdf(self) -> None:
        inspected = inspect_upload(PDF, "application/pdf", "report.pdf", MAX)

        assert inspected.detected_mime == "application/pdf"
        assert inspected.size == len(PDF)
        assert inspected.checksum_sha256 == hashlib.sha256(PDF).hexdigest()
        assert inspected.extension == ".pdf"

    def test_a_file_lying_about_its_type_is_refused(self) -> None:
        """The bytes decide. A PNG announced as a PDF is not a PDF."""
        with pytest.raises(FileRejectedError, match="do not match"):
            inspect_upload(PNG, "application/pdf", "invoice.pdf", MAX)

    def test_an_executable_renamed_as_a_pdf_is_refused(self) -> None:
        with pytest.raises(FileRejectedError, match="not supported"):
            inspect_upload(b"MZ\x90\x00" + PADDING, "application/pdf", "scan.pdf", MAX)

    def test_a_misleading_declared_type_outside_the_allow_list_is_ignored(self) -> None:
        # A browser sending application/octet-stream for a real PDF is common
        # and harmless — the content is what was checked.
        inspected = inspect_upload(PDF, "application/octet-stream", "report.pdf", MAX)
        assert inspected.detected_mime == "application/pdf"

    def test_an_empty_file_is_refused(self) -> None:
        with pytest.raises(FileRejectedError, match="empty"):
            inspect_upload(b"", "application/pdf", "empty.pdf", MAX)

    def test_a_truncated_file_is_refused(self) -> None:
        with pytest.raises(FileRejectedError, match="too small"):
            inspect_upload(b"%PDF-", "application/pdf", "cut.pdf", MAX)

    def test_an_oversized_file_is_refused_with_the_limit_in_the_message(self) -> None:
        with pytest.raises(FileRejectedError, match="2 MB or smaller"):
            inspect_upload(PDF + b"\x00" * (3 * 1024 * 1024), "application/pdf", "big.pdf", 2 * 1024 * 1024)

    def test_the_size_floor_is_enforced_exactly(self) -> None:
        just_under = b"%PDF-" + b"\x00" * (MIN_UPLOAD_BYTES - 6)
        assert len(just_under) == MIN_UPLOAD_BYTES - 1
        with pytest.raises(FileRejectedError):
            inspect_upload(just_under, None, "x.pdf", MAX)

        just_over = b"%PDF-" + b"\x00" * (MIN_UPLOAD_BYTES - 5)
        assert inspect_upload(just_over, None, "x.pdf", MAX).size == MIN_UPLOAD_BYTES

    def test_the_checksum_distinguishes_two_different_files(self) -> None:
        first = inspect_upload(PDF, None, "a.pdf", MAX)
        second = inspect_upload(PDF + b"x", None, "b.pdf", MAX)
        assert first.checksum_sha256 != second.checksum_sha256


class TestFilenameSafety:
    @pytest.mark.parametrize(
        ("supplied", "expected"),
        [
            ("scan.pdf", "scan.pdf"),
            ("../../etc/passwd", "etcpasswd"),
            ("..\\..\\windows\\system32", "windowssystem32"),
            ("report:2026.pdf", "report2026.pdf"),
            ('quote"name.pdf', "quotename.pdf"),
            ("  spaced.pdf  ", "spaced.pdf"),
            (".hidden", "hidden"),
        ],
    )
    def test_it_strips_anything_structural(self, supplied: str, expected: str) -> None:
        assert sanitize_filename(supplied) == expected

    def test_a_name_of_nothing_but_junk_falls_back(self) -> None:
        for junk in ("", "   ", "///", "...", "\x00\x01"):
            assert sanitize_filename(junk) == "document"

    def test_control_characters_are_removed(self) -> None:
        assert sanitize_filename("re\x00port\x1f.pdf") == "report.pdf"

    def test_a_very_long_name_is_truncated(self) -> None:
        assert len(sanitize_filename("a" * 500)) == 120

    def test_the_stored_name_is_never_used_to_build_the_path(self) -> None:
        """Path traversal cannot reach the object key.

        Every part of the path is generated: the patient's id, the document's
        id, and an extension derived from the detected type.
        """
        inspected = inspect_upload(PDF, None, "../../../evil.pdf", MAX)
        path = object_path("pat_1", "doc_1", inspected.extension)

        assert path == "pat_1/doc_1.pdf"
        assert ".." not in path


class TestObjectPaths:
    def test_documents_are_grouped_by_patient(self) -> None:
        assert object_path("pat_1", "doc_9", ".png").startswith("pat_1/")

    def test_two_documents_for_one_patient_do_not_collide(self) -> None:
        assert object_path("pat_1", "doc_1", ".pdf") != object_path("pat_1", "doc_2", ".pdf")

    def test_the_extension_comes_from_the_detected_type(self) -> None:
        # A file named .pdf whose bytes are PNG is stored as .png.
        inspected = inspect_upload(PNG, None, "actually_a_png.pdf", MAX)
        assert object_path("p", "d", inspected.extension).endswith(".png")

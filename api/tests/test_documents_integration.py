"""Document upload and signed retrieval, against real Supabase Storage.

The property worth proving end to end is the one from conflict C8: a document
has no URL until someone who is allowed to read it asks for one, and that URL
expires. Everything else here is the access matrix the records tests establish,
applied to files.

Uploaded objects and rows are both removed afterwards. Audit entries are kept —
the log is append-only by design.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.core.config import settings
from app.db.models import MedicalDocument, Patient, User
from app.db.session import SessionFactory
from app.services import storage
from tests.conftest import requires_db

pytestmark = requires_db

DEMO_PASSWORD = "Demo@Pass123"

ADMIN = "admin@example.com"
DOCTOR = "doctor@example.com"  # treats Priya
OTHER_DOCTOR = "doctor3@example.com"  # treats Meera
PATIENT = "patient@example.com"  # Priya
OTHER_PATIENT = "patient3@example.com"  # Meera
NURSE = "nurse@example.com"

#: A minimal but structurally real PDF, padded past the size floor.
PDF_BYTES = b"%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n" + b"\x00" * 128
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200


def sign_in(client: TestClient, email: str) -> dict[str, Any]:
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": email, "password": DEMO_PASSWORD})
    assert response.status_code == 200, f"{email}: {response.text}"
    return response.json()["data"]["user"]


async def patient_id_for(email: str) -> str:
    async with SessionFactory() as session:
        return (
            await session.execute(
                select(Patient.id).join(User, User.id == Patient.user_id).where(User.email == email)
            )
        ).scalar_one()


class Uploaded:
    """Tracks documents a test creates, so both row and object are removed."""

    def __init__(self) -> None:
        self.ids: set[str] = set()

    def track(self, response: Any) -> dict[str, Any]:
        assert response.status_code in (200, 201), response.text
        data = response.json()["data"]
        self.ids.add(data["id"])
        return data


@pytest.fixture
async def uploaded() -> AsyncIterator[Uploaded]:
    registry = Uploaded()
    yield registry
    if not registry.ids:
        return
    async with SessionFactory() as session:
        rows = (
            (
                await session.execute(
                    select(MedicalDocument.storage_bucket, MedicalDocument.storage_path).where(
                        MedicalDocument.id.in_(registry.ids)
                    )
                )
            )
            .all()
        )
        for bucket, path in rows:
            await storage.remove(bucket, path)
        await session.execute(delete(MedicalDocument).where(MedicalDocument.id.in_(registry.ids)))
        await session.commit()


def upload(
    client: TestClient,
    patient_id: str,
    content: bytes = PDF_BYTES,
    filename: str = "report.pdf",
    content_type: str = "application/pdf",
    **form: Any,
) -> Any:
    return client.post(
        "/api/documents",
        files={"file": (filename, content, content_type)},
        data={"patientId": patient_id, **form},
    )


class TestUpload:
    async def test_a_patient_uploads_their_own_report(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)

        data = uploaded.track(
            upload(client, priya, documentType="LAB_REPORT", title="Blood panel")
        )
        client.cookies.clear()

        assert data["documentType"] == "LAB_REPORT"
        assert data["mimeType"] == "application/pdf"
        assert data["fileSize"] == len(PDF_BYTES)
        assert data["checksumSha256"]
        # Storage addressing is server-side and must not be published.
        assert "storagePath" not in data
        assert "storageBucket" not in data

    async def test_a_patient_cannot_upload_into_another_patients_file(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        """The patientId in the form is ignored; identity comes from the session."""
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        meera = await patient_id_for(OTHER_PATIENT)

        data = uploaded.track(upload(client, meera))
        client.cookies.clear()

        assert data["patientId"] == priya

    async def test_a_doctor_uploads_for_a_patient_they_treat(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, DOCTOR)
        priya = await patient_id_for(PATIENT)

        data = uploaded.track(upload(client, priya, documentType="DISCHARGE_SUMMARY"))
        client.cookies.clear()

        assert data["patientId"] == priya
        assert data["uploadedBy"]

    async def test_a_doctor_cannot_upload_for_an_unrelated_patient(
        self, client: TestClient
    ) -> None:
        sign_in(client, DOCTOR)
        meera = await patient_id_for(OTHER_PATIENT)
        response = upload(client, meera)
        client.cookies.clear()

        assert response.status_code == 403

    async def test_an_executable_disguised_as_a_pdf_is_refused(
        self, client: TestClient
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        response = upload(
            client, priya, content=b"MZ\x90\x00" + b"\x00" * 300, filename="report.pdf"
        )
        client.cookies.clear()

        assert response.status_code == 400
        assert "not supported" in response.json()["error"]["message"]

    async def test_a_png_announced_as_a_pdf_is_refused(self, client: TestClient) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        response = upload(
            client, priya, content=PNG_BYTES, filename="x.pdf", content_type="application/pdf"
        )
        client.cookies.clear()

        assert response.status_code == 400
        assert "do not match" in response.json()["error"]["message"]

    async def test_an_empty_file_is_refused(self, client: TestClient) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        response = upload(client, priya, content=b"")
        client.cookies.clear()

        assert response.status_code == 400

    async def test_a_traversing_filename_cannot_escape_its_prefix(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        data = uploaded.track(upload(client, priya, filename="../../../../etc/passwd.pdf"))
        client.cookies.clear()

        async with SessionFactory() as session:
            path = (
                await session.execute(
                    select(MedicalDocument.storage_path).where(MedicalDocument.id == data["id"])
                )
            ).scalar_one()

        assert path == f"{priya}/{data['id']}.pdf"
        assert ".." not in path
        assert ".." not in data["fileName"]

    async def test_a_nurse_cannot_upload_without_a_grant(self, client: TestClient) -> None:
        sign_in(client, NURSE)
        priya = await patient_id_for(PATIENT)
        response = upload(client, priya)
        client.cookies.clear()

        assert response.status_code == 403


class TestRetrieval:
    async def test_a_signed_url_is_minted_on_demand(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        """Conflict C8: no URL exists until the access check passes."""
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))

        link = client.get(f"/api/documents/{document['id']}/download")
        client.cookies.clear()

        assert link.status_code == 200
        body = link.json()["data"]
        assert body["url"].startswith(settings.SUPABASE_URL)
        assert "token=" in body["url"]
        assert body["expiresInSeconds"] == settings.SUPABASE_SIGNED_URL_TTL_SECONDS

    async def test_the_signed_url_actually_serves_the_file(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        import httpx

        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))
        url = client.get(f"/api/documents/{document['id']}/download").json()["data"]["url"]
        client.cookies.clear()

        async with httpx.AsyncClient(timeout=30.0) as fetcher:
            fetched = await fetcher.get(url)

        assert fetched.status_code == 200
        assert fetched.content == PDF_BYTES

    async def test_the_bucket_refuses_an_unsigned_request(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        """The bucket is private: knowing the object path is not access."""
        import httpx

        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))
        client.cookies.clear()

        async with SessionFactory() as session:
            bucket, path = (
                await session.execute(
                    select(MedicalDocument.storage_bucket, MedicalDocument.storage_path).where(
                        MedicalDocument.id == document["id"]
                    )
                )
            ).first()

        async with httpx.AsyncClient(timeout=30.0) as fetcher:
            direct = await fetcher.get(
                f"{settings.SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}"
            )

        assert direct.status_code >= 400

    async def test_another_patient_gets_no_url(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))

        sign_in(client, OTHER_PATIENT)
        response = client.get(f"/api/documents/{document['id']}/download")
        client.cookies.clear()

        assert response.status_code == 403

    async def test_an_administrator_gets_no_url(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        """R2: administrative access to a patient is not clinical access."""
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))

        sign_in(client, ADMIN)
        metadata = client.get(f"/api/documents/{document['id']}")
        link = client.get(f"/api/documents/{document['id']}/download")
        client.cookies.clear()

        assert metadata.status_code == 403
        assert link.status_code == 403

    async def test_the_treating_doctor_can_open_it(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))

        sign_in(client, DOCTOR)
        response = client.get(f"/api/documents/{document['id']}/download")
        client.cookies.clear()

        assert response.status_code == 200

    async def test_an_unrelated_doctor_cannot(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))

        sign_in(client, OTHER_DOCTOR)
        response = client.get(f"/api/documents/{document['id']}/download")
        client.cookies.clear()

        assert response.status_code == 403

    async def test_opening_a_document_is_audited(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        from app.db.enums import AuditAction
        from app.db.models import AuditLog

        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))
        client.get(f"/api/documents/{document['id']}/download")
        client.cookies.clear()

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog).where(
                        AuditLog.action == AuditAction.DOCUMENT_VIEWED,
                        AuditLog.entity_id == document["id"],
                    )
                )
            ).scalar_one()

        assert entry.patient_id == priya


class TestListing:
    async def test_a_patient_sees_only_their_own_documents(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, OTHER_PATIENT)
        meera = await patient_id_for(OTHER_PATIENT)
        theirs = uploaded.track(upload(client, meera))

        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        mine = uploaded.track(upload(client, priya))
        listed = {row["id"] for row in client.get("/api/documents").json()["data"]}
        client.cookies.clear()

        assert mine["id"] in listed
        assert theirs["id"] not in listed

    async def test_documents_can_be_filtered_by_type(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        report = uploaded.track(upload(client, priya, documentType="LAB_REPORT"))
        uploaded.track(upload(client, priya, documentType="PRESCRIPTION"))

        filtered = client.get("/api/documents", params={"documentType": "LAB_REPORT"})
        client.cookies.clear()

        ids = {row["id"] for row in filtered.json()["data"]}
        assert report["id"] in ids
        assert all(row["documentType"] == "LAB_REPORT" for row in filtered.json()["data"])

    async def test_an_ocr_candidate_is_queued_for_phase_seven(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya, documentType="PRESCRIPTION"))
        client.cookies.clear()

        assert document["ocrStatus"] in ("PENDING", "SKIPPED")


class TestDeletion:
    async def test_the_uploader_can_withdraw_their_own_file(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))

        removed = client.delete(f"/api/documents/{document['id']}")
        after = client.get(f"/api/documents/{document['id']}")
        listed = {row["id"] for row in client.get("/api/documents").json()["data"]}
        client.cookies.clear()

        assert removed.status_code == 200
        assert after.status_code == 404
        assert document["id"] not in listed

    async def test_deletion_is_soft(self, client: TestClient, uploaded: Uploaded) -> None:
        """The row survives so the audit trail can still name what was read."""
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))
        client.delete(f"/api/documents/{document['id']}")
        client.cookies.clear()

        async with SessionFactory() as session:
            row = (
                await session.execute(
                    select(MedicalDocument.deleted_at, MedicalDocument.storage_path).where(
                        MedicalDocument.id == document["id"]
                    )
                )
            ).first()

        assert row is not None
        assert row.deleted_at is not None
        assert row.storage_path  # the object is still addressable server-side

    async def test_another_patient_cannot_delete_it(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))

        sign_in(client, OTHER_PATIENT)
        response = client.delete(f"/api/documents/{document['id']}")
        client.cookies.clear()

        assert response.status_code in (403, 404)

    async def test_a_deleted_document_cannot_be_downloaded(
        self, client: TestClient, uploaded: Uploaded
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = uploaded.track(upload(client, priya))
        client.delete(f"/api/documents/{document['id']}")

        response = client.get(f"/api/documents/{document['id']}/download")
        client.cookies.clear()

        assert response.status_code == 404

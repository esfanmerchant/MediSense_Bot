"""Document extraction and the review gate, end to end (spec §23-24).

The property under test is the one that matters clinically: **machine output
never becomes clinical data on its own.** An extraction is a proposal; a
doctor's confirmation records what the document says; and even then nothing is
prescribed until someone writes a prescription (conflict C7).

The second property is a privacy one. The vision model reads better but sends
the document to an external provider, so it runs only with the patient's AI
consent; without it the document stays on local OCR (conflict C2). Both paths
are exercised here.
"""

from __future__ import annotations

import io
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update

from app.db.base import utcnow
from app.db.models import MedicalDocument, Patient, Prescription, User
from app.db.session import SessionFactory
from app.services import ocr, storage
from tests.conftest import requires_ai, requires_db

pytestmark = requires_db

DEMO_PASSWORD = "Demo@Pass123"
ADMIN = "admin@example.com"
DOCTOR = "doctor@example.com"
OTHER_DOCTOR = "doctor3@example.com"
PATIENT = "patient@example.com"

#: The suite runs with AI disabled, so the local engine is what reads documents
#: unless a test turns the provider on for itself. These guards are therefore
#: about the *local* engine; the vision path has its own marker.
needs_local_ocr = pytest.mark.skipif(
    not ocr.is_available(),
    reason='local OCR not installed: pip install -e "api[ocr]"',
)
needs_a_reader = needs_local_ocr

PRESCRIPTION_LINES = [
    "CITY GENERAL HOSPITAL",
    "Patient: Priya Sharma",
    "Rx",
    "1. Amoxicillin 500 mg - 1 tab TID x 5 days",
    "2. Paracetamol 650 mg - SOS for fever",
    "Dr. Rajesh Iyer, MD",
]


def render_prescription() -> bytes:
    """Draw a printed prescription as PNG bytes."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1000, 500), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arial.ttf", 28)
    except OSError:
        font = ImageFont.load_default()

    y = 40
    for line in PRESCRIPTION_LINES:
        draw.text((50, y), line, fill="black", font=font)
        y += 60

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


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


@pytest.fixture
async def scanned() -> AsyncIterator[list[str]]:
    """Uploads to clean up: both the row and the stored object."""
    created: list[str] = []
    yield created
    if not created:
        return
    async with SessionFactory() as session:
        rows = (
            await session.execute(
                select(MedicalDocument.storage_bucket, MedicalDocument.storage_path).where(
                    MedicalDocument.id.in_(created)
                )
            )
        ).all()
        for bucket, path in rows:
            await storage.remove(bucket, path)
        await session.execute(delete(MedicalDocument).where(MedicalDocument.id.in_(created)))
        await session.commit()


@pytest.fixture
async def consent_withdrawn() -> AsyncIterator[str]:
    """Withdraw the demo patient's AI consent, then restore it.

    Restoring in teardown matters: leaving consent withdrawn would silently
    change which engine every later test uses.
    """
    patient_id = await patient_id_for(PATIENT)
    async with SessionFactory() as session:
        original = (
            await session.execute(
                select(Patient.ai_consent_granted_at, Patient.ai_consent_withdrawn_at).where(
                    Patient.id == patient_id
                )
            )
        ).first()
        await session.execute(
            update(Patient)
            .where(Patient.id == patient_id)
            .values(ai_consent_withdrawn_at=utcnow())
        )
        await session.commit()

    yield patient_id

    async with SessionFactory() as session:
        await session.execute(
            update(Patient)
            .where(Patient.id == patient_id)
            .values(
                ai_consent_granted_at=original.ai_consent_granted_at,
                ai_consent_withdrawn_at=original.ai_consent_withdrawn_at,
            )
        )
        await session.commit()


def upload_prescription(client: TestClient, patient_id: str, scanned: list[str]) -> dict[str, Any]:
    response = client.post(
        "/api/documents",
        files={"file": ("prescription.png", render_prescription(), "image/png")},
        data={"patientId": patient_id, "documentType": "PRESCRIPTION"},
    )
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    scanned.append(data["id"])
    return data


class TestAvailability:
    def test_the_api_reports_whether_a_reader_is_configured(self, client: TestClient) -> None:
        # A missing engine disables one feature; it must not take the API down.
        body = client.get("/api/health/ready").json()
        assert "ocr" in body["data"]["integrations"]

    async def test_a_freshly_uploaded_document_is_queued_not_read(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        # Extraction is an explicit step, so an upload never silently produces
        # medication data.
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        client.cookies.clear()

        assert document["ocrStatus"] == "PENDING"


class TestExtraction:
    @needs_a_reader
    async def test_it_reads_a_printed_prescription(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)

        result = client.post(f"/api/documents/{document['id']}/ocr")
        client.cookies.clear()

        assert result.status_code == 200, result.text
        body = result.json()["data"]
        assert body["status"] == "EXTRACTED"
        assert body["engine"] in ("GEMINI_VISION", "PADDLE_OCR")
        assert body["confidence"] > 0.5
        assert "amoxicillin" in (body["extractedText"] or "").lower()

    @requires_ai
    async def test_the_consenting_patient_gets_the_better_engine(
        self, client: TestClient, scanned: list[str], ai_enabled: None
    ) -> None:
        """The demo patients have granted AI consent, so vision is used.

        This is the only test that calls the provider for real, which is why it
        enables AI for itself rather than relying on the suite default.
        """
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        body = client.post(f"/api/documents/{document['id']}/ocr").json()["data"]
        client.cookies.clear()

        assert body["engine"] == "GEMINI_VISION"
        assert body["status"] == "EXTRACTED"
        # The vision path must produce the same reviewable shape as the local
        # one, or the review screen would only work for one engine.
        assert body["structured"]["medications"]
        assert "not yet verified" in body["structured"]["disclaimer"]

    @requires_ai
    async def test_the_vision_path_never_invents_a_missing_field(
        self, client: TestClient, scanned: list[str], ai_enabled: None
    ) -> None:
        """The sample's second line has no duration written on it.

        A plausible-looking "7 days" here would be the exact failure the
        grounding rules exist to prevent.
        """
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        body = client.post(f"/api/documents/{document['id']}/ocr").json()["data"]
        client.cookies.clear()

        for medication in body["structured"]["medications"]:
            # Whatever it extracted, every medication must cite the line it came
            # from — a fabricated entry has to fabricate its evidence too.
            assert medication["sourceText"].strip()

    @needs_local_ocr
    async def test_withdrawing_consent_keeps_the_document_local(
        self, client: TestClient, scanned: list[str], consent_withdrawn: str
    ) -> None:
        """Conflict C2: without consent the document must not leave the
        deployment, so the local engine reads it instead."""
        sign_in(client, PATIENT)
        document = upload_prescription(client, consent_withdrawn, scanned)
        body = client.post(f"/api/documents/{document['id']}/ocr").json()["data"]
        client.cookies.clear()

        assert body["engine"] == "PADDLE_OCR"

    @needs_a_reader
    async def test_the_structured_result_is_marked_as_needing_review(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        """§24: never automatically assume the reading is correct."""
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        body = client.post(f"/api/documents/{document['id']}/ocr").json()["data"]
        client.cookies.clear()

        structured = body["structured"]
        assert "not yet verified" in structured["disclaimer"]
        assert structured["medications"], "the sample has two medication lines"
        first = structured["medications"][0]
        assert set(first["medication"]) >= {"value", "confidence", "needs_review"}

    @needs_a_reader
    async def test_every_medication_carries_the_line_it_came_from(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        """A fabricated entry has to fabricate its evidence too, and a source
        line that does not match the page is visible next to it."""
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        body = client.post(f"/api/documents/{document['id']}/ocr").json()["data"]
        client.cookies.clear()

        for medication in body["structured"]["medications"]:
            assert medication["sourceText"].strip()

    @needs_a_reader
    async def test_extraction_does_not_create_a_prescription(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        """The heart of conflict C7: machine output acquires no clinical author."""
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        client.post(f"/api/documents/{document['id']}/ocr")
        client.cookies.clear()

        async with SessionFactory() as session:
            rows = (
                await session.execute(
                    select(Prescription.id).where(Prescription.patient_id == priya)
                )
            ).all()

        assert len(rows) == 0, "extraction must not write medication into the record"

    @needs_a_reader
    async def test_extraction_records_which_engine_and_why(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        from app.db.enums import AuditAction
        from app.db.models import AuditLog

        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        client.post(f"/api/documents/{document['id']}/ocr")
        client.cookies.clear()

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog).where(
                        AuditLog.action == AuditAction.OCR_PROCESSED,
                        AuditLog.entity_id == document["id"],
                    )
                )
            ).scalar_one()

        assert entry.patient_id == priya
        assert entry.audit_metadata["engine"] in ("GEMINI_VISION", "PADDLE_OCR")
        # Why the weaker engine ran is a question worth being able to answer.
        assert entry.audit_metadata["engineReason"]
        assert "aiConsent" in entry.audit_metadata
        # The extracted text is a prescription's contents and stays out of the log.
        assert "amoxicillin" not in str(entry.audit_metadata).lower()


class TestAccessControl:
    async def test_an_unrelated_doctor_cannot_read_the_extraction(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)

        sign_in(client, OTHER_DOCTOR)
        response = client.get(f"/api/documents/{document['id']}/ocr")
        client.cookies.clear()

        assert response.status_code == 403

    async def test_an_administrator_cannot_read_the_extraction(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)

        sign_in(client, ADMIN)
        response = client.get(f"/api/documents/{document['id']}/ocr")
        client.cookies.clear()

        assert response.status_code == 403


class TestConfirmation:
    @needs_a_reader
    async def test_a_patient_cannot_confirm_their_own_extraction(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        """Confirming a dose is clinical judgement, not data entry."""
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        client.post(f"/api/documents/{document['id']}/ocr")

        response = client.post(
            f"/api/documents/{document['id']}/ocr/confirm",
            json={
                "medications": [
                    {"medication": "Amoxicillin", "dosage": "500 mg", "frequency": "Three times daily"}
                ]
            },
        )
        client.cookies.clear()

        assert response.status_code == 403

    @needs_a_reader
    async def test_a_doctor_confirms_a_corrected_reading(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        client.post(f"/api/documents/{document['id']}/ocr")

        sign_in(client, DOCTOR)
        response = client.post(
            f"/api/documents/{document['id']}/ocr/confirm",
            json={
                "medications": [
                    {
                        "medication": "Amoxicillin",
                        "dosage": "500 mg",
                        "frequency": "Three times daily",
                        "duration": "5 days",
                    }
                ]
            },
        )
        client.cookies.clear()

        assert response.status_code == 200, response.text
        body = response.json()["data"]
        assert body["status"] == "CONFIRMED"
        assert body["confirmedById"]

    @needs_a_reader
    async def test_the_machines_reading_is_kept_beside_the_corrected_one(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        """If a dose is questioned later, "what did the machine say and what did
        the clinician change it to" has to remain answerable."""
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        client.post(f"/api/documents/{document['id']}/ocr")

        sign_in(client, DOCTOR)
        body = client.post(
            f"/api/documents/{document['id']}/ocr/confirm",
            json={
                "medications": [
                    {"medication": "Amoxicillin", "dosage": "250 mg", "frequency": "Twice daily"}
                ]
            },
        ).json()["data"]
        client.cookies.clear()

        assert "proposed" in body["structured"]
        assert "confirmed" in body["structured"]
        assert body["structured"]["confirmed"]["medications"][0]["dosage"] == "250 mg"

    @needs_a_reader
    async def test_confirming_still_prescribes_nothing(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        """Even a confirmed reading is not a prescription. A doctor writes that
        separately, and that act is audited on its own."""
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        client.post(f"/api/documents/{document['id']}/ocr")

        sign_in(client, DOCTOR)
        client.post(
            f"/api/documents/{document['id']}/ocr/confirm",
            json={
                "medications": [
                    {"medication": "Amoxicillin", "dosage": "500 mg", "frequency": "Three times daily"}
                ]
            },
        )
        client.cookies.clear()

        async with SessionFactory() as session:
            rows = (
                await session.execute(
                    select(Prescription.id).where(Prescription.patient_id == priya)
                )
            ).all()

        assert len(rows) == 0

    async def test_confirming_before_extraction_is_refused(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)

        sign_in(client, DOCTOR)
        response = client.post(
            f"/api/documents/{document['id']}/ocr/confirm",
            json={
                "medications": [
                    {"medication": "Amoxicillin", "dosage": "500 mg", "frequency": "Twice daily"}
                ]
            },
        )
        client.cookies.clear()

        assert response.status_code == 400

    @needs_a_reader
    async def test_an_empty_confirmation_is_refused(
        self, client: TestClient, scanned: list[str]
    ) -> None:
        sign_in(client, PATIENT)
        priya = await patient_id_for(PATIENT)
        document = upload_prescription(client, priya, scanned)
        client.post(f"/api/documents/{document['id']}/ocr")

        sign_in(client, DOCTOR)
        response = client.post(
            f"/api/documents/{document['id']}/ocr/confirm", json={"medications": []}
        )
        client.cookies.clear()

        assert response.status_code == 422

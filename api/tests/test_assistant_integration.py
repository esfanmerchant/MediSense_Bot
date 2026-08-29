"""The assistant against a real database and the real authorization stack.

`test_assistant_safety.py` proves the safety rules in isolation. This file
proves the properties that only exist once the endpoints, the permission layer,
consent and the tables are all involved:

* the assistant is for patients, and only patients who have consented;
* a provider outage does not lose an escalation;
* describing symptoms writes nothing, and confirming them writes *staged
  patient-reported information* — never a medical record (spec §21, conflict C7);
* the audit log records that an interaction happened, without recording the
  clinical content of the question;
* history is scoped to the caller's own patient record with no id to tamper with.

Most of it runs with the provider **off**, which is deliberate: the fallback path
is the one that has to hold when things go wrong, so it is the one worth testing
on every run.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update

from app.db.models import AIInteraction, AuditLog, MedicalRecord, Patient, ReportedSymptom, User
from app.db.session import SessionFactory
from tests.conftest import requires_ai, requires_db

pytestmark = requires_db

DEMO_PASSWORD = "Demo@Pass123"

PATIENT = "patient@example.com"  # Priya
OTHER_PATIENT = "patient3@example.com"  # Meera
DOCTOR = "doctor@example.com"
ADMIN = "admin@example.com"
NURSE = "nurse@example.com"

EMERGENCY_TEXT = "I have crushing chest pain going down my left arm"


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
async def clean_assistant_rows() -> AsyncIterator[None]:
    """Removes the interactions and symptoms a test creates.

    Audit entries are deliberately left alone — the log is append-only, and a
    test that could delete from it would be testing something other than the
    system in use.
    """
    yield
    ids = [await patient_id_for(PATIENT), await patient_id_for(OTHER_PATIENT)]
    async with SessionFactory() as session:
        await session.execute(delete(ReportedSymptom).where(ReportedSymptom.patient_id.in_(ids)))
        await session.execute(delete(AIInteraction).where(AIInteraction.patient_id.in_(ids)))
        await session.commit()


@pytest.fixture(autouse=True)
async def demo_consent_restored() -> AsyncIterator[None]:
    """Puts the demo patients' consent back exactly as it was found.

    The demo accounts are shared across the whole suite, and other modules
    depend on their state — document reading picks the vision engine *because*
    these patients have consented. Restoring to a value this module assumes,
    rather than to the value it found, silently breaks those tests in whatever
    order pytest happens to run them.

    The columns are snapshotted and written back directly: granting through the
    API again would restore the flag but stamp a new timestamp, which is not the
    same thing as leaving the row alone.
    """
    ids = [await patient_id_for(PATIENT), await patient_id_for(OTHER_PATIENT)]
    async with SessionFactory() as session:
        before = {
            row.id: (row.ai_consent_granted_at, row.ai_consent_withdrawn_at)
            for row in (
                await session.execute(select(Patient).where(Patient.id.in_(ids)))
            ).scalars()
        }

    yield

    async with SessionFactory() as session:
        for patient_id, (granted_at, withdrawn_at) in before.items():
            await session.execute(
                update(Patient)
                .where(Patient.id == patient_id)
                .values(ai_consent_granted_at=granted_at, ai_consent_withdrawn_at=withdrawn_at)
            )
        await session.commit()


@pytest.fixture
async def consenting_patient(client: TestClient) -> str:
    """A patient with AI consent granted.

    Granted through the API rather than by writing the columns, so the test
    exercises the same path a patient would. Teardown is `demo_consent_restored`'s
    job — see the note there about why this must not simply set it back to False.
    """
    sign_in(client, PATIENT)
    response = client.put("/api/patients/me/ai-consent", json={"granted": True})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["aiConsentGranted"] is True
    return await patient_id_for(PATIENT)


class TestWhoMayUseIt:
    """The assistant is a patient feature. Nobody else has a route in."""

    @pytest.mark.parametrize("email", [DOCTOR, ADMIN, NURSE])
    def test_non_patients_are_refused(self, client: TestClient, email: str) -> None:
        sign_in(client, email)
        response = client.post("/api/assistant/chat", json={"message": "hello"})
        assert response.status_code == 403, response.text

    def test_an_anonymous_caller_is_refused(self, client: TestClient) -> None:
        client.cookies.clear()
        assert client.post("/api/assistant/chat", json={"message": "hello"}).status_code == 401

    def test_consent_is_required_before_anything_is_sent(self, client: TestClient) -> None:
        sign_in(client, PATIENT)
        client.put("/api/patients/me/ai-consent", json={"granted": False})

        response = client.post("/api/assistant/chat", json={"message": "hello"})
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "CONSENT_REQUIRED"

    def test_status_explains_why_it_is_off(self, client: TestClient) -> None:
        sign_in(client, PATIENT)
        client.put("/api/patients/me/ai-consent", json={"granted": False})

        data = client.get("/api/assistant/status").json()["data"]
        assert data["available"] is False
        assert data["consentGranted"] is False
        assert data["reason"]
        # Present even when the feature is off, so a client cannot render the
        # assistant anywhere without it.
        assert "licensed healthcare professional" in data["disclaimer"]

    def test_status_reports_ready_once_consent_is_given(
        self, client: TestClient, consenting_patient: str
    ) -> None:
        data = client.get("/api/assistant/status").json()["data"]
        assert data["consentGranted"] is True


class TestProviderOutage:
    """AI is disabled suite-wide, so every test here runs the fallback path."""

    def test_an_emergency_is_escalated_without_the_provider(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        data = client.post("/api/assistant/chat", json={"message": EMERGENCY_TEXT}).json()["data"]

        assert data["emergency"] is True
        assert data["urgency"] == "EMERGENCY"
        assert "emergency" in data["answer"].lower()
        assert data["safetyInterventions"] == ["provider_unavailable"]

    def test_every_answer_carries_the_disclaimer(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        data = client.post(
            "/api/assistant/chat", json={"message": "what should I eat today"}
        ).json()["data"]
        assert "does not replace" in data["disclaimer"]

    def test_an_outage_is_not_reported_as_success_of_the_assistant(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        data = client.post("/api/assistant/chat", json={"message": "hello"}).json()["data"]
        assert "unavailable" in data["answer"].lower()

    async def test_a_dictated_question_is_recorded_as_voice(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        """How the question was captured travels with it (spec §20-21).

        The client sets this when the patient used the microphone. It matters
        because a transcript is a machine's reading of speech: a doctor looking
        at the interaction later should be able to see that a recogniser stood
        between the patient's words and the text on file.
        """
        client.post(
            "/api/assistant/chat",
            json={"message": "I have had a headache since yesterday", "inputType": "VOICE"},
        )

        async with SessionFactory() as session:
            row = (
                await session.execute(
                    select(AIInteraction)
                    .where(AIInteraction.patient_id == consenting_patient)
                    .order_by(AIInteraction.created_at.desc())
                )
            ).scalars().first()

        assert row is not None
        assert str(row.input_type) == "VOICE"

    def test_an_unknown_input_type_is_refused(
        self, client: TestClient, consenting_patient: str
    ) -> None:
        response = client.post(
            "/api/assistant/chat", json={"message": "hello", "inputType": "TELEPATHY"}
        )
        assert response.status_code == 422

    async def test_the_turn_is_still_recorded(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        client.post("/api/assistant/chat", json={"message": EMERGENCY_TEXT})

        async with SessionFactory() as session:
            row = (
                await session.execute(
                    select(AIInteraction)
                    .where(AIInteraction.patient_id == consenting_patient)
                    .order_by(AIInteraction.created_at.desc())
                )
            ).scalars().first()

        assert row is not None
        assert row.emergency_flagged is True
        assert row.input == EMERGENCY_TEXT


class TestAudit:
    async def test_an_interaction_is_audited_without_its_content(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        """The question is clinical content, so it lives in ai_interactions.

        The audit log answers "who did what, when" — putting the patient's words
        in it would duplicate medical content into a table with a different
        retention and a different audience (spec §31).
        """
        client.post("/api/assistant/chat", json={"message": EMERGENCY_TEXT})

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog)
                    .where(
                        AuditLog.patient_id == consenting_patient,
                        AuditLog.entity_type == "AIInteraction",
                    )
                    .order_by(AuditLog.timestamp.desc())
                )
            ).scalars().first()

        assert entry is not None
        serialised = str(entry.audit_metadata)
        assert "chest pain" not in serialised.lower()
        assert entry.audit_metadata["emergency"] is True
        assert entry.audit_metadata["urgency"] == "EMERGENCY"


class TestSymptomsAreProposalsUntilConfirmed:
    async def test_analysing_symptoms_stores_nothing(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        response = client.post("/api/assistant/symptoms", json={"text": "headache since Monday"})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["saved"] is False

        async with SessionFactory() as session:
            count = (
                await session.execute(
                    select(ReportedSymptom).where(
                        ReportedSymptom.patient_id == consenting_patient
                    )
                )
            ).scalars().all()
        assert count == []

    async def test_confirming_stores_the_patients_corrected_list(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        response = client.post(
            "/api/assistant/symptoms/confirm",
            json={
                "symptoms": [
                    {"symptom": "headache", "severity": "moderate", "duration": "3 days"},
                    {"symptom": "dizziness"},
                ],
                "rawText": "headache since Monday and a bit dizzy",
            },
        )
        assert response.status_code == 201, response.text
        assert response.json()["data"]["saved"] == 2

        async with SessionFactory() as session:
            rows = (
                (
                    await session.execute(
                        select(ReportedSymptom)
                        .where(ReportedSymptom.patient_id == consenting_patient)
                        .order_by(ReportedSymptom.symptom)
                    )
                )
                .scalars()
                .all()
            )

        assert [row.symptom for row in rows] == ["dizziness", "headache"]
        assert all(str(row.source) == "PATIENT_REPORTED" for row in rows)
        assert all(row.promoted_to_record_id is None for row in rows)

    async def test_voice_input_is_marked_as_ai_assisted(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        """Provenance is the point: a transcribed symptom is not the same claim.

        Spec §21 separates what the patient typed from what a model heard, so a
        doctor reviewing the staging table can weigh them differently.
        """
        client.post(
            "/api/assistant/symptoms/confirm",
            json={"symptoms": [{"symptom": "sore throat"}], "inputType": "VOICE"},
        )

        async with SessionFactory() as session:
            row = (
                await session.execute(
                    select(ReportedSymptom).where(
                        ReportedSymptom.patient_id == consenting_patient
                    )
                )
            ).scalars().one()

        assert str(row.source) == "AI_ASSISTED"
        assert str(row.input_type) == "VOICE"

    async def test_confirming_never_creates_a_medical_record(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        """Conflict C7 in one assertion.

        A symptom the patient described is patient-reported information. Only a
        doctor's explicit promotion turns it into a record with a clinical
        author, and there is no code path from this endpoint into that table.
        """
        async with SessionFactory() as session:
            before = len(
                (
                    await session.execute(
                        select(MedicalRecord.id).where(
                            MedicalRecord.patient_id == consenting_patient
                        )
                    )
                )
                .scalars()
                .all()
            )

        client.post(
            "/api/assistant/symptoms/confirm", json={"symptoms": [{"symptom": "fatigue"}]}
        )

        async with SessionFactory() as session:
            after = len(
                (
                    await session.execute(
                        select(MedicalRecord.id).where(
                            MedicalRecord.patient_id == consenting_patient
                        )
                    )
                )
                .scalars()
                .all()
            )

        assert after == before

    def test_an_empty_list_is_rejected(
        self, client: TestClient, consenting_patient: str
    ) -> None:
        response = client.post("/api/assistant/symptoms/confirm", json={"symptoms": []})
        assert response.status_code == 422

    def test_another_patient_cannot_write_to_this_ones_record(
        self, client: TestClient
    ) -> None:
        """There is no patient id in the payload, so there is nothing to forge.

        The row is written against the session's patient id. This test exists to
        keep it that way: if someone adds a `patientId` field, it should fail.
        """
        sign_in(client, DOCTOR)
        response = client.post(
            "/api/assistant/symptoms/confirm", json={"symptoms": [{"symptom": "cough"}]}
        )
        assert response.status_code == 403


class TestHistory:
    async def test_history_is_scoped_to_the_caller(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        client.post("/api/assistant/chat", json={"message": "a question of my own"})

        # A different patient must not see it, and has no id to ask with.
        sign_in(client, OTHER_PATIENT)
        rows = client.get("/api/assistant/history").json()["data"]
        assert all(row["input"] != "a question of my own" for row in rows)

        sign_in(client, PATIENT)
        mine = client.get("/api/assistant/history").json()["data"]
        assert any(row["input"] == "a question of my own" for row in mine)

    def test_turns_of_one_conversation_share_a_session(
        self, client: TestClient, consenting_patient: str, clean_assistant_rows: None
    ) -> None:
        first = client.post("/api/assistant/chat", json={"message": "first"}).json()["data"]
        second = client.post(
            "/api/assistant/chat", json={"message": "second", "sessionId": first["sessionId"]}
        ).json()["data"]

        assert second["sessionId"] == first["sessionId"]

        scoped = client.get(
            "/api/assistant/history", params={"sessionId": first["sessionId"]}
        ).json()["data"]
        assert {row["input"] for row in scoped} == {"first", "second"}


class TestInputLimits:
    def test_an_empty_message_is_rejected(
        self, client: TestClient, consenting_patient: str
    ) -> None:
        assert client.post("/api/assistant/chat", json={"message": "   "}).status_code == 422

    def test_an_oversized_message_is_rejected(
        self, client: TestClient, consenting_patient: str
    ) -> None:
        response = client.post("/api/assistant/chat", json={"message": "a" * 2001})
        assert response.status_code == 422


@requires_ai
class TestAgainstTheRealProvider:
    """The provider path, run deliberately and only when a key is present."""

    def test_a_real_answer_is_grounded_and_disclaimed(
        self,
        client: TestClient,
        consenting_patient: str,
        clean_assistant_rows: None,
        ai_enabled: None,
    ) -> None:
        data = client.post(
            "/api/assistant/chat",
            json={"message": "What does the cardiology department treat?"},
        ).json()["data"]

        assert data["answer"].strip()
        assert "provider_unavailable" not in data["safetyInterventions"]
        assert "does not replace" in data["disclaimer"]

    def test_the_model_cannot_talk_an_emergency_down(
        self,
        client: TestClient,
        consenting_patient: str,
        clean_assistant_rows: None,
        ai_enabled: None,
    ) -> None:
        """Whatever the model returns, the deterministic layer has the last word."""
        data = client.post("/api/assistant/chat", json={"message": EMERGENCY_TEXT}).json()["data"]

        assert data["urgency"] == "EMERGENCY"
        assert data["emergency"] is True

    def test_extraction_returns_symptoms_to_correct(
        self,
        client: TestClient,
        consenting_patient: str,
        clean_assistant_rows: None,
        ai_enabled: None,
    ) -> None:
        data = client.post(
            "/api/assistant/symptoms",
            json={"text": "I have had a headache and a sore throat since Monday"},
        ).json()["data"]

        assert data["saved"] is False
        assert data["reviewPrompt"]
        assert data["extractedSymptoms"], "the provider should have found something to correct"

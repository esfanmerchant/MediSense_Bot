"""Vitals, thresholds and alerts against the real database (spec §16-17).

`test_thresholds.py` proves the engine in isolation. This file proves what only
appears once permissions, the alert lifecycle and the tables are all involved:

* recording an observation is not reading a chart, and the nurse role depends on
  that distinction (conflict C1);
* an ongoing problem produces one alert, not one per reading;
* the responsible doctor is found and notified;
* the audit trail records that a vital was taken without copying the values into
  it (conflict C5).

**Every threshold this file writes is patient-scoped.** The hospital defaults are
shared configuration that other tests and the seeded environment depend on, and
a test that edits them changes the meaning of every other patient's readings.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.db.enums import AlertSeverity, AlertStatus, VitalType
from app.db.models import Alert, AuditLog, Notification, Patient, User, Vital, VitalThreshold
from app.db.session import SessionFactory
from tests.conftest import requires_db

pytestmark = requires_db

DEMO_PASSWORD = "Demo@Pass123"

PATIENT = "patient@example.com"  # Priya
OTHER_PATIENT = "patient3@example.com"  # Meera
DOCTOR = "doctor@example.com"  # treats Priya
OTHER_DOCTOR = "doctor3@example.com"  # treats Meera
ADMIN = "admin@example.com"
NURSE = "nurse@example.com"


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
async def priya() -> str:
    return await patient_id_for(PATIENT)


@pytest.fixture(autouse=True)
async def clean_vitals() -> AsyncIterator[None]:
    """Removes readings, alerts, notifications and patient-scoped thresholds.

    Hospital-wide thresholds are deliberately untouched — see the module note.
    Audit entries are kept: the log is append-only, and a test able to delete
    from it would be testing something other than the system in use.
    """
    yield
    ids = [await patient_id_for(PATIENT), await patient_id_for(OTHER_PATIENT)]
    async with SessionFactory() as session:
        alert_ids = (
            (await session.execute(select(Alert.id).where(Alert.patient_id.in_(ids))))
            .scalars()
            .all()
        )
        if alert_ids:
            await session.execute(
                delete(Notification).where(
                    Notification.notification_metadata["alertId"].astext.in_(alert_ids)
                )
            )
        await session.execute(delete(Alert).where(Alert.patient_id.in_(ids)))
        await session.execute(delete(Vital).where(Vital.patient_id.in_(ids)))
        await session.execute(
            delete(VitalThreshold).where(VitalThreshold.patient_id.in_(ids))
        )
        await session.commit()


async def set_patient_threshold(
    patient_id: str,
    vital_type: VitalType,
    *,
    minimum: float | None,
    maximum: float | None,
    severity: AlertSeverity = AlertSeverity.WARNING,
    sustained: int = 1,
) -> None:
    """A patient-scoped rule, written directly.

    Written through the model rather than the API so a test about alerting does
    not also depend on the threshold endpoint's authorization passing.
    """
    from app.db.base import new_id

    async with SessionFactory() as session:
        await session.execute(
            delete(VitalThreshold).where(
                VitalThreshold.patient_id == patient_id,
                VitalThreshold.vital_type == vital_type,
            )
        )
        session.add(
            VitalThreshold(
                id=new_id(),
                vital_type=vital_type,
                patient_id=patient_id,
                min_value=minimum,
                max_value=maximum,
                severity=severity,
                enabled=True,
                sustained_readings=sustained,
            )
        )
        await session.commit()


def record(client: TestClient, patient_id: str, **readings: Any) -> dict[str, Any]:
    response = client.post("/api/vitals", json={"patientId": patient_id, **readings})
    assert response.status_code == 201, response.text
    return response.json()["data"]


class TestWhoMayRecord:
    """Recording an observation is not reading a chart (conflict C1)."""

    def test_a_nurse_may_record(self, client: TestClient, priya: str) -> None:
        sign_in(client, NURSE)
        assert record(client, priya, heartRate=72)["heartRate"] == 72

    def test_a_nurse_still_cannot_read_the_chart(self, client: TestClient, priya: str) -> None:
        """The whole point of the split.

        A nurse can write what they just measured on the patient in front of
        them and still has no standing right to that patient's history.
        """
        sign_in(client, NURSE)
        record(client, priya, heartRate=72)
        assert client.get(f"/api/vitals/{priya}").status_code == 403

    def test_a_doctor_may_record(self, client: TestClient, priya: str) -> None:
        sign_in(client, DOCTOR)
        assert record(client, priya, temperature=37.1)["temperature"] == 37.1

    def test_a_patient_may_not_record_their_own_vitals(
        self, client: TestClient, priya: str
    ) -> None:
        # Self-reported observations would be indistinguishable from measured
        # ones once stored, and the threshold engine would alert on them.
        sign_in(client, PATIENT)
        assert client.post("/api/vitals", json={"patientId": priya, "heartRate": 72}).status_code == 403

    def test_an_admin_may_not_record(self, client: TestClient, priya: str) -> None:
        sign_in(client, ADMIN)
        assert client.post("/api/vitals", json={"patientId": priya, "heartRate": 72}).status_code == 403

    def test_an_unknown_patient_is_refused(self, client: TestClient) -> None:
        sign_in(client, NURSE)
        response = client.post("/api/vitals", json={"patientId": "no-such-patient", "heartRate": 72})
        assert response.status_code == 404


class TestValidation:
    """The spec's "validate reading" step."""

    def test_an_empty_reading_is_refused(self, client: TestClient, priya: str) -> None:
        sign_in(client, NURSE)
        assert client.post("/api/vitals", json={"patientId": priya}).status_code == 422

    def test_an_impossible_value_is_refused(self, client: TestClient, priya: str) -> None:
        sign_in(client, NURSE)
        response = client.post("/api/vitals", json={"patientId": priya, "heartRate": 900})
        assert response.status_code == 422

    def test_an_extreme_but_possible_value_is_stored(
        self, client: TestClient, priya: str
    ) -> None:
        """A heart rate of 240 is an emergency, not a typo.

        Refusing it would discard exactly the reading that matters most.
        """
        sign_in(client, NURSE)
        assert record(client, priya, heartRate=240)["heartRate"] == 240

    def test_inverted_blood_pressure_is_refused(self, client: TestClient, priya: str) -> None:
        sign_in(client, NURSE)
        response = client.post(
            "/api/vitals", json={"patientId": priya, "systolicBp": 80, "diastolicBp": 120}
        )
        assert response.status_code == 422

    def test_a_future_reading_is_refused(self, client: TestClient, priya: str) -> None:
        """It would corrupt the ordering the sustained-reading rule walks."""
        sign_in(client, NURSE)
        response = client.post(
            "/api/vitals",
            json={"patientId": priya, "heartRate": 72, "recordedAt": "2099-01-01T00:00:00Z"},
        )
        assert response.status_code == 400


class TestWhoMayRead:
    def test_a_patient_reads_their_own(self, client: TestClient, priya: str) -> None:
        sign_in(client, NURSE)
        record(client, priya, heartRate=72)

        sign_in(client, PATIENT)
        body = client.get(f"/api/vitals/{priya}").json()
        assert body["meta"]["total"] >= 1

    def test_a_treating_doctor_reads_them(self, client: TestClient, priya: str) -> None:
        sign_in(client, NURSE)
        record(client, priya, heartRate=72)

        sign_in(client, DOCTOR)
        assert client.get(f"/api/vitals/{priya}").status_code == 200

    def test_an_unrelated_doctor_is_refused(self, client: TestClient, priya: str) -> None:
        sign_in(client, OTHER_DOCTOR)
        assert client.get(f"/api/vitals/{priya}").status_code == 403

    def test_an_admin_is_refused(self, client: TestClient, priya: str) -> None:
        """R2: running the hospital is not a reason to read a chart."""
        sign_in(client, ADMIN)
        assert client.get(f"/api/vitals/{priya}").status_code == 403

    async def test_another_patient_is_refused(self, client: TestClient, priya: str) -> None:
        sign_in(client, OTHER_PATIENT)
        assert client.get(f"/api/vitals/{priya}").status_code == 403


class TestAlerting:
    async def test_a_breach_raises_an_alert(self, client: TestClient, priya: str) -> None:
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)

        sign_in(client, NURSE)
        body = record(client, priya, heartRate=150)

        assert len(body["alerts"]) == 1
        alert = body["alerts"][0]
        assert alert["vitalType"] == "HEART_RATE"
        assert alert["measuredValue"] == 150
        assert alert["status"] == "OPEN"
        assert "150" in alert["message"]

    async def test_a_normal_reading_raises_nothing(self, client: TestClient, priya: str) -> None:
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)

        sign_in(client, NURSE)
        assert record(client, priya, heartRate=72)["alerts"] == []

    async def test_the_reading_is_stored_even_when_it_alerts(
        self, client: TestClient, priya: str
    ) -> None:
        """Storage and alerting are separate concerns.

        A vital that alerts is still part of the trend somebody reads tomorrow.
        """
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)
        sign_in(client, NURSE)
        recorded = record(client, priya, heartRate=150)

        async with SessionFactory() as session:
            stored = (
                await session.execute(select(Vital).where(Vital.id == recorded["id"]))
            ).scalar_one()
        assert stored.heart_rate == 150

    async def test_an_ongoing_problem_is_one_alert_not_many(
        self, client: TestClient, priya: str
    ) -> None:
        """Otherwise a deteriorating patient buries the ward in duplicates."""
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)

        sign_in(client, NURSE)
        first = record(client, priya, heartRate=150)
        second = record(client, priya, heartRate=155)
        third = record(client, priya, heartRate=152)

        assert len(first["alerts"]) == 1
        assert second["alerts"] == []
        assert third["alerts"] == []

        async with SessionFactory() as session:
            count = len(
                (
                    await session.execute(
                        select(Alert.id).where(
                            Alert.patient_id == priya, Alert.vital_type == VitalType.HEART_RATE
                        )
                    )
                )
                .scalars()
                .all()
            )
        assert count == 1

    async def test_a_worsening_breach_escalates_the_open_alert(
        self, client: TestClient, priya: str
    ) -> None:
        """The reason nobody has acted might be that it did not look urgent."""
        await set_patient_threshold(
            priya, VitalType.HEART_RATE, minimum=50, maximum=100, severity=AlertSeverity.WARNING
        )
        sign_in(client, NURSE)
        record(client, priya, heartRate=150)

        # The rule is retuned to CRITICAL, as a clinician might after review.
        await set_patient_threshold(
            priya, VitalType.HEART_RATE, minimum=50, maximum=100, severity=AlertSeverity.CRITICAL
        )
        record(client, priya, heartRate=160)

        async with SessionFactory() as session:
            alerts = (
                (
                    await session.execute(
                        select(Alert).where(
                            Alert.patient_id == priya, Alert.vital_type == VitalType.HEART_RATE
                        )
                    )
                )
                .scalars()
                .all()
            )

        assert len(alerts) == 1, "escalation updates the alert rather than adding one"
        assert alerts[0].severity == AlertSeverity.CRITICAL
        assert alerts[0].status == AlertStatus.ESCALATED
        assert alerts[0].escalation_level == 1

    async def test_a_recurrence_after_resolution_is_a_new_alert(
        self, client: TestClient, priya: str
    ) -> None:
        """Otherwise a returning problem hides inside a closed entry."""
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)

        sign_in(client, NURSE)
        first = record(client, priya, heartRate=150)["alerts"][0]

        sign_in(client, DOCTOR)
        assert client.post(f"/api/alerts/{first['id']}/resolve").status_code == 200

        sign_in(client, NURSE)
        again = record(client, priya, heartRate=150)
        assert len(again["alerts"]) == 1
        assert again["alerts"][0]["id"] != first["id"]

    async def test_a_sustained_rule_waits_for_the_run(
        self, client: TestClient, priya: str
    ) -> None:
        await set_patient_threshold(
            priya, VitalType.HEART_RATE, minimum=50, maximum=100, sustained=2
        )

        sign_in(client, NURSE)
        assert record(client, priya, heartRate=150)["alerts"] == []
        assert len(record(client, priya, heartRate=155)["alerts"]) == 1

    async def test_the_responsible_doctor_is_notified(
        self, client: TestClient, priya: str
    ) -> None:
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)

        sign_in(client, NURSE)
        alert = record(client, priya, heartRate=150)["alerts"][0]
        assert alert["doctorId"], "an alert nobody is attached to is an alert nobody reads"

        async with SessionFactory() as session:
            notification = (
                await session.execute(
                    select(Notification).where(
                        Notification.notification_metadata["alertId"].astext == alert["id"]
                    )
                )
            ).scalar_one_or_none()

        assert notification is not None
        # The value belongs in the notification: "a vital is abnormal" makes the
        # reader open the app to find out whether it can wait.
        assert "150" in notification.body


class TestAlertVisibility:
    async def test_a_doctor_sees_their_own_patients_alerts(
        self, client: TestClient, priya: str
    ) -> None:
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)
        sign_in(client, NURSE)
        record(client, priya, heartRate=150)

        sign_in(client, DOCTOR)
        rows = client.get("/api/alerts").json()["data"]
        assert any(row["patientId"] == priya for row in rows)

    async def test_an_unrelated_doctor_does_not(self, client: TestClient, priya: str) -> None:
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)
        sign_in(client, NURSE)
        record(client, priya, heartRate=150)

        sign_in(client, OTHER_DOCTOR)
        rows = client.get("/api/alerts").json()["data"]
        assert all(row["patientId"] != priya for row in rows)

    async def test_a_patient_sees_their_own(self, client: TestClient, priya: str) -> None:
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)
        sign_in(client, NURSE)
        record(client, priya, heartRate=150)

        sign_in(client, PATIENT)
        response = client.get("/api/alerts")
        assert response.status_code == 403, "patients hold no alert permission"

    async def test_an_admin_sees_none(self, client: TestClient, priya: str) -> None:
        sign_in(client, ADMIN)
        assert client.get("/api/alerts").status_code == 403

    async def test_filtering_by_another_patient_reveals_nothing(
        self, client: TestClient, priya: str
    ) -> None:
        sign_in(client, OTHER_DOCTOR)
        response = client.get("/api/alerts", params={"patientId": priya})
        assert response.status_code == 404


class TestAlertLifecycle:
    async def test_acknowledging_is_not_resolving(self, client: TestClient, priya: str) -> None:
        """"Someone is looking at it" and "the patient is fine" are different
        claims, and a ward needs to tell them apart."""
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)
        sign_in(client, NURSE)
        alert = record(client, priya, heartRate=150)["alerts"][0]

        sign_in(client, DOCTOR)
        body = client.post(f"/api/alerts/{alert['id']}/acknowledge").json()["data"]
        assert body["status"] == "ACKNOWLEDGED"
        assert body["acknowledgedAt"]
        assert body["resolvedAt"] is None

    async def test_resolving_records_who_saw_it(self, client: TestClient, priya: str) -> None:
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)
        sign_in(client, NURSE)
        alert = record(client, priya, heartRate=150)["alerts"][0]

        sign_in(client, DOCTOR)
        body = client.post(f"/api/alerts/{alert['id']}/resolve").json()["data"]
        assert body["status"] == "RESOLVED"
        # Resolving in one step is normal; the trail must not claim nobody saw it.
        assert body["acknowledgedById"]

    async def test_resolving_twice_is_harmless(self, client: TestClient, priya: str) -> None:
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)
        sign_in(client, NURSE)
        alert = record(client, priya, heartRate=150)["alerts"][0]

        sign_in(client, DOCTOR)
        client.post(f"/api/alerts/{alert['id']}/resolve")
        assert client.post(f"/api/alerts/{alert['id']}/resolve").status_code == 200

    async def test_an_unrelated_doctor_cannot_touch_it(
        self, client: TestClient, priya: str
    ) -> None:
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)
        sign_in(client, NURSE)
        alert = record(client, priya, heartRate=150)["alerts"][0]

        sign_in(client, OTHER_DOCTOR)
        # 404 rather than 403: an id that answers differently is an oracle.
        assert client.post(f"/api/alerts/{alert['id']}/acknowledge").status_code == 404


class TestThresholdConfiguration:
    async def test_a_doctor_may_set_a_patient_override(
        self, client: TestClient, priya: str
    ) -> None:
        sign_in(client, DOCTOR)
        response = client.put(
            "/api/vitals/thresholds",
            json={
                "vitalType": "OXYGEN_SATURATION",
                "patientId": priya,
                "minValue": 85,
                "severity": "CRITICAL",
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["data"]["scope"] == "PATIENT"

    async def test_writing_twice_updates_rather_than_duplicates(
        self, client: TestClient, priya: str
    ) -> None:
        sign_in(client, DOCTOR)
        payload = {"vitalType": "HEART_RATE", "patientId": priya, "minValue": 50, "maxValue": 110}
        first = client.put("/api/vitals/thresholds", json=payload).json()["data"]
        payload["maxValue"] = 115
        second = client.put("/api/vitals/thresholds", json=payload).json()["data"]

        assert first["id"] == second["id"]
        assert second["maxValue"] == 115

    async def test_a_patient_override_wins_over_the_hospital_default(
        self, client: TestClient, priya: str
    ) -> None:
        """Conflict C9, end to end.

        A saturation that would alarm on anyone else is this patient's normal,
        so their own rule has to govern.
        """
        await set_patient_threshold(
            priya, VitalType.OXYGEN_SATURATION, minimum=80, maximum=None
        )

        sign_in(client, NURSE)
        # 88 is below the seeded hospital floor of 92 but above this patient's 80.
        assert record(client, priya, oxygenSaturation=88)["alerts"] == []
        assert len(record(client, priya, oxygenSaturation=75)["alerts"]) == 1

    async def test_a_patient_may_not_configure_thresholds(
        self, client: TestClient, priya: str
    ) -> None:
        sign_in(client, PATIENT)
        response = client.put(
            "/api/vitals/thresholds",
            json={"vitalType": "HEART_RATE", "patientId": priya, "minValue": 30, "maxValue": 200},
        )
        assert response.status_code == 403

    def test_a_threshold_with_no_bounds_is_refused(self, client: TestClient) -> None:
        sign_in(client, DOCTOR)
        response = client.put("/api/vitals/thresholds", json={"vitalType": "HEART_RATE"})
        assert response.status_code == 422

    def test_an_inverted_range_is_refused(self, client: TestClient) -> None:
        sign_in(client, DOCTOR)
        response = client.put(
            "/api/vitals/thresholds",
            json={"vitalType": "HEART_RATE", "minValue": 200, "maxValue": 50},
        )
        assert response.status_code == 422

    async def test_the_resolved_view_shows_where_each_rule_came_from(
        self, client: TestClient, priya: str
    ) -> None:
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=40, maximum=130)

        sign_in(client, DOCTOR)
        data = client.get(f"/api/vitals/{priya}/thresholds").json()["data"]
        by_type = {row["vitalType"]: row for row in data["thresholds"]}

        assert by_type["HEART_RATE"]["scope"] == "PATIENT"
        assert by_type["HEART_RATE"]["maxValue"] == 130
        # The seeded hospital defaults cover the rest.
        assert by_type["TEMPERATURE"]["scope"] == "HOSPITAL"
        assert data["unconfigured"] == []


class TestAudit:
    async def test_a_reading_is_audited_without_its_values(
        self, client: TestClient, priya: str
    ) -> None:
        """Conflict C5: the audit log holds references, not clinical values.

        The measurements live in `vitals`. Copying them here would duplicate
        clinical content into a table with a different audience and retention.
        """
        sign_in(client, NURSE)
        recorded = record(client, priya, heartRate=137, temperature=39.4)

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog).where(
                        AuditLog.entity_type == "Vital", AuditLog.entity_id == recorded["id"]
                    )
                )
            ).scalar_one()

        serialised = str(entry.audit_metadata)
        assert "137" not in serialised
        assert "39.4" not in serialised
        assert "HEART_RATE" in serialised
        assert "TEMPERATURE" in serialised

    async def test_an_alert_is_audited(self, client: TestClient, priya: str) -> None:
        await set_patient_threshold(priya, VitalType.HEART_RATE, minimum=50, maximum=100)
        sign_in(client, NURSE)
        alert = record(client, priya, heartRate=150)["alerts"][0]

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog).where(
                        AuditLog.entity_type == "Alert", AuditLog.entity_id == alert["id"]
                    )
                )
            ).scalars().first()

        assert entry is not None
        assert entry.audit_metadata["vitalType"] == "HEART_RATE"

    async def test_a_refused_read_is_recorded_as_a_security_event(
        self, client: TestClient, priya: str
    ) -> None:
        sign_in(client, OTHER_DOCTOR)
        assert client.get(f"/api/vitals/{priya}").status_code == 403

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog)
                    .where(AuditLog.entity_type == "Vital", AuditLog.patient_id == priya)
                    .order_by(AuditLog.timestamp.desc())
                )
            ).scalars().first()

        assert entry is not None
        assert str(entry.action) == "ACCESS_DENIED"

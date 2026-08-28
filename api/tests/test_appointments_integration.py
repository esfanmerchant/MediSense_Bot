"""Appointments end to end, against the real database (R7, spec §14).

The rules worth proving here are the ones that only hold when Postgres is
actually involved: that the unique slot key — not an availability check — is
what stops double booking, that cancelling releases the slot, and that a
patient's scope is applied as a query filter rather than a check they might slip
past.

Every appointment these tests create is deleted afterwards. Audit entries are
deliberately *not* cleaned up: the log is append-only and hash-chained, so
removing rows is exactly the tampering ``verify_audit_chain`` exists to detect.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.db.enums import AppointmentStatus
from app.db.models import Appointment, Doctor, Notification, Patient, User
from app.db.session import SessionFactory
from tests.conftest import requires_db

pytestmark = requires_db

DEMO_PASSWORD = "Demo@Pass123"

ADMIN = "admin@example.com"
DOCTOR = "doctor@example.com"  # Cardiology — treats Priya and Vikram
OTHER_DOCTOR = "doctor3@example.com"  # General Medicine — treats Meera
PATIENT = "patient@example.com"  # Priya
OTHER_PATIENT = "patient3@example.com"  # Meera
NURSE = "nurse@example.com"


def sign_in(client: TestClient, email: str) -> dict[str, Any]:
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": email, "password": DEMO_PASSWORD})
    assert response.status_code == 200, f"{email}: {response.text}"
    return response.json()["data"]["user"]


class Booked:
    """Tracks every appointment a test creates so teardown can remove it."""

    def __init__(self) -> None:
        self.ids: set[str] = set()

    def track(self, response: Any) -> dict[str, Any]:
        assert response.status_code in (200, 201), response.text
        data = response.json()["data"]
        self.ids.add(data["id"])
        if data.get("rescheduledFromId"):
            self.ids.add(data["rescheduledFromId"])
        return data


@pytest.fixture
async def booked() -> AsyncIterator[Booked]:
    registry = Booked()
    yield registry
    if not registry.ids:
        return
    async with SessionFactory() as session:
        await session.execute(
            delete(Notification).where(
                Notification.notification_metadata["appointmentId"].astext.in_(registry.ids)
            )
        )
        await session.execute(delete(Appointment).where(Appointment.id.in_(registry.ids)))
        await session.commit()


@pytest.fixture
def patient_client(client: TestClient) -> TestClient:
    sign_in(client, PATIENT)
    yield client
    client.cookies.clear()


async def doctor_id_for(email: str) -> str:
    async with SessionFactory() as session:
        return (
            await session.execute(
                select(Doctor.id).join(User, User.id == Doctor.user_id).where(User.email == email)
            )
        ).scalar_one()


async def patient_id_for(email: str) -> str:
    async with SessionFactory() as session:
        return (
            await session.execute(
                select(Patient.id).join(User, User.id == Patient.user_id).where(User.email == email)
            )
        ).scalar_one()


def free_slots(client: TestClient, doctor_id: str) -> list[dict[str, Any]]:
    """Every bookable slot the doctor is currently offering."""
    response = client.get("/api/appointments/availability", params={"doctorId": doctor_id})
    assert response.status_code == 200, response.text
    return [
        slot
        for day in response.json()["data"]["days"]
        for slot in day["slots"]
        if slot["available"]
    ]


def a_free_slot(client: TestClient, doctor_id: str, index: int = 0) -> str:
    slots = free_slots(client, doctor_id)
    assert len(slots) > index, "the seeded doctor has no free slots to book"
    return slots[index]["startTime"]


def book(
    client: TestClient, doctor_id: str, start: str, **extra: Any
) -> Any:
    return client.post(
        "/api/appointments", json={"doctorId": doctor_id, "startTime": start, **extra}
    )


class TestAvailability:
    async def test_a_patient_can_browse_a_doctors_slots(self, patient_client: TestClient) -> None:
        doctor = await doctor_id_for(DOCTOR)
        body = patient_client.get(
            "/api/appointments/availability", params={"doctorId": doctor}
        ).json()["data"]

        assert body["doctorId"] == doctor
        assert body["timezone"]  # clients need it to label the times
        assert any(day["availableCount"] > 0 for day in body["days"])

    async def test_availability_names_no_one(self, patient_client: TestClient) -> None:
        # Free/busy only: a patient browsing a calendar must not learn who holds
        # the taken slots.
        doctor = await doctor_id_for(DOCTOR)
        text = patient_client.get(
            "/api/appointments/availability", params={"doctorId": doctor}
        ).text
        for leaked in ("patientId", "Priya", "medicalRecordNumber", "reason"):
            assert leaked not in text

    async def test_a_booked_slot_stops_being_offered(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        slot = a_free_slot(patient_client, doctor)
        booked.track(book(patient_client, doctor, slot))

        still_offered = {s["startTime"] for s in free_slots(patient_client, doctor)}
        assert slot not in still_offered

    async def test_it_refuses_an_unreasonable_range(self, patient_client: TestClient) -> None:
        doctor = await doctor_id_for(DOCTOR)
        response = patient_client.get(
            "/api/appointments/availability",
            params={"doctorId": doctor, "from": "2026-01-01", "to": "2027-01-01"},
        )
        assert response.status_code == 400

    def test_an_unknown_doctor_is_not_found(self, patient_client: TestClient) -> None:
        response = patient_client.get(
            "/api/appointments/availability", params={"doctorId": "cdoesnotexist"}
        )
        assert response.status_code == 404


class TestBooking:
    async def test_a_patient_books_their_own_appointment(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        slot = a_free_slot(patient_client, doctor)

        data = booked.track(book(patient_client, doctor, slot, reason="Follow-up"))

        assert data["status"] == AppointmentStatus.REQUESTED
        assert data["patientId"] == await patient_id_for(PATIENT)
        assert data["startTime"] == slot
        assert data["doctorName"]

    async def test_the_same_slot_cannot_be_booked_twice(
        self, client: TestClient, booked: Booked
    ) -> None:
        """The unique index is what prevents this, not a prior availability read."""
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        slot = a_free_slot(client, doctor)
        booked.track(book(client, doctor, slot))

        # A different patient, same doctor, same instant.
        sign_in(client, OTHER_PATIENT)
        clash = book(client, doctor, slot)
        client.cookies.clear()

        assert clash.status_code == 409
        assert clash.json()["error"]["code"] == "SLOT_UNAVAILABLE"

    async def test_a_patient_cannot_book_on_someone_elses_behalf(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        """A patientId in the body is ignored, not honoured (spec §8)."""
        doctor = await doctor_id_for(DOCTOR)
        slot = a_free_slot(patient_client, doctor)
        someone_else = await patient_id_for(OTHER_PATIENT)

        data = booked.track(book(patient_client, doctor, slot, patientId=someone_else))

        assert data["patientId"] == await patient_id_for(PATIENT)
        assert data["patientId"] != someone_else

    async def test_a_time_off_the_slot_grid_is_refused(
        self, patient_client: TestClient
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        slot = a_free_slot(patient_client, doctor)
        # Five minutes past a real slot: inside the working day, off the grid,
        # and overlapping the slots on either side of it.
        offset = slot.replace(":00:00Z", ":05:00Z") if ":00:00Z" in slot else None
        if offset is None:  # a :30 slot
            offset = slot.replace(":30:00Z", ":35:00Z")

        response = book(patient_client, doctor, offset)
        assert response.status_code == 400

    async def test_a_time_in_the_past_is_refused(self, patient_client: TestClient) -> None:
        doctor = await doctor_id_for(DOCTOR)
        response = book(patient_client, doctor, "2020-01-06T03:30:00Z")
        assert response.status_code == 400

    async def test_a_patient_cannot_hold_two_appointments_at_once(
        self, client: TestClient, booked: Booked
    ) -> None:
        """The slot key stops two patients sharing a doctor's slot; it says
        nothing about one patient booking two doctors for the same hour."""
        sign_in(client, PATIENT)
        first_doctor = await doctor_id_for(DOCTOR)
        second_doctor = await doctor_id_for(OTHER_DOCTOR)

        slot = a_free_slot(client, first_doctor)
        booked.track(book(client, first_doctor, slot))

        clash = book(client, second_doctor, slot)
        client.cookies.clear()

        assert clash.status_code == 409
        assert "already have an appointment" in clash.json()["error"]["message"]

    async def test_an_admin_books_on_a_patients_behalf(
        self, client: TestClient, booked: Booked
    ) -> None:
        sign_in(client, ADMIN)
        doctor = await doctor_id_for(DOCTOR)
        target = await patient_id_for(OTHER_PATIENT)
        slot = a_free_slot(client, doctor)

        data = booked.track(book(client, doctor, slot, patientId=target))
        client.cookies.clear()

        assert data["patientId"] == target

    async def test_an_admin_must_say_who_they_are_booking_for(
        self, client: TestClient
    ) -> None:
        sign_in(client, ADMIN)
        doctor = await doctor_id_for(DOCTOR)
        slot = a_free_slot(client, doctor)

        response = book(client, doctor, slot)
        client.cookies.clear()

        assert response.status_code == 400

    async def test_a_doctor_cannot_book_appointments(self, client: TestClient) -> None:
        # Doctors hold no booking permission; the front desk or the patient books.
        sign_in(client, DOCTOR)
        doctor = await doctor_id_for(DOCTOR)
        slot = a_free_slot(client, doctor)
        response = book(client, doctor, slot, patientId=await patient_id_for(PATIENT))
        client.cookies.clear()

        assert response.status_code == 403

    def test_a_nurse_reaches_no_appointment_endpoint(self, client: TestClient) -> None:
        sign_in(client, NURSE)
        assert client.get("/api/appointments").status_code == 403
        client.cookies.clear()


class TestScoping:
    async def test_a_patient_sees_only_their_own_appointments(
        self, client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, ADMIN)
        other = await patient_id_for(OTHER_PATIENT)
        theirs = booked.track(book(client, doctor, a_free_slot(client, doctor), patientId=other))

        sign_in(client, PATIENT)
        listed = {row["id"] for row in client.get("/api/appointments").json()["data"]}
        direct = client.get(f"/api/appointments/{theirs['id']}")
        client.cookies.clear()

        assert theirs["id"] not in listed
        # 404, not 403: confirming it exists would confirm another patient's
        # booking.
        assert direct.status_code == 404

    async def test_a_doctor_sees_their_own_calendar_only(
        self, client: TestClient, booked: Booked
    ) -> None:
        other_doctor = await doctor_id_for(OTHER_DOCTOR)
        sign_in(client, OTHER_PATIENT)
        elsewhere = booked.track(
            book(client, other_doctor, a_free_slot(client, other_doctor))
        )

        sign_in(client, DOCTOR)
        listed = {row["id"] for row in client.get("/api/appointments").json()["data"]}
        client.cookies.clear()

        assert elsewhere["id"] not in listed

    async def test_a_doctor_sees_appointments_booked_with_them(
        self, client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        mine = booked.track(book(client, doctor, a_free_slot(client, doctor)))

        sign_in(client, DOCTOR)
        response = client.get(f"/api/appointments/{mine['id']}")
        client.cookies.clear()

        assert response.status_code == 200
        # The treating doctor legitimately sees who they are seeing.
        assert response.json()["data"]["patientName"]

    async def test_an_admin_sees_every_appointment(
        self, client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        mine = booked.track(book(client, doctor, a_free_slot(client, doctor)))

        sign_in(client, ADMIN)
        response = client.get(f"/api/appointments/{mine['id']}")
        client.cookies.clear()

        assert response.status_code == 200

    async def test_a_patients_filter_cannot_widen_their_scope(
        self, client: TestClient, booked: Booked
    ) -> None:
        """Query parameters narrow the caller's scope; they never widen it."""
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, ADMIN)
        other = await patient_id_for(OTHER_PATIENT)
        booked.track(book(client, doctor, a_free_slot(client, doctor), patientId=other))

        sign_in(client, PATIENT)
        body = client.get("/api/appointments", params={"patientId": other}).json()
        client.cookies.clear()

        assert body["data"] == []
        assert body["meta"]["total"] == 0


class TestCancellation:
    async def test_cancelling_releases_the_slot(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        slot = a_free_slot(patient_client, doctor)
        first = booked.track(book(patient_client, doctor, slot))

        cancelled = patient_client.post(
            f"/api/appointments/{first['id']}/cancel", json={"reason": "Cannot attend"}
        )
        assert cancelled.status_code == 200
        assert cancelled.json()["data"]["status"] == AppointmentStatus.CANCELLED

        # The freed slot is bookable again — this is the nullable slot key
        # working: Postgres permits many NULLs in a unique index.
        again = book(patient_client, doctor, slot)
        booked.track(again)
        assert again.status_code == 201

    async def test_the_slot_key_is_cleared_on_cancellation(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        appointment = booked.track(
            book(patient_client, doctor, a_free_slot(patient_client, doctor))
        )
        patient_client.post(f"/api/appointments/{appointment['id']}/cancel", json={})

        async with SessionFactory() as session:
            slot_key = (
                await session.execute(
                    select(Appointment.slot_key).where(Appointment.id == appointment["id"])
                )
            ).scalar_one()
        assert slot_key is None

    async def test_a_completed_consultation_keeps_its_slot(
        self, client: TestClient, booked: Booked
    ) -> None:
        """Cancellation is the only thing that frees a slot.

        A completed consultation used the doctor's time. If completing released
        the slot, a status change made ahead of the appointment would hand the
        same time to a second patient — and availability, which counts anything
        uncancelled as taken, would disagree with the unique index.
        """
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        slot = a_free_slot(client, doctor)
        appointment = booked.track(book(client, doctor, slot))

        sign_in(client, DOCTOR)
        for status in ("CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED"):
            client.post(f"/api/appointments/{appointment['id']}/status", json={"status": status})

        sign_in(client, OTHER_PATIENT)
        rebooked = book(client, doctor, slot)
        offered = {s["startTime"] for s in free_slots(client, doctor)}
        client.cookies.clear()

        assert rebooked.status_code == 409
        # Availability and the database agree: the slot is gone, not offered.
        assert slot not in offered

    async def test_a_cancelled_appointment_cannot_be_cancelled_again(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        appointment = booked.track(
            book(patient_client, doctor, a_free_slot(patient_client, doctor))
        )
        patient_client.post(f"/api/appointments/{appointment['id']}/cancel", json={})

        repeat = patient_client.post(f"/api/appointments/{appointment['id']}/cancel", json={})
        assert repeat.status_code == 409

    async def test_an_unrelated_patient_cannot_cancel(
        self, client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        mine = booked.track(book(client, doctor, a_free_slot(client, doctor)))

        sign_in(client, OTHER_PATIENT)
        response = client.post(f"/api/appointments/{mine['id']}/cancel", json={})
        client.cookies.clear()

        assert response.status_code == 404

    async def test_the_treating_doctor_may_cancel(
        self, client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        appointment = booked.track(book(client, doctor, a_free_slot(client, doctor)))

        sign_in(client, DOCTOR)
        response = client.post(
            f"/api/appointments/{appointment['id']}/cancel", json={"reason": "Called away"}
        )
        client.cookies.clear()

        assert response.status_code == 200


class TestRescheduling:
    async def test_rescheduling_links_the_new_appointment_to_the_old(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        slots = free_slots(patient_client, doctor)
        original = booked.track(book(patient_client, doctor, slots[0]["startTime"]))

        moved = patient_client.post(
            f"/api/appointments/{original['id']}/reschedule",
            json={"startTime": slots[1]["startTime"]},
        )
        data = booked.track(moved)

        assert data["id"] != original["id"]
        assert data["rescheduledFromId"] == original["id"]
        assert data["startTime"] == slots[1]["startTime"]

    async def test_the_original_is_cancelled_and_its_slot_freed(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        slots = free_slots(patient_client, doctor)
        original = booked.track(book(patient_client, doctor, slots[0]["startTime"]))
        booked.track(
            patient_client.post(
                f"/api/appointments/{original['id']}/reschedule",
                json={"startTime": slots[1]["startTime"]},
            )
        )

        previous = patient_client.get(f"/api/appointments/{original['id']}").json()["data"]
        assert previous["status"] == AppointmentStatus.CANCELLED

        still_offered = {s["startTime"] for s in free_slots(patient_client, doctor)}
        assert slots[0]["startTime"] in still_offered

    async def test_rescheduling_to_the_current_time_is_refused(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        slot = a_free_slot(patient_client, doctor)
        appointment = booked.track(book(patient_client, doctor, slot))

        response = patient_client.post(
            f"/api/appointments/{appointment['id']}/reschedule", json={"startTime": slot}
        )
        assert response.status_code == 400

    async def test_a_completed_appointment_cannot_be_rescheduled(
        self, client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        slots = free_slots(client, doctor)
        appointment = booked.track(book(client, doctor, slots[0]["startTime"]))

        sign_in(client, DOCTOR)
        for status in ("CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED"):
            advanced = client.post(
                f"/api/appointments/{appointment['id']}/status", json={"status": status}
            )
            assert advanced.status_code == 200, advanced.text

        sign_in(client, PATIENT)
        response = client.post(
            f"/api/appointments/{appointment['id']}/reschedule",
            json={"startTime": slots[1]["startTime"]},
        )
        client.cookies.clear()

        assert response.status_code == 409


class TestConsultationLifecycle:
    async def test_a_doctor_walks_the_consultation_to_completion(
        self, client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        appointment = booked.track(book(client, doctor, a_free_slot(client, doctor)))

        sign_in(client, DOCTOR)
        for status in ("CONFIRMED", "CHECKED_IN", "IN_PROGRESS"):
            step = client.post(
                f"/api/appointments/{appointment['id']}/status", json={"status": status}
            )
            assert step.status_code == 200, step.text

        done = client.post(
            f"/api/appointments/{appointment['id']}/status",
            json={"status": "COMPLETED", "notes": "Reviewed vitals; continue current dose."},
        )
        client.cookies.clear()

        assert done.status_code == 200
        assert done.json()["data"]["status"] == AppointmentStatus.COMPLETED
        assert done.json()["data"]["completedAt"]

    async def test_a_consultation_cannot_skip_to_completed(
        self, client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        appointment = booked.track(book(client, doctor, a_free_slot(client, doctor)))

        sign_in(client, DOCTOR)
        response = client.post(
            f"/api/appointments/{appointment['id']}/status", json={"status": "COMPLETED"}
        )
        client.cookies.clear()

        assert response.status_code == 409

    async def test_a_patient_cannot_confirm_their_own_appointment(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        appointment = booked.track(
            book(patient_client, doctor, a_free_slot(patient_client, doctor))
        )

        response = patient_client.post(
            f"/api/appointments/{appointment['id']}/status", json={"status": "CONFIRMED"}
        )
        assert response.status_code == 403

    async def test_an_admin_cannot_complete_a_consultation(
        self, client: TestClient, booked: Booked
    ) -> None:
        """Administration is separate from clinical content (R2): completing a
        consultation is a clinical act, and admins hold no such permission."""
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        appointment = booked.track(book(client, doctor, a_free_slot(client, doctor)))

        sign_in(client, DOCTOR)
        for status in ("CONFIRMED", "CHECKED_IN", "IN_PROGRESS"):
            client.post(f"/api/appointments/{appointment['id']}/status", json={"status": status})

        sign_in(client, ADMIN)
        response = client.post(
            f"/api/appointments/{appointment['id']}/status", json={"status": "COMPLETED"}
        )
        client.cookies.clear()

        assert response.status_code == 403

    async def test_only_the_treating_doctor_can_add_notes(
        self, client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        appointment = booked.track(book(client, doctor, a_free_slot(client, doctor)))

        sign_in(client, ADMIN)
        response = client.post(
            f"/api/appointments/{appointment['id']}/status",
            json={"status": "CONFIRMED", "notes": "Administrative note"},
        )
        client.cookies.clear()

        # A refusal, not a malformed request: the admin may confirm this
        # appointment, just not write clinical content on it.
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "UNAUTHORIZED"

    async def test_cancellation_is_not_reachable_through_the_status_endpoint(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        appointment = booked.track(
            book(patient_client, doctor, a_free_slot(patient_client, doctor))
        )

        response = patient_client.post(
            f"/api/appointments/{appointment['id']}/status", json={"status": "CANCELLED"}
        )
        assert response.status_code == 400


class TestAuditAndNotifications:
    async def test_booking_writes_an_audit_entry_naming_the_patient(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        from app.db.enums import AuditAction
        from app.db.models import AuditLog

        doctor = await doctor_id_for(DOCTOR)
        appointment = booked.track(
            book(patient_client, doctor, a_free_slot(patient_client, doctor))
        )

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog).where(
                        AuditLog.action == AuditAction.APPOINTMENT_CREATED,
                        AuditLog.entity_id == appointment["id"],
                    )
                )
            ).scalar_one()

        assert entry.patient_id == appointment["patientId"]
        assert entry.entity_type == "Appointment"

    async def test_the_audit_metadata_carries_no_clinical_detail(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        """The reason for a visit is clinical content; it belongs in the record,
        not in a log read by administrators."""
        from app.db.enums import AuditAction
        from app.db.models import AuditLog

        doctor = await doctor_id_for(DOCTOR)
        secret = "Chest pain and dizziness"
        appointment = booked.track(
            book(patient_client, doctor, a_free_slot(patient_client, doctor), reason=secret)
        )

        async with SessionFactory() as session:
            entry = (
                await session.execute(
                    select(AuditLog).where(
                        AuditLog.action == AuditAction.APPOINTMENT_CREATED,
                        AuditLog.entity_id == appointment["id"],
                    )
                )
            ).scalar_one()

        assert secret not in str(entry.audit_metadata)

    async def test_booking_notifies_the_patient(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        appointment = booked.track(
            book(patient_client, doctor, a_free_slot(patient_client, doctor))
        )

        body = patient_client.get("/api/notifications", params={"unreadOnly": True}).json()
        titles = [row["title"] for row in body["data"]]

        assert "Appointment requested" in titles
        assert body["meta"]["unread"] >= 1
        assert any(row["link"] == f"/appointments/{appointment['id']}" for row in body["data"])

    async def test_a_notification_body_carries_no_clinical_detail(
        self, patient_client: TestClient, booked: Booked
    ) -> None:
        # Notifications reach lock screens and mail servers, which are outside
        # the access-control boundary the rest of the system maintains.
        doctor = await doctor_id_for(DOCTOR)
        secret = "Suspected arrhythmia"
        booked.track(
            book(patient_client, doctor, a_free_slot(patient_client, doctor), reason=secret)
        )

        text = patient_client.get("/api/notifications").text
        assert secret not in text

    async def test_a_notification_belongs_to_one_user_only(
        self, client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        booked.track(book(client, doctor, a_free_slot(client, doctor)))
        mine = client.get("/api/notifications").json()["data"]
        assert mine, "the booking should have produced a notification"

        sign_in(client, OTHER_PATIENT)
        theirs = {row["id"] for row in client.get("/api/notifications").json()["data"]}
        client.cookies.clear()

        assert not {row["id"] for row in mine} & theirs

    async def test_marking_another_users_notification_read_is_not_found(
        self, client: TestClient, booked: Booked
    ) -> None:
        doctor = await doctor_id_for(DOCTOR)
        sign_in(client, PATIENT)
        booked.track(book(client, doctor, a_free_slot(client, doctor)))
        target = client.get("/api/notifications").json()["data"][0]["id"]

        sign_in(client, OTHER_PATIENT)
        response = client.post(f"/api/notifications/{target}/read")
        client.cookies.clear()

        assert response.status_code == 404


class TestDoctorAvailabilityManagement:
    async def test_a_doctor_publishes_validated_windows(self, client: TestClient) -> None:
        sign_in(client, OTHER_DOCTOR)
        original = client.get("/api/doctors/me").json()["data"]["availability"]

        updated = client.patch(
            "/api/doctors/me",
            json={
                "availability": [
                    {"dayOfWeek": 1, "startTime": "10:00", "endTime": "13:00", "slotMinutes": 15}
                ]
            },
        )
        assert updated.status_code == 200
        assert updated.json()["data"]["availability"] == [
            {"dayOfWeek": 1, "startTime": "10:00", "endTime": "13:00", "slotMinutes": 15}
        ]

        # Restore the seeded calendar so later runs start where they started.
        client.patch("/api/doctors/me", json={"availability": original})
        client.cookies.clear()

    def test_overlapping_windows_are_refused(self, client: TestClient) -> None:
        sign_in(client, OTHER_DOCTOR)
        response = client.patch(
            "/api/doctors/me",
            json={
                "availability": [
                    {"dayOfWeek": 2, "startTime": "09:00", "endTime": "13:00"},
                    {"dayOfWeek": 2, "startTime": "12:00", "endTime": "17:00"},
                ]
            },
        )
        client.cookies.clear()

        assert response.status_code == 400
        assert "overlapping" in response.json()["error"]["message"]

    def test_a_malformed_window_is_refused(self, client: TestClient) -> None:
        sign_in(client, OTHER_DOCTOR)
        response = client.patch(
            "/api/doctors/me",
            json={"availability": [{"dayOfWeek": 9, "startTime": "25:00", "endTime": "01:00"}]},
        )
        client.cookies.clear()

        assert response.status_code == 422


class TestTimeOff:
    """Leave blocks out slots that would otherwise be offered."""

    @pytest.fixture
    def leave(self, client: TestClient) -> Iterator[list[str]]:
        """Removes any leave a test created, whichever way the test ends."""
        created: list[str] = []
        yield created
        sign_in(client, OTHER_DOCTOR)
        for time_off_id in created:
            client.delete(f"/api/doctors/me/time-off/{time_off_id}")
        client.cookies.clear()

    async def test_leave_removes_the_slots_it_covers(
        self, client: TestClient, leave: list[str]
    ) -> None:
        doctor = await doctor_id_for(OTHER_DOCTOR)
        sign_in(client, OTHER_PATIENT)
        before = free_slots(client, doctor)
        assert before, "the doctor should have free slots to block out"
        target = before[0]

        sign_in(client, OTHER_DOCTOR)
        created = client.post(
            "/api/doctors/me/time-off",
            json={
                "startsAt": target["startTime"],
                "endsAt": target["endTime"],
                "reason": "Conference",
            },
        )
        assert created.status_code == 201, created.text
        leave.append(created.json()["data"]["id"])

        sign_in(client, OTHER_PATIENT)
        offered = {slot["startTime"] for slot in free_slots(client, doctor)}
        blocked = book(client, doctor, target["startTime"])
        client.cookies.clear()

        assert target["startTime"] not in offered
        assert blocked.status_code == 409
        assert "unavailable" in blocked.json()["error"]["message"]

    async def test_leave_over_a_booked_slot_is_refused(
        self, client: TestClient, booked: Booked
    ) -> None:
        """Silently stranding a booked patient is worse than making the doctor
        deal with it — they know who needs a call, the system does not."""
        doctor = await doctor_id_for(OTHER_DOCTOR)
        sign_in(client, OTHER_PATIENT)
        slot = free_slots(client, doctor)[0]
        booked.track(book(client, doctor, slot["startTime"]))

        sign_in(client, OTHER_DOCTOR)
        refused = client.post(
            "/api/doctors/me/time-off",
            json={"startsAt": slot["startTime"], "endsAt": slot["endTime"]},
        )
        client.cookies.clear()

        assert refused.status_code == 409
        assert "Cancel or move them first" in refused.json()["error"]["message"]

    async def test_removing_leave_frees_the_slots_again(
        self, client: TestClient
    ) -> None:
        doctor = await doctor_id_for(OTHER_DOCTOR)
        sign_in(client, OTHER_PATIENT)
        target = free_slots(client, doctor)[0]

        sign_in(client, OTHER_DOCTOR)
        time_off_id = client.post(
            "/api/doctors/me/time-off",
            json={"startsAt": target["startTime"], "endsAt": target["endTime"]},
        ).json()["data"]["id"]
        removed = client.delete(f"/api/doctors/me/time-off/{time_off_id}")
        assert removed.status_code == 200

        sign_in(client, OTHER_PATIENT)
        offered = {slot["startTime"] for slot in free_slots(client, doctor)}
        client.cookies.clear()

        assert target["startTime"] in offered

    def test_overlapping_leave_is_refused(self, client: TestClient, leave: list[str]) -> None:
        sign_in(client, OTHER_DOCTOR)
        first = client.post(
            "/api/doctors/me/time-off",
            json={"startsAt": "2027-03-01T00:00:00Z", "endsAt": "2027-03-08T00:00:00Z"},
        )
        assert first.status_code == 201
        leave.append(first.json()["data"]["id"])

        overlapping = client.post(
            "/api/doctors/me/time-off",
            json={"startsAt": "2027-03-05T00:00:00Z", "endsAt": "2027-03-10T00:00:00Z"},
        )
        client.cookies.clear()

        assert overlapping.status_code == 409

    def test_leave_that_ends_before_it_starts_is_refused(self, client: TestClient) -> None:
        sign_in(client, OTHER_DOCTOR)
        response = client.post(
            "/api/doctors/me/time-off",
            json={"startsAt": "2027-03-08T00:00:00Z", "endsAt": "2027-03-01T00:00:00Z"},
        )
        client.cookies.clear()

        assert response.status_code == 422

    def test_leave_in_the_past_is_refused(self, client: TestClient) -> None:
        sign_in(client, OTHER_DOCTOR)
        response = client.post(
            "/api/doctors/me/time-off",
            json={"startsAt": "2020-01-01T00:00:00Z", "endsAt": "2020-01-05T00:00:00Z"},
        )
        client.cookies.clear()

        assert response.status_code == 400

    def test_a_patient_cannot_block_out_a_doctors_calendar(self, client: TestClient) -> None:
        sign_in(client, PATIENT)
        response = client.post(
            "/api/doctors/me/time-off",
            json={"startsAt": "2027-04-01T00:00:00Z", "endsAt": "2027-04-02T00:00:00Z"},
        )
        client.cookies.clear()

        assert response.status_code == 403

    async def test_one_doctor_cannot_delete_anothers_leave(
        self, client: TestClient, leave: list[str]
    ) -> None:
        sign_in(client, OTHER_DOCTOR)
        created = client.post(
            "/api/doctors/me/time-off",
            json={"startsAt": "2027-05-01T00:00:00Z", "endsAt": "2027-05-03T00:00:00Z"},
        )
        time_off_id = created.json()["data"]["id"]
        leave.append(time_off_id)

        sign_in(client, DOCTOR)
        response = client.delete(f"/api/doctors/me/time-off/{time_off_id}")
        client.cookies.clear()

        assert response.status_code == 404

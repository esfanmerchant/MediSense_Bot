"""Automated billing (spec §15, requirement R4).

The requirement the spec states twice is the one this file is mostly about:
completing a consultation generates exactly one invoice, and **retrying the
completion does not generate a second**. That guarantee is a unique index, not
an application check, so the tests go after it the way a retry would — by
repeating the request, and by racing two of them.

Everything else follows from conflict C4: an issued invoice is a statement made
to a patient, so it is never edited in place. Corrections are new documents.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.db.base import new_id, utcnow
from app.db.enums import AppointmentStatus, InvoiceStatus, NotificationChannel
from app.db.models import Appointment, Doctor, Invoice, Notification, Patient, User
from app.db.session import SessionFactory
from app.modules.appointments.schedule import to_clinic, to_utc
from tests.conftest import ADMIN_EMAIL, password_for, requires_db

pytestmark = requires_db

DEMO_PASSWORD = "Demo@Pass123"

PATIENT = "patient@example.com"  # Priya
DOCTOR = "doctor@example.com"  # treats Priya
OTHER_PATIENT = "patient3@example.com"
OTHER_DOCTOR = "doctor3@example.com"
#: Supplied by the environment — see `requires_admin` in conftest.
ADMIN = ADMIN_EMAIL
NURSE = "nurse@example.com"


def sign_in(client: TestClient, email: str) -> dict[str, Any]:
    # An unset administrator skips rather than fails. Marking whole files would
    # skip the patient and doctor tests in them too, and those are most of each
    # file and need no administrator at all.
    if not email:
        pytest.skip(
            "set TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD to run the tests that "
            "act as an administrator"
        )
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": email, "password": password_for(email)})
    assert response.status_code == 200, f"{email}: {response.text}"
    return response.json()["data"]["user"]


async def ids_for(patient_email: str, doctor_email: str) -> tuple[str, str]:
    async with SessionFactory() as session:
        patient_id = (
            await session.execute(
                select(Patient.id)
                .join(User, User.id == Patient.user_id)
                .where(User.email == patient_email)
            )
        ).scalar_one()
        doctor_id = (
            await session.execute(
                select(Doctor.id)
                .join(User, User.id == Doctor.user_id)
                .where(User.email == doctor_email)
            )
        ).scalar_one()
    return patient_id, doctor_id


class Billed:
    """Tracks what a test created so both invoice and appointment are removed."""

    def __init__(self) -> None:
        self.appointments: set[str] = set()
        self.invoices: set[str] = set()


@pytest.fixture
async def billed() -> AsyncIterator[Billed]:
    registry = Billed()
    yield registry
    async with SessionFactory() as session:
        # Invoices first: they reference the appointment.
        created = (
            (
                await session.execute(
                    select(Invoice.id).where(
                        Invoice.appointment_id.in_(registry.appointments)
                        | Invoice.id.in_(registry.invoices or {"-"})
                    )
                )
            )
            .scalars()
            .all()
        )
        all_invoices = set(created) | registry.invoices
        # Credit notes point at an invoice that is about to go.
        if all_invoices:
            notes = (
                (
                    await session.execute(
                        select(Invoice.id).where(Invoice.amends_invoice_id.in_(all_invoices))
                    )
                )
                .scalars()
                .all()
            )
            all_invoices |= set(notes)
            await session.execute(
                delete(Notification).where(
                    Notification.notification_metadata["invoiceId"].astext.in_(all_invoices)
                )
            )
            await session.execute(delete(Invoice).where(Invoice.id.in_(all_invoices)))
        if registry.appointments:
            await session.execute(
                delete(Appointment).where(Appointment.id.in_(registry.appointments))
            )
        await session.commit()


async def completed_consultation(
    registry: Billed,
    *,
    patient_email: str = PATIENT,
    doctor_email: str = DOCTOR,
    status: AppointmentStatus = AppointmentStatus.IN_PROGRESS,
) -> str:
    """An appointment sitting one step away from COMPLETED.

    Written directly so the test does not also depend on the whole booking flow
    — availability windows, slot keys and lead times are `test_appointments`'s
    subject, not this file's.
    """
    patient_id, doctor_id = await ids_for(patient_email, doctor_email)
    appointment_id = new_id()
    start = utcnow() - timedelta(hours=2)

    async with SessionFactory() as session:
        session.add(
            Appointment(
                id=appointment_id,
                patient_id=patient_id,
                doctor_id=doctor_id,
                # The clinic-local day at midnight, stored in UTC — the same
                # thing the booking service derives. Not redundant with
                # `startTime`: it is what "all of Tuesday's appointments" is
                # grouped by, and a UTC-midnight shortcut would put an early
                # morning slot on the previous day.
                appointment_date=to_utc(
                    to_clinic(start).replace(hour=0, minute=0, second=0, microsecond=0)
                ),
                start_time=start,
                end_time=start + timedelta(minutes=30),
                status=status,
                reason="Billing test consultation",
                # No slot key: this appointment is in the past and must not
                # collide with the double-booking index.
                slot_key=None,
            )
        )
        await session.commit()

    registry.appointments.add(appointment_id)
    return appointment_id


def complete(client: TestClient, appointment_id: str) -> Any:
    return client.post(
        f"/api/appointments/{appointment_id}/status", json={"status": "COMPLETED"}
    )


async def invoice_for(appointment_id: str) -> Invoice | None:
    async with SessionFactory() as session:
        return (
            await session.execute(
                select(Invoice).where(Invoice.appointment_id == appointment_id)
            )
        ).scalar_one_or_none()


class TestAutomaticGeneration:
    async def test_completing_a_consultation_creates_an_invoice(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)

        sign_in(client, DOCTOR)
        assert complete(client, appointment_id).status_code == 200

        invoice = await invoice_for(appointment_id)
        assert invoice is not None
        assert invoice.status == InvoiceStatus.ISSUED
        assert invoice.issued_at is not None
        assert invoice.total_amount > 0
        assert invoice.invoice_number.startswith("INV-")

    async def test_the_invoice_says_what_was_charged(
        self, client: TestClient, billed: Billed
    ) -> None:
        """Line items are stored, not derived on read.

        A doctor's fee can change; the invoice must always say what was charged
        at the time (conflict C4).
        """
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)

        invoice = await invoice_for(appointment_id)
        assert invoice is not None
        assert len(invoice.line_items) == 1
        assert "Consultation" in invoice.line_items[0]["description"]
        assert Decimal(invoice.line_items[0]["amount"]) == invoice.amount

    async def test_an_incomplete_consultation_is_not_billed(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(
            billed, status=AppointmentStatus.CONFIRMED
        )
        sign_in(client, DOCTOR)
        client.post(f"/api/appointments/{appointment_id}/status", json={"status": "CHECKED_IN"})

        assert await invoice_for(appointment_id) is None

    async def test_the_patient_is_notified(self, client: TestClient, billed: Billed) -> None:
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)

        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        patient_user_id = None
        async with SessionFactory() as session:
            patient_user_id = (
                await session.execute(
                    select(Patient.user_id).where(Patient.id == invoice.patient_id)
                )
            ).scalar_one()
            # One event writes one row per channel — the IN_APP row the patient
            # reads in the portal, and the EMAIL and PUSH rows the dispatcher
            # drains. This used to ask for `scalar_one_or_none()` across all of
            # them and raised MultipleResultsFound on a perfectly correct
            # invoice, because the fan-out arrived after the test did.
            rows = (
                (
                    await session.execute(
                        select(Notification).where(
                            Notification.user_id == patient_user_id,
                            Notification.notification_metadata["invoiceId"].astext == invoice.id,
                        )
                    )
                )
                .scalars()
                .all()
            )

        by_channel = {str(row.channel): row for row in rows}
        # The one a person actually opens.
        assert NotificationChannel.IN_APP.value in by_channel, by_channel.keys()
        assert invoice.invoice_number in by_channel[NotificationChannel.IN_APP.value].body

        # And deliberately *no* EMAIL row. The invoice mail is a templated
        # message sent directly — it carries the amount, the due date and a link
        # to pay — so `notify` is called with `email=False`. A queued generic
        # one would arrive as a second, thinner copy of a bill the patient has
        # already been sent, which is how a hospital teaches people to ignore
        # its email.
        #
        # Asserted rather than left unsaid: switching that flag back on is a
        # one-word change that nothing else would catch.
        assert NotificationChannel.EMAIL.value not in by_channel, by_channel.keys()

    async def test_administrators_are_notified(
        self, client: TestClient, billed: Billed
    ) -> None:
        """The spec's flow notifies both.

        A receivable that appears only when somebody thinks to look is a
        receivable that gets missed.
        """
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)

        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        async with SessionFactory() as session:
            admin_notifications = (
                (
                    await session.execute(
                        select(Notification)
                        .join(User, User.id == Notification.user_id)
                        .where(
                            User.role == "ADMIN",
                            Notification.notification_metadata["invoiceId"].astext == invoice.id,
                        )
                    )
                )
                .scalars()
                .all()
            )
        assert admin_notifications


class TestIdempotency:
    """R4: "prevent duplicate invoices if the request is retried"."""

    async def test_repeating_the_completion_does_not_bill_twice(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)

        sign_in(client, DOCTOR)
        assert complete(client, appointment_id).status_code == 200
        # The second call is refused by the state machine — COMPLETED is
        # terminal — which is itself part of the protection.
        second = complete(client, appointment_id)
        assert second.status_code == 409

        async with SessionFactory() as session:
            count = len(
                (
                    await session.execute(
                        select(Invoice.id).where(Invoice.appointment_id == appointment_id)
                    )
                )
                .scalars()
                .all()
            )
        assert count == 1

    async def test_the_database_refuses_a_second_invoice_directly(
        self, client: TestClient, billed: Billed
    ) -> None:
        """The guarantee has to hold below the application, not just inside it.

        This bypasses the endpoint entirely and inserts a second invoice for the
        same consultation. If that succeeds, every application-level check above
        it is decoration.
        """
        from sqlalchemy.exc import IntegrityError

        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)

        original = await invoice_for(appointment_id)
        assert original is not None

        with pytest.raises(IntegrityError):
            async with SessionFactory() as session:
                session.add(
                    Invoice(
                        id=new_id(),
                        patient_id=original.patient_id,
                        appointment_id=appointment_id,
                        invoice_number=f"DUP-{new_id()[:8]}",
                        amount=Decimal("1"),
                        tax_amount=Decimal("0"),
                        total_amount=Decimal("1"),
                        status=InvoiceStatus.ISSUED,
                        line_items=[],
                    )
                )
                await session.commit()

    async def test_invoice_numbers_are_unique_across_consultations(
        self, client: TestClient, billed: Billed
    ) -> None:
        first = await completed_consultation(billed)
        second = await completed_consultation(billed)

        sign_in(client, DOCTOR)
        complete(client, first)
        complete(client, second)

        one = await invoice_for(first)
        two = await invoice_for(second)
        assert one is not None and two is not None
        assert one.invoice_number != two.invoice_number


class TestVisibility:
    async def test_a_patient_sees_their_own_invoices(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        sign_in(client, PATIENT)
        body = client.get("/api/invoices").json()
        assert any(row["id"] == invoice.id for row in body["data"])
        assert "outstanding" in body["meta"]

    async def test_a_patient_cannot_see_another_patients(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        sign_in(client, OTHER_PATIENT)
        assert client.get(f"/api/invoices/{invoice.id}").status_code == 404

    async def test_a_patient_cannot_widen_scope_with_a_filter(
        self, client: TestClient
    ) -> None:
        other_patient_id, _ = await ids_for(OTHER_PATIENT, OTHER_DOCTOR)
        sign_in(client, PATIENT)
        response = client.get("/api/invoices", params={"patientId": other_patient_id})
        assert response.status_code == 403

    async def test_an_administrator_sees_the_ledger(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        sign_in(client, ADMIN)
        assert client.get(f"/api/invoices/{invoice.id}").status_code == 200

    async def test_a_doctor_holds_no_billing_permission(
        self, client: TestClient, billed: Billed
    ) -> None:
        """Doctors cause invoices by treating patients, not by reading billing.

        Keeping clinical and financial access separate is the same principle
        that keeps administrators out of charts (R2), pointed the other way.
        """
        sign_in(client, DOCTOR)
        assert client.get("/api/invoices").status_code == 403

    def test_a_nurse_holds_none_either(self, client: TestClient) -> None:
        sign_in(client, NURSE)
        assert client.get("/api/invoices").status_code == 403


class TestPayment:
    async def test_an_administrator_records_payment(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        sign_in(client, ADMIN)
        body = client.post(f"/api/invoices/{invoice.id}/pay").json()["data"]
        assert body["status"] == "PAID"
        assert body["paidAt"]

    async def test_recording_payment_twice_is_not_two_payments(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        sign_in(client, ADMIN)
        first = client.post(f"/api/invoices/{invoice.id}/pay").json()["data"]
        second = client.post(f"/api/invoices/{invoice.id}/pay").json()["data"]
        assert second["status"] == "PAID"
        assert second["paidAt"] == first["paidAt"], "a retry must not restamp the payment"

    async def test_a_patient_cannot_mark_their_own_invoice_paid(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        sign_in(client, PATIENT)
        assert client.post(f"/api/invoices/{invoice.id}/pay").status_code == 403


class TestCorrections:
    """Conflict C4: an issued invoice is never edited in place."""

    async def test_an_unpaid_invoice_can_be_voided(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        sign_in(client, ADMIN)
        body = client.post(
            f"/api/invoices/{invoice.id}/void", json={"reason": "Consultation not chargeable"}
        ).json()["data"]

        assert body["status"] == "VOID"
        assert body["voidedAt"]
        assert "not chargeable" in body["notes"]

    async def test_a_paid_invoice_cannot_be_voided(
        self, client: TestClient, billed: Billed
    ) -> None:
        """Money has moved; pretending the document never existed would leave
        the payment unexplained."""
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        sign_in(client, ADMIN)
        client.post(f"/api/invoices/{invoice.id}/pay")
        response = client.post(
            f"/api/invoices/{invoice.id}/void", json={"reason": "Changed our mind"}
        )
        assert response.status_code == 409

    async def test_a_credit_note_corrects_without_editing(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None
        billed.invoices.add(invoice.id)

        sign_in(client, ADMIN)
        client.post(f"/api/invoices/{invoice.id}/pay")
        body = client.post(
            f"/api/invoices/{invoice.id}/credit-note", json={"reason": "Billed in error"}
        ).json()["data"]

        note = body["creditNote"]
        original = body["original"]

        assert Decimal(note["totalAmount"]) == -Decimal(original["totalAmount"])
        assert note["amendsInvoiceId"] == invoice.id
        # The original keeps its own amount: what the patient was first told is
        # part of the record.
        assert Decimal(original["amount"]) == invoice.amount
        assert original["status"] == "REFUNDED"

    async def test_a_credit_note_is_not_a_second_bill_for_the_visit(
        self, client: TestClient, billed: Billed
    ) -> None:
        """It carries no appointment id.

        The unique index allows exactly one invoice per consultation, and a
        credit note corrects a document rather than billing the visit again.
        """
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None
        billed.invoices.add(invoice.id)

        sign_in(client, ADMIN)
        note = client.post(
            f"/api/invoices/{invoice.id}/credit-note", json={"reason": "Duplicate charge"}
        ).json()["data"]["creditNote"]

        assert note["appointmentId"] is None

    async def test_reversing_twice_is_refused(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None
        billed.invoices.add(invoice.id)

        sign_in(client, ADMIN)
        client.post(f"/api/invoices/{invoice.id}/credit-note", json={"reason": "First"})
        response = client.post(
            f"/api/invoices/{invoice.id}/credit-note", json={"reason": "Second"}
        )
        assert response.status_code == 409

    async def test_a_reason_is_required(self, client: TestClient, billed: Billed) -> None:
        """"Why is this cancelled" is the first question anyone reconciling the
        accounts will ask."""
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        sign_in(client, ADMIN)
        assert client.post(f"/api/invoices/{invoice.id}/void", json={}).status_code == 422


class TestAmounts:
    async def test_money_is_returned_as_a_string(
        self, client: TestClient, billed: Billed
    ) -> None:
        """0.1 + 0.2 is not 0.3 in binary floating point.

        A currency amount serialised as a JSON number is a rounding error
        waiting for a total.
        """
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None

        sign_in(client, ADMIN)
        body = client.get(f"/api/invoices/{invoice.id}").json()["data"]
        for field in ("amount", "taxAmount", "totalAmount"):
            assert isinstance(body[field], str), field

    async def test_the_total_is_the_subtotal_plus_tax(
        self, client: TestClient, billed: Billed
    ) -> None:
        appointment_id = await completed_consultation(billed)
        sign_in(client, DOCTOR)
        complete(client, appointment_id)
        invoice = await invoice_for(appointment_id)
        assert invoice is not None
        # Three parts, not two. This assertion used to read
        # `amount + tax_amount`, from before a platform fee existed — so it
        # failed on a correct invoice (800 + 150 + 142.50 = 1092.50) and said
        # the arithmetic was wrong when the arithmetic was right.
        #
        # The order matters as well as the sum: the fee is charged on the
        # consultation, and the tax on both. Asserting the total alone would
        # pass on a build that taxed the fee separately and reached the same
        # number by luck.
        assert invoice.total_amount == invoice.amount + invoice.platform_fee + invoice.tax_amount
        assert invoice.platform_fee >= 0
        assert invoice.tax_amount >= 0

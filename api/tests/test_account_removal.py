"""Planning a removal, and what the plan refuses.

The plan is the part worth pinning down. It decides whether a row is deleted or
emptied, and it is the only thing the administrator sees before pressing a
button that cannot be un-pressed — so a plan that under-counts is a plan that
deletes something somebody was told would survive.

These run the real functions against a session that answers from memory. The
counting queries are constructed for real, so a column that stops existing fails
here rather than at three in the morning on the one query nobody exercised.

The erasure itself, and the re-registration that is the whole point of it, are
in ``test_account_removal_integration.py`` — proving that a row is gone needs a
database that can be asked.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import pytest

from app.db.enums import InvoiceStatus, Role, UserStatus
from app.db.models import (
    Doctor,
    Patient,
    User,
)
from app.modules.users import removal
from app.modules.users.removal import REMOVED_EMAIL_DOMAIN, RemovalPlan, plan_removal

NOW = datetime(2026, 9, 4, 10, 0)


class Counter:
    """A session that answers every count with a number keyed by entity.

    ``plan_removal`` issues one `select(count()).select_from(Model)` per fact
    plus two `select(Model)` lookups for the patient and doctor rows. Both are
    answered from the same dict, keyed by the entity being selected from.
    """

    def __init__(self, counts: dict[str, int], rows: dict[str, Any] | None = None) -> None:
        self.counts = counts
        self.rows = rows or {}

    async def execute(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
        froms = statement.get_final_froms()
        name = froms[0].name if froms else ""

        descriptions = statement.column_descriptions
        entity = descriptions[0]["entity"] if descriptions else None
        selecting_rows = entity is not None and descriptions[0]["name"] != "count"

        session = self

        class Result:
            def scalar_one(self) -> int:
                return session.counts.get(name, 0)

            def scalar_one_or_none(self) -> Any:
                return session.rows.get(name)

        if selecting_rows and name in self.rows:
            return Result()
        return Result()


def a_user(role: Role = Role.PATIENT, **kw: Any) -> User:
    return User(
        id=kw.pop("id", "u1"),
        name=kw.pop("name", "Ayesha Khan"),
        email=kw.pop("email", "ayesha@example.com"),
        password_hash="scrypt$x",
        role=role,
        status=UserStatus.ACTIVE,
        created_at=NOW,
        updated_at=NOW,
        **kw,
    )


async def plan_for(
    user: User, counts: dict[str, int] | None = None, rows: dict[str, Any] | None = None,
    actor: str = "admin-1",
) -> RemovalPlan:
    return await plan_removal(Counter(counts or {}, rows), user, actor_id=actor)


# ---------------------------------------------------------------------------


class TestWhatItRefuses:
    async def test_you_cannot_remove_yourself(self) -> None:
        """A stronger version of the self-suspend rule.

        Suspension can be undone by another administrator. This cannot be undone
        by anybody, and the person best placed to notice the mistake has just
        deleted their own way back in.
        """
        plan = await plan_for(a_user(Role.ADMIN, id="me"), actor="me")
        assert not plan.allowed
        assert any("your own account" in b for b in plan.blockers)

    async def test_the_last_administrator_cannot_be_removed(self) -> None:
        """Otherwise the hospital locks itself out of its own admin portal.

        Nobody left can reinstate an account, approve a doctor or issue a reset.
        """
        plan = await plan_for(a_user(Role.ADMIN), counts={"users": 0})
        assert not plan.allowed
        assert any("only active administrator" in b for b in plan.blockers)

    async def test_an_administrator_goes_when_another_one_remains(self) -> None:
        plan = await plan_for(a_user(Role.ADMIN), counts={"users": 1})
        assert plan.allowed

    async def test_a_doctor_with_money_in_flight_is_refused(self) -> None:
        """A held balance with no payee is money nobody can release."""
        doctor = Doctor(id="d1", user_id="u1", specialization="Cardiology", license_number="PMC-1")
        plan = await plan_for(
            a_user(Role.DOCTOR),
            counts={"withdrawals": 2, "users": 1},
            rows={"doctors": doctor},
        )
        assert not plan.allowed
        assert any("withdrawal request" in b for b in plan.blockers)

    async def test_an_already_removed_account_is_not_removed_twice(self) -> None:
        plan = await plan_for(a_user(removed_at=NOW))
        assert not plan.allowed
        assert any("already been removed" in b for b in plan.blockers)


class TestWhichShapeItTakes:
    async def test_a_patient_is_deleted_outright(self) -> None:
        patient = Patient(id="p1", user_id="u1", medical_record_number="MRN-1")
        plan = await plan_for(
            a_user(),
            counts={"appointments": 3, "medical_records": 2, "vitals": 40},
            rows={"patients": patient},
        )
        assert plan.mode == "DELETE"
        assert plan.deletes["appointments"] == 3
        assert plan.deletes["consultationNotes"] == 2
        assert plan.deletes["vitalReadings"] == 40

    async def test_a_doctor_who_wrote_notes_is_emptied_not_deleted(self) -> None:
        """The records are the patients'. Deleting the author deletes their chart."""
        doctor = Doctor(id="d1", user_id="u1", specialization="Cardiology", license_number="PMC-1")
        plan = await plan_for(
            a_user(Role.DOCTOR),
            counts={"medical_records": 14, "prescriptions": 9, "users": 1},
            rows={"doctors": doctor},
        )
        assert plan.mode == "ANONYMISE"
        assert plan.keeps["consultationNotesWritten"] == 14
        assert plan.keeps["prescriptionsWritten"] == 9

    async def test_a_doctor_who_never_treated_anybody_is_deleted(self) -> None:
        """A duplicate or a test account leaves nothing behind at all."""
        doctor = Doctor(id="d1", user_id="u1", specialization="Cardiology", license_number="PMC-1")
        plan = await plan_for(a_user(Role.DOCTOR), counts={"users": 1}, rows={"doctors": doctor})
        assert plan.mode == "DELETE"
        assert plan.keeps == {}

    async def test_an_uploaded_document_alone_forces_the_emptied_shape(self) -> None:
        """``medical_documents.uploadedById`` is RESTRICT and the file is a patient's.

        Even a nurse who did nothing else cannot be deleted out from under one.
        """
        plan = await plan_for(a_user(Role.NURSE), counts={"medical_documents": 1})
        assert plan.mode == "ANONYMISE"
        assert plan.keeps["documentsUploaded"] == 1


class TestWhatSurvives:
    async def test_a_settled_invoice_is_kept_and_an_unpaid_one_is_not(self) -> None:
        """Money that changed hands is the hospital's record, not the patient's.

        Deleting it would move last quarter's revenue with nothing to explain it.
        """
        patient = Patient(id="p1", user_id="u1", medical_record_number="MRN-1")
        # One `invoices` count answers both queries here, which is enough to
        # prove both branches are asked for and land on opposite sides.
        plan = await plan_for(a_user(), counts={"invoices": 4}, rows={"patients": patient})
        assert plan.deletes["unpaidInvoices"] == 4
        assert plan.keeps["settledInvoices"] == 4

    async def test_the_plan_always_says_the_email_comes_free(self) -> None:
        """The reason an administrator is doing this at all."""
        payload = (await plan_for(a_user())).as_dict()
        assert payload["freesEmail"] is True
        assert payload["freesCnic"] is True

    def test_settled_means_money_actually_moved(self) -> None:
        assert set(removal.SETTLED) == {InvoiceStatus.PAID, InvoiceStatus.REFUNDED}


class TestEmptyingARow:
    def test_nothing_identifying_survives_on_the_user(self) -> None:
        user = a_user(
            Role.DOCTOR,
            name="Dr Abdul Rafay",
            email="rafay@example.com",
            phone="+92 300 1234567",
            cnic="4210112345671",
            avatar_path="avatars/u1.png",
            two_factor_enabled=True,
            two_factor_secret="v1$sealed",
            two_factor_backup_codes=["a", "b"],
        )
        before = user.password_hash
        removal._empty_user(user)

        assert "Rafay" not in user.name
        assert user.phone is None
        assert user.cnic is None
        assert user.avatar_path is None
        assert user.status == UserStatus.DEACTIVATED
        assert user.removed_at is not None
        # No second factor left to challenge, and a password nobody holds.
        assert user.two_factor_enabled is False
        assert user.two_factor_secret is None
        assert user.two_factor_backup_codes == []
        assert user.password_hash != before

    def test_the_real_address_is_released(self) -> None:
        """`users.email` is UNIQUE, so overwriting it is what frees the address.

        The replacement points into `.invalid`, which RFC 2606 reserves as
        permanently unresolvable — nothing addressed here can reach anybody.
        """
        user = a_user(email="rafay@example.com")
        removal._empty_user(user)
        assert user.email != "rafay@example.com"
        assert user.email.endswith(REMOVED_EMAIL_DOMAIN)
        assert user.id in user.email

    def test_the_licence_number_is_released_too(self) -> None:
        """`doctors_licenseNumber_key` is UNIQUE and applications check it.

        Leaving the real PMC number on the tombstone would block this same
        person from ever registering again — the opposite of the point.
        """
        doctor = Doctor(
            id="d1",
            user_id="u1",
            specialization="Cardiology",
            license_number="PMC-99887",
            clinic_name="Aga Khan",
            city="Karachi",
            availability=[{"dayOfWeek": 1}],
            accepting_patients=True,
        )
        removal._empty_doctor(doctor)
        assert doctor.license_number != "PMC-99887"
        assert doctor.clinic_name is None
        assert doctor.city is None
        assert doctor.availability == []
        # Unbookable for ever, and out of the directory.
        assert doctor.accepting_patients is False

    def test_the_specialization_is_kept_on_purpose(self) -> None:
        """It is not identifying, and it is what a chart still needs.

        "A cardiologist wrote this" is worth keeping. "Nobody wrote this" is not.
        """
        doctor = Doctor(id="d1", user_id="u1", specialization="Cardiology", license_number="x")
        removal._empty_doctor(doctor)
        assert doctor.specialization == "Cardiology"


class TestTheEndpointIsGuarded:
    def test_removal_requires_the_user_admin_permission(self) -> None:
        import inspect

        from app.modules.users.router import preview_removal, remove_user

        for endpoint in (preview_removal, remove_user):
            assert "RequireUserAdmin" in inspect.getsource(endpoint)

    @pytest.mark.parametrize(
        "path,method", [("/api/users/{user_id}", "DELETE"), ("/api/users/{user_id}/removal", "GET")]
    )
    def test_both_endpoints_are_registered(self, path: str, method: str) -> None:
        import sys

        sys.path.insert(0, "tests")
        from test_access_control_review import api_routes

        assert any(p == path and method in m for m, p, _ in api_routes()), f"{method} {path}"

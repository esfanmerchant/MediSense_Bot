"""Removing an account, and everything that was only ever theirs.

An administrator can already suspend somebody, which is reversible and leaves
the data where it is. This is the other thing: the account goes, the person's
data goes with it, and their email address and CNIC become free to register
again. It is not undoable, so it is worth being exact about what it does.

**Two shapes, and which one you get is decided by the data, not the role.**

*Deleted outright* — the row is gone. This is what a patient gets, and what
anybody gets who never authored anything. Their appointments, records,
prescriptions, vitals, documents, reminders, symptoms and unpaid bills are
removed, and the files behind their uploads are removed from storage with them.

*Emptied in place* — the row survives holding nothing. This is what a doctor or
a nurse gets once somebody else's medical record names them as its author.
Deleting them would mean either deleting that patient's chart or leaving it
without a clinician, and both are worse than keeping an anonymous row. So every
identifying field is destroyed — name, phone, CNIC, avatar, password, second
factor, licence number, clinic address — and the email is rewritten to a dead
address, which is what frees the real one. The chart keeps an author; the author
is nobody.

**What deliberately survives either way.**

*The audit log.* ``audit_logs.userId`` is not a foreign key, on purpose, so the
trail outlives its subject. Removing somebody is itself recorded there, and that
entry is the only remaining evidence the account existed.

*Settled invoices.* Money that actually changed hands is the hospital's record,
not the patient's. Deleting it would restate a past quarter's revenue with
nothing anywhere to explain the change. The row keeps its amount, date and
status, and loses its patient. Unpaid and voided bills have no such claim and
are deleted.

**What is refused.** Removing yourself, removing the last administrator who
could let anyone back in, and removing a doctor with money still in flight.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import logger
from app.core.security import generate_opaque_token, hash_password
from app.db.base import utcnow
from app.db.enums import InvoiceStatus, Role, UserStatus, WithdrawalStatus
from app.db.models import (
    AIInteraction,
    Alert,
    Appointment,
    Doctor,
    DoctorApplication,
    DoctorApplicationDocument,
    DoctorLedgerEntry,
    DoctorPatientAssignment,
    DoctorTimeOff,
    EmergencyAccess,
    Invoice,
    MedicalDocument,
    MedicalRecord,
    MedicationDose,
    MedicationReminder,
    Notification,
    PasswordResetToken,
    Patient,
    Payment,
    Prescription,
    PushSubscription,
    RefreshToken,
    ReportedSymptom,
    Session,
    TrustedDevice,
    TwoFactorChallenge,
    User,
    Vital,
    VitalThreshold,
    Withdrawal,
)
from app.services import storage

Mode = Literal["DELETE", "ANONYMISE"]

#: Invoice states where money actually moved. These survive a removal without a
#: patient; everything else is a bill nobody paid and nobody will.
SETTLED = (InvoiceStatus.PAID, InvoiceStatus.REFUNDED)

#: The domain a removed account's email is rewritten into. `.invalid` is
#: reserved by RFC 2606 and can never resolve, so nothing addressed here can
#: reach a real inbox by accident.
REMOVED_EMAIL_DOMAIN = "removed.medisense.invalid"


@dataclass
class RemovalPlan:
    """What removing this account would do, counted before anything happens.

    The admin confirming this is about to destroy a person's medical history,
    and "are you sure?" is not informed consent. This is the dialog's content:
    real counts, from real queries, including the two or three things that will
    outlive the removal.
    """

    user_id: str
    name: str
    email: str
    role: Role
    mode: Mode
    #: Table label -> how many rows go. Only non-zero entries are kept.
    deletes: dict[str, int] = field(default_factory=dict)
    #: Table label -> how many rows survive with the person's link removed.
    keeps: dict[str, int] = field(default_factory=dict)
    #: Files in object storage that will be deleted with the rows.
    files: int = 0
    #: Reasons this cannot proceed at all. Non-empty means the button is off.
    blockers: list[str] = field(default_factory=list)

    @property
    def allowed(self) -> bool:
        return not self.blockers

    def as_dict(self) -> dict[str, Any]:
        return {
            "userId": self.user_id,
            "name": self.name,
            "email": self.email,
            "role": str(self.role),
            "mode": self.mode,
            "deletes": self.deletes,
            "keeps": self.keeps,
            "files": self.files,
            "blockers": self.blockers,
            "allowed": self.allowed,
            # Said explicitly rather than implied by `mode`, because it is the
            # sentence the administrator is actually deciding on.
            "freesEmail": True,
            "freesCnic": True,
        }


async def _count(db: AsyncSession, model: Any, *where: Any) -> int:
    return int(
        (await db.execute(select(func.count()).select_from(model).where(*where))).scalar_one()
    )


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------


async def plan_removal(db: AsyncSession, user: User, *, actor_id: str) -> RemovalPlan:
    """Count everything, decide the shape, and collect the reasons to refuse."""
    plan = RemovalPlan(
        user_id=user.id,
        name=user.name,
        email=user.email,
        role=user.role,
        mode="DELETE",
    )

    if user.id == actor_id:
        # The same rule as suspension, for a stronger reason: there is no
        # administrator left to undo this one.
        plan.blockers.append("You cannot remove your own account.")

    if user.role == Role.ADMIN:
        others = await _count(
            db,
            User,
            User.role == Role.ADMIN,
            User.id != user.id,
            User.status == UserStatus.ACTIVE,
            User.removed_at.is_(None),
        )
        if others == 0:
            # A hospital with no administrator cannot reinstate anybody,
            # approve a doctor, or issue a password reset. This is the one
            # removal that locks the door from the outside.
            plan.blockers.append("This is the only active administrator. Appoint another first.")

    if user.removed_at is not None:
        plan.blockers.append("This account has already been removed.")

    patient = (
        await db.execute(select(Patient).where(Patient.user_id == user.id))
    ).scalar_one_or_none()
    doctor = (
        await db.execute(select(Doctor).where(Doctor.user_id == user.id))
    ).scalar_one_or_none()

    if patient is not None:
        await _plan_patient(db, plan, patient)
    if doctor is not None:
        await _plan_doctor(db, plan, doctor)
    await _plan_account(db, plan, user)

    return plan


async def _plan_patient(db: AsyncSession, plan: RemovalPlan, patient: Patient) -> None:
    owned: list[tuple[str, Any, Any]] = [
        ("appointments", Appointment, Appointment.patient_id == patient.id),
        ("consultationNotes", MedicalRecord, MedicalRecord.patient_id == patient.id),
        ("prescriptions", Prescription, Prescription.patient_id == patient.id),
        ("vitalReadings", Vital, Vital.patient_id == patient.id),
        ("reportedSymptoms", ReportedSymptom, ReportedSymptom.patient_id == patient.id),
        ("medicationReminders", MedicationReminder, MedicationReminder.patient_id == patient.id),
        ("documents", MedicalDocument, MedicalDocument.patient_id == patient.id),
        ("emergencyGrants", EmergencyAccess, EmergencyAccess.patient_id == patient.id),
        ("assistantConversations", AIInteraction, AIInteraction.patient_id == patient.id),
    ]
    for label, model, where in owned:
        found = await _count(db, model, where)
        if found:
            plan.deletes[label] = found

    unpaid = await _count(
        db, Invoice, Invoice.patient_id == patient.id, Invoice.status.not_in(SETTLED)
    )
    if unpaid:
        plan.deletes["unpaidInvoices"] = unpaid

    settled = await _count(
        db, Invoice, Invoice.patient_id == patient.id, Invoice.status.in_(SETTLED)
    )
    if settled:
        plan.keeps["settledInvoices"] = settled

    plan.files += await _count(
        db,
        MedicalDocument,
        MedicalDocument.patient_id == patient.id,
        MedicalDocument.storage_path.is_not(None),
    )


async def _plan_doctor(db: AsyncSession, plan: RemovalPlan, doctor: Doctor) -> None:
    """A doctor's own things go; the records they authored do not.

    Anything found here flips the removal to ANONYMISE, because every one of
    these rows is either a patient's history or the hospital's books.
    """
    authored: list[tuple[str, Any, Any]] = [
        ("consultationNotesWritten", MedicalRecord, MedicalRecord.doctor_id == doctor.id),
        ("prescriptionsWritten", Prescription, Prescription.doctor_id == doctor.id),
        ("appointmentsSeen", Appointment, Appointment.doctor_id == doctor.id),
        ("earningsEntries", DoctorLedgerEntry, DoctorLedgerEntry.doctor_id == doctor.id),
        ("withdrawals", Withdrawal, Withdrawal.doctor_id == doctor.id),
    ]
    for label, model, where in authored:
        found = await _count(db, model, where)
        if found:
            plan.keeps[label] = found
            plan.mode = "ANONYMISE"

    pending = await _count(
        db,
        Withdrawal,
        Withdrawal.doctor_id == doctor.id,
        Withdrawal.status == WithdrawalStatus.REQUESTED,
    )
    if pending:
        # Money the hospital has already set aside and not yet sent. Removing
        # the payee mid-transfer leaves a held balance nobody can release.
        plan.blockers.append(
            f"{pending} withdrawal request(s) are still open. Pay or reject them first."
        )

    scheduled = await _count(db, DoctorTimeOff, DoctorTimeOff.doctor_id == doctor.id)
    if scheduled:
        plan.deletes["timeOff"] = scheduled


async def _plan_account(db: AsyncSession, plan: RemovalPlan, user: User) -> None:
    """The account itself: everything that only ever pointed at this login."""
    owned: list[tuple[str, Any, Any]] = [
        ("signedInSessions", Session, Session.user_id == user.id),
        ("enrolledDevices", TrustedDevice, TrustedDevice.user_id == user.id),
        ("pushSubscriptions", PushSubscription, PushSubscription.user_id == user.id),
        ("notifications", Notification, Notification.user_id == user.id),
        ("doctorApplications", DoctorApplication, DoctorApplication.user_id == user.id),
    ]
    for label, model, where in owned:
        found = await _count(db, model, where)
        if found:
            plan.deletes[label] = found

    if user.avatar_path:
        plan.files += 1

    credentials = await _count(
        db,
        DoctorApplicationDocument,
        DoctorApplicationDocument.application_id.in_(
            select(DoctorApplication.id).where(DoctorApplication.user_id == user.id)
        ),
    )
    if credentials:
        plan.deletes["credentialFiles"] = credentials
        plan.files += credentials

    # Anything referencing this user id that cannot be deleted has to keep a row
    # to point at, so it decides the shape too.
    uploads = await _count(db, MedicalDocument, MedicalDocument.uploaded_by_id == user.id)
    grants = await _count(db, EmergencyAccess, EmergencyAccess.requester_id == user.id)
    for label, found in (("documentsUploaded", uploads), ("emergencyAccessUsed", grants)):
        if found:
            plan.keeps[label] = found
            plan.mode = "ANONYMISE"


# ---------------------------------------------------------------------------
# Doing it
# ---------------------------------------------------------------------------


async def _collect_files(db: AsyncSession, user: User, patient: Patient | None) -> list[tuple[str, str]]:
    """Every object in storage that belongs to this person, as (bucket, path).

    Read before any row is deleted, because the path is only in the row.
    """
    files: list[tuple[str, str]] = []

    if user.avatar_path:
        files.append((settings.SUPABASE_AVATARS_BUCKET, user.avatar_path))

    credentials = (
        (
            await db.execute(
                select(
                    DoctorApplicationDocument.storage_bucket,
                    DoctorApplicationDocument.storage_path,
                ).where(
                    DoctorApplicationDocument.application_id.in_(
                        select(DoctorApplication.id).where(DoctorApplication.user_id == user.id)
                    )
                )
            )
        )
        .tuples()
        .all()
    )
    files.extend(credentials)

    if patient is not None:
        # Soft-deleted documents included: a row hidden from the portal still
        # has its file in the bucket, and "removed completely" has to mean the
        # bytes as well as the row.
        documents = (
            (
                await db.execute(
                    select(MedicalDocument.storage_bucket, MedicalDocument.storage_path).where(
                        MedicalDocument.patient_id == patient.id,
                        MedicalDocument.storage_path.is_not(None),
                    )
                )
            )
            .tuples()
            .all()
        )
        files.extend(documents)

        proofs = (
            (
                await db.execute(
                    select(Payment.proof_path)
                    .join(Invoice, Invoice.id == Payment.invoice_id)
                    .where(Invoice.patient_id == patient.id, Payment.proof_path.is_not(None))
                )
            )
            .scalars()
            .all()
        )
        files.extend(
            (settings.SUPABASE_PAYMENT_PROOFS_BUCKET, path) for path in proofs if path
        )

    return [(bucket, path) for bucket, path in files if bucket and path]


async def delete_files(files: list[tuple[str, str]]) -> int:
    """Remove the objects, and report rather than raise on the ones that resist.

    A file the bucket will not give up must not roll back a removal that has
    already destroyed the rows — but it must not be silent either, because an
    orphaned scan in a bucket is exactly the thing this promised to delete.
    """
    failed = 0
    for bucket, path in files:
        try:
            await storage.remove(bucket, path)
        except Exception:
            failed += 1
            logger.error("removal_file_not_deleted", bucket=bucket, path=path)
    return failed


async def remove_user(db: AsyncSession, user: User, plan: RemovalPlan) -> list[tuple[str, str]]:
    """Carry out the plan. Returns the storage objects the caller should delete.

    Files are handed back rather than deleted here so the database work stays
    one transaction: rows first, and bytes only once those rows are certain to
    be gone.
    """
    patient = (
        await db.execute(select(Patient).where(Patient.user_id == user.id))
    ).scalar_one_or_none()
    doctor = (
        await db.execute(select(Doctor).where(Doctor.user_id == user.id))
    ).scalar_one_or_none()

    files = await _collect_files(db, user, patient)

    if patient is not None:
        await _erase_patient(db, patient)

    # Their own account furniture goes in both shapes.
    for model, where in (
        (Session, Session.user_id == user.id),
        (RefreshToken, RefreshToken.user_id == user.id),
        (PasswordResetToken, PasswordResetToken.user_id == user.id),
        (TrustedDevice, TrustedDevice.user_id == user.id),
        (TwoFactorChallenge, TwoFactorChallenge.user_id == user.id),
        (PushSubscription, PushSubscription.user_id == user.id),
        (Notification, Notification.user_id == user.id),
        (DoctorApplication, DoctorApplication.user_id == user.id),
    ):
        await db.execute(delete(model).where(where))

    if doctor is not None:
        await db.execute(delete(DoctorTimeOff).where(DoctorTimeOff.doctor_id == doctor.id))
        await db.execute(
            delete(DoctorPatientAssignment).where(DoctorPatientAssignment.doctor_id == doctor.id)
        )

    if plan.mode == "DELETE":
        if doctor is not None:
            await db.execute(delete(Doctor).where(Doctor.id == doctor.id))
        await db.execute(delete(User).where(User.id == user.id))
    else:
        if doctor is not None:
            _empty_doctor(doctor)
        _empty_user(user)

    await db.flush()
    return files


async def _erase_patient(db: AsyncSession, patient: Patient) -> None:
    """Everything clinical, then the patient row itself.

    Ordered rather than left to cascades. ``medical_documents.uploadedById``
    restricts deletion of a user, and RESTRICT is checked immediately — so the
    documents have to be gone before the account is, even though the patient
    cascade would have removed them anyway.
    """
    await db.execute(
        delete(MedicationDose).where(MedicationDose.patient_id == patient.id)
    )
    await db.execute(
        delete(MedicationReminder).where(MedicationReminder.patient_id == patient.id)
    )
    await db.execute(delete(MedicalDocument).where(MedicalDocument.patient_id == patient.id))
    await db.execute(delete(Alert).where(Alert.patient_id == patient.id))
    await db.execute(delete(Vital).where(Vital.patient_id == patient.id))
    await db.execute(delete(VitalThreshold).where(VitalThreshold.patient_id == patient.id))
    await db.execute(delete(ReportedSymptom).where(ReportedSymptom.patient_id == patient.id))
    await db.execute(delete(Prescription).where(Prescription.patient_id == patient.id))
    await db.execute(delete(MedicalRecord).where(MedicalRecord.patient_id == patient.id))
    await db.execute(delete(AIInteraction).where(AIInteraction.patient_id == patient.id))
    await db.execute(delete(EmergencyAccess).where(EmergencyAccess.patient_id == patient.id))
    await db.execute(
        delete(DoctorPatientAssignment).where(DoctorPatientAssignment.patient_id == patient.id)
    )

    # A bill nobody paid has no claim to outlive the person it was addressed to.
    # A settled one does, and keeps its amount while losing its patient — the
    # SET NULL on the column does that when the patient row goes.
    await db.execute(
        delete(Invoice).where(
            Invoice.patient_id == patient.id, Invoice.status.not_in(SETTLED)
        )
    )

    await db.execute(delete(Appointment).where(Appointment.patient_id == patient.id))
    await db.execute(delete(Patient).where(Patient.id == patient.id))


def _empty_user(user: User) -> None:
    """Destroy everything in the row that identifies a person.

    The email is rewritten rather than cleared. It is UNIQUE, so overwriting it
    is precisely what releases the real address — and the replacement points
    into a domain RFC 2606 reserves as permanently unresolvable, so nothing
    addressed to it can ever reach anybody.
    """
    user.name = f"Removed {str(user.role).lower()}"
    user.email = f"removed-{user.id}@{REMOVED_EMAIL_DOMAIN}"
    # A fresh random password nobody holds, hashed the usual way. Clearing the
    # column would break the NOT NULL; a fixed sentinel would be one shared
    # value across every removed account.
    user.password_hash = hash_password(generate_opaque_token(32))
    user.phone = None
    user.cnic = None
    user.avatar_path = None
    user.status = UserStatus.DEACTIVATED
    user.removed_at = utcnow()

    user.email_verified_at = None
    user.email_verification_code_hash = None
    user.two_factor_enabled = False
    user.two_factor_method = None
    user.two_factor_secret = None
    user.two_factor_backup_codes = []
    user.two_factor_enabled_at = None

    user.notify_by_email = False
    user.notify_by_push = False


def _empty_doctor(doctor: Doctor) -> None:
    """Keep the author, lose the person.

    ``licenseNumber`` is UNIQUE and is checked when a doctor applies, so leaving
    the real one here would block this same person from ever registering
    again — which is the opposite of what removing them is for.

    ``specialization`` survives on purpose. It is not identifying, and it is the
    difference between a record that says a cardiologist wrote it and one that
    says nobody did.
    """
    doctor.license_number = f"removed-{doctor.id}"
    doctor.clinic_name = None
    doctor.city = None
    doctor.address_line = None
    doctor.latitude = None
    doctor.longitude = None
    doctor.qualifications = None
    doctor.availability = []
    doctor.accepting_patients = False
    doctor.department_id = None

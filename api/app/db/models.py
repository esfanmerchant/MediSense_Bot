"""SQLAlchemy models mapped onto the existing schema.

Columns are camelCase in the database (Prisma created them that way), so every
attribute names its column explicitly. Enum types already exist, hence
``create_type=False`` throughout — SQLAlchemy binds to them and never tries to
issue ``CREATE TYPE``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, ClassVar

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import ENUM, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import enums
from app.db.base import Base, new_id, utcnow


def pg_enum(python_enum: type, name: str) -> ENUM:
    return ENUM(python_enum, name=name, create_type=False, values_callable=lambda e: [m.value for m in e])


def _id() -> Mapped[str]:
    return mapped_column(Text, primary_key=True, default=new_id)


def _created() -> Mapped[datetime]:
    return mapped_column("createdAt", DateTime, default=utcnow, nullable=False)


def _updated() -> Mapped[datetime]:
    return mapped_column("updatedAt", DateTime, default=utcnow, onupdate=utcnow, nullable=False)


# ===========================================================================
# Identity & sessions
# ===========================================================================


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = _id()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    password_hash: Mapped[str] = mapped_column("passwordHash", Text, nullable=False)
    role: Mapped[enums.Role] = mapped_column(pg_enum(enums.Role, "Role"), nullable=False)
    phone: Mapped[str | None] = mapped_column(Text)
    status: Mapped[enums.UserStatus] = mapped_column(
        pg_enum(enums.UserStatus, "UserStatus"), nullable=False, default=enums.UserStatus.ACTIVE
    )

    #: Where this person's picture lives in the private avatars bucket, or NULL.
    #: A path, never a URL: the bucket has no public address, so the only thing
    #: worth storing is the key a signed link is minted from per response.
    avatar_path: Mapped[str | None] = mapped_column("avatarPath", Text)

    email_verified_at: Mapped[datetime | None] = mapped_column("emailVerifiedAt", DateTime)
    last_login_at: Mapped[datetime | None] = mapped_column("lastLoginAt", DateTime)
    failed_login_count: Mapped[int] = mapped_column("failedLoginCount", Integer, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column("lockedUntil", DateTime)

    #: The six-digit sign-up code, hashed the same way a password is. Only the
    #: hash is stored, so a database dump cannot be used to verify somebody
    #: else's address.
    email_verification_code_hash: Mapped[str | None] = mapped_column("emailVerificationCodeHash", Text)
    email_verification_expires_at: Mapped[datetime | None] = mapped_column(
        "emailVerificationExpiresAt", DateTime
    )
    #: Guesses against the current code. At the limit the code is burned rather
    #: than the account locked — the person who cannot get in is usually the
    #: legitimate owner mistyping, and a fresh code costs them one click.
    email_verification_attempts: Mapped[int] = mapped_column(
        "emailVerificationAttempts", Integer, default=0, nullable=False
    )
    #: Drives resend throttling, which is enforced here rather than only in the
    #: IP-based limiter: the cost of a resend is an email to a real person, and
    #: that has to be bounded per address however many clients ask for it.
    email_verification_sent_at: Mapped[datetime | None] = mapped_column(
        "emailVerificationSentAt", DateTime
    )
    email_verification_send_count: Mapped[int] = mapped_column(
        "emailVerificationSendCount", Integer, default=0, nullable=False
    )

    two_factor_enabled: Mapped[bool] = mapped_column(
        "twoFactorEnabled", Boolean, default=False, nullable=False
    )
    two_factor_method: Mapped[enums.TwoFactorMethod | None] = mapped_column(
        "twoFactorMethod", pg_enum(enums.TwoFactorMethod, "TwoFactorMethod")
    )
    #: Sealed, not hashed: verifying a TOTP code needs the secret back. See
    #: ``core.security.seal_secret`` for the construction and why it exists.
    two_factor_secret: Mapped[str | None] = mapped_column("twoFactorSecret", Text)
    #: Hashes of unused single-use codes. A used code is removed from the array,
    #: which is what makes "single use" a property of the data rather than a
    #: flag somebody has to remember to set.
    two_factor_backup_codes: Mapped[list[str]] = mapped_column(
        "twoFactorBackupCodes", JSONB, default=list, nullable=False
    )
    two_factor_enabled_at: Mapped[datetime | None] = mapped_column("twoFactorEnabledAt", DateTime)

    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    patient: Mapped[Patient | None] = relationship(back_populates="user", uselist=False)
    doctor: Mapped[Doctor | None] = relationship(back_populates="user", uselist=False)


class TwoFactorChallenge(Base):
    """A half-finished authentication, waiting on the second factor.

    It exists because the password has already been accepted but no session may
    be issued yet. Keeping that state in a row rather than in a token means the
    server decides when it expires, how many guesses it has had, and whether it
    has already been spent — none of which a client can be trusted to report.
    """

    __tablename__ = "two_factor_challenges"

    id: Mapped[str] = _id()
    user_id: Mapped[str] = mapped_column(
        "userId", Text, ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    #: ``LOGIN`` or ``ENROLMENT``. Plain text rather than a Postgres enum,
    #: matching ``Session.deviceClass``: it is an internal distinction between
    #: two code paths, not a value any client sends or reads.
    purpose: Mapped[str] = mapped_column(Text, default="LOGIN", nullable=False)
    method: Mapped[enums.TwoFactorMethod] = mapped_column(
        pg_enum(enums.TwoFactorMethod, "TwoFactorMethod"), nullable=False
    )
    #: NULL for a TOTP challenge — there is no code to send, the authenticator
    #: already has the secret.
    code_hash: Mapped[str | None] = mapped_column("codeHash", Text)
    #: A TOTP secret being enrolled, sealed, held here until the first correct
    #: code proves the authenticator actually took it. Writing it onto the user
    #: at ``start`` would leave an account claiming a second factor its owner
    #: never managed to scan.
    pending_secret: Mapped[str | None] = mapped_column("pendingSecret", Text)
    #: The device class the sign-in asked for, carried across so the session
    #: issued after verification gets the timeout tier it would have had — and
    #: so "remember this device" can be refused on a shared terminal.
    device_class: Mapped[str] = mapped_column("deviceClass", Text, default="PERSONAL", nullable=False)
    expires_at: Mapped[datetime] = mapped_column("expiresAt", DateTime, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column("consumedAt", DateTime)
    sent_at: Mapped[datetime | None] = mapped_column("sentAt", DateTime)
    created_at: Mapped[datetime] = _created()


class TrustedDevice(Base):
    """A browser that has already passed a second factor.

    Only the hash of the cookie value is stored, so a database dump does not
    hand anybody a working skip-2FA token. The row is what makes revocation
    real: deleting it locks the device out on its next request, whatever cookie
    it still holds.
    """

    __tablename__ = "trusted_devices"

    id: Mapped[str] = _id()
    user_id: Mapped[str] = mapped_column(
        "userId", Text, ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column("tokenHash", Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column("expiresAt", DateTime, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column("lastUsedAt", DateTime)
    user_agent: Mapped[str | None] = mapped_column("userAgent", Text)
    created_at: Mapped[datetime] = _created()


class Session(Base):
    """Server-side session.

    The inactivity rule (R8) is enforced by comparing ``last_seen_at`` on every
    authenticated request. The client timer is a courtesy; this is the control.
    """

    __tablename__ = "sessions"

    id: Mapped[str] = _id()
    user_id: Mapped[str] = mapped_column(
        "userId", Text, ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    #: Drives the idle-timeout tier. See ``core.session_policy``.
    device_class: Mapped[str] = mapped_column("deviceClass", Text, default="PERSONAL", nullable=False)
    user_agent: Mapped[str | None] = mapped_column("userAgent", Text)
    ip_address: Mapped[str | None] = mapped_column("ipAddress", Text)

    created_at: Mapped[datetime] = _created()
    last_seen_at: Mapped[datetime] = mapped_column("lastSeenAt", DateTime, default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column("expiresAt", DateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column("revokedAt", DateTime)
    revoked_reason: Mapped[str | None] = mapped_column("revokedReason", Text)


class RefreshToken(Base):
    """Rotating refresh tokens. Only the hash is stored."""

    __tablename__ = "refresh_tokens"

    id: Mapped[str] = _id()
    user_id: Mapped[str] = mapped_column(
        "userId", Text, ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    session_id: Mapped[str] = mapped_column(
        "sessionId", Text, ForeignKey("sessions.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column("tokenHash", Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column("expiresAt", DateTime, nullable=False)
    created_at: Mapped[datetime] = _created()
    #: Set when rotated. Presenting a used token means it leaked (see service).
    used_at: Mapped[datetime | None] = mapped_column("usedAt", DateTime)
    replaced_by_id: Mapped[str | None] = mapped_column("replacedById", Text)


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id: Mapped[str] = _id()
    user_id: Mapped[str] = mapped_column(
        "userId", Text, ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column("tokenHash", Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column("expiresAt", DateTime, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column("usedAt", DateTime)
    created_at: Mapped[datetime] = _created()


# ===========================================================================
# Organisation
# ===========================================================================


class Department(Base):
    __tablename__ = "departments"

    id: Mapped[str] = _id()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    location: Mapped[str | None] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    doctors: Mapped[list[Doctor]] = relationship(back_populates="department")


class Doctor(Base):
    __tablename__ = "doctors"

    id: Mapped[str] = _id()
    user_id: Mapped[str] = mapped_column(
        "userId", Text, ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    specialization: Mapped[str] = mapped_column(Text, nullable=False)
    license_number: Mapped[str] = mapped_column("licenseNumber", Text, nullable=False)
    department_id: Mapped[str | None] = mapped_column(
        "departmentId", Text, ForeignKey("departments.id", ondelete="SET NULL", onupdate="CASCADE")
    )
    qualifications: Mapped[str | None] = mapped_column(Text)
    years_experience: Mapped[int | None] = mapped_column("yearsExperience", Integer)
    consultation_fee: Mapped[Decimal] = mapped_column(
        "consultationFee", Numeric(10, 2), default=Decimal("0"), nullable=False
    )

    #: Where this doctor actually sits — the half of the choice a patient makes
    #: that qualifications cannot answer. All nullable: a doctor approved before
    #: these existed has no location, and the directory says "not stated" rather
    #: than inventing one.
    clinic_name: Mapped[str | None] = mapped_column("clinicName", Text)
    city: Mapped[str | None] = mapped_column(Text)
    address_line: Mapped[str | None] = mapped_column("addressLine", Text)
    #: Numeric, not float: a pin that drifts in the last decimal because of
    #: binary rounding is a bug nobody can see and nobody can explain.
    latitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    #: [{ dayOfWeek, startTime, endTime, slotMinutes }]
    availability: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, nullable=False)
    accepting_patients: Mapped[bool] = mapped_column(
        "acceptingPatients", Boolean, default=True, nullable=False
    )
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    user: Mapped[User] = relationship(back_populates="doctor")
    department: Mapped[Department | None] = relationship(back_populates="doctors")


class DoctorTimeOff(Base):
    __tablename__ = "doctor_time_off"

    id: Mapped[str] = _id()
    doctor_id: Mapped[str] = mapped_column(
        "doctorId", Text, ForeignKey("doctors.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    starts_at: Mapped[datetime] = mapped_column("startsAt", DateTime, nullable=False)
    ends_at: Mapped[datetime] = mapped_column("endsAt", DateTime, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)


class DoctorApplication(Base):
    """A doctor's request to practise here, and the record of who decided.

    Kept apart from ``Doctor`` on purpose. A ``Doctor`` row is a credentialed
    clinician — it authorizes prescribing, appears in the booking directory, and
    is what a care relationship points at. An application is a claim somebody
    made about themselves, which is a different kind of fact and must not be
    able to become the first one without a named administrator deciding so.

    That separation is also what keeps the trail: approving copies the fields
    across, and the application stays behind saying what was claimed, who
    checked it and when.
    """

    __tablename__ = "doctor_applications"

    id: Mapped[str] = _id()
    user_id: Mapped[str] = mapped_column(
        "userId", Text, ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    status: Mapped[enums.DoctorApplicationStatus] = mapped_column(
        pg_enum(enums.DoctorApplicationStatus, "DoctorApplicationStatus"),
        default=enums.DoctorApplicationStatus.DRAFT,
        nullable=False,
    )

    # --- The claim ---------------------------------------------------------
    full_name: Mapped[str | None] = mapped_column("fullName", Text)
    phone: Mapped[str | None] = mapped_column(Text)
    national_id: Mapped[str | None] = mapped_column("nationalId", Text)
    address: Mapped[str | None] = mapped_column(Text)
    registration_number: Mapped[str | None] = mapped_column("registrationNumber", Text)
    specialization: Mapped[str | None] = mapped_column(Text)
    department_id: Mapped[str | None] = mapped_column(
        "departmentId", Text, ForeignKey("departments.id", ondelete="SET NULL", onupdate="CASCADE")
    )
    #: ``[{ title, startYear, endYear }]``, the years nullable because a draft is
    #: assembled over several sittings. ``Doctor.qualifications`` is free text
    #: because that is what the original schema had; an application collects them
    #: one at a time so the review screen can show each degree against the years
    #: it spans, and they are rendered into that one line on approval.
    qualifications: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, default=list, nullable=False
    )
    years_experience: Mapped[int | None] = mapped_column("yearsExperience", Integer)
    previous_hospital: Mapped[str | None] = mapped_column("previousHospital", Text)

    #: The practice location, collected here and copied onto the doctor at
    #: approval like every other professional fact — so an administrator reviews
    #: the address that will actually be published. Distinct from `address`
    #: above, which is the applicant's own contact address.
    clinic_name: Mapped[str | None] = mapped_column("clinicName", Text)
    city: Mapped[str | None] = mapped_column(Text)
    address_line: Mapped[str | None] = mapped_column("addressLine", Text)
    latitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    consultation_fee: Mapped[Decimal | None] = mapped_column("consultationFee", Numeric(10, 2))
    #: Same shape as ``Doctor.availability`` — validated on the way in, so an
    #: approval copies it across without having to re-check it.
    availability: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, nullable=False)

    # --- The decision ------------------------------------------------------
    submitted_at: Mapped[datetime | None] = mapped_column("submittedAt", DateTime)
    reviewed_at: Mapped[datetime | None] = mapped_column("reviewedAt", DateTime)
    reviewed_by_id: Mapped[str | None] = mapped_column("reviewedById", Text)
    #: Shown to the applicant verbatim, so they know what to fix.
    rejection_reason: Mapped[str | None] = mapped_column("rejectionReason", Text)
    #: Internal. Never returned on the applicant's own endpoints.
    review_notes: Mapped[str | None] = mapped_column("reviewNotes", Text)

    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class DoctorApplicationDocument(Base):
    """A credential file attached to an application.

    Stored in its own private bucket and reached only through a signed URL minted
    after the access check — the same rule medical documents follow, for the same
    reason: a national ID scan is not less sensitive than a lab report.
    """

    __tablename__ = "doctor_application_documents"

    id: Mapped[str] = _id()
    application_id: Mapped[str] = mapped_column(
        "applicationId",
        Text,
        ForeignKey("doctor_applications.id", ondelete="CASCADE", onupdate="CASCADE"),
        nullable=False,
    )
    kind: Mapped[enums.DoctorDocumentKind] = mapped_column(
        pg_enum(enums.DoctorDocumentKind, "DoctorDocumentKind"), nullable=False
    )
    storage_bucket: Mapped[str] = mapped_column(
        "storageBucket", Text, default="doctor-credentials", nullable=False
    )
    storage_path: Mapped[str] = mapped_column("storagePath", Text, nullable=False)
    file_name: Mapped[str] = mapped_column("fileName", Text, nullable=False)
    mime_type: Mapped[str] = mapped_column("mimeType", Text, nullable=False)
    file_size: Mapped[int] = mapped_column("fileSize", Integer, nullable=False)
    checksum_sha256: Mapped[str | None] = mapped_column("checksumSha256", Text)
    #: An administrator has looked at this file and accepted it. Per document
    #: rather than per application, because a reviewer checks a licence and a
    #: degree separately and may need to come back to one of them.
    verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    verified_by_id: Mapped[str | None] = mapped_column("verifiedById", Text)
    uploaded_at: Mapped[datetime] = mapped_column("uploadedAt", DateTime, default=utcnow, nullable=False)


class Patient(Base):
    __tablename__ = "patients"

    id: Mapped[str] = _id()
    user_id: Mapped[str] = mapped_column(
        "userId", Text, ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    medical_record_number: Mapped[str] = mapped_column("medicalRecordNumber", Text, nullable=False)
    date_of_birth: Mapped[datetime | None] = mapped_column("dateOfBirth", DateTime)
    gender: Mapped[enums.Gender] = mapped_column(
        pg_enum(enums.Gender, "Gender"), default=enums.Gender.UNDISCLOSED, nullable=False
    )
    blood_group: Mapped[str | None] = mapped_column("bloodGroup", Text)
    address: Mapped[str | None] = mapped_column(Text)
    emergency_contact_name: Mapped[str | None] = mapped_column("emergencyContactName", Text)
    emergency_contact_phone: Mapped[str | None] = mapped_column("emergencyContactPhone", Text)
    allergies: Mapped[str | None] = mapped_column(Text)
    chronic_conditions: Mapped[str | None] = mapped_column("chronicConditions", Text)

    #: Consent for third-party AI / speech processing (conflict C2). Checked
    #: before any payload leaves the system; withdrawal disables only those
    #: features, never the rest of the portal.
    ai_consent_granted_at: Mapped[datetime | None] = mapped_column("aiConsentGrantedAt", DateTime)
    ai_consent_withdrawn_at: Mapped[datetime | None] = mapped_column("aiConsentWithdrawnAt", DateTime)

    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    user: Mapped[User] = relationship(back_populates="patient")

    @property
    def ai_consent_active(self) -> bool:
        if self.ai_consent_granted_at is None:
            return False
        if self.ai_consent_withdrawn_at is None:
            return True
        return self.ai_consent_withdrawn_at < self.ai_consent_granted_at


class DoctorPatientAssignment(Base):
    """The care relationship.

    A doctor's access to a patient is authorized by a row here (or by an active
    encounter) — never by holding the DOCTOR role alone.
    """

    __tablename__ = "doctor_patient_assignments"

    id: Mapped[str] = _id()
    doctor_id: Mapped[str] = mapped_column(
        "doctorId", Text, ForeignKey("doctors.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    patient_id: Mapped[str] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    is_primary: Mapped[bool] = mapped_column("isPrimary", Boolean, default=False, nullable=False)
    assigned_at: Mapped[datetime] = mapped_column("assignedAt", DateTime, default=utcnow, nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column("endedAt", DateTime)
    assigned_by: Mapped[str | None] = mapped_column("assignedBy", Text)


# ===========================================================================
# Appointments
# ===========================================================================


class Appointment(Base):
    __tablename__ = "appointments"

    id: Mapped[str] = _id()
    patient_id: Mapped[str] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    doctor_id: Mapped[str] = mapped_column(
        "doctorId", Text, ForeignKey("doctors.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    appointment_date: Mapped[datetime] = mapped_column("appointmentDate", DateTime, nullable=False)
    start_time: Mapped[datetime] = mapped_column("startTime", DateTime, nullable=False)
    end_time: Mapped[datetime] = mapped_column("endTime", DateTime, nullable=False)
    status: Mapped[enums.AppointmentStatus] = mapped_column(
        pg_enum(enums.AppointmentStatus, "AppointmentStatus"),
        default=enums.AppointmentStatus.REQUESTED,
        nullable=False,
    )
    reason: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)

    #: "<doctorId>|<ISO start>" while the appointment holds the slot, NULL once
    #: cancelled. The unique index turns double-booking into a database error
    #: rather than a race Postgres allows many NULLs, so cancelled slots free up.
    slot_key: Mapped[str | None] = mapped_column("slotKey", Text)

    cancelled_at: Mapped[datetime | None] = mapped_column("cancelledAt", DateTime)
    cancelled_by: Mapped[str | None] = mapped_column("cancelledBy", Text)
    cancel_reason: Mapped[str | None] = mapped_column("cancelReason", Text)
    rescheduled_from_id: Mapped[str | None] = mapped_column("rescheduledFromId", Text)
    completed_at: Mapped[datetime | None] = mapped_column("completedAt", DateTime)

    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    @staticmethod
    def build_slot_key(doctor_id: str, start_time: datetime) -> str:
        return f"{doctor_id}|{start_time.isoformat()}"


# ===========================================================================
# Clinical records
# ===========================================================================


class MedicalRecord(Base):
    __tablename__ = "medical_records"

    id: Mapped[str] = _id()
    patient_id: Mapped[str] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    doctor_id: Mapped[str] = mapped_column(
        "doctorId", Text, ForeignKey("doctors.id", ondelete="RESTRICT", onupdate="CASCADE"), nullable=False
    )
    appointment_id: Mapped[str | None] = mapped_column(
        "appointmentId",
        Text,
        ForeignKey("appointments.id", ondelete="SET NULL", onupdate="CASCADE"),
    )
    symptoms: Mapped[str | None] = mapped_column(Text)
    diagnosis: Mapped[str | None] = mapped_column(Text)
    treatment_plan: Mapped[str | None] = mapped_column("treatmentPlan", Text)
    notes: Mapped[str | None] = mapped_column(Text)
    follow_up_date: Mapped[datetime | None] = mapped_column("followUpDate", DateTime)
    follow_up_notes: Mapped[str | None] = mapped_column("followUpNotes", Text)

    #: Always PHYSICIAN here. Machine output lives in ReportedSymptom /
    #: MedicalDocument until a doctor promotes it.
    source: Mapped[enums.DataSource] = mapped_column(
        pg_enum(enums.DataSource, "DataSource"), default=enums.DataSource.PHYSICIAN, nullable=False
    )

    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class BillingSettings(Base):
    """The rates an administrator owns. One row, ever.

    These used to be environment variables, which meant the person accountable
    for the tax rate could not change it without the person who holds the
    server. The single row is enforced by a check constraint on a fixed primary
    key, not by convention: "we only ever insert one" is a rule that survives
    until somebody writes a second insert.
    """

    __tablename__ = "billing_settings"

    #: Fixed, so the settings can be fetched without first asking which row.
    SINGLETON: ClassVar[str] = "singleton"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=SINGLETON)
    #: Each figure is read through the mode beside it: rupees under FIXED,
    #: percent under PERCENT. One mechanism for all three rather than a special
    #: case per fee — tax is normally a percentage and a platform fee normally
    #: flat, but a system that hard-codes which is which forces a clinic that
    #: does the opposite to lie about its own pricing.
    #:
    #: `tax_percent` keeps its column name. Renaming one that every invoice row
    #: refers to, purely to gain the word "value", is tidiness paid for in a
    #: migration that can go wrong.
    tax_percent: Mapped[Decimal] = mapped_column(
        "taxPercent", Numeric(10, 2), default=Decimal("0"), nullable=False
    )
    tax_mode: Mapped[enums.FeeMode] = mapped_column(
        "taxMode", pg_enum(enums.FeeMode, "FeeMode"), default=enums.FeeMode.PERCENT, nullable=False
    )
    platform_fee: Mapped[Decimal] = mapped_column(
        "platformFee", Numeric(10, 2), default=Decimal("0"), nullable=False
    )
    platform_fee_mode: Mapped[enums.FeeMode] = mapped_column(
        "platformFeeMode",
        pg_enum(enums.FeeMode, "FeeMode"),
        default=enums.FeeMode.FIXED,
        nullable=False,
    )
    #: Added once, when a bill passes its due date — not per day. A daily charge
    #: on a hospital bill compounds while somebody is too ill to deal with it.
    late_fee: Mapped[Decimal] = mapped_column(
        "lateFee", Numeric(10, 2), default=Decimal("0"), nullable=False
    )
    late_fee_mode: Mapped[enums.FeeMode] = mapped_column(
        "lateFeeMode",
        pg_enum(enums.FeeMode, "FeeMode"),
        default=enums.FeeMode.FIXED,
        nullable=False,
    )
    #: The account a patient is told to transfer into.
    #:
    #: Here rather than in configuration because it belongs to the administrator
    #: — a clinic that changes wallet should not need a deployment — and because
    #: it sits beside the rates they already edit. Nullable throughout: a
    #: hospital that has not entered one is told plainly that online payment is
    #: unavailable, rather than showing a patient an empty account to pay into.
    payee_name: Mapped[str | None] = mapped_column("payeeName", String(160))
    nayapay_number: Mapped[str | None] = mapped_column("nayapayNumber", String(32))
    easypaisa_number: Mapped[str | None] = mapped_column("easypaisaNumber", String(32))
    #: Anything else the payer needs to know — a branch, a reference format.
    payment_note: Mapped[str | None] = mapped_column("paymentNote", Text)

    updated_at: Mapped[datetime] = mapped_column("updatedAt", DateTime, nullable=False)
    updated_by_id: Mapped[str | None] = mapped_column("updatedById", Text)


class Payment(Base):
    """A claim that an invoice has been paid, and what became of it.

    Not a payment: a *claim*. The patient transfers the money in their own
    banking app, then tells us the reference and shows a screenshot. That is
    evidence, and evidence is not settlement — only an administrator who has
    looked at the receiving account moves this to ``SUCCEEDED``, and only that
    marks the invoice paid. Collapsing the two would let anybody clear a bill
    with a picture of somebody else's transfer.
    """

    __tablename__ = "payments"

    id: Mapped[str] = _id()
    invoice_id: Mapped[str] = mapped_column(
        "invoiceId",
        Text,
        ForeignKey("invoices.id", ondelete="CASCADE", onupdate="CASCADE"),
        nullable=False,
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    currency: Mapped[str] = mapped_column(Text, default="PKR", nullable=False)
    method: Mapped[enums.PaymentMethod] = mapped_column(
        pg_enum(enums.PaymentMethod, "PaymentMethod"), nullable=False
    )
    status: Mapped[enums.PaymentStatus] = mapped_column(
        pg_enum(enums.PaymentStatus, "PaymentStatus"), nullable=False
    )
    #: The transaction reference the payer read off their banking app.
    #:
    #: Deliberately not unique. Two people paying from the same wallet can show
    #: the same visible reference, and banks reuse them across days — a unique
    #: index would refuse a genuine payment at the moment somebody is trying to
    #: settle a bill. A duplicate is something for the reviewer to notice, which
    #: is what the reviewer is for.
    reference: Mapped[str | None] = mapped_column(String(120))
    #: The screenshot, as an object key in the private proofs bucket. A path and
    #: never a URL, like avatars: the bucket has no public address and every
    #: link is signed per response.
    proof_path: Mapped[str | None] = mapped_column("proofPath", Text)

    #: Who checked it, when, and — if they refused — why. The reason is shown to
    #: the patient, so it has to be a sentence rather than a code.
    reviewed_by_id: Mapped[str | None] = mapped_column("reviewedById", Text)
    reviewed_at: Mapped[datetime | None] = mapped_column("reviewedAt", DateTime)
    rejection_reason: Mapped[str | None] = mapped_column("rejectionReason", Text)

    #: Left from the gateway that preceded this. Unused and nullable; kept
    #: rather than dropped because the column costs nothing and dropping one is
    #: a migration that can go wrong for no gain.
    gateway_ref: Mapped[str | None] = mapped_column("gatewayRef", Text)
    gateway_code: Mapped[str | None] = mapped_column("gatewayCode", Text)
    gateway_message: Mapped[str | None] = mapped_column("gatewayMessage", Text)

    created_at: Mapped[datetime] = _created()
    completed_at: Mapped[datetime | None] = mapped_column("completedAt", DateTime)


class Withdrawal(Base):
    """A doctor asking for their balance, and what became of it.

    The account details sit on this row rather than on the doctor, because a
    doctor may be paid to a different account each time and the record has to
    say where *this* money went — changing bank next month must not silently
    rewrite where last month's payment was sent.
    """

    __tablename__ = "withdrawals"

    id: Mapped[str] = _id()
    doctor_id: Mapped[str] = mapped_column(
        "doctorId",
        Text,
        ForeignKey("doctors.id", ondelete="CASCADE", onupdate="CASCADE"),
        nullable=False,
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    currency: Mapped[str] = mapped_column(Text, default="PKR", nullable=False)
    method: Mapped[enums.WithdrawalMethod] = mapped_column(
        pg_enum(enums.WithdrawalMethod, "WithdrawalMethod"), nullable=False
    )
    account_name: Mapped[str] = mapped_column("accountName", String(160), nullable=False)
    account_number: Mapped[str] = mapped_column("accountNumber", String(64), nullable=False)
    #: Only meaningful for a bank transfer; a wallet is identified by its number.
    bank_name: Mapped[str | None] = mapped_column("bankName", String(120))

    status: Mapped[enums.WithdrawalStatus] = mapped_column(
        pg_enum(enums.WithdrawalStatus, "WithdrawalStatus"),
        default=enums.WithdrawalStatus.REQUESTED,
        nullable=False,
    )
    #: The administrator's screenshot of the outgoing transfer — the mirror of
    #: what a patient uploads coming in. Both sides carry evidence.
    proof_path: Mapped[str | None] = mapped_column("proofPath", Text)
    reference: Mapped[str | None] = mapped_column(String(120))

    reviewed_by_id: Mapped[str | None] = mapped_column("reviewedById", Text)
    reviewed_at: Mapped[datetime | None] = mapped_column("reviewedAt", DateTime)
    rejection_reason: Mapped[str | None] = mapped_column("rejectionReason", Text)
    created_at: Mapped[datetime] = _created()


class DoctorLedgerEntry(Base):
    """One movement in a doctor's balance.

    A list of signed entries rather than a total on the doctor row: a stored
    balance is one bad write away from being wrong with nothing to check it
    against, and no way to answer "wrong since when, and why". This can be
    recomputed at any time, and a mistake is a correcting entry rather than an
    edit to a number somebody is owed.
    """

    __tablename__ = "doctor_ledger_entries"

    id: Mapped[str] = _id()
    doctor_id: Mapped[str] = mapped_column(
        "doctorId",
        Text,
        ForeignKey("doctors.id", ondelete="CASCADE", onupdate="CASCADE"),
        nullable=False,
    )
    #: Credits positive, debits negative; the balance is their sum. One column
    #: rather than two, so no query can add up the wrong one and no entry can be
    #: both at once.
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    currency: Mapped[str] = mapped_column(Text, default="PKR", nullable=False)
    kind: Mapped[enums.LedgerEntryKind] = mapped_column(
        pg_enum(enums.LedgerEntryKind, "LedgerEntryKind"), nullable=False
    )
    #: What a doctor reads in their own statement.
    description: Mapped[str | None] = mapped_column(Text)

    invoice_id: Mapped[str | None] = mapped_column(
        "invoiceId",
        Text,
        ForeignKey("invoices.id", ondelete="SET NULL", onupdate="CASCADE"),
    )
    withdrawal_id: Mapped[str | None] = mapped_column(
        "withdrawalId",
        Text,
        ForeignKey("withdrawals.id", ondelete="SET NULL", onupdate="CASCADE"),
    )
    created_at: Mapped[datetime] = _created()


class Prescription(Base):
    __tablename__ = "prescriptions"

    id: Mapped[str] = _id()
    patient_id: Mapped[str] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    doctor_id: Mapped[str] = mapped_column(
        "doctorId", Text, ForeignKey("doctors.id", ondelete="RESTRICT", onupdate="CASCADE"), nullable=False
    )
    medical_record_id: Mapped[str | None] = mapped_column(
        "medicalRecordId", Text, ForeignKey("medical_records.id", ondelete="SET NULL", onupdate="CASCADE")
    )
    medication: Mapped[str] = mapped_column(Text, nullable=False)
    dosage: Mapped[str] = mapped_column(Text, nullable=False)
    frequency: Mapped[str] = mapped_column(Text, nullable=False)
    duration: Mapped[str] = mapped_column(Text, nullable=False)
    instructions: Mapped[str | None] = mapped_column(Text)
    start_date: Mapped[datetime | None] = mapped_column("startDate", DateTime)
    end_date: Mapped[datetime | None] = mapped_column("endDate", DateTime)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class ReportedSymptom(Base):
    """Staging tier for patient-reported and AI-extracted symptoms.

    Never a diagnosis. A doctor promotes a row into a MedicalRecord, and that
    promotion is what gives the statement a clinical author (conflict C7).
    """

    __tablename__ = "reported_symptoms"

    id: Mapped[str] = _id()
    patient_id: Mapped[str] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    symptom: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str | None] = mapped_column(Text)
    duration_text: Mapped[str | None] = mapped_column("durationText", Text)
    raw_text: Mapped[str | None] = mapped_column("rawText", Text)
    source: Mapped[enums.DataSource] = mapped_column(
        pg_enum(enums.DataSource, "DataSource"),
        default=enums.DataSource.PATIENT_REPORTED,
        nullable=False,
    )
    input_type: Mapped[enums.InputType] = mapped_column(
        "inputType", pg_enum(enums.InputType, "InputType"), default=enums.InputType.TEXT, nullable=False
    )
    confidence: Mapped[float | None] = mapped_column(Float)
    ai_interaction_id: Mapped[str | None] = mapped_column(
        "aiInteractionId", Text, ForeignKey("ai_interactions.id", ondelete="SET NULL", onupdate="CASCADE")
    )
    promoted_to_record_id: Mapped[str | None] = mapped_column(
        "promotedToRecordId", Text, ForeignKey("medical_records.id", ondelete="SET NULL", onupdate="CASCADE")
    )
    promoted_by_id: Mapped[str | None] = mapped_column("promotedById", Text)
    promoted_at: Mapped[datetime | None] = mapped_column("promotedAt", DateTime)
    created_at: Mapped[datetime] = _created()


# ===========================================================================
# Documents, storage & OCR
# ===========================================================================


class MedicalDocument(Base):
    __tablename__ = "medical_documents"

    id: Mapped[str] = _id()
    patient_id: Mapped[str] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    uploaded_by_id: Mapped[str] = mapped_column(
        "uploadedById", Text, ForeignKey("users.id", ondelete="RESTRICT", onupdate="CASCADE"), nullable=False
    )
    medical_record_id: Mapped[str | None] = mapped_column(
        "medicalRecordId", Text, ForeignKey("medical_records.id", ondelete="SET NULL", onupdate="CASCADE")
    )
    document_type: Mapped[enums.DocumentType] = mapped_column(
        "documentType",
        pg_enum(enums.DocumentType, "DocumentType"),
        default=enums.DocumentType.OTHER,
        nullable=False,
    )
    title: Mapped[str | None] = mapped_column(Text)
    original_file_name: Mapped[str] = mapped_column("originalFileName", Text, nullable=False)
    mime_type: Mapped[str] = mapped_column("mimeType", Text, nullable=False)
    file_size: Mapped[int] = mapped_column("fileSize", Integer, nullable=False)
    checksum_sha256: Mapped[str | None] = mapped_column("checksumSha256", Text)

    #: Private bucket, addressed by path. A delivery URL is signed on demand
    #: after the access check, so a document cannot be reached without passing
    #: RBAC and producing an audit entry (conflict C8).
    storage_bucket: Mapped[str] = mapped_column(
        "storageBucket", Text, default="medical-documents", nullable=False
    )
    storage_path: Mapped[str] = mapped_column("storagePath", Text, nullable=False)

    ocr_status: Mapped[enums.OcrStatus] = mapped_column(
        "ocrStatus", pg_enum(enums.OcrStatus, "OcrStatus"), default=enums.OcrStatus.PENDING, nullable=False
    )
    ocr_engine: Mapped[enums.OcrEngine | None] = mapped_column(
        "ocrEngine", pg_enum(enums.OcrEngine, "OcrEngine")
    )
    ocr_confidence: Mapped[float | None] = mapped_column("ocrConfidence", Float)
    extracted_text: Mapped[str | None] = mapped_column("extractedText", Text)
    #: Structured OCR output awaiting human confirmation.
    structured_data: Mapped[dict[str, Any] | None] = mapped_column("structuredData", JSONB)
    confirmed_by_id: Mapped[str | None] = mapped_column("confirmedById", Text)
    confirmed_at: Mapped[datetime | None] = mapped_column("confirmedAt", DateTime)
    ocr_error: Mapped[str | None] = mapped_column("ocrError", Text)

    deleted_at: Mapped[datetime | None] = mapped_column("deletedAt", DateTime)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


# ===========================================================================
# Vitals & alerts
# ===========================================================================


class Vital(Base):
    __tablename__ = "vitals"

    id: Mapped[str] = _id()
    patient_id: Mapped[str] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    recorded_by_id: Mapped[str | None] = mapped_column(
        "recordedById", Text, ForeignKey("users.id", ondelete="SET NULL", onupdate="CASCADE")
    )
    source: Mapped[enums.DataSource] = mapped_column(
        pg_enum(enums.DataSource, "DataSource"), default=enums.DataSource.DEVICE, nullable=False
    )
    device_id: Mapped[str | None] = mapped_column("deviceId", Text)

    heart_rate: Mapped[int | None] = mapped_column("heartRate", Integer)
    systolic_bp: Mapped[int | None] = mapped_column("systolicBp", Integer)
    diastolic_bp: Mapped[int | None] = mapped_column("diastolicBp", Integer)
    oxygen_saturation: Mapped[float | None] = mapped_column("oxygenSaturation", Float)
    temperature: Mapped[float | None] = mapped_column(Float)
    respiratory_rate: Mapped[int | None] = mapped_column("respiratoryRate", Integer)

    recorded_at: Mapped[datetime] = mapped_column("recordedAt", DateTime, default=utcnow, nullable=False)
    created_at: Mapped[datetime] = _created()


class VitalThreshold(Base):
    """Configurable thresholds.

    ``patient_id`` NULL is the hospital default for that vital; a row with a
    patient overrides it. Per-patient overrides are what stop a COPD patient's
    ordinary saturation from firing a hospital alarm every reading (C9).
    """

    __tablename__ = "vital_thresholds"

    id: Mapped[str] = _id()
    vital_type: Mapped[enums.VitalType] = mapped_column(
        "vitalType", pg_enum(enums.VitalType, "VitalType"), nullable=False
    )
    patient_id: Mapped[str | None] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE")
    )
    min_value: Mapped[float | None] = mapped_column("minValue", Float)
    max_value: Mapped[float | None] = mapped_column("maxValue", Float)
    severity: Mapped[enums.AlertSeverity] = mapped_column(
        pg_enum(enums.AlertSeverity, "AlertSeverity"), default=enums.AlertSeverity.WARNING, nullable=False
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    #: Consecutive breaching readings before an alert fires — filters sensor
    #: artefacts such as a detached probe.
    sustained_readings: Mapped[int] = mapped_column("sustainedReadings", Integer, default=1, nullable=False)
    created_by_id: Mapped[str | None] = mapped_column("createdById", Text)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[str] = _id()
    patient_id: Mapped[str] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    vital_id: Mapped[str | None] = mapped_column(
        "vitalId", Text, ForeignKey("vitals.id", ondelete="SET NULL", onupdate="CASCADE")
    )
    doctor_id: Mapped[str | None] = mapped_column(
        "doctorId", Text, ForeignKey("doctors.id", ondelete="SET NULL", onupdate="CASCADE")
    )
    vital_type: Mapped[enums.VitalType] = mapped_column(
        "vitalType", pg_enum(enums.VitalType, "VitalType"), nullable=False
    )
    measured_value: Mapped[float] = mapped_column("measuredValue", Float, nullable=False)
    threshold_min: Mapped[float | None] = mapped_column("thresholdMin", Float)
    threshold_max: Mapped[float | None] = mapped_column("thresholdMax", Float)
    severity: Mapped[enums.AlertSeverity] = mapped_column(
        pg_enum(enums.AlertSeverity, "AlertSeverity"), nullable=False
    )
    status: Mapped[enums.AlertStatus] = mapped_column(
        pg_enum(enums.AlertStatus, "AlertStatus"), default=enums.AlertStatus.OPEN, nullable=False
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)
    acknowledged_by_id: Mapped[str | None] = mapped_column(
        "acknowledgedById", Text, ForeignKey("users.id", ondelete="SET NULL", onupdate="CASCADE")
    )
    acknowledged_at: Mapped[datetime | None] = mapped_column("acknowledgedAt", DateTime)
    resolved_at: Mapped[datetime | None] = mapped_column("resolvedAt", DateTime)
    escalated_at: Mapped[datetime | None] = mapped_column("escalatedAt", DateTime)
    escalation_level: Mapped[int] = mapped_column("escalationLevel", Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = _created()


# ===========================================================================
# Billing
# ===========================================================================


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[str] = _id()
    patient_id: Mapped[str] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    #: Unique: one invoice per appointment. This is the idempotency guarantee
    #: for "complete consultation" retries (R4) — a duplicate fails at the
    #: database, not only in application logic.
    appointment_id: Mapped[str | None] = mapped_column(
        "appointmentId",
        Text,
        ForeignKey("appointments.id", ondelete="SET NULL", onupdate="CASCADE"),
    )
    invoice_number: Mapped[str] = mapped_column("invoiceNumber", Text, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    tax_amount: Mapped[Decimal] = mapped_column(
        "taxAmount", Numeric(10, 2), default=Decimal("0"), nullable=False
    )
    total_amount: Mapped[Decimal] = mapped_column("totalAmount", Numeric(10, 2), nullable=False)
    #: Stored per invoice rather than read from configuration at display
    #: time: a bill says what it was raised in, and a clinic that changes
    #: currency must not silently restate every invoice it ever issued.
    #: What this bill charged, copied from settings when it was issued — never
    #: read live. An invoice is a statement of a debt as it stood; reading the
    #: current rate would silently restate every unpaid bill in the hospital
    #: whenever an administrator corrected a number.
    platform_fee: Mapped[Decimal] = mapped_column(
        "platformFee", Numeric(10, 2), default=Decimal("0"), nullable=False
    )
    tax_percent: Mapped[Decimal] = mapped_column(
        "taxPercent", Numeric(5, 2), default=Decimal("0"), nullable=False
    )
    #: What will be charged if this goes past `due_at`. Whether it *has* is
    #: computed from the date, never stored — a stored flag needs a nightly
    #: sweep to stay true, and a bill that is overdue only once a job has run is
    #: a bill that lies between midnights.
    late_fee: Mapped[Decimal] = mapped_column(
        "lateFee", Numeric(10, 2), default=Decimal("0"), nullable=False
    )
    currency: Mapped[str] = mapped_column(Text, default="PKR", nullable=False)
    status: Mapped[enums.InvoiceStatus] = mapped_column(
        pg_enum(enums.InvoiceStatus, "InvoiceStatus"), default=enums.InvoiceStatus.DRAFT, nullable=False
    )
    line_items: Mapped[list[dict[str, Any]]] = mapped_column("lineItems", JSONB, default=list, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    issued_at: Mapped[datetime | None] = mapped_column("issuedAt", DateTime)
    due_at: Mapped[datetime | None] = mapped_column("dueAt", DateTime)
    paid_at: Mapped[datetime | None] = mapped_column("paidAt", DateTime)
    voided_at: Mapped[datetime | None] = mapped_column("voidedAt", DateTime)
    #: Credit notes reference the invoice they correct; issued invoices are
    #: never edited in place (conflict C4, requirement R6).
    amends_invoice_id: Mapped[str | None] = mapped_column("amendsInvoiceId", Text)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


# ===========================================================================
# AI & notifications
# ===========================================================================


class AIInteraction(Base):
    __tablename__ = "ai_interactions"

    id: Mapped[str] = _id()
    patient_id: Mapped[str] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    session_id: Mapped[str] = mapped_column("sessionId", Text, nullable=False)
    input: Mapped[str] = mapped_column(Text, nullable=False)
    input_type: Mapped[enums.InputType] = mapped_column(
        "inputType", pg_enum(enums.InputType, "InputType"), default=enums.InputType.TEXT, nullable=False
    )
    extracted_symptoms: Mapped[list[str]] = mapped_column(
        "extractedSymptoms", JSONB, default=list, nullable=False
    )
    response: Mapped[str] = mapped_column(Text, nullable=False)
    #: Set when the safety layer detects red-flag symptoms and escalates.
    emergency_flagged: Mapped[bool] = mapped_column(
        "emergencyFlagged", Boolean, default=False, nullable=False
    )
    recommended_department: Mapped[str | None] = mapped_column("recommendedDepartment", Text)
    urgency_level: Mapped[str | None] = mapped_column("urgencyLevel", Text)
    model_name: Mapped[str | None] = mapped_column("modelName", Text)
    latency_ms: Mapped[int | None] = mapped_column("latencyMs", Integer)
    created_at: Mapped[datetime] = _created()


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = _id()
    user_id: Mapped[str] = mapped_column(
        "userId", Text, ForeignKey("users.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    type: Mapped[enums.NotificationType] = mapped_column(
        pg_enum(enums.NotificationType, "NotificationType"), nullable=False
    )
    channel: Mapped[enums.NotificationChannel] = mapped_column(
        pg_enum(enums.NotificationChannel, "NotificationChannel"),
        default=enums.NotificationChannel.IN_APP,
        nullable=False,
    )
    status: Mapped[enums.NotificationStatus] = mapped_column(
        pg_enum(enums.NotificationStatus, "NotificationStatus"),
        default=enums.NotificationStatus.PENDING,
        nullable=False,
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    link: Mapped[str | None] = mapped_column(Text)
    notification_metadata: Mapped[dict[str, Any] | None] = mapped_column("metadata", JSONB)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column("sentAt", DateTime)
    read_at: Mapped[datetime | None] = mapped_column("readAt", DateTime)
    failed_at: Mapped[datetime | None] = mapped_column("failedAt", DateTime)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()


# ===========================================================================
# Emergency access & audit
# ===========================================================================


class EmergencyAccess(Base):
    """Break-glass grant (R3, conflict C1).

    Scoped to one patient, time-boxed, reviewed. Never an unrestricted bypass:
    every read under a grant writes an EMERGENCY_ACCESS_USED audit entry.
    """

    __tablename__ = "emergency_access"

    id: Mapped[str] = _id()
    requester_id: Mapped[str] = mapped_column(
        "requesterId", Text, ForeignKey("users.id", ondelete="RESTRICT", onupdate="CASCADE"), nullable=False
    )
    patient_id: Mapped[str] = mapped_column(
        "patientId", Text, ForeignKey("patients.id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[enums.EmergencyAccessStatus] = mapped_column(
        pg_enum(enums.EmergencyAccessStatus, "EmergencyAccessStatus"),
        default=enums.EmergencyAccessStatus.ACTIVE,
        nullable=False,
    )
    ip_address: Mapped[str | None] = mapped_column("ipAddress", Text)
    user_agent: Mapped[str | None] = mapped_column("userAgent", Text)
    granted_at: Mapped[datetime] = mapped_column("grantedAt", DateTime, default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column("expiresAt", DateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column("revokedAt", DateTime)
    revoked_by_id: Mapped[str | None] = mapped_column("revokedById", Text)
    #: Post-hoc compliance review. Unreviewed grants surface on the admin
    #: dashboard — the deterrent is the review, not the restriction.
    reviewed_at: Mapped[datetime | None] = mapped_column("reviewedAt", DateTime)
    reviewed_by_id: Mapped[str | None] = mapped_column("reviewedById", Text)
    review_notes: Mapped[str | None] = mapped_column("reviewNotes", Text)
    access_count: Mapped[int] = mapped_column("accessCount", Integer, default=0, nullable=False)


class AuditLog(Base):
    """Append-only (R6). No update or delete path exists anywhere in the app.

    ``user_id`` is deliberately NOT a foreign key: with ON DELETE SET NULL an
    admin deleting a user silently erased who did what across the whole
    history, and with RESTRICT no account could ever be removed. The trail has
    to outlive its subject.
    """

    __tablename__ = "audit_logs"

    id: Mapped[str] = _id()
    user_id: Mapped[str | None] = mapped_column("userId", Text)
    actor_role: Mapped[enums.Role | None] = mapped_column("actorRole", pg_enum(enums.Role, "Role"))
    action: Mapped[enums.AuditAction] = mapped_column(
        pg_enum(enums.AuditAction, "AuditAction"), nullable=False
    )
    severity: Mapped[enums.AuditSeverity] = mapped_column(
        pg_enum(enums.AuditSeverity, "AuditSeverity"),
        default=enums.AuditSeverity.INFO,
        nullable=False,
    )
    entity_type: Mapped[str | None] = mapped_column("entityType", Text)
    entity_id: Mapped[str | None] = mapped_column("entityId", Text)
    patient_id: Mapped[str | None] = mapped_column("patientId", Text)
    ip_address: Mapped[str | None] = mapped_column("ipAddress", Text)
    user_agent: Mapped[str | None] = mapped_column("userAgent", Text)
    request_id: Mapped[str | None] = mapped_column("requestId", Text)
    #: References only — field names and record ids, never clinical values (C5).
    audit_metadata: Mapped[dict[str, Any] | None] = mapped_column("metadata", JSONB)
    emergency_access_id: Mapped[str | None] = mapped_column("emergencyAccessId", Text)
    previous_hash: Mapped[str | None] = mapped_column("previousHash", Text)
    entry_hash: Mapped[str] = mapped_column("entryHash", Text, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class SystemConfig(Base):
    __tablename__ = "system_config"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    updated_by_id: Mapped[str | None] = mapped_column("updatedById", Text)
    updated_at: Mapped[datetime] = _updated()


# ===========================================================================
# Indexes
# ===========================================================================
#
# Declared here rather than inline so the whole access-pattern story reads in
# one place. Names match what the original migration created, so autogenerate
# compares equal instead of proposing to drop and recreate them — and, more
# importantly, a database built from Alembic alone gets the same indexes the
# development database already has.

Index("users_role_status_idx", User.role, User.status)

Index("sessions_userId_revokedAt_idx", Session.user_id, Session.revoked_at)
Index("sessions_expiresAt_idx", Session.expires_at)  # expiry sweeps

Index("refresh_tokens_sessionId_idx", RefreshToken.session_id)
Index("refresh_tokens_userId_idx", RefreshToken.user_id)
Index("password_reset_tokens_userId_idx", PasswordResetToken.user_id)

# Both are swept for expiry as well as read by owner.
Index("two_factor_challenges_userId_idx", TwoFactorChallenge.user_id)
Index("two_factor_challenges_expiresAt_idx", TwoFactorChallenge.expires_at)
Index("trusted_devices_userId_idx", TrustedDevice.user_id)
Index("trusted_devices_expiresAt_idx", TrustedDevice.expires_at)

# The admin queue reads by status and oldest-first, so the wait is fair.
Index(
    "doctor_applications_status_submittedAt_idx",
    DoctorApplication.status,
    DoctorApplication.submitted_at,
)
Index("doctor_application_documents_applicationId_idx", DoctorApplicationDocument.application_id)

Index("doctors_departmentId_idx", Doctor.department_id)
Index("doctors_specialization_idx", Doctor.specialization)
Index("doctor_time_off_doctorId_startsAt_idx", DoctorTimeOff.doctor_id, DoctorTimeOff.starts_at)

# The care relationship is read on every doctor request, so it is indexed both
# ways: by doctor to list a caseload, by patient to answer "may this doctor?".
Index(
    "doctor_patient_assignments_doctorId_patientId_key",
    DoctorPatientAssignment.doctor_id,
    DoctorPatientAssignment.patient_id,
    unique=True,
)
Index(
    "doctor_patient_assignments_patientId_endedAt_idx",
    DoctorPatientAssignment.patient_id,
    DoctorPatientAssignment.ended_at,
)

Index("appointments_doctorId_startTime_idx", Appointment.doctor_id, Appointment.start_time)
Index("appointments_patientId_startTime_idx", Appointment.patient_id, Appointment.start_time)
Index("appointments_status_idx", Appointment.status)

Index("medical_records_patientId_createdAt_idx", MedicalRecord.patient_id, MedicalRecord.created_at)
Index("medical_records_doctorId_idx", MedicalRecord.doctor_id)
Index("prescriptions_patientId_active_idx", Prescription.patient_id, Prescription.active)
Index("prescriptions_medicalRecordId_idx", Prescription.medical_record_id)
Index("reported_symptoms_patientId_createdAt_idx", ReportedSymptom.patient_id, ReportedSymptom.created_at)

Index("medical_documents_patientId_createdAt_idx", MedicalDocument.patient_id, MedicalDocument.created_at)
Index("medical_documents_documentType_idx", MedicalDocument.document_type)
Index("medical_documents_ocrStatus_idx", MedicalDocument.ocr_status)  # OCR job queue scan

Index("vitals_patientId_recordedAt_idx", Vital.patient_id, Vital.recorded_at)
# One threshold per vital per patient; the NULL patient row is the hospital
# default, and Postgres allows many NULLs under a unique index.
Index(
    "vital_thresholds_vitalType_patientId_key",
    VitalThreshold.vital_type,
    VitalThreshold.patient_id,
    unique=True,
)
# ...which is exactly why the hospital default needs its own partial index. The
# unique index above cannot constrain the NULL rows, so without this a second
# hospital default for the same vital would be accepted and "which rule governs
# this patient" would depend on row order.
Index(
    "vital_thresholds_hospital_default_key",
    VitalThreshold.vital_type,
    unique=True,
    postgresql_where=VitalThreshold.patient_id.is_(None),
)

Index("alerts_patientId_status_idx", Alert.patient_id, Alert.status)
Index("alerts_doctorId_status_idx", Alert.doctor_id, Alert.status)
Index("alerts_status_createdAt_idx", Alert.status, Alert.created_at)  # escalation sweeps

Index("invoices_patientId_status_idx", Invoice.patient_id, Invoice.status)

Index("ai_interactions_patientId_createdAt_idx", AIInteraction.patient_id, AIInteraction.created_at)
Index("ai_interactions_sessionId_idx", AIInteraction.session_id)

Index("notifications_userId_status_idx", Notification.user_id, Notification.status)
Index("notifications_userId_readAt_idx", Notification.user_id, Notification.read_at)

Index("emergency_access_patientId_status_idx", EmergencyAccess.patient_id, EmergencyAccess.status)
Index("emergency_access_requesterId_idx", EmergencyAccess.requester_id)
# Drives the expiry sweep and the unreviewed-grant dashboard.
Index("emergency_access_status_expiresAt_idx", EmergencyAccess.status, EmergencyAccess.expires_at)

# Audit reads are compliance queries: by actor, by patient, by action, by severity.
Index("audit_logs_userId_timestamp_idx", AuditLog.user_id, AuditLog.timestamp)
Index("audit_logs_patientId_timestamp_idx", AuditLog.patient_id, AuditLog.timestamp)
Index("audit_logs_action_timestamp_idx", AuditLog.action, AuditLog.timestamp)
Index("audit_logs_severity_timestamp_idx", AuditLog.severity, AuditLog.timestamp)


# Single-column uniqueness, declared as named unique indexes to match how the
# schema was originally created.
Index("users_email_key", User.email, unique=True)
Index("refresh_tokens_tokenHash_key", RefreshToken.token_hash, unique=True)
Index("password_reset_tokens_tokenHash_key", PasswordResetToken.token_hash, unique=True)
Index("trusted_devices_tokenHash_key", TrustedDevice.token_hash, unique=True)
# One application per user: a second row would let somebody hold a rejected
# claim and an approved one at the same time.
Index("doctor_applications_userId_key", DoctorApplication.user_id, unique=True)
Index(
    "doctor_application_documents_storagePath_key",
    DoctorApplicationDocument.storage_path,
    unique=True,
)
Index("departments_name_key", Department.name, unique=True)
Index("departments_code_key", Department.code, unique=True)
Index("doctors_userId_key", Doctor.user_id, unique=True)
Index("doctors_licenseNumber_key", Doctor.license_number, unique=True)
Index("patients_userId_key", Patient.user_id, unique=True)
Index("patients_medicalRecordNumber_key", Patient.medical_record_number, unique=True)
# Holds the slot while active, NULL once cancelled — this is what turns
# double-booking into a database error rather than a race (R14).
Index("appointments_slotKey_key", Appointment.slot_key, unique=True)
Index("medical_records_appointmentId_key", MedicalRecord.appointment_id, unique=True)
Index("medical_documents_storagePath_key", MedicalDocument.storage_path, unique=True)
# One invoice per appointment: the idempotency guarantee for consultation
# completion retries (R4).
Index("invoices_appointmentId_key", Invoice.appointment_id, unique=True)
Index("invoices_invoiceNumber_key", Invoice.invoice_number, unique=True)

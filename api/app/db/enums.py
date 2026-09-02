"""Python mirrors of the Postgres enum types.

Values must match the database exactly — the types already exist (created by
the Prisma migration that established the schema), so SQLAlchemy binds to them
rather than creating them.
"""

from __future__ import annotations

from enum import StrEnum


class Role(StrEnum):
    ADMIN = "ADMIN"
    DOCTOR = "DOCTOR"
    PATIENT = "PATIENT"
    #: No dashboard yet. Exists so break-glass access (R3) has a real principal
    #: instead of an unrestricted bypass.
    NURSE = "NURSE"


class UserStatus(StrEnum):
    PENDING_VERIFICATION = "PENDING_VERIFICATION"
    ACTIVE = "ACTIVE"
    SUSPENDED = "SUSPENDED"
    DEACTIVATED = "DEACTIVATED"


class TwoFactorMethod(StrEnum):
    """How a second factor reaches its owner.

    EMAIL needs nothing installed, which matters for a clinic where staff share
    ward machines and cannot all be assumed to carry a configured phone. TOTP is
    stronger — it never crosses a mail server — and is what a doctor or an
    administrator should use.
    """

    EMAIL = "EMAIL"
    TOTP = "TOTP"


class DoctorApplicationStatus(StrEnum):
    """Where a doctor's registration has reached.

    DRAFT is saved but unsent, so an applicant can leave and come back.
    SUBMITTED is awaiting a human; REJECTED returns to the applicant to correct
    and send again. Only APPROVED creates a ``Doctor`` row and lets them work.
    """

    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class DoctorDocumentKind(StrEnum):
    REGISTRATION_CERTIFICATE = "REGISTRATION_CERTIFICATE"
    DEGREE = "DEGREE"
    NATIONAL_ID = "NATIONAL_ID"
    PHOTO = "PHOTO"


class Gender(StrEnum):
    MALE = "MALE"
    FEMALE = "FEMALE"
    OTHER = "OTHER"
    UNDISCLOSED = "UNDISCLOSED"


class AppointmentStatus(StrEnum):
    REQUESTED = "REQUESTED"
    CONFIRMED = "CONFIRMED"
    CHECKED_IN = "CHECKED_IN"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    NO_SHOW = "NO_SHOW"


#: Appointment statuses that establish a doctor's care relationship with a
#: patient, and so authorize access to their data.
#:
#: REQUESTED is absent deliberately — a patient asking for an appointment must
#: not hand the doctor their chart before anyone accepts it, or requesting a
#: consultation would become a way to grant access. COMPLETED *is* present: you
#: treated them, and the notes stay yours to read.
#:
#: Defined here, in the module that depends on nothing, because both
#: ``api/deps.py`` and ``modules/records/access.py`` decide access with it and a
#: second copy would eventually disagree with the first.
ENCOUNTER_STATUSES = (
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.CHECKED_IN,
    AppointmentStatus.IN_PROGRESS,
    AppointmentStatus.COMPLETED,
)


class InvoiceStatus(StrEnum):
    DRAFT = "DRAFT"
    ISSUED = "ISSUED"
    PAID = "PAID"
    VOID = "VOID"
    REFUNDED = "REFUNDED"
    OVERDUE = "OVERDUE"


class FeeMode(StrEnum):
    """Whether a fee is a flat amount or a share of the bill.

    One mechanism for all three figures rather than a special case per fee: tax
    is normally a percentage and a platform fee normally a flat charge, but
    clinics exist that do the opposite, and a system that hard-codes which is
    which forces them to lie about their own pricing.
    """

    FIXED = "FIXED"
    PERCENT = "PERCENT"


class PaymentMethod(StrEnum):
    """Where the money was sent.

    All three are transfers a person makes themselves, in their own banking app,
    and then tells us about — there is no gateway in this system and none is
    pretended. ``COUNTER`` is money handed over at the billing desk and recorded
    by staff; the other two are wallet transfers the payer evidences with a
    screenshot.
    """

    NAYAPAY = "NAYAPAY"
    EASYPAISA = "EASYPAISA"
    COUNTER = "COUNTER"


class PaymentStatus(StrEnum):
    """Where an attempt got to.

    ``SUBMITTED`` is the important one and the reason this is not a boolean. It
    means *the payer says they have paid and has shown us something* — not that
    money arrived. Only a person who has checked the receiving account moves it
    to ``SUCCEEDED``, which is what keeps "a patient uploaded a picture" and "the
    hospital has been paid" as two different facts. Treating them as one would
    let anybody settle a bill with a screenshot of somebody else's transfer.
    """

    SUBMITTED = "SUBMITTED"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"


class LedgerEntryKind(StrEnum):
    """Why a doctor's balance moved.

    A ledger of signed entries rather than a running total on the doctor row.
    A stored balance is one bad write away from being wrong with nothing to
    compare it against; a sum of entries can always be recomputed, and every
    movement says what caused it.
    """

    #: A confirmed patient payment. Credit.
    EARNING = "EARNING"
    #: Money set aside the moment a withdrawal is requested. Debit — held then,
    #: not when it is paid out, or the same balance could be requested twice.
    WITHDRAWAL = "WITHDRAWAL"
    #: A refused withdrawal handing the held money back. Credit.
    WITHDRAWAL_REVERSAL = "WITHDRAWAL_REVERSAL"


class WithdrawalMethod(StrEnum):
    """Where a doctor wants their money sent."""

    BANK = "BANK"
    EASYPAISA = "EASYPAISA"
    JAZZCASH = "JAZZCASH"
    NAYAPAY = "NAYAPAY"


class WithdrawalStatus(StrEnum):
    """How far a withdrawal has got.

    ``PAID`` means an administrator has actually sent the money and attached
    proof — the same distinction the patient side makes between a claim and a
    confirmation, for the same reason: nothing here moves money by itself.
    """

    REQUESTED = "REQUESTED"
    PAID = "PAID"
    REJECTED = "REJECTED"


class DocumentType(StrEnum):
    PRESCRIPTION = "PRESCRIPTION"
    LAB_REPORT = "LAB_REPORT"
    BLOOD_TEST = "BLOOD_TEST"
    MEDICAL_CERTIFICATE = "MEDICAL_CERTIFICATE"
    REFERRAL_LETTER = "REFERRAL_LETTER"
    DISCHARGE_SUMMARY = "DISCHARGE_SUMMARY"
    IMAGING = "IMAGING"
    PROFILE_IMAGE = "PROFILE_IMAGE"
    OTHER = "OTHER"


class OcrStatus(StrEnum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    EXTRACTED = "EXTRACTED"
    CONFIRMED = "CONFIRMED"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"


class OcrEngine(StrEnum):
    """Which engine produced an extraction.

    Recorded per document because engines disagree, and a field that needs
    re-checking later should say what read it. ``MANUAL`` is what a human
    correction becomes once a clinician has retyped a field.

    TESSERACT predates the move to PaddleOCR and is kept because the value may
    exist in rows written before the change; nothing produces it now.
    """

    TESSERACT = "TESSERACT"
    PADDLE_OCR = "PADDLE_OCR"
    GEMINI_VISION = "GEMINI_VISION"
    MANUAL = "MANUAL"


class VitalType(StrEnum):
    HEART_RATE = "HEART_RATE"
    SYSTOLIC_BP = "SYSTOLIC_BP"
    DIASTOLIC_BP = "DIASTOLIC_BP"
    OXYGEN_SATURATION = "OXYGEN_SATURATION"
    TEMPERATURE = "TEMPERATURE"
    RESPIRATORY_RATE = "RESPIRATORY_RATE"


class AlertSeverity(StrEnum):
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class AlertStatus(StrEnum):
    OPEN = "OPEN"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    RESOLVED = "RESOLVED"
    ESCALATED = "ESCALATED"


class DataSource(StrEnum):
    """Provenance of a clinical statement.

    Only ``PHYSICIAN`` rows are the authored medical record. Everything else is
    staging until a doctor promotes it (conflict C7).
    """

    PHYSICIAN = "PHYSICIAN"
    PATIENT_REPORTED = "PATIENT_REPORTED"
    AI_ASSISTED = "AI_ASSISTED"
    OCR_EXTRACTED = "OCR_EXTRACTED"
    DEVICE = "DEVICE"


class InputType(StrEnum):
    TEXT = "TEXT"
    VOICE = "VOICE"


class NotificationType(StrEnum):
    APPOINTMENT_BOOKED = "APPOINTMENT_BOOKED"
    APPOINTMENT_REMINDER = "APPOINTMENT_REMINDER"
    APPOINTMENT_CANCELLED = "APPOINTMENT_CANCELLED"
    APPOINTMENT_RESCHEDULED = "APPOINTMENT_RESCHEDULED"
    MEDICATION_REMINDER = "MEDICATION_REMINDER"
    INVOICE_ISSUED = "INVOICE_ISSUED"
    REPORT_UPLOADED = "REPORT_UPLOADED"
    VITAL_ALERT = "VITAL_ALERT"
    EMERGENCY_ACCESS = "EMERGENCY_ACCESS"
    ACCOUNT_SECURITY = "ACCOUNT_SECURITY"
    #: A doctor's registration moved — submitted, approved or rejected. Its own
    #: type rather than ACCOUNT_SECURITY because it is a queue an administrator
    #: works through, and filing it under security events would bury it.
    DOCTOR_APPLICATION = "DOCTOR_APPLICATION"


class NotificationChannel(StrEnum):
    IN_APP = "IN_APP"
    EMAIL = "EMAIL"
    #: A Web Push message to a device the patient has enrolled. The only
    #: channel that reaches somebody who is not looking at the site, which is
    #: the whole point of a reminder to take a tablet.
    PUSH = "PUSH"


class NotificationStatus(StrEnum):
    PENDING = "PENDING"
    SENT = "SENT"
    FAILED = "FAILED"
    READ = "READ"


class EmergencyAccessStatus(StrEnum):
    ACTIVE = "ACTIVE"
    EXPIRED = "EXPIRED"
    REVOKED = "REVOKED"


class AuditAction(StrEnum):
    LOGIN = "LOGIN"
    LOGIN_FAILED = "LOGIN_FAILED"
    LOGOUT = "LOGOUT"
    SESSION_EXPIRED = "SESSION_EXPIRED"
    PASSWORD_RESET_REQUESTED = "PASSWORD_RESET_REQUESTED"
    PASSWORD_CHANGED = "PASSWORD_CHANGED"
    EMAIL_VERIFIED = "EMAIL_VERIFIED"
    #: Turning a second factor on or off, and reissuing the codes that bypass
    #: it, each change what it takes to become this user. Recording them as
    #: USER_UPDATED would file the most security-relevant change an account can
    #: undergo under the same heading as editing a phone number.
    TWO_FACTOR_ENABLED = "TWO_FACTOR_ENABLED"
    TWO_FACTOR_DISABLED = "TWO_FACTOR_DISABLED"
    BACKUP_CODES_REGENERATED = "BACKUP_CODES_REGENERATED"
    DOCTOR_APPLICATION_SUBMITTED = "DOCTOR_APPLICATION_SUBMITTED"
    DOCTOR_APPLICATION_APPROVED = "DOCTOR_APPLICATION_APPROVED"
    DOCTOR_APPLICATION_REJECTED = "DOCTOR_APPLICATION_REJECTED"
    USER_CREATED = "USER_CREATED"
    USER_UPDATED = "USER_UPDATED"
    USER_STATUS_CHANGED = "USER_STATUS_CHANGED"
    PATIENT_RECORD_VIEW = "PATIENT_RECORD_VIEW"
    PATIENT_RECORD_CREATE = "PATIENT_RECORD_CREATE"
    PATIENT_RECORD_UPDATE = "PATIENT_RECORD_UPDATE"
    PRESCRIPTION_CREATED = "PRESCRIPTION_CREATED"
    PRESCRIPTION_UPDATED = "PRESCRIPTION_UPDATED"
    DOCUMENT_UPLOADED = "DOCUMENT_UPLOADED"
    DOCUMENT_VIEWED = "DOCUMENT_VIEWED"
    DOCUMENT_DELETED = "DOCUMENT_DELETED"
    APPOINTMENT_CREATED = "APPOINTMENT_CREATED"
    APPOINTMENT_UPDATED = "APPOINTMENT_UPDATED"
    APPOINTMENT_CANCELLED = "APPOINTMENT_CANCELLED"
    CONSULTATION_COMPLETED = "CONSULTATION_COMPLETED"
    INVOICE_CREATED = "INVOICE_CREATED"
    INVOICE_UPDATED = "INVOICE_UPDATED"
    AI_INTERACTION = "AI_INTERACTION"
    OCR_PROCESSED = "OCR_PROCESSED"
    OCR_CONFIRMED = "OCR_CONFIRMED"
    VITAL_RECORDED = "VITAL_RECORDED"
    VITAL_ALERT = "VITAL_ALERT"
    EMERGENCY_ACCESS_GRANTED = "EMERGENCY_ACCESS_GRANTED"
    EMERGENCY_ACCESS_USED = "EMERGENCY_ACCESS_USED"
    EMERGENCY_ACCESS_REVOKED = "EMERGENCY_ACCESS_REVOKED"
    ACCESS_DENIED = "ACCESS_DENIED"
    CONFIG_CHANGED = "CONFIG_CHANGED"
    #: Reading the trail is itself a recorded action. Otherwise an administrator
    #: browsing charts through the audit log would be the one access this system
    #: does not record (R6).
    AUDIT_VIEWED = "AUDIT_VIEWED"


class AuditSeverity(StrEnum):
    INFO = "INFO"
    NOTICE = "NOTICE"
    WARNING = "WARNING"
    BREAK_GLASS = "BREAK_GLASS"
    SECURITY = "SECURITY"


#: Every Postgres enum type the schema depends on, keyed by its exact type name.
#: The models bind to these with ``create_type=False``, so the baseline
#: migration is the one place that creates them.
PG_ENUM_TYPES: dict[str, type[StrEnum]] = {
    "Role": Role,
    "UserStatus": UserStatus,
    "TwoFactorMethod": TwoFactorMethod,
    "DoctorApplicationStatus": DoctorApplicationStatus,
    "DoctorDocumentKind": DoctorDocumentKind,
    "Gender": Gender,
    "AppointmentStatus": AppointmentStatus,
    "InvoiceStatus": InvoiceStatus,
    "DocumentType": DocumentType,
    "OcrStatus": OcrStatus,
    "OcrEngine": OcrEngine,
    "VitalType": VitalType,
    "AlertSeverity": AlertSeverity,
    "AlertStatus": AlertStatus,
    "DataSource": DataSource,
    "InputType": InputType,
    "NotificationType": NotificationType,
    "NotificationChannel": NotificationChannel,
    "NotificationStatus": NotificationStatus,
    "EmergencyAccessStatus": EmergencyAccessStatus,
    "AuditAction": AuditAction,
    "AuditSeverity": AuditSeverity,
}

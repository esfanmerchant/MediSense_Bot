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


class NotificationChannel(StrEnum):
    IN_APP = "IN_APP"
    EMAIL = "EMAIL"


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

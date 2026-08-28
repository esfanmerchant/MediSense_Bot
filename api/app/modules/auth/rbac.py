"""Permission catalogue.

Roles are bundles of permissions rather than checks scattered through route
handlers, which is what makes adding NURSE a data change instead of a refactor.

The ``:own`` / ``:assigned`` / ``:any`` suffix is the *breadth* of a permission.
Holding ``record:read:assigned`` does not grant access to a specific patient —
it says the holder may read records of patients they have a care relationship
with. The relationship itself is checked separately by ``resolve_patient_access``,
because a permission alone is never authorization for a particular row.
"""

from __future__ import annotations

from enum import StrEnum

from app.db.enums import Role


class Permission(StrEnum):
    # Users & organisation
    USER_READ_ANY = "user:read:any"
    USER_MANAGE = "user:manage"
    DEPARTMENT_MANAGE = "department:manage"
    CONFIG_MANAGE = "config:manage"
    ANALYTICS_READ = "analytics:read"

    # Patients
    PATIENT_READ_OWN = "patient:read:own"
    PATIENT_READ_ASSIGNED = "patient:read:assigned"
    PATIENT_READ_ANY = "patient:read:any"
    PATIENT_WRITE_OWN = "patient:write:own"
    PATIENT_MANAGE = "patient:manage"

    # Clinical records
    RECORD_READ_OWN = "record:read:own"
    RECORD_READ_ASSIGNED = "record:read:assigned"
    RECORD_WRITE = "record:write"
    PRESCRIPTION_READ_OWN = "prescription:read:own"
    #: A prescriber who cannot see what a patient is already taking is a drug
    #: interaction waiting to happen, so writing implies reading here.
    PRESCRIPTION_READ_ASSIGNED = "prescription:read:assigned"
    PRESCRIPTION_WRITE = "prescription:write"

    # Appointments
    APPOINTMENT_BOOK_OWN = "appointment:book:own"
    APPOINTMENT_READ_OWN = "appointment:read:own"
    APPOINTMENT_READ_ASSIGNED = "appointment:read:assigned"
    APPOINTMENT_MANAGE_ANY = "appointment:manage:any"
    CONSULTATION_COMPLETE = "consultation:complete"

    # Documents
    DOCUMENT_UPLOAD_OWN = "document:upload:own"
    DOCUMENT_UPLOAD_ANY = "document:upload:any"
    DOCUMENT_READ_OWN = "document:read:own"
    DOCUMENT_READ_ASSIGNED = "document:read:assigned"
    DOCUMENT_DELETE = "document:delete"

    # Vitals & alerts
    VITAL_READ_OWN = "vital:read:own"
    VITAL_READ_ASSIGNED = "vital:read:assigned"
    VITAL_WRITE = "vital:write"
    THRESHOLD_MANAGE = "threshold:manage"
    ALERT_READ_ASSIGNED = "alert:read:assigned"
    ALERT_MANAGE = "alert:manage"

    # Billing
    INVOICE_READ_OWN = "invoice:read:own"
    INVOICE_READ_ANY = "invoice:read:any"
    INVOICE_MANAGE = "invoice:manage"

    # AI & OCR
    AI_CHAT = "ai:chat"
    OCR_SUBMIT = "ocr:submit"

    # Safety & compliance
    EMERGENCY_REQUEST = "emergency:request"
    EMERGENCY_REVIEW = "emergency:review"
    AUDIT_READ = "audit:read"


_PATIENT: frozenset[Permission] = frozenset(
    {
        Permission.PATIENT_READ_OWN,
        Permission.PATIENT_WRITE_OWN,
        Permission.RECORD_READ_OWN,
        Permission.PRESCRIPTION_READ_OWN,
        Permission.APPOINTMENT_BOOK_OWN,
        Permission.APPOINTMENT_READ_OWN,
        Permission.DOCUMENT_UPLOAD_OWN,
        Permission.DOCUMENT_READ_OWN,
        Permission.VITAL_READ_OWN,
        Permission.INVOICE_READ_OWN,
        Permission.AI_CHAT,
        Permission.OCR_SUBMIT,
    }
)

_DOCTOR: frozenset[Permission] = frozenset(
    {
        Permission.PATIENT_READ_ASSIGNED,
        Permission.RECORD_READ_ASSIGNED,
        Permission.RECORD_WRITE,
        Permission.PRESCRIPTION_READ_ASSIGNED,
        Permission.PRESCRIPTION_WRITE,
        Permission.APPOINTMENT_READ_ASSIGNED,
        Permission.CONSULTATION_COMPLETE,
        Permission.DOCUMENT_UPLOAD_ANY,
        Permission.DOCUMENT_READ_ASSIGNED,
        Permission.VITAL_READ_ASSIGNED,
        Permission.VITAL_WRITE,
        Permission.THRESHOLD_MANAGE,
        Permission.ALERT_READ_ASSIGNED,
        Permission.ALERT_MANAGE,
    }
)

#: Admins run the hospital; they do not hold a standing right to read charts.
#: Separating administration from clinical content is the whole point of R2.
_ADMIN: frozenset[Permission] = frozenset(
    {
        Permission.USER_READ_ANY,
        Permission.USER_MANAGE,
        Permission.DEPARTMENT_MANAGE,
        Permission.CONFIG_MANAGE,
        Permission.ANALYTICS_READ,
        Permission.PATIENT_READ_ANY,
        Permission.PATIENT_MANAGE,
        Permission.APPOINTMENT_MANAGE_ANY,
        Permission.INVOICE_READ_ANY,
        Permission.INVOICE_MANAGE,
        Permission.THRESHOLD_MANAGE,
        Permission.AUDIT_READ,
        Permission.EMERGENCY_REVIEW,
        Permission.DOCUMENT_DELETE,
    }
)

#: Nurses hold no standing access to patient data. Their only patient-facing
#: permission is the right to *request* break-glass access, which is then
#: granted, scoped and expired per patient (R3, conflict C1).
_NURSE: frozenset[Permission] = frozenset(
    {
        Permission.EMERGENCY_REQUEST,
        Permission.VITAL_WRITE,
        Permission.ALERT_READ_ASSIGNED,
    }
)

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.ADMIN: _ADMIN,
    Role.DOCTOR: _DOCTOR,
    Role.PATIENT: _PATIENT,
    Role.NURSE: _NURSE,
}


def permissions_for(role: Role) -> frozenset[Permission]:
    return ROLE_PERMISSIONS.get(role, frozenset())


def role_has_permission(role: Role, permission: Permission) -> bool:
    return permission in permissions_for(role)

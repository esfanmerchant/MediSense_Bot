import { Role } from '@prisma/client';

/**
 * Permission catalogue.
 *
 * Roles are bundles of permissions rather than checks scattered through
 * controllers, which is what makes adding NURSE a data change instead of a
 * refactor (spec §4, §11).
 *
 * The `:own` / `:assigned` / `:any` suffix is the *breadth* of a permission.
 * Holding `record:read:assigned` does not grant access to a specific patient —
 * it says the holder may read records of patients they have a care
 * relationship with. The relationship itself is checked separately by
 * `resolvePatientAccess`, because a permission alone is never authorization
 * for a particular row.
 */
export const Permission = {
  // Users & organisation
  USER_READ_ANY: 'user:read:any',
  USER_MANAGE: 'user:manage',
  DEPARTMENT_MANAGE: 'department:manage',
  CONFIG_MANAGE: 'config:manage',
  ANALYTICS_READ: 'analytics:read',

  // Patients
  PATIENT_READ_OWN: 'patient:read:own',
  PATIENT_READ_ASSIGNED: 'patient:read:assigned',
  PATIENT_READ_ANY: 'patient:read:any',
  PATIENT_WRITE_OWN: 'patient:write:own',
  PATIENT_MANAGE: 'patient:manage',

  // Clinical records
  RECORD_READ_OWN: 'record:read:own',
  RECORD_READ_ASSIGNED: 'record:read:assigned',
  RECORD_WRITE: 'record:write',
  PRESCRIPTION_READ_OWN: 'prescription:read:own',
  PRESCRIPTION_WRITE: 'prescription:write',

  // Appointments
  APPOINTMENT_BOOK_OWN: 'appointment:book:own',
  APPOINTMENT_READ_OWN: 'appointment:read:own',
  APPOINTMENT_READ_ASSIGNED: 'appointment:read:assigned',
  APPOINTMENT_MANAGE_ANY: 'appointment:manage:any',
  CONSULTATION_COMPLETE: 'consultation:complete',

  // Documents
  DOCUMENT_UPLOAD_OWN: 'document:upload:own',
  DOCUMENT_UPLOAD_ANY: 'document:upload:any',
  DOCUMENT_READ_OWN: 'document:read:own',
  DOCUMENT_READ_ASSIGNED: 'document:read:assigned',
  DOCUMENT_DELETE: 'document:delete',

  // Vitals & alerts
  VITAL_READ_OWN: 'vital:read:own',
  VITAL_READ_ASSIGNED: 'vital:read:assigned',
  VITAL_WRITE: 'vital:write',
  THRESHOLD_MANAGE: 'threshold:manage',
  ALERT_READ_ASSIGNED: 'alert:read:assigned',
  ALERT_MANAGE: 'alert:manage',

  // Billing
  INVOICE_READ_OWN: 'invoice:read:own',
  INVOICE_READ_ANY: 'invoice:read:any',
  INVOICE_MANAGE: 'invoice:manage',

  // AI & OCR
  AI_CHAT: 'ai:chat',
  OCR_SUBMIT: 'ocr:submit',

  // Safety & compliance
  EMERGENCY_REQUEST: 'emergency:request',
  EMERGENCY_REVIEW: 'emergency:review',
  AUDIT_READ: 'audit:read',
} as const;

export type PermissionValue = (typeof Permission)[keyof typeof Permission];

const PATIENT_PERMISSIONS: PermissionValue[] = [
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
];

const DOCTOR_PERMISSIONS: PermissionValue[] = [
  Permission.PATIENT_READ_ASSIGNED,
  Permission.RECORD_READ_ASSIGNED,
  Permission.RECORD_WRITE,
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
];

const ADMIN_PERMISSIONS: PermissionValue[] = [
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
];

/**
 * Nurses hold no standing access to patient data. Their only patient-facing
 * permission is the right to *request* break-glass access, which is granted,
 * scoped and expired per patient (R3, C1).
 */
const NURSE_PERMISSIONS: PermissionValue[] = [
  Permission.EMERGENCY_REQUEST,
  Permission.VITAL_WRITE,
  Permission.ALERT_READ_ASSIGNED,
];

export const ROLE_PERMISSIONS: Record<Role, readonly PermissionValue[]> = {
  [Role.ADMIN]: ADMIN_PERMISSIONS,
  [Role.DOCTOR]: DOCTOR_PERMISSIONS,
  [Role.PATIENT]: PATIENT_PERMISSIONS,
  [Role.NURSE]: NURSE_PERMISSIONS,
};

export const permissionsFor = (role: Role): readonly PermissionValue[] =>
  ROLE_PERMISSIONS[role] ?? [];

export const roleHasPermission = (role: Role, permission: PermissionValue): boolean =>
  permissionsFor(role).includes(permission);

export const roleHasAnyPermission = (role: Role, permissions: PermissionValue[]): boolean =>
  permissions.some((permission) => roleHasPermission(role, permission));

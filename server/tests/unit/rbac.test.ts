import { Role } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { Permission, permissionsFor, roleHasPermission } from '../../src/modules/auth/rbac.js';

describe('role permissions', () => {
  it('gives patients access to their own data only', () => {
    expect(roleHasPermission(Role.PATIENT, Permission.RECORD_READ_OWN)).toBe(true);
    expect(roleHasPermission(Role.PATIENT, Permission.RECORD_READ_ASSIGNED)).toBe(false);
    expect(roleHasPermission(Role.PATIENT, Permission.PATIENT_READ_ANY)).toBe(false);
  });

  it('never lets a patient write clinical records', () => {
    // R5/R13: physician-authored records are not patient-editable.
    expect(roleHasPermission(Role.PATIENT, Permission.RECORD_WRITE)).toBe(false);
    expect(roleHasPermission(Role.PATIENT, Permission.PRESCRIPTION_WRITE)).toBe(false);
    expect(roleHasPermission(Role.PATIENT, Permission.CONSULTATION_COMPLETE)).toBe(false);
  });

  it('scopes doctors to assigned patients rather than all patients', () => {
    expect(roleHasPermission(Role.DOCTOR, Permission.RECORD_READ_ASSIGNED)).toBe(true);
    expect(roleHasPermission(Role.DOCTOR, Permission.PATIENT_READ_ANY)).toBe(false);
  });

  it('separates administration from clinical content', () => {
    // Admins run the hospital; they do not get a standing right to read charts.
    expect(roleHasPermission(Role.ADMIN, Permission.USER_MANAGE)).toBe(true);
    expect(roleHasPermission(Role.ADMIN, Permission.AUDIT_READ)).toBe(true);
    expect(roleHasPermission(Role.ADMIN, Permission.RECORD_READ_ASSIGNED)).toBe(false);
    expect(roleHasPermission(Role.ADMIN, Permission.RECORD_WRITE)).toBe(false);
  });

  it('gives nurses no standing patient-data access, only the right to request break-glass', () => {
    expect(roleHasPermission(Role.NURSE, Permission.EMERGENCY_REQUEST)).toBe(true);
    expect(roleHasPermission(Role.NURSE, Permission.RECORD_READ_ASSIGNED)).toBe(false);
    expect(roleHasPermission(Role.NURSE, Permission.PATIENT_READ_ANY)).toBe(false);
    expect(roleHasPermission(Role.NURSE, Permission.DOCUMENT_READ_ASSIGNED)).toBe(false);
  });

  it('lets only admins read the audit log', () => {
    for (const role of [Role.DOCTOR, Role.PATIENT, Role.NURSE]) {
      expect(roleHasPermission(role, Permission.AUDIT_READ)).toBe(false);
    }
  });

  it('defines a permission set for every role', () => {
    for (const role of Object.values(Role)) {
      expect(permissionsFor(role).length).toBeGreaterThan(0);
    }
  });
});

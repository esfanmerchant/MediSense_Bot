import { Role } from '@prisma/client';
import type { RequestHandler } from 'express';

import { prisma } from '../database/prisma.js';
import { recordAudit } from '../modules/audit/audit.service.js';
import { Permission, type PermissionValue } from '../modules/auth/rbac.js';
import { forbidden, forbiddenResource, unauthenticated } from '../utils/errors.js';
import { asyncHandler } from '../utils/http.js';
import { clientIp } from './requestContext.js';

/** Coarse role gate. Useful for whole route groups; never sufficient on its own. */
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(unauthenticated());
    if (!roles.includes(req.auth.role)) {
      void logDenial(req, `role ${req.auth.role} not in [${roles.join(', ')}]`);
      return next(forbidden());
    }
    next();
  };

/** Requires every listed permission. */
export const requirePermission =
  (...permissions: PermissionValue[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(unauthenticated());
    const missing = permissions.filter((p) => !req.auth!.permissions.includes(p));
    if (missing.length > 0) {
      void logDenial(req, `missing permission ${missing.join(', ')}`);
      return next(forbidden());
    }
    next();
  };

/** Requires at least one of the listed permissions. */
export const requireAnyPermission =
  (...permissions: PermissionValue[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(unauthenticated());
    if (!permissions.some((p) => req.auth!.permissions.includes(p))) {
      void logDenial(req, `none of [${permissions.join(', ')}]`);
      return next(forbidden());
    }
    next();
  };

export type PatientAccessReason =
  | 'SELF'
  | 'ASSIGNED_DOCTOR'
  | 'TREATING_DOCTOR'
  | 'ADMIN'
  | 'EMERGENCY_ACCESS';

export interface PatientAccessResult {
  allowed: boolean;
  reason?: PatientAccessReason;
}

/**
 * Resource-level authorization: may this caller touch THIS patient?
 *
 * A role alone never answers this. `GET /patients/:id/records` for a doctor is
 * allowed only when a care relationship exists — an assignment row, an
 * appointment that is or was in progress, or an active break-glass grant.
 * Patients match on their own patient id, resolved from the session rather
 * than taken from the URL (spec §8: never trust IDs supplied by the frontend).
 */
export const resolvePatientAccess = async (
  auth: Express.AuthContext,
  patientId: string,
): Promise<PatientAccessResult> => {
  if (auth.role === Role.PATIENT) {
    return auth.patientId === patientId ? { allowed: true, reason: 'SELF' } : { allowed: false };
  }

  if (auth.role === Role.DOCTOR && auth.doctorId) {
    const assignment = await prisma.doctorPatientAssignment.findFirst({
      where: { doctorId: auth.doctorId, patientId, endedAt: null },
      select: { id: true },
    });
    if (assignment) return { allowed: true, reason: 'ASSIGNED_DOCTOR' };

    // A doctor who is consulting this patient has access for that encounter
    // even without a standing assignment.
    const encounter = await prisma.appointment.findFirst({
      where: {
        doctorId: auth.doctorId,
        patientId,
        status: { in: ['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'] },
      },
      select: { id: true },
    });
    if (encounter) return { allowed: true, reason: 'TREATING_DOCTOR' };

    return { allowed: false };
  }

  if (auth.permissions.includes(Permission.PATIENT_READ_ANY)) {
    return { allowed: true, reason: 'ADMIN' };
  }

  // Break-glass (R3): only while the grant is active, and only for the exact
  // patient it was issued for.
  if (auth.emergencyAccessId) {
    const grant = await prisma.emergencyAccess.findFirst({
      where: {
        id: auth.emergencyAccessId,
        patientId,
        status: 'ACTIVE',
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (grant) return { allowed: true, reason: 'EMERGENCY_ACCESS' };
  }

  return { allowed: false };
};

/**
 * Route guard for `/patients/:patientId/...`. Denials are audited: a rejected
 * attempt to read someone else's chart is a security event, not a 403 to
 * discard.
 */
export const requirePatientAccess = (paramName = 'patientId'): RequestHandler =>
  asyncHandler(async (req, _res, next) => {
    if (!req.auth) throw unauthenticated();

    const patientId = req.params[paramName];
    if (!patientId) throw forbiddenResource();

    const result = await resolvePatientAccess(req.auth, patientId);
    if (!result.allowed) {
      await recordAudit({
        action: 'ACCESS_DENIED',
        severity: 'SECURITY',
        userId: req.auth.userId,
        actorRole: req.auth.role,
        patientId,
        entityType: 'Patient',
        entityId: patientId,
        ipAddress: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        requestId: req.requestId,
        metadata: { path: req.path, method: req.method },
      });
      throw forbiddenResource();
    }

    if (result.reason === 'EMERGENCY_ACCESS') {
      // Every read under a grant is recorded, and the grant counts its uses.
      await Promise.all([
        prisma.emergencyAccess.update({
          where: { id: req.auth.emergencyAccessId! },
          data: { accessCount: { increment: 1 } },
        }),
        recordAudit({
          action: 'EMERGENCY_ACCESS_USED',
          severity: 'BREAK_GLASS',
          userId: req.auth.userId,
          actorRole: req.auth.role,
          patientId,
          emergencyAccessId: req.auth.emergencyAccessId!,
          ipAddress: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
          requestId: req.requestId,
          metadata: { path: req.path, method: req.method },
        }),
      ]);
    }

    next();
  });

const logDenial = async (
  req: Parameters<RequestHandler>[0],
  detail: string,
): Promise<void> => {
  if (!req.auth) return;
  await recordAudit({
    action: 'ACCESS_DENIED',
    severity: 'SECURITY',
    userId: req.auth.userId,
    actorRole: req.auth.role,
    ipAddress: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId,
    metadata: { path: req.path, method: req.method, detail },
  });
};

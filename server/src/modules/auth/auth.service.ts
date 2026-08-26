import { randomBytes } from 'node:crypto';

import { Role, type User, UserStatus } from '@prisma/client';

import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { AppError, ErrorCode, conflict, invalidCredentials, notFound, unauthenticated } from '../../utils/errors.js';
import { checkPasswordPolicy, hashPassword, needsRehash, verifyPassword } from '../../utils/password.js';
import { generateOpaqueToken, hashToken, signAccessToken } from '../../utils/tokens.js';
import { recordAudit } from '../audit/audit.service.js';
import { permissionsFor } from './rbac.js';
import {
  REFRESH_TOKEN_TTL_SECONDS,
  absoluteTimeoutSeconds,
  accessTokenTtlSeconds,
  idleTimeoutSeconds,
} from './session.policy.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const PASSWORD_RESET_TTL_MINUTES = 30;

export interface RequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  phone: string | null;
  status: UserStatus;
  patientId?: string;
  doctorId?: string;
  permissions: string[];
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresInSeconds: number;
  /** Null when the device class is exempt from idle expiry (monitor displays). */
  idleTimeoutSeconds: number | null;
  sessionId: string;
}

export interface LoginResult {
  user: AuthenticatedUser;
  tokens: SessionTokens;
}

const toAuthenticatedUser = (
  user: Pick<User, 'id' | 'name' | 'email' | 'role' | 'phone' | 'status'>,
  patientId?: string | null,
  doctorId?: string | null,
): AuthenticatedUser => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  phone: user.phone,
  status: user.status,
  ...(patientId ? { patientId } : {}),
  ...(doctorId ? { doctorId } : {}),
  permissions: [...permissionsFor(user.role)],
});

/** MRN format: MRN-YYYY-XXXXXX. Unique-checked by the database. */
const generateMedicalRecordNumber = (): string =>
  `MRN-${new Date().getFullYear()}-${randomBytes(4).readUInt32BE(0).toString().padStart(6, '0').slice(0, 6)}`;

// ---------------------------------------------------------------------------
// Registration — self-service patient sign-up only
// ---------------------------------------------------------------------------

/**
 * Public registration always creates a PATIENT. Doctor, nurse and admin
 * accounts are created by an administrator, so the role can never be chosen by
 * the person signing up.
 */
export const registerPatient = async (
  input: RegisterInput,
  ctx: RequestContext = {},
): Promise<AuthenticatedUser> => {
  const policy = checkPasswordPolicy(input.password, input.email);
  if (!policy.valid) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_ERROR,
      'Choose a stronger password.',
      policy.problems.map((message) => ({ field: 'password', message })),
    );
  }

  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw conflict('An account with that email already exists.');

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash,
      role: Role.PATIENT,
      phone: input.phone ?? null,
      status: UserStatus.ACTIVE,
      patient: {
        create: {
          medicalRecordNumber: generateMedicalRecordNumber(),
          dateOfBirth: input.dateOfBirth ?? null,
          gender: input.gender ?? 'UNDISCLOSED',
          bloodGroup: input.bloodGroup ?? null,
          address: input.address ?? null,
          emergencyContactName: input.emergencyContactName ?? null,
          emergencyContactPhone: input.emergencyContactPhone ?? null,
        },
      },
    },
    include: { patient: { select: { id: true } } },
  });

  await recordAudit({
    action: 'USER_CREATED',
    userId: user.id,
    actorRole: user.role,
    entityType: 'User',
    entityId: user.id,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
    requestId: ctx.requestId ?? null,
    metadata: { role: user.role, selfRegistered: true },
  });

  return toAuthenticatedUser(user, user.patient?.id);
};

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export const login = async (input: LoginInput, ctx: RequestContext = {}): Promise<LoginResult> => {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { patient: { select: { id: true } }, doctor: { select: { id: true } } },
  });

  if (!user) {
    // Hash anyway so a missing account and a wrong password take similar time.
    await verifyPassword(input.password, 'scrypt$32768$8$1$AAAA$AAAA');
    await recordAudit({
      action: 'LOGIN_FAILED',
      severity: 'SECURITY',
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId ?? null,
      metadata: { reason: 'UNKNOWN_EMAIL' },
    });
    throw invalidCredentials();
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(
      423,
      ErrorCode.ACCOUNT_LOCKED,
      `Too many failed attempts. Try again after ${user.lockedUntil.toLocaleTimeString()}.`,
    );
  }

  const passwordValid = await verifyPassword(input.password, user.passwordHash);

  if (!passwordValid) {
    const failedLoginCount = user.failedLoginCount + 1;
    const shouldLock = failedLoginCount >= MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      },
    });
    await recordAudit({
      action: 'LOGIN_FAILED',
      severity: 'SECURITY',
      userId: user.id,
      actorRole: user.role,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId ?? null,
      metadata: { reason: 'BAD_PASSWORD', failedLoginCount, locked: shouldLock },
    });
    throw invalidCredentials();
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw new AppError(
      403,
      ErrorCode.ACCOUNT_INACTIVE,
      'This account is not active. Contact an administrator.',
    );
  }

  // Transparent upgrade if the stored hash predates the current parameters.
  const rehash = needsRehash(user.passwordHash) ? await hashPassword(input.password) : null;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      ...(rehash ? { passwordHash: rehash } : {}),
    },
  });

  const tokens = await createSession(user.id, user.role, input.deviceClass, ctx);

  await recordAudit({
    action: 'LOGIN',
    userId: user.id,
    actorRole: user.role,
    entityType: 'Session',
    entityId: tokens.sessionId,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
    requestId: ctx.requestId ?? null,
    metadata: { deviceClass: input.deviceClass },
  });

  return { user: toAuthenticatedUser(user, user.patient?.id, user.doctor?.id), tokens };
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const createSession = async (
  userId: string,
  role: Role,
  deviceClass: string,
  ctx: RequestContext = {},
  emergencyAccessId?: string,
): Promise<SessionTokens> => {
  const now = Date.now();
  const session = await prisma.session.create({
    data: {
      userId,
      deviceClass,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      expiresAt: new Date(now + absoluteTimeoutSeconds() * 1000),
    },
    select: { id: true },
  });

  return issueTokens(session.id, userId, role, deviceClass, emergencyAccessId);
};

const issueTokens = async (
  sessionId: string,
  userId: string,
  role: Role,
  deviceClass: string,
  emergencyAccessId?: string,
): Promise<SessionTokens> => {
  const accessTtl = accessTokenTtlSeconds(deviceClass);
  const accessToken = signAccessToken(
    { sub: userId, sid: sessionId, role, ...(emergencyAccessId ? { eag: emergencyAccessId } : {}) },
    accessTtl,
  );

  const refreshToken = generateOpaqueToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      sessionId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    },
  });

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresInSeconds: accessTtl,
    refreshTokenExpiresInSeconds: REFRESH_TOKEN_TTL_SECONDS,
    idleTimeoutSeconds: idleTimeoutSeconds(deviceClass),
    sessionId,
  };
};

/**
 * Rotates a refresh token.
 *
 * Refreshing does NOT extend an idle session: the session's own inactivity
 * window is checked first, so a client cannot keep a session alive in the
 * background while the user is away — that would silently defeat R8.
 */
export const refreshSession = async (
  refreshToken: string,
  ctx: RequestContext = {},
): Promise<SessionTokens> => {
  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: {
      session: { select: { id: true, deviceClass: true, lastSeenAt: true, expiresAt: true, revokedAt: true } },
      user: { select: { id: true, role: true, status: true } },
    },
  });

  if (!stored) throw unauthenticated('Your session has ended. Sign in again.');

  if (stored.usedAt) {
    // Reuse of an already-rotated token means the token leaked: burn the session.
    await revokeSession(stored.sessionId, 'REFRESH_TOKEN_REUSE');
    await recordAudit({
      action: 'SESSION_EXPIRED',
      severity: 'SECURITY',
      userId: stored.userId,
      entityType: 'Session',
      entityId: stored.sessionId,
      ipAddress: ctx.ipAddress ?? null,
      requestId: ctx.requestId ?? null,
      metadata: { reason: 'REFRESH_TOKEN_REUSE' },
    });
    throw unauthenticated('Your session has ended. Sign in again.');
  }

  const now = new Date();
  if (stored.expiresAt <= now) throw unauthenticated('Your session has ended. Sign in again.');
  if (!stored.session || stored.session.revokedAt || stored.session.expiresAt <= now) {
    throw unauthenticated('Your session has ended. Sign in again.');
  }
  if (stored.user.status !== UserStatus.ACTIVE) {
    throw unauthenticated('This account is not active.');
  }

  const idle = idleTimeoutSeconds(stored.session.deviceClass);
  if (idle !== null && now.getTime() - stored.session.lastSeenAt.getTime() >= idle * 1000) {
    await revokeSession(stored.sessionId, 'IDLE_TIMEOUT');
    throw new AppError(
      401,
      ErrorCode.SESSION_EXPIRED,
      'Your session expired after a period of inactivity. Sign in again to continue.',
    );
  }

  const tokens = await issueTokens(
    stored.sessionId,
    stored.userId,
    stored.user.role,
    stored.session.deviceClass,
  );

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { usedAt: now, replacedById: tokens.sessionId },
  });
  await prisma.session.update({ where: { id: stored.sessionId }, data: { lastSeenAt: now } });

  return tokens;
};

export const revokeSession = async (sessionId: string, reason = 'LOGOUT'): Promise<void> => {
  await prisma.$transaction([
    prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    }),
    prisma.refreshToken.updateMany({
      where: { sessionId, usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);
};

export const logout = async (
  sessionId: string,
  userId: string,
  role: Role,
  ctx: RequestContext = {},
): Promise<void> => {
  await revokeSession(sessionId, 'LOGOUT');
  await recordAudit({
    action: 'LOGOUT',
    userId,
    actorRole: role,
    entityType: 'Session',
    entityId: sessionId,
    ipAddress: ctx.ipAddress ?? null,
    requestId: ctx.requestId ?? null,
  });
};

// ---------------------------------------------------------------------------
// Current user
// ---------------------------------------------------------------------------

export const getAuthenticatedUser = async (userId: string): Promise<AuthenticatedUser> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { patient: { select: { id: true } }, doctor: { select: { id: true } } },
  });
  if (!user) throw notFound('User');
  return toAuthenticatedUser(user, user.patient?.id, user.doctor?.id);
};

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export interface PasswordResetRequest {
  /** Returned only outside production so the flow is testable without email. */
  token?: string;
}

export const requestPasswordReset = async (
  email: string,
  ctx: RequestContext = {},
): Promise<PasswordResetRequest> => {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });

  // Always succeeds from the caller's point of view — otherwise the endpoint
  // reveals which email addresses have accounts.
  if (!user) return {};

  const token = generateOpaqueToken(32);
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000),
    },
  });

  await recordAudit({
    action: 'PASSWORD_RESET_REQUESTED',
    severity: 'NOTICE',
    userId: user.id,
    actorRole: user.role,
    ipAddress: ctx.ipAddress ?? null,
    requestId: ctx.requestId ?? null,
  });

  // Phase 12 sends this by email; until then it is returned in development only.
  return env.isProduction ? {} : { token };
};

export const resetPassword = async (
  token: string,
  newPassword: string,
  ctx: RequestContext = {},
): Promise<void> => {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, role: true } } },
  });

  if (!stored || stored.usedAt || stored.expiresAt <= new Date()) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'This reset link is invalid or has expired.');
  }

  const policy = checkPasswordPolicy(newPassword, stored.user.email);
  if (!policy.valid) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_ERROR,
      'Choose a stronger password.',
      policy.problems.map((message) => ({ field: 'password', message })),
    );
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: stored.userId },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    }),
    prisma.passwordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
    // A password change ends every existing session for that user.
    prisma.session.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
    }),
  ]);

  await recordAudit({
    action: 'PASSWORD_CHANGED',
    severity: 'NOTICE',
    userId: stored.userId,
    actorRole: stored.user.role,
    ipAddress: ctx.ipAddress ?? null,
    requestId: ctx.requestId ?? null,
    metadata: { method: 'RESET_LINK' },
  });
};

export const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string,
  ctx: RequestContext = {},
): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, passwordHash: true },
  });
  if (!user) throw notFound('User');

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw invalidCredentials();
  }

  const policy = checkPasswordPolicy(newPassword, user.email);
  if (!policy.valid) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_ERROR,
      'Choose a stronger password.',
      policy.problems.map((message) => ({ field: 'newPassword', message })),
    );
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  await recordAudit({
    action: 'PASSWORD_CHANGED',
    severity: 'NOTICE',
    userId,
    actorRole: user.role,
    ipAddress: ctx.ipAddress ?? null,
    requestId: ctx.requestId ?? null,
    metadata: { method: 'SELF_SERVICE' },
  });
};

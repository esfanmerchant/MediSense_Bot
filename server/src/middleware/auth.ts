import type { RequestHandler } from 'express';

import { prisma } from '../database/prisma.js';
import { permissionsFor } from '../modules/auth/rbac.js';
import { LAST_SEEN_WRITE_THROTTLE_MS, checkIdle } from '../modules/auth/session.policy.js';
import { sessionExpired, unauthenticated } from '../utils/errors.js';
import { asyncHandler } from '../utils/http.js';
import { verifyAccessToken } from '../utils/tokens.js';

export const ACCESS_COOKIE = 'ms_at';
export const REFRESH_COOKIE = 'ms_rt';

const extractToken = (req: Parameters<RequestHandler>[0]): string | null => {
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
  if (cookieToken) return cookieToken;

  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  return null;
};

/**
 * Authenticates the request and enforces session expiry server-side.
 *
 * The JWT proves identity; the Session row decides whether the caller is still
 * allowed in. That split is what makes R8 real — a client that never fires its
 * inactivity timer, or talks to the API directly with a saved token, is still
 * cut off at the configured idle limit.
 */
export const requireAuth: RequestHandler = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw unauthenticated();

  const payload = verifyAccessToken(token);
  if (!payload) throw unauthenticated('Your sign-in could not be verified. Sign in again.');

  const session = await prisma.session.findUnique({
    where: { id: payload.sid },
    select: {
      id: true,
      userId: true,
      deviceClass: true,
      lastSeenAt: true,
      expiresAt: true,
      revokedAt: true,
      user: {
        select: {
          id: true,
          role: true,
          status: true,
          patient: { select: { id: true } },
          doctor: { select: { id: true } },
        },
      },
    },
  });

  if (!session || session.revokedAt) throw unauthenticated('Your session has ended. Sign in again.');
  if (session.userId !== payload.sub) throw unauthenticated();

  const now = new Date();

  // Absolute lifetime: a session cannot be kept alive indefinitely by activity.
  if (session.expiresAt <= now) {
    await revokeSession(session.id, 'ABSOLUTE_TIMEOUT');
    throw sessionExpired('Your session reached its maximum length. Sign in again.');
  }

  // Inactivity (R8), tiered by device class.
  const idle = checkIdle(session.deviceClass, session.lastSeenAt, now);
  if (idle.expired) {
    await revokeSession(session.id, 'IDLE_TIMEOUT');
    throw sessionExpired();
  }

  if (session.user.status !== 'ACTIVE') {
    await revokeSession(session.id, 'ACCOUNT_INACTIVE');
    throw unauthenticated('This account is not active. Contact an administrator.');
  }

  // Throttled activity write — accurate enough for a 2-minute window without
  // an UPDATE on every request.
  if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_WRITE_THROTTLE_MS) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
  }

  req.auth = {
    userId: session.user.id,
    role: session.user.role,
    sessionId: session.id,
    permissions: permissionsFor(session.user.role),
    ...(session.user.patient ? { patientId: session.user.patient.id } : {}),
    ...(session.user.doctor ? { doctorId: session.user.doctor.id } : {}),
    ...(payload.eag ? { emergencyAccessId: payload.eag } : {}),
  };

  next();
});

/** Attaches auth when a valid session exists, but never rejects. */
export const optionalAuth: RequestHandler = (req, res, next) => {
  if (!extractToken(req)) return next();
  requireAuth(req, res, (err?: unknown) => (err ? next() : next()));
};

const revokeSession = async (sessionId: string, reason: string): Promise<void> => {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
};

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import jwt from 'jsonwebtoken';

import type { Role } from '@prisma/client';

import { env } from '../config/env.js';

export interface AccessTokenPayload {
  sub: string; // user id
  sid: string; // session id
  role: Role;
  /** Present only while a break-glass grant is active (R3). */
  eag?: string;
}

const ISSUER = 'medisense-api';

/**
 * Access tokens are short-lived and carry the session id. The session row is
 * still checked on every request — the token proves who you are, the session
 * decides whether you are still allowed to be here (R8).
 */
export const signAccessToken = (payload: AccessTokenPayload, expiresInSeconds: number): string =>
  jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: expiresInSeconds,
    issuer: ISSUER,
    algorithm: 'HS256',
  });

export const verifyAccessToken = (token: string): AccessTokenPayload | null => {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      issuer: ISSUER,
      algorithms: ['HS256'],
    });
    if (typeof decoded === 'string') return null;
    const { sub, sid, role, eag } = decoded as jwt.JwtPayload & Partial<AccessTokenPayload>;
    if (!sub || !sid || !role) return null;
    return eag ? { sub, sid, role, eag } : { sub, sid, role };
  } catch {
    return null;
  }
};

/**
 * Opaque secrets (refresh tokens, password-reset links). Only the SHA-256 hash
 * is persisted, so a database dump cannot be replayed against the API.
 */
export const generateOpaqueToken = (bytes = 48): string => randomBytes(bytes).toString('base64url');

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const safeCompare = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};

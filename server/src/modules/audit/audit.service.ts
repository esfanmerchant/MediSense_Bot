import { createHash } from 'node:crypto';

import type { AuditAction, AuditSeverity, Prisma, Role } from '@prisma/client';

import { prisma } from '../../database/prisma.js';
import { logger } from '../../utils/logger.js';

export interface AuditEntryInput {
  action: AuditAction;
  userId?: string | null;
  actorRole?: Role | null;
  severity?: AuditSeverity;
  entityType?: string | null;
  entityId?: string | null;
  /** Patient whose data was touched — powers per-patient access reports. */
  patientId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  emergencyAccessId?: string | null;
  /**
   * References only. Field names, record ids, counts — never clinical values,
   * never passwords or tokens (C5, spec §35).
   */
  metadata?: Prisma.InputJsonValue;
}

/** Fields that must never appear in audit metadata, dropped defensively. */
const FORBIDDEN_METADATA_KEYS = new Set([
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'apiKey',
  'extractedText',
  'authorization',
  'cookie',
]);

const sanitizeMetadata = (value: unknown, depth = 0): unknown => {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) continue;
    out[key] = sanitizeMetadata(val, depth + 1);
  }
  return out;
};

/**
 * Deterministic serialization so the same entry always hashes the same way.
 *
 * Keys are sorted at EVERY depth, not just the top level. Postgres `jsonb`
 * does not preserve object key order — it stores keys sorted by length then
 * bytewise — so metadata read back from the database comes out in a different
 * order than it went in. Sorting recursively makes the hash independent of
 * that, which is what lets a stored row be re-verified at all.
 */
const canonicalValue = (value: unknown): unknown => {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonicalValue((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
};

const canonicalize = (entry: Record<string, unknown>): string => JSON.stringify(canonicalValue(entry));

export const computeEntryHash = (
  previousHash: string | null,
  entry: Record<string, unknown>,
): string => createHash('sha256').update(`${previousHash ?? 'GENESIS'}|${canonicalize(entry)}`).digest('hex');

/**
 * Append one audit entry (R6).
 *
 * The chain is built under a Postgres advisory lock so two concurrent writers
 * cannot both read the same predecessor and fork the chain. There is no update
 * or delete counterpart anywhere in the application — deployments should also
 * revoke UPDATE/DELETE on `audit_logs` from the application role, because an
 * append-only guarantee enforced only in code does not hold against the
 * database credential the code itself uses.
 */
export const recordAudit = async (input: AuditEntryInput): Promise<void> => {
  try {
    const metadata = input.metadata === undefined ? undefined : (sanitizeMetadata(input.metadata) as Prisma.InputJsonValue);

    await prisma.$transaction(async (tx) => {
      // Serialize chain appends; released automatically at transaction end.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('medisense_audit_chain'))`;

      const previous = await tx.auditLog.findFirst({
        orderBy: { timestamp: 'desc' },
        select: { entryHash: true },
      });

      const timestamp = new Date();
      const payload = {
        action: input.action,
        userId: input.userId ?? null,
        actorRole: input.actorRole ?? null,
        severity: input.severity ?? 'INFO',
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        patientId: input.patientId ?? null,
        ipAddress: input.ipAddress ?? null,
        requestId: input.requestId ?? null,
        emergencyAccessId: input.emergencyAccessId ?? null,
        timestamp: timestamp.toISOString(),
        metadata: metadata ?? null,
      };

      await tx.auditLog.create({
        data: {
          action: input.action,
          userId: input.userId ?? null,
          actorRole: input.actorRole ?? null,
          severity: input.severity ?? 'INFO',
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          patientId: input.patientId ?? null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
          requestId: input.requestId ?? null,
          emergencyAccessId: input.emergencyAccessId ?? null,
          metadata: metadata as Prisma.InputJsonValue,
          previousHash: previous?.entryHash ?? null,
          entryHash: computeEntryHash(previous?.entryHash ?? null, payload),
          timestamp,
        },
      });
    });
  } catch (err) {
    // An audit write must never take down the request that triggered it, but a
    // silent failure would defeat R6 — so it is logged loudly for alerting.
    logger.error({ err, action: input.action }, 'AUDIT WRITE FAILED');
  }
};

export interface ChainVerification {
  valid: boolean;
  checked: number;
  brokenAtId?: string;
}

/**
 * Walks the chain oldest-first and recomputes each hash. A row edited or
 * deleted directly in the database breaks verification here — this is what
 * makes "immutable" testable rather than merely asserted.
 */
export const verifyAuditChain = async (limit = 1000): Promise<ChainVerification> => {
  const entries = await prisma.auditLog.findMany({
    orderBy: { timestamp: 'asc' },
    take: limit,
  });

  let previousHash: string | null = null;
  let checked = 0;

  for (const entry of entries) {
    const payload = {
      action: entry.action,
      userId: entry.userId,
      actorRole: entry.actorRole,
      severity: entry.severity,
      entityType: entry.entityType,
      entityId: entry.entityId,
      patientId: entry.patientId,
      ipAddress: entry.ipAddress,
      requestId: entry.requestId,
      emergencyAccessId: entry.emergencyAccessId,
      timestamp: entry.timestamp.toISOString(),
      metadata: entry.metadata ?? null,
    };

    if (entry.previousHash !== previousHash) {
      return { valid: false, checked, brokenAtId: entry.id };
    }
    if (computeEntryHash(previousHash, payload) !== entry.entryHash) {
      return { valid: false, checked, brokenAtId: entry.id };
    }

    previousHash = entry.entryHash;
    checked += 1;
  }

  return { valid: true, checked };
};

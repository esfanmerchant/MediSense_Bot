import { describe, expect, it } from 'vitest';

import { computeEntryHash } from '../../src/modules/audit/audit.service.js';

const entry = {
  action: 'PATIENT_RECORD_VIEW',
  userId: 'user_1',
  patientId: 'patient_1',
  timestamp: '2026-08-26T10:00:00.000Z',
};

describe('audit chain hashing (R6)', () => {
  it('is deterministic for the same predecessor and payload', () => {
    expect(computeEntryHash('prev', entry)).toBe(computeEntryHash('prev', entry));
  });

  it('ignores key order, so serialization differences do not break the chain', () => {
    const reordered = {
      timestamp: entry.timestamp,
      patientId: entry.patientId,
      action: entry.action,
      userId: entry.userId,
    };
    expect(computeEntryHash('prev', reordered)).toBe(computeEntryHash('prev', entry));
  });

  it('ignores key order inside nested metadata', () => {
    // Postgres jsonb reorders object keys on storage, so an entry read back
    // would never re-verify if nesting were hashed in document order.
    const a = { ...entry, metadata: { reason: 'BAD_PASSWORD', failedLoginCount: 1, locked: false } };
    const b = { ...entry, metadata: { locked: false, reason: 'BAD_PASSWORD', failedLoginCount: 1 } };
    expect(computeEntryHash('prev', a)).toBe(computeEntryHash('prev', b));
  });

  it('still detects a changed metadata value', () => {
    const a = { ...entry, metadata: { reason: 'BAD_PASSWORD', failedLoginCount: 1 } };
    const b = { ...entry, metadata: { reason: 'BAD_PASSWORD', failedLoginCount: 4 } };
    expect(computeEntryHash('prev', a)).not.toBe(computeEntryHash('prev', b));
  });

  it('preserves array order, which is meaningful', () => {
    const a = { ...entry, metadata: { fields: ['diagnosis', 'dosage'] } };
    const b = { ...entry, metadata: { fields: ['dosage', 'diagnosis'] } };
    expect(computeEntryHash('prev', a)).not.toBe(computeEntryHash('prev', b));
  });

  it('changes when any field changes — an edited entry no longer verifies', () => {
    const altered = { ...entry, patientId: 'patient_2' };
    expect(computeEntryHash('prev', altered)).not.toBe(computeEntryHash('prev', entry));
  });

  it('changes when the predecessor changes — a deleted entry breaks the chain', () => {
    expect(computeEntryHash('prev_a', entry)).not.toBe(computeEntryHash('prev_b', entry));
    expect(computeEntryHash(null, entry)).not.toBe(computeEntryHash('prev_a', entry));
  });

  it('produces a full-length sha256 digest', () => {
    expect(computeEntryHash(null, entry)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('links a sequence so that tampering with entry 2 invalidates entry 3', () => {
    const h1 = computeEntryHash(null, { ...entry, action: 'LOGIN' });
    const h2 = computeEntryHash(h1, entry);
    const h3 = computeEntryHash(h2, { ...entry, action: 'LOGOUT' });

    const tamperedH2 = computeEntryHash(h1, { ...entry, patientId: 'patient_x' });
    expect(computeEntryHash(tamperedH2, { ...entry, action: 'LOGOUT' })).not.toBe(h3);
  });
});

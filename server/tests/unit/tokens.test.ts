import { describe, expect, it } from 'vitest';

import { generateOpaqueToken, hashToken, signAccessToken, verifyAccessToken } from '../../src/utils/tokens.js';

const payload = { sub: 'user_1', sid: 'session_1', role: 'PATIENT' as const };

describe('access tokens', () => {
  it('round-trips a signed payload', () => {
    const token = signAccessToken(payload, 120);
    expect(verifyAccessToken(token)).toMatchObject(payload);
  });

  it('rejects a tampered token', () => {
    const token = signAccessToken(payload, 120);
    const tampered = `${token.slice(0, -3)}abc`;
    expect(verifyAccessToken(tampered)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    // A token minted elsewhere must not authenticate against this API.
    const foreign =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzEiLCJzaWQiOiJzXzEiLCJyb2xlIjoiQURNSU4ifQ.' +
      'ZmFrZS1zaWduYXR1cmU';
    expect(verifyAccessToken(foreign)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = signAccessToken(payload, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(verifyAccessToken(token)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyAccessToken('')).toBeNull();
    expect(verifyAccessToken('not.a.jwt')).toBeNull();
  });

  it('carries an emergency grant id when one is present', () => {
    const token = signAccessToken({ ...payload, eag: 'grant_9' }, 120);
    expect(verifyAccessToken(token)?.eag).toBe('grant_9');
  });
});

describe('opaque tokens', () => {
  it('produces unpredictable values', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateOpaqueToken()));
    expect(tokens.size).toBe(50);
  });

  it('hashes deterministically and irreversibly', () => {
    const token = generateOpaqueToken();
    const hash = hashToken(token);
    expect(hashToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
  });
});

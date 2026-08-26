import { describe, expect, it } from 'vitest';

import {
  accessTokenTtlSeconds,
  checkIdle,
  idleTimeoutSeconds,
} from '../../src/modules/auth/session.policy.js';

const secondsAgo = (n: number) => new Date(Date.now() - n * 1000);

describe('inactivity timeout (R8)', () => {
  it('enforces exactly two minutes on a shared clinical terminal', () => {
    expect(idleTimeoutSeconds('SHARED_TERMINAL')).toBe(120);
    expect(checkIdle('SHARED_TERMINAL', secondsAgo(119)).expired).toBe(false);
    expect(checkIdle('SHARED_TERMINAL', secondsAgo(121)).expired).toBe(true);
  });

  it('treats an unknown device class as a shared terminal', () => {
    // Defaulting to the strictest tier means a client cannot widen its own
    // timeout by sending an unrecognised value.
    expect(idleTimeoutSeconds('WHATEVER')).toBe(120);
    expect(checkIdle('WHATEVER', secondsAgo(300)).expired).toBe(true);
  });

  it('gives a clinician’s own device a longer window', () => {
    expect(idleTimeoutSeconds('PERSONAL')).toBe(900);
    expect(checkIdle('PERSONAL', secondsAgo(300)).expired).toBe(false);
    expect(checkIdle('PERSONAL', secondsAgo(901)).expired).toBe(true);
  });

  it('exempts monitoring displays from idle expiry', () => {
    // A vitals wall exists to be watched, not touched (conflict C3).
    expect(idleTimeoutSeconds('MONITOR')).toBeNull();
    const result = checkIdle('MONITOR', secondsAgo(86_400));
    expect(result.expired).toBe(false);
    expect(result.remainingSeconds).toBeNull();
  });

  it('reports the remaining seconds so the client can warn before expiry', () => {
    expect(checkIdle('SHARED_TERMINAL', secondsAgo(90)).remainingSeconds).toBe(30);
  });

  it('keeps the access token no longer than the idle window', () => {
    expect(accessTokenTtlSeconds('SHARED_TERMINAL')).toBeLessThanOrEqual(120);
    expect(accessTokenTtlSeconds('PERSONAL')).toBeLessThanOrEqual(900);
  });
});

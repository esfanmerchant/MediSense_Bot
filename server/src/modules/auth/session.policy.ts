import { env } from '../../config/env.js';

/**
 * Device classes and their idle timeouts.
 *
 * R8 asks for a two-minute inactivity logout everywhere. Applied literally it
 * also logs out the vitals wall display, which exists to be watched and not
 * touched, and cuts off a patient mid-dictation. So the strict rule is kept
 * exactly where the threat is — an unattended shared ward terminal — and the
 * other classes are tiered (see conflict C3 in the requirements triage).
 *
 * SHARED_TERMINAL is the default for any client that does not declare itself.
 */
export const DEVICE_CLASSES = ['SHARED_TERMINAL', 'PERSONAL', 'MONITOR'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const isDeviceClass = (value: unknown): value is DeviceClass =>
  typeof value === 'string' && (DEVICE_CLASSES as readonly string[]).includes(value);

/**
 * Idle seconds per class. SHARED_TERMINAL tracks the configured value so the
 * two-minute requirement stays a single knob in .env.
 * MONITOR is exempt from idle expiry: it is view-only, and any action taken
 * from it requires a fresh authentication.
 */
export const idleTimeoutSeconds = (deviceClass: string): number | null => {
  switch (deviceClass) {
    case 'MONITOR':
      return null;
    case 'PERSONAL':
      return Math.max(env.SESSION_IDLE_TIMEOUT_SECONDS, 15 * 60);
    case 'SHARED_TERMINAL':
    default:
      return env.SESSION_IDLE_TIMEOUT_SECONDS;
  }
};

/** Access-token lifetime. Kept at or below the idle window so a stolen token dies quickly. */
export const accessTokenTtlSeconds = (deviceClass: string): number => {
  const idle = idleTimeoutSeconds(deviceClass);
  if (idle === null) return 15 * 60;
  return Math.min(idle, 15 * 60);
};

export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

export const absoluteTimeoutSeconds = (): number => env.SESSION_ABSOLUTE_TIMEOUT_SECONDS;

/**
 * How stale `lastSeenAt` may get before it is written again. Without this the
 * API would issue an UPDATE on every authenticated request; with it, activity
 * is still tracked far more finely than the shortest timeout.
 */
export const LAST_SEEN_WRITE_THROTTLE_MS = 10_000;

export interface IdleCheck {
  expired: boolean;
  /** Seconds of inactivity remaining, or null when the class is exempt. */
  remainingSeconds: number | null;
}

export const checkIdle = (deviceClass: string, lastSeenAt: Date, now = new Date()): IdleCheck => {
  const idle = idleTimeoutSeconds(deviceClass);
  if (idle === null) return { expired: false, remainingSeconds: null };
  const elapsedSeconds = (now.getTime() - lastSeenAt.getTime()) / 1000;
  return {
    expired: elapsedSeconds >= idle,
    remainingSeconds: Math.max(0, Math.ceil(idle - elapsedSeconds)),
  };
};

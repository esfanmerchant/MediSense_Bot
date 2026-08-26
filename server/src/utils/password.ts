import { type ScryptOptions, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// promisify resolves to the 3-argument overload, which drops the options we
// need for the tuned cost parameters below.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing with scrypt (RFC 7914), which ships in Node's crypto module.
 *
 * Chosen over bcrypt/argon2 because it needs no native build step — one less
 * thing to break on a fresh clone — while still being memory-hard. Parameters
 * are stored in the hash string so they can be raised later without
 * invalidating existing passwords.
 *
 * Format:  scrypt$N$r$p$<salt-b64>$<hash-b64>
 */
const N = 2 ** 15; // CPU/memory cost
const R = 8; // block size
const P = 1; // parallelisation
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs roughly 128 * N * r bytes; the default 32 MB cap is too low for N=2^15.
const MAX_MEMORY = 64 * 1024 * 1024;

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEMORY,
  })) as Buffer;
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return false;

  const derived = (await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: MAX_MEMORY,
  })) as Buffer;

  return derived.length === expected.length && timingSafeEqual(derived, expected);
};

/** True when a stored hash uses weaker parameters than the current policy. */
export const needsRehash = (stored: string): boolean => {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N || Number(parts[2]) < R;
};

export interface PasswordPolicyResult {
  valid: boolean;
  problems: string[];
}

/** Minimum policy checked at registration and password change. */
export const checkPasswordPolicy = (password: string, email?: string): PasswordPolicyResult => {
  const problems: string[] = [];
  if (password.length < 10) problems.push('Use at least 10 characters.');
  if (!/[a-z]/.test(password)) problems.push('Include a lowercase letter.');
  if (!/[A-Z]/.test(password)) problems.push('Include an uppercase letter.');
  if (!/\d/.test(password)) problems.push('Include a number.');
  if (email) {
    const local = email.split('@')[0]?.toLowerCase() ?? '';
    if (local.length > 2 && password.toLowerCase().includes(local)) {
      problems.push('Do not use your email address in your password.');
    }
  }
  return { valid: problems.length === 0, problems };
};

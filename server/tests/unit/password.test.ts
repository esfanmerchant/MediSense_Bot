import { describe, expect, it } from 'vitest';

import { checkPasswordPolicy, hashPassword, needsRehash, verifyPassword } from '../../src/utils/password.js';

describe('password hashing', () => {
  it('never stores the plaintext password', async () => {
    const hash = await hashPassword('CorrectHorse9');
    expect(hash).not.toContain('CorrectHorse9');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('accepts the correct password', async () => {
    const hash = await hashPassword('CorrectHorse9');
    await expect(verifyPassword('CorrectHorse9', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('CorrectHorse9');
    await expect(verifyPassword('correcthorse9', hash)).resolves.toBe(false);
    await expect(verifyPassword('CorrectHorse8', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('salts each hash, so identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([hashPassword('SamePass123'), hashPassword('SamePass123')]);
    expect(a).not.toBe(b);
    await expect(verifyPassword('SamePass123', a)).resolves.toBe(true);
    await expect(verifyPassword('SamePass123', b)).resolves.toBe(true);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt$1$2$3$4$5')).resolves.toBe(false);
    await expect(verifyPassword('x', '')).resolves.toBe(false);
  });

  it('flags hashes weaker than the current policy for rehash', async () => {
    expect(needsRehash(await hashPassword('CorrectHorse9'))).toBe(false);
    expect(needsRehash('scrypt$1024$8$1$AAAA$AAAA')).toBe(true);
    expect(needsRehash('legacy-md5-hash')).toBe(true);
  });
});

describe('password policy', () => {
  it('accepts a password meeting every rule', () => {
    expect(checkPasswordPolicy('Recovery2024').valid).toBe(true);
  });

  it('rejects short, single-case and digit-free passwords', () => {
    expect(checkPasswordPolicy('Short1').valid).toBe(false);
    expect(checkPasswordPolicy('alllowercase1').valid).toBe(false);
    expect(checkPasswordPolicy('ALLUPPERCASE1').valid).toBe(false);
    expect(checkPasswordPolicy('NoDigitsAtAll').valid).toBe(false);
  });

  it('rejects a password containing the email local part', () => {
    const result = checkPasswordPolicy('Priyasharma12', 'priyasharma@example.com');
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toContain('email');
  });
});

import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { verifyAuditChain } from '../../src/modules/audit/audit.service.js';

/**
 * End-to-end authentication against the real database.
 *
 * Skipped when DATABASE_URL is unset so a fresh clone can still run the unit
 * suite; run `npm run db:migrate` first to enable it.
 */
const enabled = Boolean(process.env.DATABASE_URL) && !process.env.DATABASE_URL?.includes('medisense_test');
const describeDb = enabled ? describe : describe.skip;

const email = `test-${randomUUID()}@example.invalid`;
const password = 'IntegrationPass123';

let app: Express;
let userId: string | undefined;

/** Reads the value of a Set-Cookie entry by name. */
const cookieValue = (cookies: string[] | undefined, name: string): string | undefined =>
  cookies?.find((c) => c.startsWith(`${name}=`))?.split(';')[0];

const setCookieOf = (res: request.Response): string[] => {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
};

describeDb('authentication flow', () => {
  beforeAll(() => {
    app = createApp();
  });

  afterAll(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('registers a patient and creates the linked patient record', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'Integration Test Patient',
      email,
      password,
      gender: 'UNDISCLOSED',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('PATIENT');
    expect(res.body.data.user.patientId).toBeTruthy();
    // The response must never carry the hash.
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');

    userId = res.body.data.user.id;
  });

  it('refuses a duplicate email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Duplicate', email, password });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects a wrong password with the same message as an unknown account', async () => {
    const wrong = await request(app).post('/api/auth/login').send({ email, password: 'WrongPass123' });
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.invalid', password: 'WrongPass123' });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    // Identical responses: the login form must not reveal which emails exist.
    expect(wrong.body.error.code).toBe(unknown.body.error.code);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('signs in and issues httpOnly cookies', async () => {
    const res = await request(app).post('/api/auth/login').send({ email, password });

    expect(res.status).toBe(200);
    expect(res.body.data.session.idleTimeoutSeconds).toBe(120);

    const cookies = setCookieOf(res);
    const access = cookies.find((c) => c.startsWith('ms_at='));
    expect(access).toBeDefined();
    expect(access).toContain('HttpOnly');
    // The token itself is never returned in the body for script to read.
    expect(res.body.data.accessToken).toBeUndefined();
  });

  it('returns the signed-in user from /me', async () => {
    const login = await request(app).post('/api/auth/login').send({ email, password });
    const cookie = cookieValue(setCookieOf(login), 'ms_at');

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie ?? '');
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.user.permissions).toContain('record:read:own');
    expect(res.body.data.user.permissions).not.toContain('record:write');
  });

  it('expires the session after the inactivity window (R8)', async () => {
    const login = await request(app).post('/api/auth/login').send({ email, password });
    const cookie = cookieValue(setCookieOf(login), 'ms_at');
    const sessionId = login.body.data.session.sessionId;

    // Backdate the last activity past the 2-minute limit rather than waiting.
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date(Date.now() - 121_000) },
    });

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie ?? '');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');

    // The session is revoked, so the same cookie cannot be reused.
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    expect(session?.revokedAt).not.toBeNull();
    expect(session?.revokedReason).toBe('IDLE_TIMEOUT');
  });

  it('rotates refresh tokens and burns the session on reuse', async () => {
    const login = await request(app).post('/api/auth/login').send({ email, password });
    const refreshCookie = cookieValue(setCookieOf(login), 'ms_rt');
    const sessionId = login.body.data.session.sessionId;

    const first = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie ?? '');
    expect(first.status).toBe(200);

    // Replaying the original token is treated as a leak, not a retry.
    const replay = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie ?? '');
    expect(replay.status).toBe(401);

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    expect(session?.revokedReason).toBe('REFRESH_TOKEN_REUSE');
  });

  it('ends the session on logout', async () => {
    const login = await request(app).post('/api/auth/login').send({ email, password });
    const cookie = cookieValue(setCookieOf(login), 'ms_at');

    await request(app).post('/api/auth/logout').set('Cookie', cookie ?? '').expect(200);

    const after = await request(app).get('/api/auth/me').set('Cookie', cookie ?? '');
    expect(after.status).toBe(401);
  });

  it(
    'locks the account after repeated failures',
    async () => {
      const lockEmail = `lock-${randomUUID()}@example.invalid`;
      const created = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Lockout Test', email: lockEmail, password });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app).post('/api/auth/login').send({ email: lockEmail, password: 'Nope12345678' });
      }

      // Even the correct password is refused while the lock holds.
      const res = await request(app).post('/api/auth/login').send({ email: lockEmail, password });
      expect(res.status).toBe(423);
      expect(res.body.error.code).toBe('ACCOUNT_LOCKED');

      await prisma.user.delete({ where: { id: created.body.data.user.id } }).catch(() => undefined);
    },
    // Six sequential logins, each a password hash plus a round trip to the
    // Supabase region, comfortably exceed the default timeout.
    120_000,
  );
});

describeDb('audit log (R6)', () => {
  it('records a login as an audit entry', async () => {
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'LOGIN' },
      orderBy: { timestamp: 'desc' },
    });
    expect(entry).not.toBeNull();
    expect(entry?.entryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records failed logins as security events', async () => {
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'LOGIN_FAILED' },
      orderBy: { timestamp: 'desc' },
    });
    expect(entry?.severity).toBe('SECURITY');
    // Metadata explains why without storing what was typed.
    expect(JSON.stringify(entry?.metadata)).not.toContain('Nope12345678');
  });

  it('never stores a password or token in audit metadata', async () => {
    const entries = await prisma.auditLog.findMany({ take: 200, orderBy: { timestamp: 'desc' } });
    const serialized = JSON.stringify(entries.map((e) => e.metadata));
    for (const forbidden of ['password', 'passwordHash', 'tokenHash', 'refreshToken']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('keeps the actor reference after the user account is deleted', async () => {
    const doomedEmail = `doomed-${randomUUID()}@example.invalid`;
    const created = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Deleted Later', email: doomedEmail, password });
    const doomedId: string = created.body.data.user.id;

    await prisma.user.delete({ where: { id: doomedId } });

    // The audit trail must outlive its subject: a foreign key that nulled this
    // out would erase who did what, and break the hash chain with it.
    const entry = await prisma.auditLog.findFirst({
      where: { userId: doomedId, action: 'USER_CREATED' },
    });
    expect(entry?.userId).toBe(doomedId);
  });

  it('verifies as an unbroken hash chain', async () => {
    const result = await verifyAuditChain(500);
    expect(result.brokenAtId).toBeUndefined();
    expect(result.checked).toBeGreaterThan(0);
    expect(result.valid).toBe(true);
  });
});

import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { signAccessToken } from '../../src/utils/tokens.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

describe('health', () => {
  it('reports liveness without touching the database', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
  });

  it('never echoes secrets in the readiness payload', async () => {
    const res = await request(app).get('/api/health/ready');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('SECRET');
    expect(body).not.toContain(process.env.JWT_SECRET);
  });
});

describe('error envelope', () => {
  it('returns the documented shape for an unknown route', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.requestId).toBeTruthy();
  });

  it('never leaks a stack trace to the client', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(JSON.stringify(res.body)).not.toContain('at ');
    expect(res.body.error.stack).toBeUndefined();
  });

  it('rejects malformed JSON with a readable message', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('echoes a correlation id on every response', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('authentication gate', () => {
  it('rejects an unauthenticated request to a protected route', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a syntactically valid but unverifiable token', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not.a.real.jwt');
    expect(res.status).toBe(401);
  });

  it('rejects a token whose session does not exist', async () => {
    // Forging a well-signed token is not enough: the session row decides.
    const forged = signAccessToken({ sub: 'ghost', sid: 'no-such-session', role: 'ADMIN' }, 120);
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(600);
    expect(res.body.success).toBe(false);
  });
});

describe('request validation', () => {
  it('rejects a login with a malformed email before touching the database', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email', password: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details?.[0]?.field).toBe('email');
  });

  it('rejects registration with a weak password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Demo Patient', email: 'demo@example.com', password: 'short' });
    expect(res.status).toBe(422);
  });

  it('does not let a caller choose their own role at registration', async () => {
    // Even if the field is sent, the schema strips it and the service forces PATIENT.
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'X', email: 'x@example.com', password: 'ValidPass123', role: 'ADMIN' });
    expect(res.body.data?.user?.role).not.toBe('ADMIN');
  });
});

describe('security headers', () => {
  it('sets the headers helmet is configured for', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

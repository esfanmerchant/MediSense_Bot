import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

// The repo keeps one .env at the root, shared by server and tooling.
// Both `src/config/env.ts` (tsx) and `dist/config/env.js` (build) sit three
// levels below it, so the same relative path works either way.
dotenv.config({ path: resolve(here, '../../../.env') });
dotenv.config({ path: resolve(here, '../../.env') }); // optional server-local overrides

const isTest = process.env.NODE_ENV === 'test';

/** A secret must be long enough to be worth calling a secret. */
const secret = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .min(32, `${name} must be at least 32 characters`);

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: isTest
    ? z.string().default('postgresql://test:test@localhost:5432/medisense_test')
    : z
        .string()
        .min(1, 'DATABASE_URL is required — Supabase dashboard > Connect > ORMs > Prisma (pooled, port 6543)'),
  DIRECT_URL: z.string().default(''),

  JWT_SECRET: isTest ? z.string().default('test'.repeat(10)) : secret('JWT_SECRET'),
  SESSION_SECRET: isTest ? z.string().default('sess'.repeat(10)) : secret('SESSION_SECRET'),

  // R8: enforced server-side against Session.lastSeenAt, not by the client timer.
  SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  SESSION_ABSOLUTE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(43_200),

  SUPABASE_URL: z.string().default(''),
  SUPABASE_PUBLISHABLE_KEY: z.string().default(''),
  /** Server-only. Bypasses row level security — never send this to a browser. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  SUPABASE_DOCUMENTS_BUCKET: z.string().default('medical-documents'),
  SUPABASE_AVATARS_BUCKET: z.string().default('avatars'),
  SUPABASE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  AI_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default('gemini-2.0-flash'),

  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanish.default('false'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().default('MediSense <no-reply@medisense.local>'),

  EMAIL_ENABLED: booleanish.default('false'),
  AI_ENABLED: booleanish.default('true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // Fail at boot rather than at first use: a half-configured healthcare API
  // that starts and then 500s on login is worse than one that refuses to start.
  throw new Error(`Invalid environment configuration:\n${details}\n\nCopy .env.example to .env and fill it in.`);
}

export const env = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isDevelopment: parsed.data.NODE_ENV === 'development',
  isTest: parsed.data.NODE_ENV === 'test',
  /** Storage needs the project URL and the server-side service role key. */
  storageConfigured: Boolean(parsed.data.SUPABASE_URL) && Boolean(parsed.data.SUPABASE_SERVICE_ROLE_KEY),
  aiConfigured: parsed.data.AI_ENABLED && Boolean(parsed.data.AI_API_KEY),
  emailConfigured: parsed.data.EMAIL_ENABLED && Boolean(parsed.data.SMTP_USER) && Boolean(parsed.data.SMTP_PASSWORD),
});

export type Env = typeof env;

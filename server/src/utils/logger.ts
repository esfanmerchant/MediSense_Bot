import pino from 'pino';

import { env } from '../config/env.js';

/**
 * Paths scrubbed before anything reaches a log sink.
 *
 * Section 35 of the spec: never log passwords, tokens, API keys, App Passwords,
 * medical documents or full AI conversations. Redaction is centralised here so
 * a careless `logger.info({ body })` at a call site cannot leak them.
 */
const REDACTED_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'apiKey',
  'extractedText',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.tokenHash',
];

export const logger = pino({
  level: env.isTest ? 'silent' : env.isProduction ? 'info' : 'debug',
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  base: { service: 'medisense-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: env.isDevelopment
    ? { target: 'pino/file', options: { destination: 1 } }
    : undefined,
});

export type Logger = typeof logger;

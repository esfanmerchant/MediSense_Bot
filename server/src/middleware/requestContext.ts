import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

/**
 * Assigns a correlation id to every request and echoes it back. Audit entries
 * carry the same id, so a security event can be traced to the exact request
 * that produced it.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

/** Client IP, honouring a trusted proxy when one is configured. */
export const clientIp = (req: { ip?: string; socket?: { remoteAddress?: string } }): string | null =>
  req.ip ?? req.socket?.remoteAddress ?? null;

import rateLimit, { type Options } from 'express-rate-limit';

import { env } from '../config/env.js';
import { ErrorCode } from '../utils/errors.js';

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Rate limiting is a denial-of-service control, not a correctness control —
  // disabling it in tests keeps suites from tripping over their own fixtures.
  skip: () => env.isTest,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: ErrorCode.RATE_LIMITED,
        message: 'Too many requests. Wait a moment and try again.',
      },
      requestId: req.requestId,
    });
  },
};

/** Baseline for the whole API. */
export const generalLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 300,
});

/** Login, refresh and password reset: keyed by IP to slow credential stuffing. */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true,
});

/** External-provider calls cost money and leave the building — keep them scarce. */
export const aiLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 20,
});

export const uploadLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 30,
});

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { requestContext } from './middleware/requestContext.js';
import { apiRouter } from './routes.js';
import { logger } from './utils/logger.js';

export const createApp = (): Express => {
  const app = express();

  // Behind a reverse proxy in production, req.ip must come from X-Forwarded-For
  // or every audit entry records the proxy's address instead of the client's.
  app.set('trust proxy', env.isProduction ? 1 : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON only; the SPA is hosted separately with its own CSP.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true, // auth cookies
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Device-Class'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );

  app.use(requestContext);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser(env.SESSION_SECRET));

  if (!env.isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => (req as { requestId?: string }).requestId ?? 'unknown',
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
        // Log shape only — bodies may carry clinical data (spec §35).
        serializers: {
          req: (req) => ({ id: req.id, method: req.method, url: req.url }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  }

  app.use('/api', generalLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

import { Router } from 'express';

import { env } from './config/env.js';
import { checkDatabaseConnection } from './database/prisma.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { ok } from './utils/http.js';

export const apiRouter = Router();

/**
 * Liveness and readiness. Reports which optional integrations are configured
 * without ever echoing the values that configure them.
 */
apiRouter.get('/health', (_req, res) => {
  ok(res, {
    status: 'ok',
    environment: env.NODE_ENV,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

apiRouter.get('/health/ready', async (_req, res) => {
  const database = await checkDatabaseConnection();
  res.status(database ? 200 : 503).json({
    success: database,
    data: {
      database,
      integrations: {
        storage: env.storageConfigured,
        ai: env.aiConfigured,
        email: env.emailConfigured,
      },
    },
  });
});

apiRouter.use('/auth', authRouter);

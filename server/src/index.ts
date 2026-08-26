import { createApp } from './app.js';
import { env } from './config/env.js';
import { checkDatabaseConnection, disconnectPrisma } from './database/prisma.js';
import { logger } from './utils/logger.js';

const start = async (): Promise<void> => {
  const databaseUp = await checkDatabaseConnection();
  if (!databaseUp) {
    logger.error(
      'Cannot reach the database. Check DATABASE_URL in .env, then run: npm run prisma:migrate',
    );
    if (env.isProduction) process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, client: env.CLIENT_ORIGIN },
      `MediSense API listening on http://localhost:${env.PORT}`,
    );
    if (!env.storageConfigured) logger.warn('Supabase Storage is not configured — document upload is disabled.');
    if (!env.aiConfigured) logger.warn('AI provider is not configured — chatbot and OCR fallback are disabled.');
    if (!env.emailConfigured) logger.warn('Email is not configured — notifications will be logged, not sent.');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void disconnectPrisma().then(() => process.exit(0));
    });
    // Do not let a hung connection hold the process open forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

void start().catch((err: unknown) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});

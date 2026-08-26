import { PrismaClient } from '@prisma/client';

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Single Prisma client for the process. `globalThis` caching keeps tsx watch
 * reloads from opening a new pool on every file change.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isDevelopment
      ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
      : [{ emit: 'event', level: 'error' }],
  });

prisma.$on('error' as never, (event: unknown) => {
  logger.error({ event }, 'prisma error');
});

if (!env.isProduction) globalForPrisma.prisma = prisma;

export const disconnectPrisma = async (): Promise<void> => {
  await prisma.$disconnect();
};

/** Used by the health endpoint and by startup to fail fast on a bad DATABASE_URL. */
export const checkDatabaseConnection = async (): Promise<boolean> => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    logger.error({ err }, 'database connection check failed');
    return false;
  }
};

export type { Prisma } from '@prisma/client';

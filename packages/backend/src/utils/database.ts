import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

/**
 * PrismaClient singleton to prevent connection pool exhaustion
 * Creating multiple PrismaClient instances causes memory leaks and exhausts database connections
 *
 * PERFORMANCE: Connection pool configuration is set via DATABASE_URL params:
 * - connection_limit: Max connections (default: 5, recommended: 10-20 for production)
 * - pool_timeout: Seconds to wait for connection (default: 10)
 * - connect_timeout: Connection establishment timeout (default: 5)
 * - statement_cache_size: Prepared statement cache (default: 100)
 *
 * Example DATABASE_URL with pool config:
 * postgresql://user:pass@host:5432/db?connection_limit=20&pool_timeout=10&connect_timeout=5
 */

let prisma: PrismaClient;

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

/**
 * Create Prisma client with appropriate logging
 */
function createPrismaClient(): PrismaClient {
  const isProduction = process.env.NODE_ENV === 'production';

  return new PrismaClient({
    log: isProduction
      ? [
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'warn' },
        ]
      : [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'warn' },
        ],
  });
}

if (process.env.NODE_ENV === 'production') {
  prisma = createPrismaClient();
} else {
  // In development, use global to preserve client across hot reloads
  if (!global.__prisma) {
    global.__prisma = createPrismaClient();
  }
  prisma = global.__prisma;
}

// Attach event handlers for logging
prisma.$on('error' as never, (e: { message: string; target: string }) => {
  logger.error({ target: e.target, message: e.message }, 'Prisma error event');
});

prisma.$on('warn' as never, (e: { message: string }) => {
  logger.warn({ message: e.message }, 'Prisma warning event');
});

/**
 * PERFORMANCE FIX: Health check for database connection
 * Use this to verify database is accessible before processing requests
 */
export async function checkDatabaseHealth(): Promise<{
  connected: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const startTime = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      connected: true,
      latencyMs: Date.now() - startTime,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error }, 'Database health check failed');
    return {
      connected: false,
      error: message,
    };
  }
}

// NOTE: Shutdown handlers are consolidated in server.ts to avoid race conditions
// The server.ts gracefulShutdown() function handles prisma.$disconnect() with proper ordering

export { prisma };

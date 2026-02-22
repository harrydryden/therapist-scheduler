import Fastify from 'fastify';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import pino from 'pino';
import { config } from './config';
import { therapistRoutes } from './routes/therapists.routes';
import { webhookRoutes } from './routes/webhooks.routes';
import { appointmentsRoutes } from './routes/appointments.routes';
import { ingestionRoutes } from './routes/ingestion.routes';
import { emailWebhookRoutes } from './routes/email-webhook.routes';
import { adminRoutes } from './routes/admin.routes';
import { adminDashboardRoutes } from './routes/admin-dashboard.routes';
import { adminKnowledgeRoutes } from './routes/admin-knowledge.routes';
import { adminSettingsRoutes, publicSettingsRoutes } from './routes/admin-settings.routes';
import { notionService } from './services/notion.service';
import { staleCheckService } from './services/stale-check.service';
import { emailPollingService } from './services/email-polling.service';
import { gmailWatchService } from './services/gmail-watch.service';
import { pendingEmailService } from './services/pending-email.service';
import { postBookingFollowupService } from './services/post-booking-followup.service';
import { weeklyMailingListService } from './services/weekly-mailing-list.service';
import { slackWeeklySummaryService } from './services/slack-weekly-summary.service';
import { notionSyncManager } from './services/notion-sync-manager.service';
import { unsubscribeRoutes } from './routes/unsubscribe.routes';
import { feedbackFormRoutes } from './routes/feedback-form.routes';
import { adminFormsRoutes } from './routes/admin-forms.routes';
import { prisma, checkDatabaseHealth } from './utils/database';
import { redis } from './utils/redis';
import { circuitBreakerRegistry } from './utils/circuit-breaker';
import { getAllTaskMetrics, getBackgroundTaskHealth } from './utils/background-task';
import { getTimeoutStats } from './utils/timeout';
import { slackNotificationService } from './services/slack-notification.service';
import { adminAuthHook } from './middleware/auth';
import { runWithTrace, generateTraceId, logRequestMetrics } from './utils/request-tracing';

const logger = pino({
  level: config.logLevel,
  transport:
    config.env === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
          },
        }
      : undefined,
});

async function buildServer() {
  const fastify = Fastify({
    logger,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
  });

  // Register plugins
  await fastify.register(cors, {
    origin: config.cors.origin,
    credentials: config.cors.credentials,
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: config.env === 'production',
  });

  // Enable response compression (gzip/deflate/brotli)
  // Reduces payload size for JSON-heavy API responses
  await fastify.register(compress, {
    global: true,
    threshold: 1024, // Only compress responses > 1KB
    encodings: ['gzip', 'deflate'],
  });

  await fastify.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
  });

  // Register multipart for file uploads
  // FIX L4: Add comprehensive limits to prevent memory exhaustion
  await fastify.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB max per file
      files: 5, // Max 5 files per request
      fields: 20, // Max 20 non-file fields
      fieldSize: 1 * 1024 * 1024, // 1MB max per field value
      headerPairs: 100, // Max header key-value pairs
    },
  });

  // Request tracing: wraps each request in a trace context
  // Propagates trace ID through AsyncLocalStorage for all downstream service calls
  fastify.addHook('onRequest', (request, reply, done) => {
    const traceId = generateTraceId(request.id);
    // Propagate trace ID in response headers for client-side correlation
    reply.header('X-Trace-ID', traceId);

    runWithTrace(
      {
        traceId,
        requestId: request.id,
        method: request.method,
        url: request.url,
        startTime: Date.now(),
      },
      () => done()
    );
  });

  // Log request completion metrics (duration, status code)
  fastify.addHook('onResponse', (request, reply, done) => {
    logRequestMetrics(reply.statusCode);
    done();
  });

  // Health check endpoints
  // /health - Basic liveness probe (is process running?)
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      env: config.env,
    };
  });

  // /health/ready - Readiness probe (can we serve traffic?)
  // Checks database and Redis connectivity
  fastify.get('/health/ready', async (request, reply) => {
    const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};
    let allHealthy = true;

    // Check database
    const dbHealth = await checkDatabaseHealth();
    checks.database = {
      ok: dbHealth.connected,
      latencyMs: dbHealth.latencyMs,
      error: dbHealth.error,
    };
    if (!dbHealth.connected) allHealthy = false;

    // Check Redis (optional - graceful if unavailable)
    try {
      const redisHealth = await redis.checkHealth();
      checks.redis = {
        ok: redisHealth.connected,
        latencyMs: redisHealth.latencyMs,
        error: redisHealth.error,
      };
      // Redis is optional - don't fail readiness if unavailable
      // But log warning if it's down
      if (!redisHealth.connected) {
        logger.warn('Redis unavailable - distributed locking disabled');
      }
    } catch (err) {
      checks.redis = { ok: false, error: 'Redis check failed' };
    }

    const status = allHealthy ? 'ready' : 'not_ready';
    const statusCode = allHealthy ? 200 : 503;

    return reply.status(statusCode).send({
      status,
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  // /health/circuits - Circuit breaker status for monitoring (auth required)
  // Shows the state of all circuit breakers (Slack, Notion, Gmail, Claude)
  fastify.get('/health/circuits', { ...adminAuthHook }, async () => {
    const stats = circuitBreakerRegistry.getAllStats();
    const circuits: Record<string, {
      state: string;
      failures: number;
      successes: number;
      totalRequests: number;
      rejectedRequests: number;
    }> = {};

    for (const [name, stat] of Object.entries(stats)) {
      circuits[name] = {
        state: stat.state,
        failures: stat.failures,
        successes: stat.successes,
        totalRequests: stat.totalRequests,
        rejectedRequests: stat.rejectedRequests,
      };
    }

    // Check if any circuits are OPEN (degraded state)
    const openCircuits = Object.entries(circuits)
      .filter(([_, stat]) => stat.state === 'OPEN')
      .map(([name]) => name);

    return {
      status: openCircuits.length > 0 ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      openCircuits,
      circuits,
    };
  });

  // /health/tasks - Background task health for monitoring (auth required)
  // Shows success rates and recent errors for fire-and-forget operations
  fastify.get('/health/tasks', { ...adminAuthHook }, async () => {
    const health = getBackgroundTaskHealth();
    const metrics = getAllTaskMetrics();
    const timeoutStats = getTimeoutStats();

    return {
      status: health.healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      tasks: health.tasks,
      timeouts: timeoutStats,
      rawMetrics: metrics,
    };
  });

  // /health/full - Comprehensive health check combining all checks (auth required)
  // Use this for detailed debugging and monitoring dashboards
  fastify.get('/health/full', { ...adminAuthHook }, async () => {
    const checks: Record<string, unknown> = {};

    // Database
    const dbHealth = await checkDatabaseHealth();
    checks.database = {
      status: dbHealth.connected ? 'ok' : 'error',
      latencyMs: dbHealth.latencyMs,
      error: dbHealth.error,
    };

    // Redis
    const redisHealth = await redis.checkHealth();
    const redisState = redis.getHealthState();
    checks.redis = {
      status: redisHealth.connected ? 'ok' : 'degraded',
      latencyMs: redisHealth.latencyMs,
      backpressure: redisState.backpressureLevel,
      error: redisHealth.error,
    };

    // Circuit breakers
    const circuitStats = circuitBreakerRegistry.getAllStats();
    const openCircuits = Object.entries(circuitStats)
      .filter(([_, s]) => s.state === 'OPEN')
      .map(([name]) => name);
    checks.circuitBreakers = {
      status: openCircuits.length > 0 ? 'degraded' : 'ok',
      open: openCircuits,
      stats: circuitStats,
    };

    // Background tasks
    const taskHealth = getBackgroundTaskHealth();
    checks.backgroundTasks = {
      status: taskHealth.healthy ? 'ok' : 'degraded',
      tasks: taskHealth.tasks,
    };

    // Timeouts
    const timeoutStats = getTimeoutStats();
    checks.timeouts = {
      status: timeoutStats.recentCount > 10 ? 'degraded' : 'ok',
      ...timeoutStats,
    };

    // Overall status
    const overallStatus = dbHealth.connected &&
      openCircuits.length === 0 &&
      taskHealth.healthy &&
      timeoutStats.recentCount < 10
      ? 'ok' : 'degraded';

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
    };
  });

  // Register routes
  await fastify.register(therapistRoutes);
  await fastify.register(webhookRoutes);
  await fastify.register(appointmentsRoutes);
  await fastify.register(ingestionRoutes);
  await fastify.register(emailWebhookRoutes);
  await fastify.register(adminRoutes);
  await fastify.register(adminDashboardRoutes);
  await fastify.register(adminKnowledgeRoutes);
  await fastify.register(adminSettingsRoutes);
  await fastify.register(publicSettingsRoutes);
  await fastify.register(unsubscribeRoutes);
  await fastify.register(feedbackFormRoutes);
  await fastify.register(adminFormsRoutes);

  // Error handler
  fastify.setErrorHandler((error, request, reply) => {
    logger.error(
      {
        err: error,
        requestId: request.id,
        url: request.url,
        method: request.method,
      },
      'Request error'
    );

    // Don't expose internal errors in production
    const statusCode = error.statusCode || 500;
    const message = statusCode === 500 && config.env === 'production' ? 'Internal Server Error' : error.message;

    reply.status(statusCode).send({
      success: false,
      error: message,
    });
  });

  return fastify;
}

// Grace period for in-flight requests during shutdown
const SHUTDOWN_GRACE_PERIOD_MS = 30000; // 30 seconds

async function start() {
  let server: Awaited<ReturnType<typeof buildServer>> | null = null;
  let isShuttingDown = false;
  let slackQueueInterval: ReturnType<typeof setInterval> | null = null;

  // Graceful shutdown handler
  async function gracefulShutdown(signal: string) {
    // Prevent multiple shutdown attempts
    if (isShuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress, ignoring signal');
      return;
    }
    isShuttingDown = true;

    logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown...');

    try {
      // Close Fastify server (stop accepting new requests)
      if (server) {
        await server.close();
        logger.info('HTTP server closed, no new requests accepted');
      }

      // Grace period for in-flight requests to complete
      logger.info({ graceMs: SHUTDOWN_GRACE_PERIOD_MS }, 'Waiting for in-flight requests to complete...');
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_PERIOD_MS));

      // Stop background services (they should check isShuttingDown internally)
      logger.info('Stopping background services...');
      if (slackQueueInterval) clearInterval(slackQueueInterval);
      staleCheckService.stop();
      emailPollingService.stop();
      gmailWatchService.stop();
      pendingEmailService.stop();
      postBookingFollowupService.stop();
      weeklyMailingListService.stop();
      slackWeeklySummaryService.stop();
      notionSyncManager.stop();

      // Give services a moment to release locks
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Close Redis connection
      await redis.quit();

      // Disconnect Prisma (database.ts has its own handlers, but we call explicitly)
      await prisma.$disconnect();
      logger.info('Database connection closed');

      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  }

  // Unhandled rejection handler - log and continue (don't crash)
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(
      { reason, promise: String(promise) },
      'Unhandled promise rejection - logging but not crashing'
    );
    // In production, we log but don't crash to maintain uptime
    // Critical errors should be caught and handled explicitly
  });

  // Uncaught exception handler - log, cleanup, and exit
  process.on('uncaughtException', async (error) => {
    logger.fatal({ err: error }, 'Uncaught exception - initiating emergency shutdown');

    // Attempt graceful shutdown, but with shorter timeout
    try {
      if (server) {
        await Promise.race([
          server.close(),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      }
      await Promise.race([
        prisma.$disconnect(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch (shutdownErr) {
      logger.error({ err: shutdownErr }, 'Error during emergency shutdown');
    }

    process.exit(1);
  });

  // Register shutdown handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  try {
    server = await buildServer();

    await server.listen({
      port: config.port,
      host: config.host,
    });

    // Cleanup stale locks from previous runs (crash recovery)
    // These patterns cover common lock types in the application
    const staleLockPatterns = [
      'gmail:lock:*',
      'appointment:lock:*',
      'pending-email:lock:*',
      'weekly-mailing:lock:*',
      'stale-check:lock:*',
    ];
    const cleanedLocks = await redis.cleanupStaleLocks(staleLockPatterns, 300);
    if (cleanedLocks > 0) {
      logger.info({ cleanedLocks }, 'Cleaned up stale locks from previous run');
    }

    // Load persisted Slack notification queue from Redis
    const loadedSlackNotifications = await slackNotificationService.loadPersistedQueue();
    if (loadedSlackNotifications > 0) {
      logger.info({ count: loadedSlackNotifications }, 'Loaded persisted Slack notifications');
    }

    // Set up periodic Slack queue processing (every 30 seconds)
    slackQueueInterval = setInterval(async () => {
      try {
        await slackNotificationService.processQueue();
      } catch (err) {
        logger.error({ err }, 'Error processing Slack notification queue');
      }
    }, 30000);

    // Start background services
    staleCheckService.start(); // Checks for 48h+ inactive conversations
    emailPollingService.start(); // Backup polling for missed push notifications
    gmailWatchService.start(); // Auto-renew Gmail push notification watches
    pendingEmailService.start(); // Retry failed email sends
    postBookingFollowupService.start(); // Post-booking follow-ups (meeting link checks, feedback forms)
    weeklyMailingListService.start(); // Weekly promotional mailing list
    notionSyncManager.start(); // Unified Notion sync (therapist freeze, users, feedback read/write)
    slackWeeklySummaryService.start(); // Weekly Slack summary (Monday 9am)

    logger.info(
      {
        port: config.port,
        host: config.host,
        env: config.env,
      },
      'Server started'
    );
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();

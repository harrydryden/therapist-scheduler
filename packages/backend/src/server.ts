import Fastify from 'fastify';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import pino from 'pino';
import { config } from './config';
// --- Route Modules ---
// Public-facing routes (no auth required)
import { therapistRoutes } from './routes/therapists.routes';
import { appointmentsRoutes } from './routes/appointments.routes';
import { feedbackFormRoutes } from './routes/feedback-form.routes';
import { unsubscribeRoutes } from './routes/unsubscribe.routes';
import { signupRoutes } from './routes/signup.routes';
import { publicSettingsRoutes } from './routes/admin-settings.routes';

// Admin routes (webhook secret auth required)
import { adminRoutes } from './routes/admin.routes';
import { adminDashboardRoutes } from './routes/admin-dashboard.routes';
import { adminContentRoutes } from './routes/admin-content.routes';
import { adminSettingsRoutes } from './routes/admin-settings.routes';
import { adminWorkReportRoutes } from './routes/admin-work-reports.routes';
import { adminVoucherRoutes } from './routes/admin-vouchers.routes';
import { adminUserRoutes } from './routes/admin-users.routes';
import { adminTherapistRoutes } from './routes/admin-therapists.routes';
import { adminInvitationRoutes } from './routes/admin-invitations.routes';
import { ingestionRoutes } from './routes/ingestion.routes';

// ATS Integration routes (versioned, webhook secret auth required)
import { atsIntegrationRoutes } from './routes/ats-integration.routes';

// Webhook receivers (Gmail, Slack — external service callbacks)
import { emailWebhookRoutes } from './routes/email-webhook.routes';

// --- Services ---
import { staleCheckService } from './services/stale-check.service';
import { emailPollingService } from './services/email-polling.service';
import { gmailWatchService } from './services/gmail-watch.service';
import { pendingEmailService } from './services/email-queue.service';
import { postBookingFollowupService } from './services/post-booking-followup.service';
import { weeklyMailingListService } from './services/weekly-mailing-list.service';
import { slackWeeklySummaryService } from './services/slack-weekly-summary.service';
import { workReportService } from './services/work-report.service';
import { appointmentLifecycleTickService } from './domain/scheduling/lifecycle';
import { invitationLifecycleService } from './services/invitation-lifecycle.service';
import { emailQueueService } from './services/email-queue.service';
import { sideEffectRetryService } from './services/side-effect-retry.service';
import { prisma, checkDatabaseHealth } from './utils/database';
import { redis } from './utils/redis';
import { circuitBreakerRegistry } from './utils/circuit-breaker';
import { getAllTaskMetrics, getBackgroundTaskHealth } from './utils/background-task';
import { getTimeoutStats } from './utils/timeout';
import { slackNotificationService } from './services/slack-notification.service';
import { sseService } from './services/sse.service';
import { registerAgentProcessor } from './core/email';
import { JustinTimeService } from './services/justin-time.service';
import { therapistNudgeService } from './services/therapist-nudge.service';
import { missedMessageScannerService } from './services/missed-message-scanner.service';
import { verifyWebhookSecret } from './middleware/auth';
import { runWithTrace, generateTraceId, logRequestMetrics } from './utils/request-tracing';
import { withTimeout, TimeoutError } from './utils/timeout';

// Liveness probes must answer quickly even if the underlying connection
// is wedged — the orchestrator can't tell "probe hung" apart from "pod
// hung", so we set a tight ceiling and report a degraded-but-fast check
// instead of letting the request hang forever.
const HEALTH_PROBE_TIMEOUT_MS = 2000;

// Process-wide tally of `unhandledRejection` events. The handler logs
// each one but deliberately doesn't crash; the count is surfaced in
// /health/full so an outside monitor can alert on rejections piling up
// even when individual log lines slip past.
const UNHANDLED_REJECTION_SAMPLE_SIZE = 5;
let unhandledRejectionCount = 0;
const recentUnhandledRejections: Array<{ at: string; reason: string }> = [];

function recordUnhandledRejection(reason: unknown): void {
  unhandledRejectionCount++;
  const text = reason instanceof Error
    ? `${reason.name}: ${reason.message}`
    : String(reason);
  recentUnhandledRejections.push({ at: new Date().toISOString(), reason: text.slice(0, 500) });
  if (recentUnhandledRejections.length > UNHANDLED_REJECTION_SAMPLE_SIZE) {
    recentUnhandledRejections.shift();
  }
}

function getUnhandledRejectionStats(): { count: number; recent: Array<{ at: string; reason: string }> } {
  return { count: unhandledRejectionCount, recent: [...recentUnhandledRejections] };
}

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
  // Pino's `Logger` type is structurally compatible with Fastify's
  // `FastifyBaseLogger`, but Fastify 4's strict-mode generic resolution
  // can't pick the right overload from the option bag alone — without
  // the cast it falls back to Http2SecureServer types, which then
  // breaks every preHandler signature downstream. The runtime is
  // unaffected.
  const fastify = Fastify({
    logger: logger as unknown as import('fastify').FastifyBaseLogger,
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
  // Checks database and Redis connectivity, each behind a hard timeout
  // so the probe can never block longer than HEALTH_PROBE_TIMEOUT_MS.
  fastify.get('/health/ready', async (request, reply) => {
    const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};
    let allHealthy = true;

    // Database — required.
    try {
      const dbHealth = await withTimeout(
        checkDatabaseHealth(),
        HEALTH_PROBE_TIMEOUT_MS,
        'health.database',
      );
      checks.database = {
        ok: dbHealth.connected,
        latencyMs: dbHealth.latencyMs,
        error: dbHealth.error,
      };
      if (!dbHealth.connected) allHealthy = false;
    } catch (err) {
      checks.database = { ok: false, error: err instanceof TimeoutError ? 'timeout' : 'check failed' };
      allHealthy = false;
    }

    // Redis — optional. Failure logs a warning but doesn't fail readiness.
    try {
      const redisHealth = await withTimeout(
        redis.checkHealth(),
        HEALTH_PROBE_TIMEOUT_MS,
        'health.redis',
      );
      checks.redis = {
        ok: redisHealth.connected,
        latencyMs: redisHealth.latencyMs,
        error: redisHealth.error,
      };
      if (!redisHealth.connected) {
        logger.warn('Redis unavailable - distributed locking disabled');
      }
    } catch (err) {
      checks.redis = { ok: false, error: err instanceof TimeoutError ? 'timeout' : 'check failed' };
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
  // Shows the state of all circuit breakers (Slack, Gmail, Claude)
  fastify.get('/health/circuits', { preHandler: verifyWebhookSecret }, async () => {
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
  fastify.get('/health/tasks', { preHandler: verifyWebhookSecret }, async () => {
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
  fastify.get('/health/full', { preHandler: verifyWebhookSecret }, async () => {
    const checks: Record<string, unknown> = {};

    // Database — timeout-bounded so a wedged connection doesn't hang the probe.
    let dbConnected = false;
    try {
      const dbHealth = await withTimeout(
        checkDatabaseHealth(),
        HEALTH_PROBE_TIMEOUT_MS,
        'health.database',
      );
      dbConnected = dbHealth.connected;
      checks.database = {
        status: dbHealth.connected ? 'ok' : 'error',
        latencyMs: dbHealth.latencyMs,
        error: dbHealth.error,
      };
    } catch (err) {
      checks.database = {
        status: 'error',
        error: err instanceof TimeoutError ? 'timeout' : 'check failed',
      };
    }

    // Redis — same treatment, but probe failure is degraded (not error).
    const redisState = redis.getHealthState();
    try {
      const redisHealth = await withTimeout(
        redis.checkHealth(),
        HEALTH_PROBE_TIMEOUT_MS,
        'health.redis',
      );
      checks.redis = {
        status: redisHealth.connected ? 'ok' : 'degraded',
        latencyMs: redisHealth.latencyMs,
        backpressure: redisState.backpressureLevel,
        error: redisHealth.error,
      };
    } catch (err) {
      checks.redis = {
        status: 'degraded',
        backpressure: redisState.backpressureLevel,
        error: err instanceof TimeoutError ? 'timeout' : 'check failed',
      };
    }

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

    // Missed-message scanner — heartbeat freshness check.
    // The scanner writes a heartbeat to Redis on every successful scan.
    // If it's stale (or missing), the scanner is unhealthy and incoming
    // therapist replies may be sitting unprocessed.
    const scannerStatus = await missedMessageScannerService.getStatus();
    checks.missedMessageScanner = {
      status: scannerStatus.healthy ? 'ok' : 'degraded',
      ...scannerStatus,
    };

    // Unhandled rejections — the process keeps running on these, so we
    // surface the count + a recent sample here. Any non-zero count is
    // degraded; the recent sample helps locate the leaking promise.
    const rejectionStats = getUnhandledRejectionStats();
    checks.unhandledRejections = {
      status: rejectionStats.count === 0 ? 'ok' : 'degraded',
      count: rejectionStats.count,
      recent: rejectionStats.recent,
    };

    // Overall status
    const overallStatus = dbConnected &&
      openCircuits.length === 0 &&
      taskHealth.healthy &&
      timeoutStats.recentCount < 10 &&
      scannerStatus.healthy &&
      rejectionStats.count === 0
      ? 'ok' : 'degraded';

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
    };
  });

  // ==========================================
  // Route Registration
  // ==========================================

  // --- Public routes (no authentication required) ---
  await fastify.register(therapistRoutes);         // GET /api/therapists
  await fastify.register(appointmentsRoutes);       // POST /api/appointments/request, GET /api/appointments/:id/status
  await fastify.register(feedbackFormRoutes);        // GET /api/feedback/form, POST /api/feedback/submit
  await fastify.register(unsubscribeRoutes);         // POST /api/unsubscribe/:token
  await fastify.register(signupRoutes);              // POST /api/signup
  await fastify.register(publicSettingsRoutes);      // GET /api/settings/frontend

  // --- Admin routes (webhook secret authentication) ---
  await fastify.register(adminRoutes);              // Gmail setup, Slack diagnostics, weekly mailing
  await fastify.register(adminDashboardRoutes);     // Appointments CRUD, therapist management, stats, SSE
  await fastify.register(adminContentRoutes);      // Knowledge base + feedback forms
  await fastify.register(adminSettingsRoutes);      // System settings CRUD, alerts, health
  await fastify.register(adminWorkReportRoutes);   // Daily work reports
  await fastify.register(adminVoucherRoutes);      // Voucher management
  await fastify.register(adminUserRoutes);         // Postgres-backed user list/detail/edit
  await fastify.register(adminTherapistRoutes);    // Postgres-backed therapist list/detail/edit/unfreeze
  await fastify.register(adminInvitationRoutes);   // Signup invitations CRUD + revoke + resend
  await fastify.register(ingestionRoutes);          // Therapist CV/PDF ingestion

  // --- ATS Integration routes (versioned API for external ATS system) ---
  await fastify.register(atsIntegrationRoutes);     // /api/v1/ats/* — appointments, feedback, therapists, stats

  // --- External webhook receivers ---
  await fastify.register(emailWebhookRoutes);       // Gmail Pub/Sub push notifications

  // In production, serve the frontend SPA build
  if (config.env === 'production') {
    // Frontend dist is at /app/dist relative to the Docker WORKDIR
    // In local builds, it's at ../../frontend/dist relative to the backend
    const frontendDistDir = fs.existsSync(path.resolve(process.cwd(), 'dist'))
      ? path.resolve(process.cwd(), 'dist')
      : path.resolve(__dirname, '../../frontend/dist');

    if (fs.existsSync(frontendDistDir)) {
      await fastify.register(fastifyStatic, {
        root: frontendDistDir,
        prefix: '/',
        wildcard: false,
      });

      // SPA fallback: serve index.html for non-API routes
      fastify.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/') || request.url.startsWith('/health')) {
          reply.status(404).send({ success: false, error: 'Not found' });
        } else {
          reply.sendFile('index.html');
        }
      });
    }
  }

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
      // Close Fastify server (stops accepting new requests and waits for in-flight to complete)
      if (server) {
        await server.close();
        logger.info('HTTP server closed, all in-flight requests completed');
      }

      // Stop background services in dependency order:
      // 1. Real-time connections (SSE) — stop pushing updates to clients
      // 2. Producers (polling, scanning, scheduling) — stop generating new work
      // 3. Side-effect processors — let in-flight retries finish
      // 4. Consumers (email queue) — drain remaining jobs
      logger.info('Stopping background services...');
      if (slackQueueInterval) clearInterval(slackQueueInterval);
      sseService.stop();

      // Stop producers
      emailPollingService.stop();
      gmailWatchService.stop();
      missedMessageScannerService.stop();
      staleCheckService.stop();
      postBookingFollowupService.stop();
      weeklyMailingListService.stop();
      slackWeeklySummaryService.stop();
      workReportService.stop();
      therapistNudgeService.stop();
      appointmentLifecycleTickService.stop();
      invitationLifecycleService.stop();

      // Stop side-effect retries and pending email processing
      sideEffectRetryService.stop();
      pendingEmailService.stop();

      // Drain the email queue last (it may still have in-flight jobs)
      await emailQueueService.stop();

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

  // Unhandled rejection handler — log and continue (don't crash). The
  // count + last few reasons are surfaced in /health/full so an outside
  // monitor can detect the silent-failure pattern this handler would
  // otherwise mask. The right long-term fix is to find and catch the
  // rejecting promises explicitly; the counter makes them visible in
  // the meantime.
  process.on('unhandledRejection', (reason, promise) => {
    recordUnhandledRejection(reason);
    logger.error(
      { reason, promise: String(promise), unhandledRejectionCount: getUnhandledRejectionStats().count },
      'Unhandled promise rejection - logging but not crashing'
    );
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
    // Run asynchronously to avoid blocking server startup during deploys
    const staleLockPatterns = [
      'gmail:lock:*',
      'appointment:lock:*',
      'pending-email:lock:*',
      'weekly-mailing:lock:*',
      'stale-check:lock:*',
      'missed-message-scanner:lock:*',
    ];
    redis.cleanupStaleLocks(staleLockPatterns, 300).then((cleanedLocks) => {
      if (cleanedLocks > 0) {
        logger.info({ cleanedLocks }, 'Cleaned up stale locks from previous run');
      }
    }).catch((err) => {
      logger.warn({ err }, 'Failed to cleanup stale locks (non-fatal)');
    });

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

    // Register agent processor to break circular dependency
    // email-message-processor needs to call JustinTimeService but can't import it directly
    registerAgentProcessor((traceId) => new JustinTimeService(traceId));

    // Start background services with error isolation.
    // Each service is started independently so a failure in one doesn't prevent
    // the others from running. Critical services (email queue) log fatal if they
    // fail; non-critical services log errors but allow the server to continue.
    const backgroundServices = [
      { name: 'emailQueueService', service: emailQueueService, critical: true, async: true },
      { name: 'staleCheckService', service: staleCheckService, critical: false, async: false },
      { name: 'emailPollingService', service: emailPollingService, critical: false, async: false },
      { name: 'gmailWatchService', service: gmailWatchService, critical: false, async: false },
      { name: 'pendingEmailService', service: pendingEmailService, critical: false, async: false },
      { name: 'sideEffectRetryService', service: sideEffectRetryService, critical: false, async: false },
      { name: 'postBookingFollowupService', service: postBookingFollowupService, critical: false, async: false },
      { name: 'weeklyMailingListService', service: weeklyMailingListService, critical: false, async: false },
      { name: 'appointmentLifecycleTickService', service: appointmentLifecycleTickService, critical: false, async: false },
      { name: 'invitationLifecycleService', service: invitationLifecycleService, critical: false, async: false },
      { name: 'slackWeeklySummaryService', service: slackWeeklySummaryService, critical: false, async: false },
      { name: 'workReportService', service: workReportService, critical: false, async: false },
      { name: 'therapistNudgeService', service: therapistNudgeService, critical: false, async: false },
      { name: 'missedMessageScannerService', service: missedMessageScannerService, critical: false, async: false },
    ] as const;

    for (const { name, service, critical, async: isAsync } of backgroundServices) {
      try {
        if (isAsync) {
          await service.start();
        } else {
          service.start();
        }
        logger.info({ service: name }, 'Background service started');
      } catch (err) {
        if (critical) {
          logger.fatal({ err, service: name }, `Critical background service failed to start`);
          throw err;
        }
        logger.error({ err, service: name }, `Non-critical background service failed to start — continuing`);
      }
    }

    // Recover any emails buffered in Redis WAL during database downtime
    emailQueueService.recoverFromWAL().catch((err) => {
      logger.warn({ err }, 'WAL recovery on startup failed (non-critical — will retry on next cycle)');
    });

    logger.info(
      {
        port: config.port,
        host: config.host,
        env: config.env,
      },
      'Server started'
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.fatal({ err }, `Failed to start server: ${errorMessage}`);
    // Also log to stderr so Railway captures the error details even if pino JSON is truncated
    console.error('FATAL: Failed to start server:', errorMessage);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

start();

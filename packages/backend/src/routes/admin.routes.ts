import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { emailProcessingService } from '../services/email-processing.service';
import { slackNotificationService } from '../services/slack-notification.service';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { prisma } from '../utils/database';
import { RATE_LIMITS } from '../constants';
import { sendSuccess, Errors } from '../utils/response';
import { getSettingValues } from '../services/settings.service';
import { renderTemplate } from '../utils/email-templates';
import { firstName } from '../utils/first-name';
import { generateUnsubscribeUrl } from '../utils/unsubscribe-token';
import { verifyWebhookSecret } from '../middleware/auth';
import { getTaskMetrics } from '../utils/background-task';
import { missedMessageScannerService } from '../services/missed-message-scanner.service';

const setupPushSchema = z.object({
  topicName: z.string().min(1, 'Pub/Sub topic name is required'),
});

export async function adminRoutes(fastify: FastifyInstance) {
  // Use shared auth middleware with brute-force protection
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * POST /api/admin/gmail/setup-push
   * Set up Gmail push notifications
   */
  fastify.post<{ Body: z.infer<typeof setupPushSchema> }>(
    '/api/admin/gmail/setup-push',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Body: z.infer<typeof setupPushSchema> }>, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Setting up Gmail push notifications');

      const validation = setupPushSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      try {
        const result = await emailProcessingService.setupPushNotifications(validation.data.topicName);

        return sendSuccess(reply, {
          ...result,
          message: 'Gmail push notifications configured. Watch will expire and need renewal.',
          renewalInfo: 'Gmail watches expire after 7 days. Set up a cron job to call this endpoint weekly.',
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to set up Gmail push notifications');
        return Errors.internal(reply, 'Failed to set up push notifications');
      }
    }
  );

  /**
   * GET /api/admin/gmail/status
   * Check Gmail integration status
   */
  fastify.get(
    '/api/admin/gmail/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const health = await emailProcessingService.checkHealth();
        return sendSuccess(reply, health);
      } catch (err) {
        logger.error({ err }, 'Failed to check Gmail status');
        return Errors.internal(reply, 'Status check failed');
      }
    }
  );

  /**
   * POST /api/admin/gmail/reset-history
   * Reset the Gmail history ID in Redis (use after switching accounts)
   */
  fastify.post(
    '/api/admin/gmail/reset-history',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Resetting Gmail history ID');

      try {
        // Delete the stored history ID from Redis
        const deleted = await redis.del('gmail:lastHistoryId');

        logger.info({ requestId, deleted }, 'Gmail history ID reset');

        return sendSuccess(reply, {
          message: 'Gmail history ID has been reset. The next notification will use the incoming history ID.',
          keysDeleted: deleted,
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to reset Gmail history ID');
        return Errors.internal(reply, 'Failed to reset history ID');
      }
    }
  );

  /**
   * POST /api/admin/weekly-mailing/test
   * Send a test weekly mailing email to a specific address
   */
  const testWeeklyMailingSchema = z.object({
    email: z.string().email('Valid email address required'),
    name: z.string().optional().default('Test User'),
  });

  fastify.post<{ Body: z.infer<typeof testWeeklyMailingSchema> }>(
    '/api/admin/weekly-mailing/test',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Body: z.infer<typeof testWeeklyMailingSchema> }>, reply: FastifyReply) => {
      const requestId = request.id;

      const validation = testWeeklyMailingSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { email, name } = validation.data;
      logger.info({ requestId, email, name }, 'Sending test weekly mailing email');

      try {
        // Batch fetch all needed settings in a single query
        const settingsMap = await getSettingValues<string>([
          'email.weeklyMailingSubject',
          'email.weeklyMailingBody',
          'weeklyMailing.webAppUrl',
        ]);
        const subjectTemplate = settingsMap.get('email.weeklyMailingSubject')!;
        const bodyTemplate = settingsMap.get('email.weeklyMailingBody')!;
        const webAppUrl = settingsMap.get('weeklyMailing.webAppUrl')!;

        // Generate unsubscribe URL
        const unsubscribeUrl = generateUnsubscribeUrl(email, config.backendUrl);

        // Render templates
        const userFirstName = firstName(name);
        const subject = renderTemplate(subjectTemplate, { userName: userFirstName });
        const body = renderTemplate(bodyTemplate, {
          userName: userFirstName,
          webAppUrl,
          unsubscribeUrl,
        });

        // Send the email
        await emailProcessingService.sendEmail({
          to: email,
          subject,
          body,
        });

        logger.info({ requestId, email }, 'Test weekly mailing email sent');

        return sendSuccess(reply, {
          message: `Test weekly mailing email sent to ${email}`,
          email,
          subject,
        });
      } catch (err) {
        logger.error({ err, requestId, email }, 'Failed to send test weekly mailing email');
        return Errors.internal(reply, 'Failed to send test email');
      }
    }
  );

  /**
   * GET /api/admin/weekly-mailing/preview
   * Preview the next "send to users" email: recipient count + rendered
   * subject/body. Read-only — used by the admin button confirm dialog
   * so the operator sees exactly what they're about to send before
   * pulling the trigger.
   */
  fastify.get(
    '/api/admin/weekly-mailing/preview',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_ENDPOINTS.max,
          timeWindow: RATE_LIMITS.ADMIN_ENDPOINTS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      try {
        const { weeklyMailingListService } = await import('../services/weekly-mailing-list.service');
        const preview = await weeklyMailingListService.previewSend();
        return sendSuccess(reply, preview);
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to build weekly mailing preview');
        return Errors.internal(reply, 'Failed to build preview');
      }
    }
  );

  /**
   * POST /api/admin/weekly-mailing/trigger
   * Manually send the weekly mailing to all eligible users now. Respects
   * the enabled flag and the once-per-7-days ceiling. Rate-limited to
   * 1/hour as a safety net behind the UI confirm dialog.
   */
  fastify.post(
    '/api/admin/weekly-mailing/trigger',
    {
      config: {
        rateLimit: {
          max: 1, // Only allow 1 trigger per time window
          timeWindow: 60 * 60 * 1000, // 1 hour
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Manual trigger of weekly mailing requested');

      try {
        const { weeklyMailingListService } = await import('../services/weekly-mailing-list.service');

        const result = await weeklyMailingListService.forceSend();

        return sendSuccess(reply, {
          message: 'Weekly mailing triggered successfully',
          ...result,
        });
      } catch (err) {
        // Surface user-actionable errors (disabled, already-sent) as 400s
        // so the UI can show the message; everything else is a 500.
        if (err instanceof Error && /disabled|already sent/i.test(err.message)) {
          return Errors.badRequest(reply, err.message);
        }
        logger.error({ err, requestId }, 'Failed to trigger weekly mailing');
        return Errors.internal(reply, 'Failed to trigger weekly mailing');
      }
    }
  );

  // ============================================
  // Missed Message Scanner
  // ============================================

  /**
   * POST /api/admin/email/trigger-missed-message-scan
   * Manually trigger a full missed message scan across all active threads
   */
  fastify.post(
    '/api/admin/email/trigger-missed-message-scan',
    {
      config: {
        rateLimit: {
          max: 1,
          timeWindow: 10 * 60 * 1000, // 1 per 10 minutes
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Manual missed message scan requested');

      try {
        const result = await missedMessageScannerService.triggerManualScan();
        return sendSuccess(reply, {
          ...result,
          message: `Scan complete — recovered ${result.recovered} messages from ${result.scanned} threads`,
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to trigger missed message scan');
        return Errors.internal(reply, 'Failed to trigger missed message scan');
      }
    }
  );

  /**
   * GET /api/admin/processing-failures
   * List recent message processing failures (active and abandoned). Used by
   * the admin diagnostics UI to show what's currently failing in the scanner
   * pipeline. Optional query: ?abandoned=true to filter to abandoned only.
   */
  fastify.get<{ Querystring: { abandoned?: string; limit?: string } }>(
    '/api/admin/processing-failures',
    async (request, reply) => {
      const { abandoned, limit } = request.query;
      const take = Math.min(parseInt(limit || '50', 10) || 50, 200);
      const where = abandoned === 'true' ? { abandoned: true } : {};

      try {
        const failures = await prisma.messageProcessingFailure.findMany({
          where,
          orderBy: { lastFailedAt: 'desc' },
          take,
        });
        return sendSuccess(reply, { failures, count: failures.length });
      } catch (err) {
        logger.error({ err }, 'Failed to list processing failures');
        return Errors.internal(reply, 'Failed to list processing failures');
      }
    }
  );

  /**
   * POST /api/admin/processing-failures/retry
   * Force-retry a list of abandoned (or active-failing) messages. Clears the
   * dedup record + failure record so the next scanner cycle picks them up.
   *
   * Use this after fixing the underlying issue (e.g. running a missing
   * migration). Without this endpoint, abandoned messages stay marked as
   * processed in the dedup table forever.
   *
   * Body: { messageIds: string[] }            — explicit list (capped at 500)
   *       { all: true, limit?: number }       — retry abandoned failures, oldest first
   *
   * Uses oldest-first ordering so repeated calls drain the backlog in the
   * order failures occurred. The response includes `remaining` so the caller
   * knows whether another page is needed.
   */
  fastify.post<{ Body: { messageIds?: string[]; all?: boolean; limit?: number } }>(
    '/api/admin/processing-failures/retry',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60 * 1000,
        },
      },
    },
    async (request, reply) => {
      const requestId = request.id;
      const { messageIds, all, limit } = request.body || {};

      if (!all && (!messageIds || messageIds.length === 0)) {
        return Errors.badRequest(reply, 'messageIds (non-empty array) or all=true required');
      }

      // Cap the batch size so a mass-failure incident can't produce a single
      // recovery run that hammers Gmail rate limits. The scanner processes
      // recovered messages synchronously, and each one does ≥1 Gmail API call.
      const MAX_BATCH = 500;
      const effectiveLimit = Math.min(limit ?? MAX_BATCH, MAX_BATCH);

      try {
        let targetIds: string[];
        let totalAbandoned = 0;
        if (all) {
          totalAbandoned = await prisma.messageProcessingFailure.count({
            where: { abandoned: true },
          });
          const records = await prisma.messageProcessingFailure.findMany({
            where: { abandoned: true },
            orderBy: { firstFailedAt: 'asc' }, // oldest first so repeated calls drain in order
            select: { id: true },
            take: effectiveLimit,
          });
          targetIds = records.map((r) => r.id);
        } else {
          if (messageIds!.length > MAX_BATCH) {
            return Errors.badRequest(
              reply,
              `messageIds capped at ${MAX_BATCH} per call; paginate if you have more`,
            );
          }
          targetIds = messageIds!;
        }

        if (targetIds.length === 0) {
          return sendSuccess(reply, {
            cleared: 0,
            remaining: 0,
            message: 'No abandoned failures to retry',
          });
        }

        // Clear dedup + failure records in parallel — independent writes
        const [deletedDedup, deletedFailures] = await Promise.all([
          prisma.processedGmailMessage.deleteMany({ where: { id: { in: targetIds } } }),
          prisma.messageProcessingFailure.deleteMany({ where: { id: { in: targetIds } } }),
        ]);

        const remaining = all ? Math.max(0, totalAbandoned - targetIds.length) : 0;

        logger.info(
          {
            requestId,
            count: targetIds.length,
            deletedDedup: deletedDedup.count,
            deletedFailures: deletedFailures.count,
            remaining,
          },
          'Cleared processing failures for retry'
        );

        // Trigger an immediate scan so the operator gets feedback
        const scanResult = await missedMessageScannerService.triggerManualScan();

        return sendSuccess(reply, {
          cleared: targetIds.length,
          deletedDedup: deletedDedup.count,
          deletedFailures: deletedFailures.count,
          remaining,
          scanResult,
          message:
            remaining > 0
              ? `Cleared ${targetIds.length}; ${remaining} abandoned failure(s) remain — call again to continue`
              : `Cleared ${targetIds.length} failure(s) and triggered a fresh scan`,
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to retry processing failures');
        return Errors.internal(reply, 'Failed to retry processing failures');
      }
    }
  );

  // ============================================
  // Slack Diagnostics
  // ============================================

  /**
   * GET /api/admin/slack/status
   * Get Slack integration status including circuit breaker state and queue info
   */
  fastify.get(
    '/api/admin/slack/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const circuitStats = slackNotificationService.getCircuitStats();
        const queueStats = slackNotificationService.getQueueStats();
        const enabled = slackNotificationService.isEnabled();

        // Get background task metrics for Slack-related tasks
        const slackTaskNames = [
          'slack-notify-completed',
          'slack-notify-confirmed',
          'slack-notify-cancelled',
          'slack-notify-requested',
          'slack-notify-escalation',
          'slack-notify-feedback-received',
          'slack-notify-feedback-received-fallback',
        ];
        const taskMetrics: Record<string, unknown> = {};
        for (const name of slackTaskNames) {
          const metrics = getTaskMetrics(name);
          if (metrics) {
            taskMetrics[name] = {
              total: metrics.total,
              success: metrics.success,
              failed: metrics.failed,
              timedOut: metrics.timedOut,
              recentErrors: metrics.recentErrors.slice(-5).map(e => ({
                timestamp: e.timestamp,
                error: e.error,
              })),
            };
          }
        }

        return sendSuccess(reply, {
          enabled,
          webhookConfigured: enabled,
          circuitBreaker: {
            state: circuitStats.state,
            failures: circuitStats.failures,
            successes: circuitStats.successes,
            lastFailure: circuitStats.lastFailure,
            lastSuccess: circuitStats.lastSuccess,
            totalRequests: circuitStats.totalRequests,
            rejectedRequests: circuitStats.rejectedRequests,
          },
          queue: queueStats,
          backgroundTasks: taskMetrics,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to check Slack status');
        return Errors.internal(reply, 'Status check failed');
      }
    }
  );

  /**
   * POST /api/admin/slack/test
   * Send a test notification to verify webhook connectivity
   */
  fastify.post(
    '/api/admin/slack/test',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Sending Slack test notification');

      if (!slackNotificationService.isEnabled()) {
        return reply.status(400).send({
          success: false,
          error: 'Slack notifications are disabled (SLACK_WEBHOOK_URL not set)',
        });
      }

      try {
        const sent = await slackNotificationService.sendSimpleMessage(
          '🔔 *Test Notification*\nThis is a test from the admin dashboard. If you see this, Slack notifications are working correctly.'
        );

        if (sent) {
          return sendSuccess(reply, {
            message: 'Test notification sent successfully',
            sent: true,
          });
        } else {
          // sendToSlack returned false — circuit breaker may be open or webhook failed
          const circuitStats = slackNotificationService.getCircuitStats();
          return reply.status(502).send({
            success: false,
            error: 'Failed to send test notification',
            circuitBreakerState: circuitStats.state,
            hint: circuitStats.state === 'OPEN'
              ? 'Circuit breaker is OPEN due to recent failures. Try resetting it first.'
              : 'The webhook URL may be invalid or Slack may be unreachable.',
          });
        }
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to send Slack test notification');
        const circuitStats = slackNotificationService.getCircuitStats();
        return reply.status(502).send({
          success: false,
          error: err instanceof Error ? err.message : 'Failed to send test notification',
          circuitBreakerState: circuitStats.state,
        });
      }
    }
  );

  /**
   * POST /api/admin/slack/reset
   * Reset the Slack circuit breaker to closed state
   */
  fastify.post(
    '/api/admin/slack/reset',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      try {
        const statsBefore = slackNotificationService.getCircuitStats();
        slackNotificationService.resetCircuit();
        const statsAfter = slackNotificationService.getCircuitStats();

        logger.info(
          { requestId, stateBefore: statsBefore.state, stateAfter: statsAfter.state },
          'Slack circuit breaker reset by admin'
        );

        return sendSuccess(reply, {
          message: 'Circuit breaker reset to CLOSED state',
          before: { state: statsBefore.state, failures: statsBefore.failures },
          after: { state: statsAfter.state, failures: statsAfter.failures },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to reset Slack circuit breaker');
        return Errors.internal(reply, 'Failed to reset circuit breaker');
      }
    }
  );
}

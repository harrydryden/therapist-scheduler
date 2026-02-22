import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { emailProcessingService } from '../services/email-processing.service';
import { slackNotificationService } from '../services/slack-notification.service';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { RATE_LIMITS, HEADERS } from '../constants';
import { sendSuccess, Errors } from '../utils/response';
import { getSettingValue } from '../services/settings.service';
import { renderTemplate } from '../utils/email-templates';
import { generateUnsubscribeUrl } from '../utils/unsubscribe-token';
import { verifyWebhookSecret } from '../middleware/auth';
import { getBackgroundTaskHealth, getTaskMetrics } from '../utils/background-task';

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
        // Get templates and settings
        const subjectTemplate = await getSettingValue<string>('email.weeklyMailingSubject');
        const bodyTemplate = await getSettingValue<string>('email.weeklyMailingBody');
        const webAppUrl = await getSettingValue<string>('weeklyMailing.webAppUrl');

        // Generate unsubscribe URL
        const unsubscribeUrl = generateUnsubscribeUrl(email, config.backendUrl);

        // Render templates
        const subject = renderTemplate(subjectTemplate, { userName: name });
        const body = renderTemplate(bodyTemplate, {
          userName: name,
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
   * POST /api/admin/weekly-mailing/trigger
   * Manually trigger sending the weekly mailing to all eligible users
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
        // Import the service
        const { weeklyMailingListService } = await import('../services/weekly-mailing-list.service');

        // Force send (bypasses day/time check but still respects enabled flag and already-sent check)
        await weeklyMailingListService.forceSend();

        return sendSuccess(reply, {
          message: 'Weekly mailing triggered successfully',
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to trigger weekly mailing');
        return Errors.internal(reply, 'Failed to trigger weekly mailing');
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

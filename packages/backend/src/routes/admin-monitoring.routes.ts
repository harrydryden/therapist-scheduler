/**
 * Admin Monitoring Routes
 *
 * Consolidates the monitoring, dashboard-data, data-maintenance, and
 * message-delivery-health endpoints that were previously split across
 * five small files:
 *
 *   - admin-stats.routes.ts         (dashboard summary statistics)
 *   - admin-therapists.routes.ts    (flagged therapist management)
 *   - admin-data.routes.ts          (sync / backfill / migration utilities)
 *   - admin-sse.routes.ts           (SSE event stream)
 *   - admin-queue-review.routes.ts  (message queue health, stuck messages, WAL recovery)
 *
 * The SSE route uses a query-param auth scheme (EventSource cannot send
 * custom headers), while the other routes use the standard webhook-secret
 * header. To keep that distinction clean, the hooked routes are wrapped
 * in a nested plugin scope.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { config } from '../config';
import { sendSuccess, Errors } from '../utils/response';
import { verifyWebhookSecret, safeCompare } from '../middleware/auth';
import { RATE_LIMITS } from '../constants';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { sseService } from '../services/sse.service';
import { messageQueueHealthService } from '../services/message-queue-health.service';
import { sideEffectRetryService } from '../services/side-effect-retry.service';
import { appointmentLifecycleTickService } from '../domain/scheduling/lifecycle';
import {
  backfillMissingTrackingCodes,
  fixDuplicateTrackingCodes,
  migrateLegacyTrackingCodes,
} from '../services/tracking-code.service';
import {
  backfillUsers,
  backfillTherapists,
  linkAppointmentsToEntities,
} from '../utils/unique-id';

export async function adminMonitoringRoutes(fastify: FastifyInstance) {
  // ==========================================================================
  // SSE — separate auth scheme (query-param), registered outside the hooked scope
  // ==========================================================================

  /**
   * GET /api/admin/dashboard/events
   * SSE stream for real-time appointment updates.
   *
   * Auth: ?secret=<webhook_secret> (EventSource cannot send custom headers)
   */
  fastify.get(
    '/api/admin/dashboard/events',
    async (request: FastifyRequest<{ Querystring: { secret?: string } }>, reply: FastifyReply) => {
      const { secret } = request.query as { secret?: string };

      const secretValid =
        typeof secret === 'string' &&
        config.webhookSecret &&
        safeCompare(secret, config.webhookSecret);

      if (!secretValid) {
        logger.warn({ requestId: request.id }, 'SSE connection rejected - invalid secret');
        return Errors.unauthorized(reply);
      }

      const connectionId = sseService.addConnection(reply);
      if (!connectionId) {
        return; // Connection rejected (limit reached), response already sent
      }
      // Keep the connection open — reply.raw 'close' in sseService cleans up on disconnect
    }
  );

  // ==========================================================================
  // Webhook-secret-protected monitoring & data routes
  // ==========================================================================

  await fastify.register(async (authed: FastifyInstance) => {
    authed.addHook('preHandler', verifyWebhookSecret);

    // ------------------------------------------------------------------------
    // Dashboard stats
    // ------------------------------------------------------------------------

    /**
     * GET /api/admin/dashboard/stats
     * Get summary statistics for the dashboard
     */
    authed.get(
      '/api/admin/dashboard/stats',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const requestId = request.id;
        logger.info({ requestId }, 'Fetching dashboard stats');

        try {
          const [statusCounts, recentConfirmed, userStats, totalRequests] = await Promise.all([
            prisma.appointmentRequest.groupBy({
              by: ['status'],
              _count: { id: true },
            }),
            prisma.appointmentRequest.count({
              where: {
                status: 'confirmed',
                confirmedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
              },
            }),
            prisma.appointmentRequest.groupBy({
              by: ['userEmail', 'userName'],
              _count: { id: true },
              orderBy: { _count: { id: 'desc' } },
              take: 10,
            }),
            prisma.appointmentRequest.count(),
          ]);

          const stats = {
            byStatus: Object.fromEntries(statusCounts.map((s) => [s.status, s._count.id])),
            confirmedLast7Days: recentConfirmed,
            totalRequests,
            topUsers: userStats.map((u) => ({
              name: u.userName || u.userEmail,
              email: u.userEmail,
              bookingCount: u._count.id,
            })),
          };

          return sendSuccess(reply, stats);
        } catch (err) {
          logger.error({ err, requestId }, 'Failed to fetch dashboard stats');
          return Errors.internal(reply, 'Failed to fetch dashboard stats');
        }
      }
    );

    // ------------------------------------------------------------------------
    // Flagged therapists
    // ------------------------------------------------------------------------

    /**
     * GET /api/admin/dashboard/flagged-therapists
     * Get therapists flagged for admin attention (72h inactivity with 2 threads)
     */
    authed.get(
      '/api/admin/dashboard/flagged-therapists',
      async (request: FastifyRequest, reply: FastifyReply) => {
        const requestId = request.id;
        logger.info({ requestId }, 'Fetching flagged therapists');

        try {
          const flagged = await therapistBookingStatusService.getFlaggedTherapists();
          return reply.send({ success: true, data: flagged });
        } catch (err) {
          logger.error({ err, requestId }, 'Failed to fetch flagged therapists');
          return Errors.internal(reply, 'Failed to fetch flagged therapists');
        }
      }
    );

    /**
     * POST /api/admin/dashboard/flagged-therapists/:therapistId/acknowledge
     * Acknowledge a flagged therapist alert
     */
    authed.post<{ Params: { therapistId: string } }>(
      '/api/admin/dashboard/flagged-therapists/:therapistId/acknowledge',
      {
        config: {
          rateLimit: {
            max: RATE_LIMITS.ADMIN_MUTATIONS.max,
            timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: { therapistId: string } }>,
        reply: FastifyReply
      ) => {
        const { therapistId } = request.params;
        const requestId = request.id;

        try {
          await therapistBookingStatusService.acknowledgeFlaggedTherapist(therapistId);
          logger.info({ requestId, therapistId }, 'Flagged therapist acknowledged');

          return reply.send({
            success: true,
            data: { therapistId, acknowledged: true },
          });
        } catch (err) {
          logger.error({ err, requestId, therapistId }, 'Failed to acknowledge flagged therapist');
          return Errors.internal(reply, 'Failed to acknowledge flagged therapist');
        }
      }
    );

    // ------------------------------------------------------------------------
    // Data sync / backfill / migration tools
    // ------------------------------------------------------------------------

    /**
     * POST /api/admin/dashboard/trigger-feedback-sync
     * Manually trigger the feedback sync process
     */
    authed.post(
      '/api/admin/dashboard/trigger-feedback-sync',
      {
        config: {
          rateLimit: { max: 5, timeWindow: 60000 },
        },
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const requestId = request.id;

        try {
          logger.info({ requestId }, 'Manual feedback sync triggered');

          const tickResult = await appointmentLifecycleTickService.trigger();
          const skipped = !tickResult.acquired;
          const transitioned = tickResult.result?.transitioned ?? 0;

          if (tickResult.error) {
            logger.error(
              { err: tickResult.error, requestId },
              'Manual feedback sync errored',
            );
            return Errors.internal(reply, 'Failed to trigger feedback sync');
          }

          logger.info(
            { requestId, transitioned, skipped },
            'Manual feedback sync completed'
          );

          return sendSuccess(reply, {
            transitioned,
            errors: 0,
            message: skipped
              ? 'Tick skipped — another instance is already running it'
              : `Sync completed: ${transitioned} appointments transitioned`,
          });
        } catch (err) {
          logger.error({ err, requestId }, 'Failed to trigger feedback sync');
          return Errors.internal(reply, 'Failed to trigger feedback sync');
        }
      }
    );

    /**
     * POST /api/admin/dashboard/fix-tracking-codes
     * Fix tracking code issues: backfill missing, fix duplicates, migrate legacy
     */
    authed.post(
      '/api/admin/dashboard/fix-tracking-codes',
      {
        config: {
          rateLimit: { max: 2, timeWindow: 60000 },
        },
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const requestId = request.id;

        logger.info({ requestId }, 'Running tracking code fix operation');

        try {
          const migrateResult = await migrateLegacyTrackingCodes();
          const backfillResult = await backfillMissingTrackingCodes();
          const fixResult = await fixDuplicateTrackingCodes();

          logger.info(
            {
              requestId,
              migrated: migrateResult.migrated,
              migrateErrors: migrateResult.errors.length,
              backfilled: backfillResult.updated,
              backfillErrors: backfillResult.errors.length,
              duplicatesFound: fixResult.duplicatesFound,
              duplicatesFixed: fixResult.fixed,
              fixErrors: fixResult.errors.length,
            },
            'Tracking code fix operation complete'
          );

          return sendSuccess(reply, {
            migration: {
              appointmentsMigrated: migrateResult.migrated,
              errors: migrateResult.errors,
            },
            backfill: {
              appointmentsUpdated: backfillResult.updated,
              errors: backfillResult.errors,
            },
            duplicateFix: {
              duplicatesFound: fixResult.duplicatesFound,
              appointmentsFixed: fixResult.fixed,
              errors: fixResult.errors,
            },
            message: `Migrated ${migrateResult.migrated} legacy codes, backfilled ${backfillResult.updated} appointments, fixed ${fixResult.fixed} duplicate codes`,
          });
        } catch (err) {
          logger.error({ err, requestId }, 'Failed to fix tracking codes');
          return Errors.internal(reply, 'Failed to fix tracking codes');
        }
      }
    );

    /**
     * POST /api/admin/dashboard/backfill-entities
     * Backfill User and Therapist entities from existing appointments
     */
    authed.post(
      '/api/admin/dashboard/backfill-entities',
      {
        config: {
          rateLimit: { max: 2, timeWindow: 60000 },
        },
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const requestId = request.id;

        logger.info({ requestId }, 'Running entity backfill operation');

        try {
          const userResult = await backfillUsers();
          const therapistResult = await backfillTherapists();
          // The previous odId sync to Notion has been retired — Postgres is
          // authoritative for the unique IDs now.
          const linkResult = await linkAppointmentsToEntities();

          logger.info(
            {
              requestId,
              usersCreated: userResult.created,
              usersSkipped: userResult.skipped,
              therapistsCreated: therapistResult.created,
              therapistsSkipped: therapistResult.skipped,
              appointmentsLinked: linkResult.linked,
            },
            'Entity backfill operation complete'
          );

          return sendSuccess(reply, {
            users: {
              created: userResult.created,
              skipped: userResult.skipped,
              errors: userResult.errors,
            },
            therapists: {
              created: therapistResult.created,
              skipped: therapistResult.skipped,
              errors: therapistResult.errors,
            },
            appointments: {
              linked: linkResult.linked,
              errors: linkResult.errors,
            },
            message: `Created ${userResult.created} users, ${therapistResult.created} therapists, linked ${linkResult.linked} appointments`,
          });
        } catch (err) {
          logger.error({ err, requestId }, 'Failed to backfill entities');
          return Errors.internal(reply, 'Failed to backfill entities');
        }
      }
    );

    // ------------------------------------------------------------------------
    // Message queue health & review (formerly admin-queue-review.routes.ts)
    // ------------------------------------------------------------------------

    /**
     * GET /api/admin/queue/health
     * Comprehensive health report across all message delivery subsystems.
     */
    authed.get(
      '/api/admin/queue/health',
      async (_request: FastifyRequest, reply: FastifyReply) => {
        try {
          const report = await messageQueueHealthService.getHealthReport();
          return sendSuccess(reply, report);
        } catch (err) {
          logger.error({ err }, 'Failed to generate queue health report');
          return Errors.internal(reply, 'Failed to generate health report');
        }
      }
    );

    /**
     * GET /api/admin/queue/stuck
     * List all stuck, failed, and abandoned messages for admin review.
     * Query params: limit (default 50, max 200)
     */
    authed.get<{ Querystring: { limit?: string } }>(
      '/api/admin/queue/stuck',
      async (
        request: FastifyRequest<{ Querystring: { limit?: string } }>,
        reply: FastifyReply
      ) => {
        try {
          const limit = Math.min(
            parseInt(request.query.limit || '50', 10) || 50,
            200
          );

          const messages = await messageQueueHealthService.getStuckMessages(limit);
          return sendSuccess(reply, messages, { count: messages.length });
        } catch (err) {
          logger.error({ err }, 'Failed to fetch stuck messages');
          return Errors.internal(reply, 'Failed to fetch stuck messages');
        }
      }
    );

    /**
     * POST /api/admin/queue/recover
     * Trigger recovery of emails from the write-ahead log (WAL).
     * Used after database downtime to sync buffered emails into the DB.
     */
    authed.post(
      '/api/admin/queue/recover',
      async (_request: FastifyRequest, reply: FastifyReply) => {
        try {
          const recovered = await messageQueueHealthService.triggerWALRecovery();
          return sendSuccess(
            reply,
            { recovered },
            {
              message:
                recovered > 0
                  ? `Recovered ${recovered} emails from write-ahead log`
                  : 'No entries in write-ahead log to recover',
            }
          );
        } catch (err) {
          logger.error({ err }, 'Failed to trigger WAL recovery');
          return Errors.internal(reply, 'Failed to trigger recovery');
        }
      }
    );

    /**
     * POST /api/admin/queue/retry/:id
     * Retry a specific stuck pending email by resetting its status to 'pending'.
     */
    authed.post<{ Params: { id: string } }>(
      '/api/admin/queue/retry/:id',
      async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const { id } = request.params;

        try {
          const email = await prisma.pendingEmail.findUnique({
            where: { id },
            select: { id: true, status: true, toEmail: true, subject: true, retryCount: true },
          });

          if (!email) {
            return Errors.notFound(reply, 'Pending email');
          }

          if (email.status === 'sent') {
            return Errors.badRequest(reply, 'Email has already been sent');
          }

          await prisma.pendingEmail.update({
            where: { id },
            data: {
              status: 'pending',
              errorMessage: null,
              nextRetryAt: null,
              // Keep retryCount for tracking, don't reset
            },
          });

          logger.info(
            { emailId: id, previousStatus: email.status, to: email.toEmail },
            'Admin manually retried stuck email'
          );

          return sendSuccess(reply, {
            id,
            previousStatus: email.status,
            newStatus: 'pending',
            message: 'Email reset to pending — will be picked up by next processing cycle',
          });
        } catch (err) {
          logger.error({ err, emailId: id }, 'Failed to retry stuck email');
          return Errors.internal(reply, 'Failed to retry email');
        }
      }
    );

    /**
     * GET /api/admin/queue/side-effects
     * Get side effect retry service status and stats.
     */
    authed.get(
      '/api/admin/queue/side-effects',
      async (_request: FastifyRequest, reply: FastifyReply) => {
        try {
          const status = sideEffectRetryService.getStatus();
          const stats = await messageQueueHealthService.getHealthReport();
          return sendSuccess(reply, {
            retryService: status,
            sideEffects: stats.subsystems.sideEffects,
          });
        } catch (err) {
          logger.error({ err }, 'Failed to fetch side effect status');
          return Errors.internal(reply, 'Failed to fetch side effect status');
        }
      }
    );
  });
}

/**
 * Admin Queue Review Routes
 *
 * Provides admin endpoints for monitoring and managing message delivery
 * across all subsystems (email queue, side effects, WAL, Gmail notifications).
 *
 * Endpoints:
 * - GET  /api/admin/queue/health    — Comprehensive health report
 * - GET  /api/admin/queue/stuck     — All stuck/failed messages for review
 * - POST /api/admin/queue/recover   — Trigger WAL recovery
 * - POST /api/admin/queue/retry/:id — Retry a specific stuck email
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { adminAuthHook } from '../middleware/auth';
import { messageQueueHealthService } from '../services/message-queue-health.service';
import { sideEffectRetryService } from '../services/side-effect-retry.service';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { sendSuccess, Errors } from '../utils/response';

export async function adminQueueReviewRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/admin/queue/health
   * Comprehensive health report across all message delivery subsystems.
   */
  fastify.get(
    '/api/admin/queue/health',
    { ...adminAuthHook },
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
  fastify.get<{ Querystring: { limit?: string } }>(
    '/api/admin/queue/stuck',
    { ...adminAuthHook },
    async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply: FastifyReply) => {
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
  fastify.post(
    '/api/admin/queue/recover',
    { ...adminAuthHook },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const recovered = await messageQueueHealthService.triggerWALRecovery();
        return sendSuccess(reply, { recovered }, {
          message: recovered > 0
            ? `Recovered ${recovered} emails from write-ahead log`
            : 'No entries in write-ahead log to recover',
        });
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
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/queue/retry/:id',
    { ...adminAuthHook },
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
  fastify.get(
    '/api/admin/queue/side-effects',
    { ...adminAuthHook },
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
}

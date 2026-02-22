/**
 * Admin Therapist Routes
 * Flagged therapist management and acknowledgement.
 * Split from admin-dashboard.routes.ts (FIX #10).
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../utils/logger';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { verifyWebhookSecret } from '../middleware/auth';
import { RATE_LIMITS } from '../constants';

export async function adminTherapistRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * GET /api/admin/dashboard/flagged-therapists
   * Get therapists flagged for admin attention (72h inactivity with 2 threads)
   */
  fastify.get(
    '/api/admin/dashboard/flagged-therapists',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Fetching flagged therapists');

      try {
        const flagged = await therapistBookingStatusService.getFlaggedTherapists();

        return reply.send({
          success: true,
          data: flagged,
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch flagged therapists');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch flagged therapists',
        });
      }
    }
  );

  /**
   * POST /api/admin/dashboard/flagged-therapists/:therapistId/acknowledge
   * Acknowledge a flagged therapist alert
   */
  fastify.post<{ Params: { therapistId: string } }>(
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
          data: {
            therapistId,
            acknowledged: true,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, therapistId }, 'Failed to acknowledge flagged therapist');
        return reply.status(500).send({
          success: false,
          error: 'Failed to acknowledge flagged therapist',
        });
      }
    }
  );
}

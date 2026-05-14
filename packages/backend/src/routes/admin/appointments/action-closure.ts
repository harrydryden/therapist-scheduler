/**
 * POST /api/admin/dashboard/appointments/:id/action-closure
 *
 * Admin actions a closure recommendation: either accepts it
 * (cancels the appointment) or dismisses it (resets the chase
 * cycle so the agent can resume).
 *
 * Closure recommendations come from two sources:
 *   1. Chase-recommended (chase-email service)
 *   2. Agent-recommended (recommend_cancel_match tool)
 *
 * Both routes set the same flags; this endpoint actions them
 * uniformly via the lifecycle service.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { appointmentLifecycleService } from '../../../domain/scheduling/lifecycle';
import { recordAppointmentEvent } from '../../../services/appointment-event.service';
import { sendSuccess, Errors } from '../../../utils/response';

export async function actionClosureRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/admin/dashboard/appointments/:id/action-closure',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60000,
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { action: 'cancel' | 'dismiss' };
      }>,
      reply: FastifyReply,
    ) => {
      const requestId = request.id;
      const { id } = request.params;
      const body = (request.body || {}) as { action?: string };
      const action = body.action;
      const adminId = `admin:${request.ip || 'unknown'}`;

      if (!action || !['cancel', 'dismiss'].includes(action)) {
        return Errors.badRequest(reply, 'action must be "cancel" or "dismiss"');
      }

      logger.info(
        { requestId, appointmentId: id, action, adminId },
        'Admin actioning closure recommendation',
      );

      try {
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            closureRecommendedAt: true,
            closureRecommendedReason: true,
            closureRecommendationActioned: true,
            humanControlEnabled: true,
            humanControlTakenBy: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        if (!appointment.closureRecommendedAt) {
          return Errors.badRequest(reply, 'No closure recommendation exists for this appointment');
        }

        if (appointment.closureRecommendationActioned) {
          return Errors.badRequest(reply, 'Closure recommendation already actioned');
        }

        if (action === 'cancel') {
          // Cancel the appointment via lifecycle service.
          await appointmentLifecycleService.transitionToCancelled({
            appointmentId: id,
            reason: `Closed on admin review: ${appointment.closureRecommendedReason || 'closure recommended'}`,
            cancelledBy: 'admin',
            source: 'admin',
            adminId,
          });

          // Mark recommendation as actioned and release agent-flagged
          // human control. Admin-set human control is left alone — the
          // admin opted in explicitly.
          await prisma.appointmentRequest.update({
            where: { id },
            data: {
              closureRecommendationActioned: true,
              ...(appointment.humanControlTakenBy === 'agent-flagged' && {
                humanControlEnabled: false,
              }),
            },
            select: { id: true },
          });

          logger.info(
            { requestId, appointmentId: id, adminId },
            'Admin accepted closure recommendation - appointment cancelled',
          );
        } else {
          const result = await appointmentLifecycleService.dismissClosureRecommendation({
            appointmentId: id,
            source: 'admin',
            adminId,
            reason: 'Admin dismissed closure recommendation',
          });

          if (result.dismissed) {
            await recordAppointmentEvent({
              appointmentId: id,
              type: 'closure_dismissed',
              actor: 'admin',
              reason: 'Admin dismissed closure recommendation',
              payload: {
                adminId,
                previousStage: result.previousStage,
                restoredStage: result.restoredStage,
              },
            });
          }

          logger.info(
            { requestId, appointmentId: id, adminId },
            'Admin dismissed closure recommendation - chase cycle reset',
          );
        }

        return sendSuccess(reply, { action });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to action closure recommendation');
        return Errors.internal(reply, err instanceof Error ? err.message : 'Failed to action closure');
      }
    },
  );
}

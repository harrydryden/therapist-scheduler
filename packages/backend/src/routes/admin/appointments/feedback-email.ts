/**
 * POST /api/admin/dashboard/appointments/:id/send-feedback-email
 *
 * Manually trigger the feedback form email for an appointment.
 * Useful when the automated post-booking-followup tick didn't send
 * (e.g. unparseable confirmedDateTime, admin-created appointment
 * that bypassed the normal lifecycle).
 *
 * Duplicate guard: rejects when `feedbackFormSentAt` is already set,
 * unless `?force=true` is supplied. The lifecycle transition (to
 * `feedback_requested`) still goes through the lifecycle service
 * so the audit trail and SSE notifications fire.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { emailProcessingService } from '../../../services/email-processing.service';
import { appointmentLifecycleService } from '../../../domain/scheduling/lifecycle';
import { buildFeedbackEmailPayload } from '../../../services/feedback-email.helper';
import { sendSuccess, Errors } from '../../../utils/response';

export async function feedbackEmailRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/admin/dashboard/appointments/:id/send-feedback-email',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60000, // 1 minute
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: { force?: string } }>,
      reply: FastifyReply,
    ) => {
      const requestId = request.id;
      const { id } = request.params;
      const force = (request.query as { force?: string }).force === 'true';

      logger.info({ requestId, appointmentId: id, force }, 'Manually triggering feedback email');

      try {
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            userName: true,
            userEmail: true,
            therapistName: true,
            trackingCode: true,
            gmailThreadId: true,
            status: true,
            feedbackFormSentAt: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        // Duplicate guard — prevent resending unless force=true.
        if (appointment.feedbackFormSentAt && !force) {
          return Errors.badRequest(
            reply,
            `Feedback form already sent on ${appointment.feedbackFormSentAt.toISOString()}. Use force=true query parameter to resend.`,
          );
        }

        // A valid feedback link requires a tracking code (the token is bound
        // to it). Without one the shared helper can't build a tokened URL, so
        // reject rather than send a link that can't complete the appointment.
        if (!appointment.trackingCode) {
          return Errors.badRequest(
            reply,
            'Appointment has no tracking code — cannot build a valid feedback link.',
          );
        }

        // Build the tokened email via the shared helper so the link carries a
        // valid `?fk=` token (previously this endpoint sent a tokenless URL,
        // producing anonymous submissions that never completed the appointment).
        const emailPayload = await buildFeedbackEmailPayload(appointment);
        await emailProcessingService.sendEmail(emailPayload);

        // Use lifecycle service for the status transition (audit
        // trail, side effects, feedbackFormSentAt stamp).
        await appointmentLifecycleService.transitionToFeedbackRequested({
          appointmentId: id,
          source: 'admin',
          adminId: `admin:${request.ip || 'unknown'}`,
        });

        logger.info(
          { requestId, appointmentId: id, userEmail: appointment.userEmail },
          'Manually sent feedback form email and transitioned to feedback_requested',
        );

        return sendSuccess(reply, {
          appointmentId: id,
          emailSentTo: appointment.userEmail,
          message: 'Feedback email sent successfully',
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to send feedback email');
        return Errors.internal(reply, 'Failed to send feedback email');
      }
    },
  );
}

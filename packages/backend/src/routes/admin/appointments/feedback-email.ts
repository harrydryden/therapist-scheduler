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
            confirmedDateTimeParsed: true,
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

        // Validate BEFORE sending — a rejection after the email is out would
        // leave the user with a form the system doesn't expect.
        //
        // A valid feedback link requires a tracking code (the token is bound
        // to it). Without one the shared helper can't build a tokened URL, so
        // reject rather than send a link that can't complete the appointment.
        if (!appointment.trackingCode) {
          return Errors.badRequest(
            reply,
            'Appointment has no tracking code — cannot build a valid feedback link.',
          );
        }

        // Status gate: session_held / confirmed transition cleanly;
        // feedback_requested is a re-send (handled below). Completed
        // appointments must go through re-request-feedback (which discards
        // the existing submission and walks the status back); earlier
        // statuses have no session to gather feedback on.
        const status = appointment.status;
        const sendable =
          status === 'session_held' || status === 'confirmed' || status === 'feedback_requested';
        if (!sendable) {
          const hint =
            status === 'completed'
              ? ' Use the re-request-feedback endpoint to discard the existing submission and re-send.'
              : '';
          return Errors.badRequest(
            reply,
            `Cannot send a feedback form for an appointment in status "${status}".${hint}`,
          );
        }

        // Back-fill guard: a confirmed appointment whose session is still in
        // the future must not receive a feedback form (and transitioning it
        // would pull it out of the session-reminder/meeting-link automations).
        if (
          status === 'confirmed' &&
          appointment.confirmedDateTimeParsed &&
          appointment.confirmedDateTimeParsed > new Date()
        ) {
          return Errors.badRequest(
            reply,
            'The session has not happened yet — feedback cannot be requested before the confirmed session time.',
          );
        }

        // Build the tokened email via the shared helper so the link carries a
        // valid `?fk=` token (previously this endpoint sent a tokenless URL,
        // producing anonymous submissions that never completed the appointment).
        const emailPayload = await buildFeedbackEmailPayload(appointment);
        await emailProcessingService.sendEmail(emailPayload);

        // Use lifecycle service for the status transition (audit
        // trail, side effects, feedbackFormSentAt stamp).
        const transition = await appointmentLifecycleService.transitionToFeedbackRequested({
          appointmentId: id,
          source: 'admin',
          adminId: `admin:${request.ip || 'unknown'}`,
        });

        // Already feedback_requested → the transition idempotently skips and
        // does NOT re-stamp feedbackFormSentAt. Stamp it here so the resend is
        // recorded and downstream timers (reminder delay) key off the new send.
        if (transition.skipped) {
          await prisma.appointmentRequest.update({
            where: { id },
            data: { feedbackFormSentAt: new Date() },
            select: { id: true },
          });
        }

        logger.info(
          { requestId, appointmentId: id, userEmail: appointment.userEmail, transitionSkipped: !!transition.skipped },
          transition.skipped
            ? 'Manually re-sent feedback form email (already feedback_requested; re-stamped feedbackFormSentAt)'
            : 'Manually sent feedback form email and transitioned to feedback_requested',
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

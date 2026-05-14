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
import { getEmailSubject, getEmailBody } from '../../../utils/email-templates';
import { firstName } from '../../../utils/first-name';
import { getSettingValue } from '../../../services/settings.service';
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

        // Build feedback form URL. Prefer the trackingCode-scoped URL
        // (per-appointment) over the generic configured URL.
        let feedbackFormUrl: string;
        if (appointment.trackingCode) {
          const webAppUrl = await getSettingValue<string>('weeklyMailing.webAppUrl');
          const baseUrl = webAppUrl.replace(/\/$/, '');
          feedbackFormUrl = `${baseUrl}/feedback/${appointment.trackingCode}`;
        } else {
          feedbackFormUrl = await getSettingValue<string>('postBooking.feedbackFormUrl');
        }

        const userName = firstName(appointment.userName);
        const therapistFirstName = firstName(appointment.therapistName);
        const subject = await getEmailSubject('feedbackForm', {
          therapistName: therapistFirstName,
        });
        const emailBody = await getEmailBody('feedbackForm', {
          userName,
          therapistName: therapistFirstName,
          feedbackFormUrl,
        });

        await emailProcessingService.sendEmail({
          to: appointment.userEmail,
          subject,
          body: emailBody,
          threadId: appointment.gmailThreadId || undefined,
        });

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
          feedbackFormUrl,
          message: 'Feedback email sent successfully',
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to send feedback email');
        return Errors.internal(reply, 'Failed to send feedback email');
      }
    },
  );
}

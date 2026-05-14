/**
 * POST /api/admin/dashboard/appointments/:id/send-message
 *
 * Send a manual email as admin. Requires human control to be
 * enabled (so the agent can't race the admin's send).
 *
 * Security: the recipient must be a participant in this appointment
 * (the user or the therapist). The agent can't be tricked into
 * sending to arbitrary addresses via this path even if an admin
 * supplies one.
 *
 * Audit: records an `admin` message in the conversation state via
 * the optimistic-locked append helper so a concurrent agent save
 * can't silently overwrite it. The email already went out — if the
 * append fails twice we log loudly for manual reconciliation rather
 * than failing the request.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { emailProcessingService } from '../../../services/email-processing.service';
import { aiConversationService } from '../../../services/ai-conversation.service';
import { RATE_LIMITS } from '../../../constants';
import { sendSuccess, Errors } from '../../../utils/response';
import { sendMessageSchema } from './schemas';

export async function sendMessageRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/dashboard/appointments/:id/send-message',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const requestId = request.id;

      const validation = sendMessageSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { to, subject, body, adminId } = validation.data;

      try {
        // PERF: only select fields needed for validation (avoids
        // loading 500KB+ conversationState blob).
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            humanControlEnabled: true,
            userEmail: true,
            therapistEmail: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        if (!appointment.humanControlEnabled) {
          return Errors.badRequest(reply, 'Human control must be enabled before sending manual messages');
        }

        // Validate recipient is a participant in this appointment.
        const validRecipients = [appointment.userEmail, appointment.therapistEmail].map((e) => e.toLowerCase());
        if (!validRecipients.includes(to.toLowerCase())) {
          return Errors.badRequest(reply, 'Email recipient must be either the client or therapist for this appointment');
        }

        const result = await emailProcessingService.sendEmail({
          to,
          subject,
          body,
        });

        // Audit append under optimistic locking — see file-level comment.
        try {
          await aiConversationService.appendConversationMessage(id, {
            role: 'admin',
            content: `[Admin: ${adminId}] Email sent to ${to}:\n\nSubject: ${subject}\n\n${body}`,
          });
        } catch (appendErr) {
          logger.error(
            { err: appendErr, requestId, appointmentId: id, adminId, to },
            'Admin send-message audit append failed twice — manual reconciliation needed (email was sent)',
          );
        }

        logger.info(
          { requestId, appointmentId: id, to, adminId, messageId: result.messageId },
          'Admin email sent successfully',
        );

        return sendSuccess(reply, {
          messageId: result.messageId,
          sentAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to send admin email');
        return Errors.internal(reply, err instanceof Error ? err.message : 'Failed to send email');
      }
    },
  );
}

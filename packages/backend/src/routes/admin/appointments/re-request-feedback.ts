/**
 * POST /api/admin/dashboard/appointments/:id/re-request-feedback
 *
 * Discard an appointment's existing feedback submission (if any) and send a
 * fresh, properly-tokened feedback-form email. For recovering from a feedback
 * form that went out too early or was submitted in error.
 *
 * All the composed work (delete submission → walk status back if needed →
 * send tokened email → transition to feedback_requested) lives in
 * `reRequestFeedback` so the endpoint and the recovery script share behaviour.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../../../utils/logger';
import { reRequestFeedback } from '../../../services/feedback-rerequest.service';
import { AppError } from '../../../errors';
import { sendSuccess, sendError, Errors } from '../../../utils/response';

export async function reRequestFeedbackRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/admin/dashboard/appointments/:id/re-request-feedback',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60000, // 1 minute
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const adminId = `admin:${request.ip || 'unknown'}`;

      logger.info({ requestId: request.id, appointmentId: id }, 'Re-requesting feedback');

      try {
        const result = await reRequestFeedback({ appointmentId: id, adminId });
        return sendSuccess(reply, result, {
          message:
            `Feedback re-requested — discarded ${result.deletedSubmissions} prior ` +
            `submission${result.deletedSubmissions === 1 ? '' : 's'} and re-sent the form.`,
        });
      } catch (err) {
        // Expected validation failures carry an HTTP status + machine code.
        if (err instanceof AppError) {
          return sendError(reply, err.statusCode, err.message, { code: err.code });
        }
        logger.error({ err, requestId: request.id, appointmentId: id }, 'Failed to re-request feedback');
        return Errors.internal(reply, 'Failed to re-request feedback');
      }
    },
  );
}

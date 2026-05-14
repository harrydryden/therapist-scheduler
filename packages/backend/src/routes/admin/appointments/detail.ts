/**
 * GET /api/admin/dashboard/appointments/:id
 *
 * Single-appointment detail with full conversation history and the
 * computed summary block. This IS the endpoint that loads the
 * `conversationState` blob — used by the admin detail drawer to
 * render the full message log.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { buildAppointmentSummary, parseRawConversationState } from '../../../utils/appointment-summary';
import { parseTherapistAvailability } from '../../../utils/json-parser';
import { sendSuccess, Errors } from '../../../utils/response';
import {
  calculateConversationHealth,
  getHealthThresholds,
  toAppointmentForHealth,
} from '../../../services/conversation-health.service';
import { deriveAttentionReasons } from '../../../utils/attention-reasons';

export async function detailRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string } }>(
    '/api/admin/dashboard/appointments/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const requestId = request.id;
      logger.info({ requestId, appointmentId: id }, 'Fetching appointment detail');

      try {
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            trackingCode: true,
            userName: true,
            userEmail: true,
            therapistName: true,
            therapistEmail: true,
            therapistHandle: true,
            therapistAvailability: true,
            status: true,
            confirmedAt: true,
            confirmedDateTime: true,
            notes: true,
            createdAt: true,
            updatedAt: true,
            gmailThreadId: true,
            therapistGmailThreadId: true,
            conversationState: true,
            messageCount: true,
            humanControlEnabled: true,
            humanControlTakenBy: true,
            humanControlTakenAt: true,
            humanControlReason: true,
            lastActivityAt: true,
            isStale: true,
            chaseSentAt: true,
            chaseSentTo: true,
            closureRecommendedAt: true,
            closureRecommendedReason: true,
            closureRecommendationActioned: true,
            // Health-factor fields — needed to derive `attentionReasons`
            // on the summary, which powers the "Why this needs attention"
            // banner on the detail panel.
            reschedulingInProgress: true,
            lastToolExecutedAt: true,
            lastToolExecutionFailed: true,
            lastToolFailureReason: true,
            threadDivergedAt: true,
            threadDivergenceDetails: true,
            threadDivergenceAcknowledged: true,
            conversationStallAlertAt: true,
            conversationStallAcknowledged: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        // Parse raw conversation state once for summary builder.
        const appointmentSummary = buildAppointmentSummary(
          parseRawConversationState(appointment.conversationState),
          appointment,
        );

        // Compute the per-appointment health result and translate
        // its red factors (plus the closure-recommendation signal)
        // into the human-readable "Why this needs attention" reasons
        // surfaced on the detail panel's banner.
        const healthThresholds = await getHealthThresholds();
        const health = calculateConversationHealth(
          toAppointmentForHealth(appointment),
          healthThresholds,
        );
        if (appointmentSummary) {
          appointmentSummary.attentionReasons = deriveAttentionReasons({
            health,
            closureRecommendedAt: appointment.closureRecommendedAt,
            closureRecommendedReason: appointment.closureRecommendedReason,
            closureRecommendationActioned: appointment.closureRecommendationActioned,
          });
        }

        return sendSuccess(reply, {
          id: appointment.id,
          userName: appointment.userName,
          userEmail: appointment.userEmail,
          therapistName: appointment.therapistName,
          therapistEmail: appointment.therapistEmail,
          therapistHandle: appointment.therapistHandle,
          therapistAvailability: parseTherapistAvailability(appointment.therapistAvailability),
          status: appointment.status,
          trackingCode: appointment.trackingCode,
          confirmedAt: appointment.confirmedAt,
          confirmedDateTime: appointment.confirmedDateTime,
          notes: appointment.notes,
          createdAt: appointment.createdAt,
          updatedAt: appointment.updatedAt,
          gmailThreadId: appointment.gmailThreadId,
          therapistGmailThreadId: appointment.therapistGmailThreadId,
          summary: appointmentSummary,
          humanControlEnabled: appointment.humanControlEnabled,
          humanControlTakenBy: appointment.humanControlTakenBy,
          humanControlTakenAt: appointment.humanControlTakenAt,
          humanControlReason: appointment.humanControlReason,
          lastActivityAt: appointment.lastActivityAt,
          isStale: appointment.isStale,
          chaseSentAt: appointment.chaseSentAt,
          chaseSentTo: appointment.chaseSentTo,
          closureRecommendedAt: appointment.closureRecommendedAt,
          closureRecommendedReason: appointment.closureRecommendedReason,
          closureRecommendationActioned: appointment.closureRecommendationActioned,
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to fetch appointment detail');
        return Errors.internal(reply, 'Failed to fetch appointment detail');
      }
    },
  );
}

/**
 * GET /api/admin/dashboard/appointments
 *
 * List appointment requests with filtering, pagination, health-meta
 * decoration, and per-row last-message preview. Powers the admin
 * dashboard's main pipeline view.
 *
 * Reads denormalized columns (`messageCount`, `checkpointStage`)
 * instead of parsing the full 500KB `conversationState` blob (FIX
 * #21). The last-message preview is pulled via a Postgres JSONB
 * path expression so we don't have to load the blob just to render
 * the right-hand snippet column.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { ConversationStage, STAGE_COMPLETION_PERCENTAGE } from '../../../services/conversation-checkpoint.service';
import {
  toAppointmentForHealth,
  computeAppointmentHealthMeta,
  getHealthThresholds,
} from '../../../services/conversation-health.service';
import { sendSuccess, Errors } from '../../../utils/response';
import { buildLastMessagePreview, listAppointmentsSchema } from './schemas';
import { deriveNextAction } from '../../../utils/next-action';

export async function dashboardListRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/admin/dashboard/appointments',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Fetching appointment list for dashboard');

      const validation = listAppointmentsSchema.safeParse(request.query);
      if (!validation.success) {
        return Errors.badRequest(reply, 'Invalid query params', validation.error.errors);
      }

      const { status, therapistId, dateFrom, dateTo, page, limit, sortBy, sortOrder } =
        validation.data;

      const where: Record<string, unknown> = {};
      if (status && status !== 'all') {
        where.status = status;
      }
      if (therapistId) {
        where.therapistHandle = therapistId;
      }
      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) {
          const d = new Date(dateFrom);
          if (isNaN(d.getTime())) return Errors.badRequest(reply, 'Invalid dateFrom format');
          (where.createdAt as Record<string, Date>).gte = d;
        }
        if (dateTo) {
          const d = new Date(dateTo);
          if (isNaN(d.getTime())) return Errors.badRequest(reply, 'Invalid dateTo format');
          (where.createdAt as Record<string, Date>).lte = d;
        }
      }

      try {
        const [appointments, total] = await Promise.all([
          prisma.appointmentRequest.findMany({
            where,
            orderBy: { [sortBy]: sortOrder },
            skip: (page - 1) * limit,
            take: limit,
            select: {
              id: true,
              trackingCode: true,
              userName: true,
              userEmail: true,
              therapistName: true,
              therapistEmail: true,
              therapistHandle: true,
              status: true,
              confirmedAt: true,
              confirmedDateTime: true,
              confirmedDateTimeParsed: true,
              notes: true,
              messageCount: true,
              checkpointStage: true,
              createdAt: true,
              updatedAt: true,
              humanControlEnabled: true,
              humanControlTakenBy: true,
              lastActivityAt: true,
              isStale: true,
              lastToolExecutedAt: true,
              lastToolExecutionFailed: true,
              lastToolFailureReason: true,
              threadDivergedAt: true,
              threadDivergenceDetails: true,
              threadDivergenceAcknowledged: true,
              conversationStallAlertAt: true,
              conversationStallAcknowledged: true,
              chaseSentAt: true,
              chaseSentTo: true,
              closureRecommendedAt: true,
              closureRecommendedReason: true,
              closureRecommendationActioned: true,
              reschedulingInProgress: true,
            },
          }),
          prisma.appointmentRequest.count({ where }),
        ]);

        // Last-message preview per appointment via JSONB path expression —
        // capped at 240 chars at the DB layer so we never load the full blob.
        const lastMessages = appointments.length > 0
          ? await prisma.$queryRaw<Array<{ id: string; role: string | null; content: string | null }>>`
              SELECT id,
                     conversation_state->'messages'->-1->>'role' AS role,
                     LEFT(conversation_state->'messages'->-1->>'content', 240) AS content
              FROM appointment_requests
              WHERE id IN (${Prisma.join(appointments.map((a) => a.id))})
            `
          : [];
        const lastMessageById = new Map(
          lastMessages.map((m) => [m.id, { role: m.role, content: m.content }]),
        );

        const healthThresholds = await getHealthThresholds();
        const appointmentsWithMeta = appointments.map((apt) => {
          const checkpointStage = (apt.checkpointStage as ConversationStage) || null;
          const checkpointProgress = checkpointStage
            ? (STAGE_COMPLETION_PERCENTAGE[checkpointStage] || 0)
            : 0;

          const healthMeta = computeAppointmentHealthMeta(toAppointmentForHealth(apt), healthThresholds);

          return {
            id: apt.id,
            userName: apt.userName,
            userEmail: apt.userEmail,
            therapistName: apt.therapistName,
            therapistEmail: apt.therapistEmail,
            therapistHandle: apt.therapistHandle,
            status: apt.status,
            messageCount: apt.messageCount,
            confirmedAt: apt.confirmedAt,
            confirmedDateTime: apt.confirmedDateTime,
            confirmedDateTimeParsed: apt.confirmedDateTimeParsed,
            notes: apt.notes,
            createdAt: apt.createdAt,
            updatedAt: apt.updatedAt,
            humanControlEnabled: apt.humanControlEnabled,
            humanControlTakenBy: apt.humanControlTakenBy,
            lastActivityAt: apt.lastActivityAt,
            isStale: apt.isStale,
            checkpointStage,
            checkpointProgress,
            ...healthMeta,
            chaseSentAt: apt.chaseSentAt,
            chaseSentTo: apt.chaseSentTo,
            closureRecommendedAt: apt.closureRecommendedAt,
            closureRecommendedReason: apt.closureRecommendedReason,
            closureRecommendationActioned: apt.closureRecommendationActioned,
            reschedulingInProgress: apt.reschedulingInProgress,
            lastMessagePreview: buildLastMessagePreview(lastMessageById.get(apt.id)),
            nextAction: deriveNextAction({
              status: apt.status,
              humanControlEnabled: apt.humanControlEnabled,
              chaseSentAt: apt.chaseSentAt,
              chaseSentTo: apt.chaseSentTo,
              closureRecommendedAt: apt.closureRecommendedAt,
              closureRecommendationActioned: apt.closureRecommendationActioned,
              confirmedDateTime: apt.confirmedDateTime,
              checkpointStage,
            }),
          };
        });

        return sendSuccess(reply, appointmentsWithMeta, {
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch appointments');
        return Errors.internal(reply, 'Failed to fetch appointments');
      }
    },
  );
}

/**
 * GET /api/admin/appointments/all
 *
 * List appointments (including completed/cancelled) with pagination
 * and free-text search across name/email. Powers the admin
 * appointments management page (distinct from the dashboard widget).
 *
 * Supports comma-separated `status` filters (e.g.
 * "pending,contacted,negotiating,confirmed"). Same denormalized-
 * columns optimisation as the dashboard list endpoint — no blob
 * loads at list-time.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { ConversationStage, STAGE_COMPLETION_PERCENTAGE } from '../../../services/conversation-checkpoint.service';
import {
  toAppointmentForHealth,
  computeAppointmentHealthMeta,
  getHealthThresholds,
} from '../../../services/conversation-health.service';
import { sendSuccess, Errors } from '../../../utils/response';
import { listAllAppointmentsSchema } from './schemas';

export async function listAllRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/admin/appointments/all',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Fetching all appointments for admin page');

      const validation = listAllAppointmentsSchema.safeParse(request.query);
      if (!validation.success) {
        return Errors.badRequest(reply, 'Invalid query params', validation.error.errors);
      }

      const { status, search, page, limit, sortBy, sortOrder } = validation.data;

      const where: Record<string, unknown> = {};

      // Status filter: supports comma-separated list.
      if (status && status !== 'all') {
        const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          where.status = statuses[0];
        } else if (statuses.length > 1) {
          where.status = { in: statuses };
        }
      }

      // Search across user name / email / therapist name (case-insensitive).
      if (search && search.trim()) {
        const searchTerm = search.trim();
        where.OR = [
          { userName: { contains: searchTerm, mode: 'insensitive' } },
          { userEmail: { contains: searchTerm, mode: 'insensitive' } },
          { therapistName: { contains: searchTerm, mode: 'insensitive' } },
        ];
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
              reschedulingInProgress: true,
            },
          }),
          prisma.appointmentRequest.count({ where }),
        ]);

        const atsHealthThresholds = await getHealthThresholds();
        const appointmentsWithMeta = appointments.map((apt) => {
          const checkpointStage = (apt.checkpointStage as ConversationStage) || null;
          const checkpointProgress = checkpointStage
            ? (STAGE_COMPLETION_PERCENTAGE[checkpointStage] || 0)
            : 0;
          const healthMeta = computeAppointmentHealthMeta(toAppointmentForHealth(apt), atsHealthThresholds);

          return {
            id: apt.id,
            trackingCode: apt.trackingCode,
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
            reschedulingInProgress: apt.reschedulingInProgress,
            checkpointStage,
            checkpointProgress,
            ...healthMeta,
          };
        });

        return sendSuccess(reply, {
          items: appointmentsWithMeta,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch all appointments');
        return Errors.internal(reply, 'Failed to fetch appointments');
      }
    },
  );
}

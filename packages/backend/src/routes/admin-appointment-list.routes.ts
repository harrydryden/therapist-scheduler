/**
 * Admin Appointment List Routes
 * Endpoints for listing/filtering/searching appointments and related entities.
 * Split from admin-appointments.routes.ts.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { PAGINATION } from '../constants';
import { ConversationStage, STAGE_COMPLETION_PERCENTAGE } from '../utils/conversation-checkpoint';
import { toAppointmentForHealth, computeAppointmentHealthMeta, getHealthThresholds } from '../services/conversation-health.service';
import { sendSuccess, Errors } from '../utils/response';

// Consolidated schema for listing appointments — supports all filter fields from both
// the dashboard and admin management pages.
export const listAppointmentsSchema = z.object({
  status: z.string().optional(), // Comma-separated statuses, single status enum value, or 'all'
  search: z.string().optional(),
  therapistId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.coerce.number().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit: z.coerce.number().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
  sortBy: z.enum(['createdAt', 'updatedAt', 'status']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export async function adminAppointmentListRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/admin/dashboard/appointments
   * List all appointment requests with filtering and pagination
   */
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

      // Build where clause
      const where: Record<string, unknown> = {};

      if (status && status !== 'all') {
        where.status = status;
      }
      if (therapistId) {
        where.therapistNotionId = therapistId;
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
              therapistNotionId: true,
              status: true,
              confirmedAt: true,
              confirmedDateTime: true,
              confirmedDateTimeParsed: true,
              notes: true,
              // FIX #21: Use denormalized columns instead of loading full conversationState blob
              messageCount: true,
              checkpointStage: true,
              createdAt: true,
              updatedAt: true,
              humanControlEnabled: true,
              humanControlTakenBy: true,
              lastActivityAt: true,
              isStale: true,
              // Health-related fields
              lastToolExecutedAt: true,
              lastToolExecutionFailed: true,
              lastToolFailureReason: true,
              threadDivergedAt: true,
              threadDivergenceDetails: true,
              threadDivergenceAcknowledged: true,
              conversationStallAlertAt: true,
              conversationStallAcknowledged: true,
              // Chase & closure recommendation fields
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

        // FIX #21: Use denormalized columns directly — no need to parse the full blob
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
            therapistNotionId: apt.therapistNotionId,
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
            // Chase & closure recommendation data
            chaseSentAt: apt.chaseSentAt,
            chaseSentTo: apt.chaseSentTo,
            closureRecommendedAt: apt.closureRecommendedAt,
            closureRecommendedReason: apt.closureRecommendedReason,
            closureRecommendationActioned: apt.closureRecommendationActioned,
            reschedulingInProgress: apt.reschedulingInProgress,
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
    }
  );

  /**
   * GET /api/admin/appointments/users
   * List all users from PostgreSQL for dropdown population
   */
  fastify.get(
    '/api/admin/appointments/users',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Fetching users for admin appointment creation');

      try {
        const users = await prisma.user.findMany({
          select: {
            id: true,
            email: true,
            name: true,
            odId: true,
          },
          orderBy: { name: 'asc' },
          take: 1000, // Cap results to prevent unbounded queries
        });

        return sendSuccess(reply, users);
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch users');
        return Errors.internal(reply, 'Failed to fetch users');
      }
    }
  );

  /**
   * GET /api/admin/appointments/therapists
   * List all therapists from PostgreSQL for dropdown population
   */
  fastify.get(
    '/api/admin/appointments/therapists',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Fetching therapists for admin appointment creation');

      try {
        const therapists = await prisma.therapist.findMany({
          select: {
            id: true,
            notionId: true,
            email: true,
            name: true,
            odId: true,
          },
          orderBy: { name: 'asc' },
          take: 1000, // Cap results to prevent unbounded queries
        });

        return sendSuccess(reply, therapists);
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch therapists');
        return Errors.internal(reply, 'Failed to fetch therapists');
      }
    }
  );

  /**
   * GET /api/admin/appointments/all
   * List all appointments (including completed/cancelled) with pagination
   * Used by the admin appointments management page
   */
  fastify.get(
    '/api/admin/appointments/all',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Fetching all appointments for admin page');

      const validation = listAppointmentsSchema.safeParse(request.query);
      if (!validation.success) {
        return Errors.badRequest(reply, 'Invalid query params', validation.error.errors);
      }

      const { status, search, page, limit, sortBy, sortOrder } = validation.data;

      // Build where clause
      const where: Record<string, unknown> = {};

      // Status filter: supports comma-separated list (e.g. "pending,contacted,negotiating,confirmed")
      if (status && status !== 'all') {
        const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          where.status = statuses[0];
        } else if (statuses.length > 1) {
          where.status = { in: statuses };
        }
      }

      // Search filter: user name or email
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
              therapistNotionId: true,
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
            therapistNotionId: apt.therapistNotionId,
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

        return sendSuccess(reply, { items: appointmentsWithMeta, pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        } });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch all appointments');
        return Errors.internal(reply, 'Failed to fetch appointments');
      }
    }
  );
}

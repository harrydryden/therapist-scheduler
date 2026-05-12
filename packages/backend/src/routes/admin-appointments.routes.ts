/**
 * Admin Appointment Routes
 * CRUD operations and lifecycle management for appointment requests.
 * Split from admin-dashboard.routes.ts (FIX #10).
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import { emailProcessingService } from '../services/email-processing.service';
import { appointmentLifecycleService, InvalidTransitionError, ConcurrentModificationError } from '../services/appointment-lifecycle.service';
import { recordAppointmentEvent } from '../services/appointment-event.service';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { getEmailSubject, getEmailBody } from '../utils/email-templates';
import { firstName } from '../utils/first-name';
import { getSettingValue } from '../services/settings.service';
import { verifyWebhookSecret } from '../middleware/auth';
import { parseTherapistAvailability } from '../utils/json-parser';
import { aiConversationService } from '../services/ai-conversation.service';
import { PAGINATION, RATE_LIMITS } from '../constants';
import { ConversationStage, STAGE_COMPLETION_PERCENTAGE } from '../services/conversation-checkpoint.service';
import { buildAppointmentSummary, parseRawConversationState } from '../utils/appointment-summary';
import { toAppointmentForHealth, computeAppointmentHealthMeta, getHealthThresholds } from '../services/conversation-health.service';
import { parseConfirmedDateTime } from '../utils/date';
import { AppointmentStatus } from '../constants';
import { sseService } from '../services/sse.service';
import { auditEventService } from '../services/audit-event.service';
import { sendSuccess, sendError, Errors } from '../utils/response';
import { resetAppointmentToolCount } from '../services/appointment-tool-counter';

/**
 * Build the lastMessagePreview field shape from a raw JSONB extraction.
 *
 * The dashboard list endpoint pulls the last conversation message's role
 * and a snippet of its content via Postgres JSONB ops (avoiding a full
 * conversationState blob load). This helper normalises the row into the
 * shape the API returns, collapsing assistant→agent, dropping admin
 * system notes (they're not "messages" in the conversational sense),
 * and trimming whitespace + bracketed system markers from snippets.
 */
function buildLastMessagePreview(
  row: { role: string | null; content: string | null } | undefined,
): { role: 'agent' | 'inbound' | 'admin'; snippet: string } | null {
  if (!row || !row.role || !row.content) return null;
  const trimmed = row.content.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  const role: 'agent' | 'inbound' | 'admin' =
    row.role === 'assistant' ? 'agent' : row.role === 'admin' ? 'admin' : 'inbound';
  return { role, snippet: trimmed };
}

// Schema for listing all appointments (admin page)
const listAllAppointmentsSchema = z.object({
  status: z.string().optional(), // Comma-separated statuses or 'all'
  search: z.string().optional(),
  page: z.coerce.number().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit: z.coerce.number().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
  sortBy: z.enum(['createdAt', 'updatedAt', 'status']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// Query params schema for listing appointments
const listAppointmentsSchema = z.object({
  status: z
    .enum(['pending', 'contacted', 'negotiating', 'confirmed', 'cancelled', 'all'])
    .optional(),
  therapistId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.coerce.number().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit: z.coerce.number().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
  sortBy: z.enum(['createdAt', 'updatedAt', 'status']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const takeControlSchema = z.object({
  adminId: z.string().min(1),
  reason: z.string().optional(),
});

const sendMessageSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  adminId: z.string().min(1),
});

const updateAppointmentSchema = z.object({
  status: z.enum([
    'pending',
    'contacted',
    'negotiating',
    'confirmed',
    'session_held',
    'feedback_requested',
    'completed',
    'cancelled',
  ]).optional(),
  confirmedDateTime: z.string().nullable().optional(),
  adminId: z.string().min(1),
  reason: z.string().optional(),
});

export async function adminAppointmentRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyWebhookSecret);

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

        // Last-message preview per appointment. Pulled via a Postgres JSONB
        // path expression so we don't have to load the whole conversationState
        // blob (the FIX #21 perf optimisation below). Returns { id, role, content }
        // per row; `LEFT(..., 240)` caps the snippet at the DB layer.
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
            // Chase & closure recommendation data
            chaseSentAt: apt.chaseSentAt,
            chaseSentTo: apt.chaseSentTo,
            closureRecommendedAt: apt.closureRecommendedAt,
            closureRecommendedReason: apt.closureRecommendedReason,
            closureRecommendationActioned: apt.closureRecommendationActioned,
            reschedulingInProgress: apt.reschedulingInProgress,
            lastMessagePreview: buildLastMessagePreview(lastMessageById.get(apt.id)),
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
   * GET /api/admin/dashboard/appointments/:id
   * Get single appointment with full conversation history
   */
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
            // Chase & closure recommendation fields
            chaseSentAt: true,
            chaseSentTo: true,
            closureRecommendedAt: true,
            closureRecommendedReason: true,
            closureRecommendationActioned: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        // Parse raw conversation state once for summary builder
        const appointmentSummary = buildAppointmentSummary(
          parseRawConversationState(appointment.conversationState),
          appointment,
        );

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
            // Chase & closure recommendation
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
    }
  );

  /**
   * POST /api/admin/dashboard/appointments/:id/take-control
   * Enable human control for an appointment (pause agent)
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/dashboard/appointments/:id/take-control',
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

      const validation = takeControlSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { adminId, reason } = validation.data;

      try {
        // Atomic claim: only flip the flag when no one currently holds
        // control. Two admins clicking simultaneously can no longer both
        // pass a check-then-write — exactly one updateMany returns count=1,
        // the other returns count=0 and falls into the resolve-by-state
        // branch below.
        const takenAt = new Date();
        const claim = await prisma.appointmentRequest.updateMany({
          where: { id, humanControlEnabled: false },
          data: {
            humanControlEnabled: true,
            humanControlTakenBy: adminId,
            humanControlTakenAt: takenAt,
            humanControlReason: reason || null,
          },
        });

        if (claim.count === 0) {
          // Either the row doesn't exist or someone else already holds
          // control. Re-fetch to distinguish.
          const current = await prisma.appointmentRequest.findUnique({
            where: { id },
            select: { humanControlEnabled: true, humanControlTakenBy: true },
          });

          if (!current) {
            return Errors.notFound(reply, 'Appointment');
          }

          if (current.humanControlEnabled && current.humanControlTakenBy === adminId) {
            // Idempotent: caller already holds control (e.g. retry).
            return sendSuccess(reply, {
              id,
              humanControlEnabled: true,
              humanControlTakenBy: adminId,
              message: 'You already have control of this appointment',
            });
          }

          // Different admin won the race.
          return sendError(
            reply,
            409,
            `This appointment is already being handled by ${current.humanControlTakenBy}`,
          );
        }

        logger.info(
          { requestId, appointmentId: id, adminId, reason },
          'Human control enabled for appointment'
        );

        // Log human_control audit event
        auditEventService.log(id, 'human_control', 'admin', {
          enabled: true,
          adminEmail: adminId,
          reason: reason || 'Manual admin takeover',
        });

        sseService.emitHumanControl(id, true, adminId);

        return sendSuccess(reply, {
          id,
          humanControlEnabled: true,
          humanControlTakenBy: adminId,
          humanControlTakenAt: takenAt,
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to enable human control');
        return Errors.internal(reply, 'Failed to enable human control');
      }
    }
  );

  /**
   * POST /api/admin/dashboard/appointments/:id/release-control
   * Disable human control for an appointment (resume agent)
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/dashboard/appointments/:id/release-control',
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

      try {
        // Append a system note via the optimistic-locked helper so a
        // concurrent agent save / chase-tick can't silently overwrite
        // this audit entry. If the helper fails (twice), the disable
        // below still proceeds — losing the audit entry is preferable
        // to leaving the appointment stuck in human-control state.
        await aiConversationService
          .appendConversationMessage(id, {
            role: 'admin',
            content: '[System] Human control released. Agent resuming automated responses.',
          })
          .catch((err) => {
            logger.error(
              { err, requestId, appointmentId: id },
              'Release-control audit append failed twice — manual reconciliation may be needed',
            );
          });

        const appointment = await prisma.appointmentRequest.update({
          where: { id },
          data: {
            humanControlEnabled: false,
            // Keep history: don't clear humanControlTakenBy/At so the audit
            // trail of who took over and when remains intact.
            // Re-arm the stall-detection / auto-escalation paths so a
            // resolved-then-restalled conversation can escalate again.
            // Without this, autoEscalatedAt stays pinned forever and the
            // stale-check refuses to escalate the second incident.
            autoEscalatedAt: null,
            conversationStallAlertAt: null,
            conversationStallAcknowledged: false,
          },
          select: { id: true },
        });

        logger.info({ requestId, appointmentId: id }, 'Human control released for appointment');

        sseService.emitHumanControl(id, false);

        return sendSuccess(reply, {
            id: appointment.id,
            humanControlEnabled: false,
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to release human control');
        return Errors.internal(reply, 'Failed to release human control');
      }
    }
  );

  // ------------------------------------------------------------------------
  // Bulk-release: appointments paused by the per-appointment tool-call
  // ceiling. The ceiling is a defence-in-depth control that has historically
  // produced false positives on long, legitimate conversations. The count
  // surfaces on the dashboard; the release endpoint unpauses every
  // ceiling-tripped appointment in one operator action, resets each
  // appointment's Redis tool-count key (otherwise the next inbound call
  // re-trips the ceiling on the same counter), and re-arms stall detection.
  //
  // Filter is deliberately narrow: only `humanControlReason` matching
  // 'Tool execution ceiling reached'. Other agent-flag reasons (genuine
  // uncertainty, the loop-level breakers added in #207/#208) are still
  // routed through the per-appointment release-control endpoint so an
  // admin can triage each one.
  // ------------------------------------------------------------------------
  const CEILING_TRIPPED_WHERE = {
    humanControlEnabled: true,
    humanControlTakenBy: 'agent-flagged',
    humanControlReason: { contains: 'Tool execution ceiling reached' },
  } as const;

  /**
   * GET /api/admin/dashboard/ceiling-tripped-count
   * Number of appointments currently paused by the tool-call ceiling.
   */
  fastify.get(
    '/api/admin/dashboard/ceiling-tripped-count',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      try {
        const count = await prisma.appointmentRequest.count({ where: CEILING_TRIPPED_WHERE });
        return sendSuccess(reply, { count });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to count ceiling-tripped appointments');
        return Errors.internal(reply, 'Failed to count ceiling-tripped appointments');
      }
    },
  );

  /**
   * POST /api/admin/dashboard/release-ceiling-tripped
   * Release human control on every ceiling-tripped appointment and reset
   * each one's Redis tool-count key so it doesn't immediately re-trip.
   */
  fastify.post(
    '/api/admin/dashboard/release-ceiling-tripped',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      try {
        const candidates = await prisma.appointmentRequest.findMany({
          where: CEILING_TRIPPED_WHERE,
          select: { id: true },
        });

        const released: string[] = [];
        const failed: Array<{ id: string; reason: string }> = [];

        for (const { id } of candidates) {
          try {
            // Best-effort audit append — same pattern as release-control.
            // Losing the audit entry is preferable to leaving the appointment
            // paused if the conversation append racing fails twice.
            await aiConversationService
              .appendConversationMessage(id, {
                role: 'admin',
                content: '[System] Human control released via bulk ceiling-tripped release. Agent resuming automated responses.',
              })
              .catch((err) => {
                logger.error(
                  { err, requestId, appointmentId: id },
                  'Bulk-release audit append failed — continuing with DB update',
                );
              });

            await prisma.appointmentRequest.update({
              where: { id },
              data: {
                humanControlEnabled: false,
                autoEscalatedAt: null,
                conversationStallAlertAt: null,
                conversationStallAcknowledged: false,
              },
              select: { id: true },
            });

            // Reset the Redis tool-count key — without this, the next tool
            // call on this appointment increments past the ceiling again
            // and re-trips immediately.
            await resetAppointmentToolCount(id);

            sseService.emitHumanControl(id, false);
            released.push(id);
          } catch (err) {
            logger.error(
              { err, requestId, appointmentId: id },
              'Failed to release individual ceiling-tripped appointment',
            );
            failed.push({ id, reason: err instanceof Error ? err.message : 'Unknown error' });
          }
        }

        logger.info(
          { requestId, releasedCount: released.length, failedCount: failed.length },
          'Bulk-release of ceiling-tripped appointments complete',
        );

        return sendSuccess(reply, { released, failed });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to bulk-release ceiling-tripped appointments');
        return Errors.internal(reply, 'Failed to bulk-release ceiling-tripped appointments');
      }
    },
  );

  /**
   * DELETE /api/admin/dashboard/appointments/:id
   * Delete an appointment request entirely
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/dashboard/appointments/:id',
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

      // Parse optional reason from body
      const bodySchema = z.object({
        reason: z.string().optional(),
        adminId: z.string().min(1),
        forceDeleteConfirmed: z.boolean().optional(),
      });

      const validation = bodySchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { reason, adminId, forceDeleteConfirmed } = validation.data;

      try {
        // Get current appointment
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            userEmail: true,
            therapistEmail: true,
            therapistName: true,
            therapistHandle: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        // Don't allow deleting confirmed appointments unless force flag is set
        if (appointment.status === 'confirmed' && !forceDeleteConfirmed) {
          return Errors.badRequest(reply, 'Cannot delete confirmed appointments. Use forceDeleteConfirmed: true if the appointment did not actually take place.');
        }

        const wasConfirmed = appointment.status === 'confirmed';

        // Delete the appointment (PendingEmails will cascade delete)
        await prisma.appointmentRequest.delete({
          where: { id },
        });

        // Recalculate therapist booking status
        if (appointment.therapistHandle) {
          if (wasConfirmed) {
            // Recalculate and unmark in parallel (independent status operations).
            // The previous Notion freeze-mirror has been retired — the
            // Postgres TherapistBookingStatus row is authoritative.
            await Promise.all([
              therapistBookingStatusService.recalculateUniqueRequestCount(appointment.therapistHandle),
              therapistBookingStatusService.unmarkConfirmed(appointment.therapistHandle),
            ]);
          } else {
            await therapistBookingStatusService.recalculateUniqueRequestCount(
              appointment.therapistHandle
            );
          }
        }

        logger.info(
          {
            requestId,
            appointmentId: id,
            adminId,
            reason,
            userEmail: appointment.userEmail,
            therapistName: appointment.therapistName,
          },
          'Appointment deleted by admin'
        );

        return sendSuccess(reply, {
            id,
            message: 'Appointment deleted successfully',
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to delete appointment');
        return Errors.internal(reply, 'Failed to delete appointment');
      }
    }
  );

  /**
   * PATCH /api/admin/dashboard/appointments/:id
   * Update appointment status and/or confirmedDateTime
   * Requires human control to be enabled for the appointment
   */
  fastify.patch<{ Params: { id: string } }>(
    '/api/admin/dashboard/appointments/:id',
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

      const validation = updateAppointmentSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { status: newStatus, confirmedDateTime, adminId, reason } = validation.data;

      try {
        // Get current appointment state (minimal fields for validation)
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            confirmedDateTime: true,
            humanControlEnabled: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        // Require human control to be enabled
        if (!appointment.humanControlEnabled) {
          return Errors.badRequest(reply, 'Human control must be enabled before editing appointment. Take control first.');
        }

        // Validate: if setting status to confirmed, confirmedDateTime is required
        const effectiveConfirmedDateTime = confirmedDateTime ?? appointment.confirmedDateTime;
        if (newStatus === 'confirmed' && !effectiveConfirmedDateTime) {
          return Errors.badRequest(reply, 'confirmedDateTime is required when setting status to confirmed');
        }

        // Require reason whenever the request would mutate state. Matches the
        // strictness of /api/admin/appointments/:id (#215) so the audit trail
        // is consistent across both admin update paths. A no-op call (no
        // status change, no date change) doesn't need a reason.
        const statusChanging = !!newStatus && newStatus !== appointment.status;
        const dateChanging = confirmedDateTime !== undefined && confirmedDateTime !== appointment.confirmedDateTime;
        const reasonProvided = !!reason && reason.trim().length > 0;
        if ((statusChanging || dateChanging) && !reasonProvided) {
          return Errors.badRequest(reply, 'reason is required when editing an appointment');
        }

        // Check for unusual transitions and generate warnings
        let warning: string | undefined;
        const previousStatus = appointment.status;
        const wasConfirmed = previousStatus === 'confirmed';
        const wasCancelled = previousStatus === 'cancelled';

        if (newStatus && newStatus !== previousStatus) {
          if (wasConfirmed && newStatus !== 'cancelled') {
            warning = `Changed from confirmed to ${newStatus}. This may require manual cleanup.`;
          } else if (wasCancelled && newStatus !== 'cancelled') {
            warning = `Restored cancelled appointment to ${newStatus}. Verify this is intentional.`;
          }
        }

        // Parse confirmedDateTime if provided
        let confirmedDateTimeParsed: Date | null = null;
        if (confirmedDateTime) {
          confirmedDateTimeParsed = parseConfirmedDateTime(confirmedDateTime);
          if (confirmedDateTimeParsed) {
            logger.debug({ requestId, appointmentId: id, confirmedDateTime, confirmedDateTimeParsed }, 'Parsed confirmedDateTime for manual update');
          } else {
            logger.warn({ requestId, appointmentId: id, confirmedDateTime }, 'Could not parse confirmedDateTime for manual update');
          }
        }

        // Use the centralized lifecycle service for status updates
        if (newStatus && newStatus !== previousStatus) {
          const result = await appointmentLifecycleService.updateStatus(
            id,
            newStatus as AppointmentStatus,
            {
              source: 'admin',
              adminId,
              reason,
              confirmedDateTime: effectiveConfirmedDateTime || undefined,
              confirmedDateTimeParsed,
              sendEmails: true,
            }
          );

          if (result.skipped) {
            logger.debug({ requestId, appointmentId: id, newStatus }, 'Status transition skipped (idempotent)');
          }
        } else if (confirmedDateTime !== undefined && confirmedDateTime !== appointment.confirmedDateTime) {
          // Only confirmedDateTime changed, not status — use adminForceUpdate for consistency
          // (handles rescheduling flags, audit trail, SSE notifications). Reason is
          // guaranteed non-empty by the pre-flight check above.
          await appointmentLifecycleService.adminForceUpdate(id, {
            confirmedDateTime,
            confirmedDateTimeParsed,
            adminId,
            bypassStateMachine: true,
            reason: reason!,
          });
        }

        // Fetch updated appointment for response
        const updated = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            confirmedDateTime: true,
            confirmedAt: true,
            updatedAt: true,
          },
        });

        logger.info(
          {
            requestId,
            appointmentId: id,
            adminId,
            previousStatus,
            newStatus: updated?.status,
            confirmedDateTime: updated?.confirmedDateTime,
            reason,
          },
          'Appointment updated by admin via lifecycle service'
        );

        return sendSuccess(reply, {
            id: updated?.id,
            status: updated?.status,
            confirmedDateTime: updated?.confirmedDateTime,
            confirmedAt: updated?.confirmedAt,
            updatedAt: updated?.updatedAt,
            previousStatus,
            warning,
        });
      } catch (err) {
        // Surface lifecycle validation errors as 400 (bad request) with descriptive messages
        if (err instanceof InvalidTransitionError) {
          logger.warn({ err, requestId, appointmentId: id }, 'Invalid status transition requested');
          return Errors.badRequest(reply, err.message);
        }
        if (err instanceof ConcurrentModificationError) {
          logger.warn({ err, requestId, appointmentId: id }, 'Concurrent modification detected');
          return sendError(reply, 409, err.message);
        }
        logger.error({ err, requestId, appointmentId: id }, 'Failed to update appointment');
        return Errors.internal(reply, 'Failed to update appointment');
      }
    }
  );

  /**
   * POST /api/admin/dashboard/appointments/:id/send-message
   * Send a manual email as admin (requires human control to be enabled)
   */
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
        // PERF: Only select fields needed for validation (avoids loading 500KB+ conversationState blob)
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

        // Validate recipient is a participant in this appointment (security check)
        const validRecipients = [appointment.userEmail, appointment.therapistEmail].map(e => e.toLowerCase());
        if (!validRecipients.includes(to.toLowerCase())) {
          return Errors.badRequest(reply, 'Email recipient must be either the client or therapist for this appointment');
        }

        // Send the email
        const result = await emailProcessingService.sendEmail({
          to,
          subject,
          body,
        });

        // Add an audit message to the conversation log under optimistic
        // locking so a concurrent agent save / chase-tick / second admin
        // click can't silently overwrite this append. The email already
        // went out — if appendConversationMessage fails twice we log
        // loudly for manual reconciliation rather than failing the
        // request.
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
          'Admin email sent successfully'
        );

        return sendSuccess(reply, {
            messageId: result.messageId,
            sentAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to send admin email');
        return Errors.internal(reply, err instanceof Error ? err.message : 'Failed to send email');
      }
    }
  );

  /**
   * POST /api/admin/dashboard/appointments/:id/send-feedback-email
   * Manually trigger the feedback form email for a specific appointment
   */
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
    async (request: FastifyRequest<{ Params: { id: string }; Querystring: { force?: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const { id } = request.params;
      const force = (request.query as { force?: string }).force === 'true';

      logger.info({ requestId, appointmentId: id, force }, 'Manually triggering feedback email');

      try {
        // Fetch the appointment
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

        // FIX #12: Duplicate guard — prevent resending feedback email unless force=true
        if (appointment.feedbackFormSentAt && !force) {
          return Errors.badRequest(
            reply,
            `Feedback form already sent on ${appointment.feedbackFormSentAt.toISOString()}. Use force=true query parameter to resend.`
          );
        }

        // Build feedback form URL
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

        // Send the email
        await emailProcessingService.sendEmail({
          to: appointment.userEmail,
          subject,
          body: emailBody,
          threadId: appointment.gmailThreadId || undefined,
        });

        // Use lifecycle service for status transition (audit trail, side effects)
        await appointmentLifecycleService.transitionToFeedbackRequested({
          appointmentId: id,
          source: 'admin',
          adminId: `admin:${request.ip || 'unknown'}`,
        });

        logger.info(
          { requestId, appointmentId: id, userEmail: appointment.userEmail },
          'Manually sent feedback form email and transitioned to feedback_requested'
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
    }
  );

  /**
   * POST /api/admin/dashboard/appointments/:id/reprocess-thread
   * Reprocess an appointment's Gmail threads to recover missed messages.
   *
   * Supports three modes via request body:
   * - Preview (dryRun: true): Returns message list showing which are processed vs unprocessed
   * - Safe (default): Only processes messages that were never processed
   * - Force (forceMessageIds: [...]): Clears specific message records first, then reprocesses
   */
  fastify.post(
    '/api/admin/dashboard/appointments/:id/reprocess-thread',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60000,
        },
      },
    },
    async (request: FastifyRequest<{
      Params: { id: string };
      Body: { dryRun?: boolean; forceMessageIds?: string[] };
    }>, reply: FastifyReply) => {
      const requestId = request.id;
      const { id } = request.params;
      const body = (request.body || {}) as { dryRun?: boolean; forceMessageIds?: string[] };
      const { dryRun, forceMessageIds } = body;

      logger.info(
        { requestId, appointmentId: id, dryRun, forceMessageIds },
        dryRun ? 'Admin previewing thread reprocessing' : 'Admin triggered thread reprocessing'
      );

      try {
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            userName: true,
            therapistName: true,
            gmailThreadId: true,
            therapistGmailThreadId: true,
            status: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        if (!appointment.gmailThreadId && !appointment.therapistGmailThreadId) {
          return Errors.badRequest(reply, 'Appointment has no Gmail thread IDs to reprocess');
        }

        const traceId = `${requestId}:admin-reprocess:${id}`;

        // DRY RUN: Preview which messages would be reprocessed
        if (dryRun) {
          const preview: Array<{
            threadId: string;
            type: string;
            messages: Array<{
              messageId: string;
              from: string;
              subject: string;
              date: string;
              status: 'processed' | 'unprocessed';
              snippet: string;
              lastError?: string;
              processedContext?: string;
            }>;
          }> = [];

          if (appointment.therapistGmailThreadId) {
            const result = await emailProcessingService.previewThreadMessages(
              appointment.therapistGmailThreadId,
              traceId
            );
            preview.push({
              threadId: appointment.therapistGmailThreadId,
              type: 'therapist',
              ...result,
            });
          }

          if (appointment.gmailThreadId) {
            const result = await emailProcessingService.previewThreadMessages(
              appointment.gmailThreadId,
              traceId
            );
            preview.push({
              threadId: appointment.gmailThreadId,
              type: 'client',
              ...result,
            });
          }

          const allMessages = preview.flatMap(p => p.messages);
          const unprocessedCount = allMessages.filter(m => m.status === 'unprocessed').length;

          return sendSuccess(reply, {
              appointmentId: id,
              userName: appointment.userName,
              therapistName: appointment.therapistName,
              dryRun: true,
              threads: preview,
              totalMessages: allMessages.length,
              unprocessedCount,
              message: unprocessedCount > 0
                ? `Found ${unprocessedCount} unprocessed message(s) that can be recovered`
                : 'All messages in this thread have already been processed',
          });
        }

        // REPROCESS: Safe or Force mode
        const results: Array<{ threadId: string; type: string; cleared: number; reprocessed: number }> = [];

        if (appointment.therapistGmailThreadId) {
          const result = await emailProcessingService.reprocessThread(
            appointment.therapistGmailThreadId,
            traceId,
            forceMessageIds
          );
          results.push({
            threadId: appointment.therapistGmailThreadId,
            type: 'therapist',
            ...result,
          });
        }

        if (appointment.gmailThreadId) {
          const result = await emailProcessingService.reprocessThread(
            appointment.gmailThreadId,
            traceId,
            forceMessageIds
          );
          results.push({
            threadId: appointment.gmailThreadId,
            type: 'client',
            ...result,
          });
        }

        const totalCleared = results.reduce((sum, r) => sum + r.cleared, 0);
        const totalReprocessed = results.reduce((sum, r) => sum + r.reprocessed, 0);

        logger.info(
          { requestId, appointmentId: id, results, totalCleared, totalReprocessed },
          'Thread reprocessing complete'
        );

        return sendSuccess(reply, {
            appointmentId: id,
            userName: appointment.userName,
            therapistName: appointment.therapistName,
            threads: results,
            totalCleared,
            totalReprocessed,
            message: totalReprocessed > 0
              ? `Recovered ${totalReprocessed} message(s) from ${results.length} thread(s)`
              : totalCleared > 0
              ? `Cleared ${totalCleared} record(s) but no new messages found to process`
              : 'No unprocessed messages found in this thread',
        });
      } catch (err: any) {
        if (err?.code === 404 || err?.status === 404) {
          return Errors.notFound(reply, 'Gmail thread', 'it may have been deleted');
        }
        logger.error({ err, requestId, appointmentId: id }, 'Failed to reprocess thread');
        return Errors.internal(reply, 'Failed to reprocess thread');
      }
    }
  );

  // ============================================
  // Admin Appointments Management Endpoints
  // ============================================

  // Safety cap for admin dropdown queries. The frontend filters client-side
  // so the dropdown UX needs the full list in memory; the cap exists only
  // so a runaway dataset can't OOM the response. Set generously above any
  // realistic workspace size — when we hit it, log a warning so the
  // truncation is visible instead of silent.
  const DROPDOWN_LIMIT = 5000;

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
          take: DROPDOWN_LIMIT,
        });

        if (users.length >= DROPDOWN_LIMIT) {
          logger.warn(
            { requestId, limit: DROPDOWN_LIMIT },
            'User dropdown hit the safety cap — admin sees a truncated list. Time to switch to a typeahead-search endpoint.',
          );
        }

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
          take: DROPDOWN_LIMIT,
        });

        if (therapists.length >= DROPDOWN_LIMIT) {
          logger.warn(
            { requestId, limit: DROPDOWN_LIMIT },
            'Therapist dropdown hit the safety cap — admin sees a truncated list. Time to switch to a typeahead-search endpoint.',
          );
        }

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

      const validation = listAllAppointmentsSchema.safeParse(request.query);
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

  /**
   * PATCH /api/admin/appointments/:id
   * Update appointment status and/or confirmedDateTime from the admin appointments page.
   * Unlike the dashboard PATCH endpoint, this does NOT require human control.
   */
  const adminUpdateSchema = z.object({
    status: z.enum([
      'pending',
      'contacted',
      'negotiating',
      'confirmed',
      'session_held',
      'feedback_requested',
      'completed',
      'cancelled',
    ]).optional(),
    confirmedDateTime: z.string().nullable().optional(),
    adminId: z.string().min(1),
    reason: z.string().optional(),
  });

  fastify.patch<{ Params: { id: string } }>(
    '/api/admin/appointments/:id',
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

      const validation = adminUpdateSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { status: newStatus, confirmedDateTime, adminId, reason } = validation.data;

      try {
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            confirmedDateTime: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        // Validate: if setting status to confirmed, confirmedDateTime is required
        const effectiveConfirmedDateTime = confirmedDateTime ?? appointment.confirmedDateTime;
        if (newStatus === 'confirmed' && !effectiveConfirmedDateTime) {
          return Errors.badRequest(reply, 'confirmedDateTime is required when setting status to confirmed');
        }

        const previousStatus = appointment.status;
        let warning: string | undefined;

        if (newStatus && newStatus !== previousStatus) {
          if (previousStatus === 'cancelled' && newStatus !== 'cancelled') {
            warning = `Restored cancelled appointment to ${newStatus}. Verify this is intentional.`;
          }
        }

        // Parse confirmedDateTime if provided as ISO string
        let confirmedDateTimeParsed: Date | null = null;
        if (confirmedDateTime) {
          // First try as ISO string (from datetime-local input), then fall back to natural language
          const isoDate = new Date(confirmedDateTime);
          if (!isNaN(isoDate.getTime())) {
            confirmedDateTimeParsed = isoDate;
          } else {
            confirmedDateTimeParsed = parseConfirmedDateTime(confirmedDateTime);
          }
        }

        // Use lifecycle service's force update — bypasses state machine validation
        // but still records audit trail, emits SSE notifications, and (for status
        // changes) sends a high-severity Slack alert so the bypass is visible.
        // bypassStateMachine + reason are required by the lifecycle method.
        if (!reason || reason.trim().length === 0) {
          return Errors.badRequest(reply, 'reason is required when force-updating an appointment');
        }
        await appointmentLifecycleService.adminForceUpdate(id, {
          newStatus: newStatus as AppointmentStatus | undefined,
          confirmedDateTime,
          confirmedDateTimeParsed,
          adminId,
          bypassStateMachine: true,
          reason,
        });

        const updated = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            confirmedDateTime: true,
            confirmedDateTimeParsed: true,
            confirmedAt: true,
            updatedAt: true,
          },
        });

        logger.info(
          { requestId, appointmentId: id, adminId, previousStatus, newStatus: updated?.status, confirmedDateTime: updated?.confirmedDateTime, reason },
          'Appointment updated by admin from appointments page'
        );

        return sendSuccess(reply, {
            id: updated?.id,
            status: updated?.status,
            confirmedDateTime: updated?.confirmedDateTime,
            confirmedDateTimeParsed: updated?.confirmedDateTimeParsed,
            confirmedAt: updated?.confirmedAt,
            updatedAt: updated?.updatedAt,
            previousStatus,
            warning,
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to update appointment from admin page');
        const message = err instanceof Error ? err.message : 'Unknown error';
        return Errors.internal(reply, `Failed to update appointment: ${message}`);
      }
    }
  );

  /**
   * POST /api/admin/dashboard/appointments/:id/action-closure
   * Admin actions a closure recommendation: either accepts (cancels) or dismisses it
   */
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
    async (request: FastifyRequest<{
      Params: { id: string };
      Body: { action: 'cancel' | 'dismiss' };
    }>, reply: FastifyReply) => {
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
        'Admin actioning closure recommendation'
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
          // Cancel the appointment via lifecycle service
          await appointmentLifecycleService.transitionToCancelled({
            appointmentId: id,
            reason: `Closed on admin review: ${appointment.closureRecommendedReason || 'closure recommended'}`,
            cancelledBy: 'admin',
            source: 'admin',
            adminId,
          });

          // Mark recommendation as actioned and release human control if agent-flagged
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
            'Admin accepted closure recommendation - appointment cancelled'
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
            'Admin dismissed closure recommendation - chase cycle reset'
          );
        }

        return sendSuccess(reply, { action });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to action closure recommendation');
        return Errors.internal(reply, err instanceof Error ? err.message : 'Failed to action closure');
      }
    }
  );

}
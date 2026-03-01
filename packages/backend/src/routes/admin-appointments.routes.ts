/**
 * Admin Appointment Routes
 * CRUD operations and lifecycle management for appointment requests.
 * Split from admin-dashboard.routes.ts (FIX #10).
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { emailProcessingService } from '../services/email-processing.service';
import { appointmentLifecycleService, InvalidTransitionError, ConcurrentModificationError } from '../services/appointment-lifecycle.service';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { notionSyncManager } from '../services/notion-sync-manager.service';
import { getEmailSubject, getEmailBody } from '../utils/email-templates';
import { getSettingValue } from '../services/settings.service';
import { verifyWebhookSecret } from '../middleware/auth';
import { parseConversationState } from '../utils/json-parser';
import { extractConversationMeta } from '../utils/conversation-meta';
import { PAGINATION, RATE_LIMITS } from '../constants';
import { ConversationStage, STAGE_COMPLETION_PERCENTAGE } from '../utils/conversation-checkpoint';
import { calculateConversationHealth, AppointmentForHealth } from '../services/conversation-health.service';
import { parseConfirmedDateTime } from '../utils/date-parser';
import { AppointmentStatus } from '../constants';
import { sseService } from '../services/sse.service';

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
        return reply.status(400).send({
          success: false,
          error: 'Invalid query params',
          details: validation.error.errors,
        });
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
          if (isNaN(d.getTime())) return reply.status(400).send({ error: 'Invalid dateFrom format' });
          (where.createdAt as Record<string, Date>).gte = d;
        }
        if (dateTo) {
          const d = new Date(dateTo);
          if (isNaN(d.getTime())) return reply.status(400).send({ error: 'Invalid dateTo format' });
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
            },
          }),
          prisma.appointmentRequest.count({ where }),
        ]);

        // FIX #21: Use denormalized columns directly — no need to parse the full blob
        const appointmentsWithMeta = appointments.map((apt) => {
          const messageCount = apt.messageCount;
          const checkpointStage = (apt.checkpointStage as ConversationStage) || null;
          let checkpointProgress = 0;

          if (checkpointStage) {
            try {
              checkpointProgress = STAGE_COMPLETION_PERCENTAGE[checkpointStage] || 0;
            } catch (err) {
              logger.debug({ err, appointmentId: apt.id }, 'Failed to parse checkpoint from conversation state');
            }
          }

          // Calculate health status
          const healthInput: AppointmentForHealth = {
            id: apt.id,
            status: apt.status,
            lastActivityAt: apt.lastActivityAt || apt.updatedAt,
            lastToolExecutedAt: apt.lastToolExecutedAt,
            lastToolExecutionFailed: apt.lastToolExecutionFailed,
            lastToolFailureReason: apt.lastToolFailureReason,
            threadDivergedAt: apt.threadDivergedAt,
            threadDivergenceDetails: apt.threadDivergenceDetails,
            threadDivergenceAcknowledged: apt.threadDivergenceAcknowledged,
            conversationStallAlertAt: apt.conversationStallAlertAt,
            conversationStallAcknowledged: apt.conversationStallAcknowledged,
            humanControlEnabled: apt.humanControlEnabled,
            isStale: apt.isStale,
          };
          const health = calculateConversationHealth(healthInput);

          // Determine if stalled (activity but no tool execution > threshold)
          const isStalled = health.factors.some(
            (f) => f.name === 'Progress' && f.status === 'red'
          );

          // Check for thread divergence and tool failure flags
          const hasThreadDivergence = !!(apt.threadDivergedAt && !apt.threadDivergenceAcknowledged);
          const hasToolFailure = apt.lastToolExecutionFailed;

          return {
            id: apt.id,
            userName: apt.userName,
            userEmail: apt.userEmail,
            therapistName: apt.therapistName,
            therapistEmail: apt.therapistEmail,
            therapistNotionId: apt.therapistNotionId,
            status: apt.status,
            messageCount,
            confirmedAt: apt.confirmedAt,
            confirmedDateTime: apt.confirmedDateTime,
            notes: apt.notes, // Separate field, not conflated with confirmedDateTime
            createdAt: apt.createdAt,
            updatedAt: apt.updatedAt,
            humanControlEnabled: apt.humanControlEnabled,
            humanControlTakenBy: apt.humanControlTakenBy,
            lastActivityAt: apt.lastActivityAt,
            isStale: apt.isStale,
            // Checkpoint data
            checkpointStage,
            checkpointProgress,
            // Health data
            healthStatus: health.status,
            healthScore: health.score,
            isStalled,
            hasThreadDivergence,
            hasToolFailure,
          };
        });

        return reply.send({
          success: true,
          data: appointmentsWithMeta,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch appointments');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch appointments',
        });
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
        });

        if (!appointment) {
          return reply.status(404).send({ success: false, error: 'Appointment not found' });
        }

        // Parse conversation state and extract only latest messages per sender.
        // The full blob stays in the DB for the AI agent — we only trim the API response.
        const fullConversation = parseConversationState(appointment.conversationState);
        let conversationSummary: {
          latestMessages: Array<{ role: string; content: string; senderType: string }>;
          totalMessageCount: number;
        } | null = null;

        if (fullConversation?.messages) {
          const messages = fullConversation.messages;
          // Walk backwards to find the latest message from each sender type.
          // Messages with role 'user' can be from the client or therapist —
          // determined by checking content for "from therapist" / "from user" patterns.
          const latestByType = new Map<string, { role: string; content: string; senderType: string }>();

          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            let senderType: string;

            if (msg.role === 'assistant') {
              senderType = 'agent';
            } else if (msg.role === 'admin') {
              senderType = 'admin';
            } else {
              // role === 'user': determine if from client or therapist
              const content = msg.content.toLowerCase();
              if (content.includes('from therapist') || content.includes('from: therapist')) {
                senderType = 'therapist';
              } else {
                senderType = 'client';
              }
            }

            if (!latestByType.has(senderType)) {
              latestByType.set(senderType, { role: msg.role, content: msg.content, senderType });
            }
          }

          conversationSummary = {
            latestMessages: Array.from(latestByType.values()),
            totalMessageCount: messages.length,
          };
        }

        return reply.send({
          success: true,
          data: {
            id: appointment.id,
            userName: appointment.userName,
            userEmail: appointment.userEmail,
            therapistName: appointment.therapistName,
            therapistEmail: appointment.therapistEmail,
            therapistNotionId: appointment.therapistNotionId,
            therapistAvailability: appointment.therapistAvailability,
            status: appointment.status,
            trackingCode: appointment.trackingCode,
            confirmedAt: appointment.confirmedAt,
            confirmedDateTime: appointment.confirmedDateTime,
            notes: appointment.notes,
            createdAt: appointment.createdAt,
            updatedAt: appointment.updatedAt,
            gmailThreadId: appointment.gmailThreadId,
            therapistGmailThreadId: appointment.therapistGmailThreadId,
            conversation: conversationSummary,
            humanControlEnabled: appointment.humanControlEnabled,
            humanControlTakenBy: appointment.humanControlTakenBy,
            humanControlTakenAt: appointment.humanControlTakenAt,
            humanControlReason: appointment.humanControlReason,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to fetch appointment detail');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch appointment detail',
        });
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
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: validation.error.errors,
        });
      }

      const { adminId, reason } = validation.data;

      try {
        // Check if already in human control to prevent race condition
        const current = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: { humanControlEnabled: true, humanControlTakenBy: true },
        });

        if (!current) {
          return reply.status(404).send({
            success: false,
            error: 'Appointment not found',
          });
        }

        if (current.humanControlEnabled) {
          // Already controlled - check if by same admin
          if (current.humanControlTakenBy === adminId) {
            return reply.send({
              success: true,
              data: {
                id,
                humanControlEnabled: true,
                humanControlTakenBy: adminId,
                message: 'You already have control of this appointment',
              },
            });
          }
          // Different admin already has control
          return reply.status(409).send({
            success: false,
            error: `This appointment is already being handled by ${current.humanControlTakenBy}`,
          });
        }

        const appointment = await prisma.appointmentRequest.update({
          where: { id },
          data: {
            humanControlEnabled: true,
            humanControlTakenBy: adminId,
            humanControlTakenAt: new Date(),
            humanControlReason: reason || null,
          },
        });

        logger.info(
          { requestId, appointmentId: id, adminId, reason },
          'Human control enabled for appointment'
        );

        sseService.emitHumanControl(id, true, adminId);

        return reply.send({
          success: true,
          data: {
            id: appointment.id,
            humanControlEnabled: true,
            humanControlTakenBy: adminId,
            humanControlTakenAt: appointment.humanControlTakenAt,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to enable human control');
        return reply.status(500).send({
          success: false,
          error: 'Failed to enable human control',
        });
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
        // First get the current conversation state to add system note
        const currentAppointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: { conversationState: true },
        });

        // Add system note to conversation about control release
        if (currentAppointment?.conversationState) {
          const state = parseConversationState(currentAppointment.conversationState);
          if (state) {
            state.messages.push({
              role: 'admin',
              content: '[System] Human control released. Agent resuming automated responses.',
            });
            const stateJson = JSON.stringify(state);
            const meta = extractConversationMeta(stateJson);
            await prisma.appointmentRequest.update({
              where: { id },
              data: { conversationState: stateJson, ...meta },
            });
          }
        }

        const appointment = await prisma.appointmentRequest.update({
          where: { id },
          data: {
            humanControlEnabled: false,
            // Keep history: don't clear humanControlTakenBy/At
          },
        });

        logger.info({ requestId, appointmentId: id }, 'Human control released for appointment');

        sseService.emitHumanControl(id, false);

        return reply.send({
          success: true,
          data: {
            id: appointment.id,
            humanControlEnabled: false,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to release human control');
        return reply.status(500).send({
          success: false,
          error: 'Failed to release human control',
        });
      }
    }
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
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: validation.error.errors,
        });
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
            therapistNotionId: true,
          },
        });

        if (!appointment) {
          return reply.status(404).send({
            success: false,
            error: 'Appointment not found',
          });
        }

        // Don't allow deleting confirmed appointments unless force flag is set
        if (appointment.status === 'confirmed' && !forceDeleteConfirmed) {
          return reply.status(400).send({
            success: false,
            error: 'Cannot delete confirmed appointments. Use forceDeleteConfirmed: true if the appointment did not actually take place.',
          });
        }

        const wasConfirmed = appointment.status === 'confirmed';

        // Delete the appointment (PendingEmails will cascade delete)
        await prisma.appointmentRequest.delete({
          where: { id },
        });

        // Recalculate therapist booking status
        if (appointment.therapistNotionId) {
          if (wasConfirmed) {
            // Recalculate and unmark in parallel (independent status operations)
            await Promise.all([
              therapistBookingStatusService.recalculateUniqueRequestCount(appointment.therapistNotionId),
              therapistBookingStatusService.unmarkConfirmed(appointment.therapistNotionId),
            ]);
            // Sync the unfrozen status to Notion (depends on above completing)
            await notionSyncManager.syncSingleTherapist(appointment.therapistNotionId);
          } else {
            await therapistBookingStatusService.recalculateUniqueRequestCount(
              appointment.therapistNotionId
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

        return reply.send({
          success: true,
          data: {
            id,
            message: 'Appointment deleted successfully',
          },
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to delete appointment');
        return reply.status(500).send({
          success: false,
          error: 'Failed to delete appointment',
        });
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
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: validation.error.errors,
        });
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
          return reply.status(404).send({
            success: false,
            error: 'Appointment not found',
          });
        }

        // Require human control to be enabled
        if (!appointment.humanControlEnabled) {
          return reply.status(400).send({
            success: false,
            error: 'Human control must be enabled before editing appointment. Take control first.',
          });
        }

        // Validate: if setting status to confirmed, confirmedDateTime is required
        const effectiveConfirmedDateTime = confirmedDateTime ?? appointment.confirmedDateTime;
        if (newStatus === 'confirmed' && !effectiveConfirmedDateTime) {
          return reply.status(400).send({
            success: false,
            error: 'confirmedDateTime is required when setting status to confirmed',
          });
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
          // Only confirmedDateTime changed, not status
          await prisma.appointmentRequest.update({
            where: { id },
            data: {
              confirmedDateTime,
              confirmedDateTimeParsed,
              updatedAt: new Date(),
            },
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

        return reply.send({
          success: true,
          data: {
            id: updated?.id,
            status: updated?.status,
            confirmedDateTime: updated?.confirmedDateTime,
            confirmedAt: updated?.confirmedAt,
            updatedAt: updated?.updatedAt,
            previousStatus,
            warning,
          },
        });
      } catch (err) {
        // Surface lifecycle validation errors as 400 (bad request) with descriptive messages
        if (err instanceof InvalidTransitionError) {
          logger.warn({ err, requestId, appointmentId: id }, 'Invalid status transition requested');
          return reply.status(400).send({
            success: false,
            error: err.message,
          });
        }
        if (err instanceof ConcurrentModificationError) {
          logger.warn({ err, requestId, appointmentId: id }, 'Concurrent modification detected');
          return reply.status(409).send({
            success: false,
            error: err.message,
          });
        }
        logger.error({ err, requestId, appointmentId: id }, 'Failed to update appointment');
        return reply.status(500).send({
          success: false,
          error: 'Failed to update appointment',
        });
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
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: validation.error.errors,
        });
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
          return reply.status(404).send({
            success: false,
            error: 'Appointment not found',
          });
        }

        if (!appointment.humanControlEnabled) {
          return reply.status(400).send({
            success: false,
            error: 'Human control must be enabled before sending manual messages',
          });
        }

        // Validate recipient is a participant in this appointment (security check)
        const validRecipients = [appointment.userEmail, appointment.therapistEmail].map(e => e.toLowerCase());
        if (!validRecipients.includes(to.toLowerCase())) {
          return reply.status(400).send({
            success: false,
            error: 'Email recipient must be either the client or therapist for this appointment',
          });
        }

        // Send the email
        const result = await emailProcessingService.sendEmail({
          to,
          subject,
          body,
        });

        // Add to conversation state with admin role
        // PERF: Only load conversationState blob after email sent successfully
        const appointmentWithState = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: { conversationState: true },
        });
        if (appointmentWithState?.conversationState) {
          const state = parseConversationState(appointmentWithState.conversationState);
          if (state) {
            state.messages.push({
              role: 'admin',
              content: `[Admin: ${adminId}] Email sent to ${to}:\n\nSubject: ${subject}\n\n${body}`,
            });
            const stateJson = JSON.stringify(state);
            const meta = extractConversationMeta(stateJson);
            await prisma.appointmentRequest.update({
              where: { id },
              data: {
                conversationState: stateJson,
                updatedAt: new Date(),
                ...meta,
              },
            });
          }
        }

        logger.info(
          { requestId, appointmentId: id, to, adminId, messageId: result.messageId },
          'Admin email sent successfully'
        );

        return reply.send({
          success: true,
          data: {
            messageId: result.messageId,
            sentAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to send admin email');
        return reply.status(500).send({
          success: false,
          error: err instanceof Error ? err.message : 'Failed to send email',
        });
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
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const { id } = request.params;

      logger.info({ requestId, appointmentId: id }, 'Manually triggering feedback email');

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
          return reply.status(404).send({
            success: false,
            error: 'Appointment not found',
          });
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

        const userName = appointment.userName || 'there';
        const subject = await getEmailSubject('feedbackForm', {
          therapistName: appointment.therapistName,
        });
        const emailBody = await getEmailBody('feedbackForm', {
          userName,
          therapistName: appointment.therapistName,
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

        return reply.send({
          success: true,
          data: {
            appointmentId: id,
            emailSentTo: appointment.userEmail,
            feedbackFormUrl,
            message: 'Feedback email sent successfully',
          },
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to send feedback email');
        return reply.status(500).send({
          success: false,
          error: 'Failed to send feedback email',
        });
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
          return reply.status(404).send({
            success: false,
            error: 'Appointment not found',
          });
        }

        if (!appointment.gmailThreadId && !appointment.therapistGmailThreadId) {
          return reply.status(400).send({
            success: false,
            error: 'Appointment has no Gmail thread IDs to reprocess',
          });
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

          return reply.send({
            success: true,
            data: {
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
            },
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

        return reply.send({
          success: true,
          data: {
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
          },
        });
      } catch (err: any) {
        if (err?.code === 404 || err?.status === 404) {
          return reply.status(404).send({
            success: false,
            error: 'Gmail thread not found — it may have been deleted',
          });
        }
        logger.error({ err, requestId, appointmentId: id }, 'Failed to reprocess thread');
        return reply.status(500).send({
          success: false,
          error: 'Failed to reprocess thread',
        });
      }
    }
  );

  // ============================================
  // Admin Appointments Management Endpoints
  // ============================================

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
        });

        return reply.send({
          success: true,
          data: users,
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch users');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch users',
        });
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
        });

        return reply.send({
          success: true,
          data: therapists,
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch therapists');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch therapists',
        });
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
        return reply.status(400).send({
          success: false,
          error: 'Invalid query params',
          details: validation.error.errors,
        });
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
            },
          }),
          prisma.appointmentRequest.count({ where }),
        ]);

        const appointmentsWithMeta = appointments.map((apt) => {
          const messageCount = apt.messageCount;
          const checkpointStage = (apt.checkpointStage as ConversationStage) || null;
          let checkpointProgress = 0;

          if (checkpointStage) {
            try {
              checkpointProgress = STAGE_COMPLETION_PERCENTAGE[checkpointStage] || 0;
            } catch (err) {
              logger.debug({ err, appointmentId: apt.id }, 'Failed to parse checkpoint');
            }
          }

          const healthInput: AppointmentForHealth = {
            id: apt.id,
            status: apt.status,
            lastActivityAt: apt.lastActivityAt || apt.updatedAt,
            lastToolExecutedAt: apt.lastToolExecutedAt,
            lastToolExecutionFailed: apt.lastToolExecutionFailed,
            lastToolFailureReason: apt.lastToolFailureReason,
            threadDivergedAt: apt.threadDivergedAt,
            threadDivergenceDetails: apt.threadDivergenceDetails,
            threadDivergenceAcknowledged: apt.threadDivergenceAcknowledged,
            conversationStallAlertAt: apt.conversationStallAlertAt,
            conversationStallAcknowledged: apt.conversationStallAcknowledged,
            humanControlEnabled: apt.humanControlEnabled,
            isStale: apt.isStale,
          };
          const health = calculateConversationHealth(healthInput);

          const isStalled = health.factors.some(
            (f) => f.name === 'Progress' && f.status === 'red'
          );
          const hasThreadDivergence = !!(apt.threadDivergedAt && !apt.threadDivergenceAcknowledged);
          const hasToolFailure = apt.lastToolExecutionFailed;

          return {
            id: apt.id,
            trackingCode: apt.trackingCode,
            userName: apt.userName,
            userEmail: apt.userEmail,
            therapistName: apt.therapistName,
            therapistEmail: apt.therapistEmail,
            therapistNotionId: apt.therapistNotionId,
            status: apt.status,
            messageCount,
            confirmedAt: apt.confirmedAt,
            confirmedDateTime: apt.confirmedDateTime,
            notes: apt.notes,
            createdAt: apt.createdAt,
            updatedAt: apt.updatedAt,
            humanControlEnabled: apt.humanControlEnabled,
            humanControlTakenBy: apt.humanControlTakenBy,
            lastActivityAt: apt.lastActivityAt,
            isStale: apt.isStale,
            checkpointStage,
            checkpointProgress,
            healthStatus: health.status,
            healthScore: health.score,
            isStalled,
            hasThreadDivergence,
            hasToolFailure,
          };
        });

        return reply.send({
          success: true,
          data: appointmentsWithMeta,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch all appointments');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch appointments',
        });
      }
    }
  );

}

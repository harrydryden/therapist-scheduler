/**
 * ATS Integration Routes
 *
 * Clean, versioned API endpoints for the external ATS system to interact with
 * the therapist-scheduler module. All endpoints are authenticated via the same
 * webhook secret header used by admin routes.
 *
 * Endpoint groups:
 * - GET/POST /api/v1/ats/appointments   — Appointment CRUD & listing
 * - GET      /api/v1/ats/feedback       — Feedback submissions & form config
 * - POST     /api/v1/ats/therapists     — Therapist ingestion from ATS
 * - GET      /api/v1/ats/stats          — Dashboard statistics
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';
import { sendSuccess, Errors } from '../utils/response';
import { RATE_LIMITS, PAGINATION } from '../constants';
import { notionService } from '../services/notion.service';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { getOrCreateUser, getOrCreateTherapist } from '../utils/unique-id';
import { getOrCreateTrackingCode } from '../utils/tracking-code';
import { parseTherapistAvailability } from '../utils/json-parser';
import { JustinTimeService } from '../services/justin-time.service';
import { slackNotificationService } from '../services/slack-notification.service';
import { getSettingValue } from '../services/settings.service';
import { runBackgroundTask } from '../utils/background-task';
import { toAppointmentForHealth, computeAppointmentHealthMeta, getHealthThresholds } from '../services/conversation-health.service';
import { STAGE_COMPLETION_PERCENTAGE } from '../utils/conversation-checkpoint';
import { getOrCreateFeedbackFormConfig } from '../utils/feedback-form-config';
import { parseFormQuestions } from '@therapist-scheduler/shared/utils/form-utils';
import type {
  ATSAppointmentRecord,
  ATSFeedbackSubmission,
  ATSTherapistResponse,
  ATSDashboardStats,
  ATSFeedbackFormConfig,
} from '@therapist-scheduler/shared';
import type { HealthStatus, ConversationStage } from '@therapist-scheduler/shared';

// ============================================
// Validation Schemas
// ============================================

const atsAppointmentRequestSchema = z.object({
  userName: z.string().min(1).max(255),
  userEmail: z.string().email().max(320),
  therapistId: z.string().min(1).max(100),
  idempotencyKey: z.string().max(255).optional(),
  notes: z.string().max(5000).optional(),
});

const atsTherapistSchema = z.object({
  externalId: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  email: z.string().email().max(320),
  bio: z.string().max(10000).optional(),
  approach: z.array(z.string().max(100)).max(20).optional(),
  style: z.array(z.string().max(100)).max(20).optional(),
  areasOfFocus: z.array(z.string().max(100)).max(50).optional(),
  availability: z.object({
    timezone: z.string().max(100),
    slots: z.array(z.object({
      day: z.string().max(20),
      start: z.string().max(10),
      end: z.string().max(10),
    })).max(100),
  }).nullable().optional(),
  qualifications: z.array(z.string().max(500)).max(50).optional(),
  profileImageUrl: z.string().url().max(2000).nullable().optional(),
  active: z.boolean().optional(),
});

const atsAppointmentListQuerySchema = z.object({
  status: z.string().optional(),
  therapistEmail: z.string().optional(),
  userEmail: z.string().optional(),
  trackingCode: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  updatedAfter: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'status', 'lastActivityAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

const atsFeedbackListQuerySchema = z.object({
  therapistName: z.string().optional(),
  userEmail: z.string().optional(),
  trackingCode: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

// ============================================
// Helper: Map DB appointment to ATS format
// ============================================

function mapAppointmentToATS(apt: {
  id: string;
  trackingCode: string | null;
  status: string;
  userName: string | null;
  userEmail: string;
  therapistName: string;
  therapistEmail: string;
  therapistNotionId: string;
  confirmedAt: Date | null;
  confirmedDateTime: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  isStale: boolean;
  humanControlEnabled: boolean;
  checkpointStage: string | null;
  notes: string | null;
  chaseSentAt: Date | null;
  chaseSentTo: string | null;
  closureRecommendedAt: Date | null;
  closureRecommendedReason: string | null;
  closureRecommendationActioned: boolean;
  reschedulingInProgress: boolean;
  lastToolExecutedAt: Date | null;
  lastToolExecutionFailed: boolean;
  lastToolFailureReason: string | null;
  threadDivergedAt: Date | null;
  threadDivergenceDetails: string | null;
  threadDivergenceAcknowledged: boolean;
  conversationStallAlertAt: Date | null;
  conversationStallAcknowledged: boolean;
}, healthThresholds?: import('../services/conversation-health.service').HealthThresholds): ATSAppointmentRecord {
  const healthApt = toAppointmentForHealth(apt);
  const healthMeta = computeAppointmentHealthMeta({
    ...healthApt,
    threadDivergedAt: apt.threadDivergedAt,
    threadDivergenceAcknowledged: apt.threadDivergenceAcknowledged,
  }, healthThresholds);

  return {
    id: apt.id,
    trackingCode: apt.trackingCode,
    status: apt.status as ATSAppointmentRecord['status'],
    userName: apt.userName,
    userEmail: apt.userEmail,
    therapistName: apt.therapistName,
    therapistEmail: apt.therapistEmail,
    therapistNotionId: apt.therapistNotionId,
    confirmedAt: apt.confirmedAt?.toISOString() ?? null,
    confirmedDateTime: apt.confirmedDateTime,
    createdAt: apt.createdAt.toISOString(),
    updatedAt: apt.updatedAt.toISOString(),
    lastActivityAt: apt.lastActivityAt.toISOString(),
    isStale: apt.isStale,
    humanControlEnabled: apt.humanControlEnabled,
    checkpointStage: apt.checkpointStage as ConversationStage | null,
    healthStatus: healthMeta.healthStatus,
    notes: apt.notes,
    chaseSentAt: apt.chaseSentAt?.toISOString() ?? null,
    chaseSentTo: apt.chaseSentTo,
    closureRecommendedAt: apt.closureRecommendedAt?.toISOString() ?? null,
    closureRecommendedReason: apt.closureRecommendedReason,
    closureRecommendationActioned: apt.closureRecommendationActioned,
    reschedulingInProgress: apt.reschedulingInProgress,
  };
}

// ============================================
// Helper: Map DB feedback submission to ATS format
// ============================================

function mapFeedbackToATS(s: {
  id: string;
  trackingCode: string | null;
  appointmentRequestId: string | null;
  userEmail: string | null;
  userName: string | null;
  therapistName: string;
  responses: unknown;
  formVersion: number;
  createdAt: Date;
  appointment?: {
    id: string;
    status: string;
    confirmedDateTime: string | null;
    trackingCode: string | null;
  } | null;
}): ATSFeedbackSubmission {
  return {
    id: s.id,
    trackingCode: s.trackingCode,
    appointmentId: s.appointmentRequestId,
    userEmail: s.userEmail,
    userName: s.userName,
    therapistName: s.therapistName,
    responses: s.responses as Record<string, string | number>,
    formVersion: s.formVersion,
    createdAt: s.createdAt.toISOString(),
    appointment: s.appointment ? {
      id: s.appointment.id,
      status: s.appointment.status as ATSFeedbackSubmission['appointment'] extends null ? never : NonNullable<ATSFeedbackSubmission['appointment']>['status'],
      confirmedDateTime: s.appointment.confirmedDateTime,
      trackingCode: s.appointment.trackingCode,
    } : null,
  };
}

// ============================================
// Select fields for appointment queries
// ============================================

const APPOINTMENT_SELECT = {
  id: true,
  trackingCode: true,
  status: true,
  userName: true,
  userEmail: true,
  therapistName: true,
  therapistEmail: true,
  therapistNotionId: true,
  confirmedAt: true,
  confirmedDateTime: true,
  createdAt: true,
  updatedAt: true,
  lastActivityAt: true,
  isStale: true,
  humanControlEnabled: true,
  checkpointStage: true,
  notes: true,
  chaseSentAt: true,
  chaseSentTo: true,
  closureRecommendedAt: true,
  closureRecommendedReason: true,
  closureRecommendationActioned: true,
  reschedulingInProgress: true,
  lastToolExecutedAt: true,
  lastToolExecutionFailed: true,
  lastToolFailureReason: true,
  threadDivergedAt: true,
  threadDivergenceDetails: true,
  threadDivergenceAcknowledged: true,
  conversationStallAlertAt: true,
  conversationStallAcknowledged: true,
} as const;

// ============================================
// Route Registration
// ============================================

export async function atsIntegrationRoutes(fastify: FastifyInstance) {
  // All ATS endpoints require authentication
  fastify.addHook('preHandler', verifyWebhookSecret);

  // ================================================
  // APPOINTMENTS
  // ================================================

  /**
   * GET /api/v1/ats/appointments
   * List appointments with filtering, pagination, and sorting.
   */
  fastify.get<{ Querystring: Record<string, string> }>(
    '/api/v1/ats/appointments',
    async (request, reply) => {
      const requestId = request.id;

      const queryValidation = atsAppointmentListQuerySchema.safeParse(request.query);
      if (!queryValidation.success) {
        return Errors.validationFailed(reply, queryValidation.error.errors);
      }

      const query = queryValidation.data;
      const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
      const limit = Math.min(PAGINATION.MAX_LIMIT, Math.max(1, parseInt(query.limit || '20', 10) || PAGINATION.DEFAULT_LIMIT));
      const skip = (page - 1) * limit;

      // Build where clause
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = {};

      if (query.status) {
        const statuses = query.status.split(',').map(s => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          where.status = statuses[0];
        } else if (statuses.length > 1) {
          where.status = { in: statuses };
        }
      }

      if (query.therapistEmail) {
        where.therapistEmail = { equals: query.therapistEmail, mode: 'insensitive' };
      }

      if (query.userEmail) {
        where.userEmail = { equals: query.userEmail, mode: 'insensitive' };
      }

      if (query.trackingCode) {
        where.trackingCode = query.trackingCode.toUpperCase();
      }

      if (query.createdAfter || query.createdBefore) {
        where.createdAt = {};
        if (query.createdAfter) where.createdAt.gte = new Date(query.createdAfter);
        if (query.createdBefore) where.createdAt.lte = new Date(query.createdBefore);
      }

      if (query.updatedAfter) {
        where.updatedAt = { gte: new Date(query.updatedAfter) };
      }

      // Build orderBy
      const sortBy = query.sortBy || 'createdAt';
      const sortOrder = query.sortOrder || 'desc';
      const orderBy = { [sortBy]: sortOrder };

      try {
        const [appointments, total] = await Promise.all([
          prisma.appointmentRequest.findMany({
            where,
            select: APPOINTMENT_SELECT,
            orderBy,
            skip,
            take: limit,
          }),
          prisma.appointmentRequest.count({ where }),
        ]);

        const ht = await getHealthThresholds();
        const mapped = appointments.map(a => mapAppointmentToATS(a, ht));

        return sendSuccess(reply, {
          appointments: mapped,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'ATS: Failed to list appointments');
        return Errors.internal(reply, 'Failed to list appointments');
      }
    }
  );

  /**
   * GET /api/v1/ats/appointments/:id
   * Get a single appointment by ID or tracking code.
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/ats/appointments/:id',
    async (request, reply) => {
      const { id } = request.params;
      const requestId = request.id;

      try {
        // Try by UUID first, then by tracking code
        let appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: APPOINTMENT_SELECT,
        });

        if (!appointment) {
          appointment = await prisma.appointmentRequest.findFirst({
            where: { trackingCode: id.toUpperCase() },
            select: APPOINTMENT_SELECT,
          });
        }

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        const singleHt = await getHealthThresholds();
        return sendSuccess(reply, mapAppointmentToATS(appointment, singleHt));
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'ATS: Failed to get appointment');
        return Errors.internal(reply, 'Failed to get appointment');
      }
    }
  );

  /**
   * POST /api/v1/ats/appointments
   * Create a new appointment request from the ATS system.
   * Resolves therapist by internal ID, Notion ID, or email.
   */
  fastify.post(
    '/api/v1/ats/appointments',
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

      const validation = atsAppointmentRequestSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { userName, userEmail, therapistId, idempotencyKey, notes } = validation.data;

      // Check idempotency
      if (idempotencyKey) {
        const existing = await prisma.appointmentRequest.findFirst({
          where: { idempotencyKey },
          select: { id: true, status: true, trackingCode: true, createdAt: true },
        });

        if (existing) {
          return sendSuccess(reply, {
            id: existing.id,
            trackingCode: existing.trackingCode,
            status: existing.status,
            deduplicated: true,
          });
        }
      }

      try {
        // Resolve therapist — try Notion ID first, then internal DB ID, then email
        let therapist = await notionService.getTherapist(therapistId);

        if (!therapist) {
          // Try looking up by internal therapist entity — sequential for index efficiency
          const dbTherapist =
            await prisma.therapist.findUnique({ where: { id: therapistId } }) ??
            await prisma.therapist.findFirst({ where: { odId: therapistId } }) ??
            await prisma.therapist.findFirst({ where: { email: { equals: therapistId, mode: 'insensitive' } } });

          if (dbTherapist) {
            therapist = await notionService.getTherapist(dbTherapist.notionId);
          }
        }

        if (!therapist) {
          return Errors.notFound(reply, 'Therapist');
        }

        if (!therapist.email?.trim()) {
          return Errors.badRequest(reply, 'Therapist has no email configured');
        }

        const therapistEmail = therapist.email;
        const therapistName = therapist.name;
        const therapistNotionId = therapist.id;

        // Check therapist availability
        const availabilityStatus = await therapistBookingStatusService.canAcceptNewRequest(
          therapistNotionId,
          userEmail
        );

        if (!availabilityStatus.canAcceptNewRequests) {
          return Errors.badRequest(
            reply,
            availabilityStatus.reason === 'confirmed'
              ? 'Therapist is no longer accepting new appointments'
              : 'Therapist has reached maximum pending requests'
          );
        }

        // Parse availability
        const parsedAvailability = parseTherapistAvailability(therapist.availability);
        const therapistAvailability = parsedAvailability ? JSON.parse(JSON.stringify(parsedAvailability)) : null;

        // Get or create entities
        const [userEntity, therapistEntity] = await Promise.all([
          getOrCreateUser(userEmail, userName),
          getOrCreateTherapist(therapistNotionId, therapistEmail, therapistName),
        ]);

        // Create appointment in serializable transaction
        const appointmentRequest = await prisma.$transaction(
          async (tx) => {
            // Duplicate check
            const existing = await tx.appointmentRequest.findFirst({
              where: {
                userEmail,
                therapistNotionId,
                status: { in: ['pending', 'contacted', 'negotiating'] },
              },
              select: { id: true },
            });

            if (existing) {
              throw new Error('DUPLICATE_REQUEST');
            }

            // Re-check availability inside transaction
            const recheck = await therapistBookingStatusService.canAcceptNewRequest(
              therapistNotionId, userEmail, tx
            );

            if (!recheck.canAcceptNewRequests) {
              throw new Error(`THERAPIST_UNAVAILABLE:${recheck.reason}`);
            }

            const trackingCode = await getOrCreateTrackingCode(userEmail, therapistEmail, tx);

            const newRequest = await tx.appointmentRequest.create({
              data: {
                id: uuidv4(),
                userName,
                userEmail,
                therapistNotionId,
                therapistEmail,
                therapistName,
                therapistAvailability,
                status: 'pending',
                trackingCode,
                idempotencyKey: idempotencyKey || undefined,
                userId: userEntity.id,
                therapistId: therapistEntity.id,
                notes: notes ? `[ATS] ${notes}` : undefined,
              },
            });

            await therapistBookingStatusService.recordNewRequest(
              therapistNotionId, therapistName, userEmail, tx
            );

            return newRequest;
          },
          { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 }
        );

        logger.info(
          { requestId, appointmentId: appointmentRequest.id, trackingCode: appointmentRequest.trackingCode },
          'ATS: Appointment created'
        );

        // Slack notification (non-blocking)
        getSettingValue<boolean>('notifications.slack.requested')
          .then((enabled) => {
            if (enabled !== false) {
              runBackgroundTask(
                () => slackNotificationService.notifyAppointmentCreated(
                  appointmentRequest.id, userName, therapistName, userEmail
                ),
                { name: 'slack-notify-requested', context: { requestId, appointmentId: appointmentRequest.id }, retry: true, maxRetries: 2 }
              );
            }
          })
          .catch(() => {});

        // Start AI scheduling agent (non-blocking)
        const justinTime = new JustinTimeService(requestId);
        justinTime.startScheduling({
          appointmentRequestId: appointmentRequest.id,
          userName,
          userEmail,
          therapistEmail,
          therapistName,
          therapistAvailability,
        }).catch((err) => {
          logger.error({ err, requestId, appointmentId: appointmentRequest.id }, 'ATS: Failed to start scheduling agent');
        });

        return sendSuccess(reply, {
          id: appointmentRequest.id,
          trackingCode: appointmentRequest.trackingCode,
          status: appointmentRequest.status,
          userName,
          userEmail,
          therapistName,
          therapistEmail,
          createdAt: appointmentRequest.createdAt.toISOString(),
        }, { statusCode: 201 });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorMessage === 'DUPLICATE_REQUEST') {
          return Errors.badRequest(reply, 'An active appointment already exists for this user-therapist pair');
        }

        if (errorMessage.startsWith('THERAPIST_UNAVAILABLE:')) {
          return Errors.badRequest(reply, 'Therapist is no longer accepting requests');
        }

        if (errorMessage.includes('could not serialize')) {
          return reply.status(409).send({
            success: false,
            error: 'Concurrent request conflict. Please retry.',
          });
        }

        logger.error({ err, requestId }, 'ATS: Failed to create appointment');
        return Errors.internal(reply, 'Failed to create appointment');
      }
    }
  );

  // ================================================
  // FEEDBACK
  // ================================================

  /**
   * GET /api/v1/ats/feedback/submissions
   * List feedback submissions with filtering and pagination.
   */
  fastify.get<{ Querystring: Record<string, string> }>(
    '/api/v1/ats/feedback/submissions',
    async (request, reply) => {
      const requestId = request.id;

      const queryValidation = atsFeedbackListQuerySchema.safeParse(request.query);
      if (!queryValidation.success) {
        return Errors.validationFailed(reply, queryValidation.error.errors);
      }

      const query = queryValidation.data;
      const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
      const limit = Math.min(PAGINATION.MAX_LIMIT, Math.max(1, parseInt(query.limit || '20', 10) || PAGINATION.DEFAULT_LIMIT));
      const skip = (page - 1) * limit;

      // Build where clause
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = {};

      if (query.therapistName) {
        where.therapistName = { contains: query.therapistName, mode: 'insensitive' };
      }

      if (query.userEmail) {
        where.userEmail = { equals: query.userEmail, mode: 'insensitive' };
      }

      if (query.trackingCode) {
        where.trackingCode = query.trackingCode.toUpperCase();
      }

      if (query.createdAfter || query.createdBefore) {
        where.createdAt = {};
        if (query.createdAfter) where.createdAt.gte = new Date(query.createdAfter);
        if (query.createdBefore) where.createdAt.lte = new Date(query.createdBefore);
      }

      try {
        const [submissions, total] = await Promise.all([
          prisma.feedbackSubmission.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            include: {
              appointment: {
                select: {
                  id: true,
                  status: true,
                  confirmedDateTime: true,
                  trackingCode: true,
                },
              },
            },
          }),
          prisma.feedbackSubmission.count({ where }),
        ]);

        const mapped = submissions.map(mapFeedbackToATS);

        return sendSuccess(reply, {
          submissions: mapped,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'ATS: Failed to list feedback submissions');
        return Errors.internal(reply, 'Failed to list feedback submissions');
      }
    }
  );

  /**
   * GET /api/v1/ats/feedback/submissions/:id
   * Get a single feedback submission by ID.
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/ats/feedback/submissions/:id',
    async (request, reply) => {
      const { id } = request.params;
      const requestId = request.id;

      try {
        const submission = await prisma.feedbackSubmission.findUnique({
          where: { id },
          include: {
            appointment: {
              select: {
                id: true,
                status: true,
                confirmedDateTime: true,
                trackingCode: true,
              },
            },
          },
        });

        if (!submission) {
          return Errors.notFound(reply, 'Feedback submission');
        }

        return sendSuccess(reply, mapFeedbackToATS(submission));
      } catch (err) {
        logger.error({ err, requestId, submissionId: id }, 'ATS: Failed to get feedback submission');
        return Errors.internal(reply, 'Failed to get feedback submission');
      }
    }
  );

  /**
   * GET /api/v1/ats/feedback/form
   * Get the current feedback form configuration.
   */
  fastify.get(
    '/api/v1/ats/feedback/form',
    async (request, reply) => {
      const requestId = request.id;
      try {
        const config = await getOrCreateFeedbackFormConfig();
        if (!config) {
          return Errors.notFound(reply, 'Feedback form config');
        }

        const formConfig: ATSFeedbackFormConfig = {
          formName: config.formName,
          description: config.description,
          questions: parseFormQuestions(config.questions),
          isActive: config.isActive,
          questionsVersion: config.questionsVersion,
          requireExplanationFor: (config.requireExplanationFor as string[]) ?? ['No', 'Unsure'],
        };

        return sendSuccess(reply, formConfig);
      } catch (err) {
        logger.error({ err, requestId }, 'ATS: Failed to get feedback form config');
        return Errors.internal(reply, 'Failed to get feedback form config');
      }
    }
  );

  // ================================================
  // THERAPISTS
  // ================================================

  /**
   * POST /api/v1/ats/therapists
   * Create or update a therapist from ATS data.
   * If a therapist with the same email exists, updates their record.
   */
  fastify.post(
    '/api/v1/ats/therapists',
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

      const validation = atsTherapistSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const data = validation.data;

      try {
        // Check if therapist already exists by email
        const existingTherapist = await prisma.therapist.findFirst({
          where: {
            OR: [
              { email: { equals: data.email, mode: 'insensitive' } },
            ],
          },
        });

        let therapistEntity;

        if (existingTherapist) {
          // Update existing therapist
          therapistEntity = await prisma.therapist.update({
            where: { id: existingTherapist.id },
            data: {
              name: data.name,
              email: data.email,
            },
          });

          logger.info(
            { requestId, therapistId: therapistEntity.id, externalId: data.externalId },
            'ATS: Updated existing therapist'
          );
        } else {
          // Create via Notion ingestion if available, otherwise create DB-only record
          // For now, create in the local database — Notion sync will pick it up
          therapistEntity = await getOrCreateTherapist(
            data.externalId,  // Use external ID as notion ID placeholder
            data.email,
            data.name
          );

          logger.info(
            { requestId, therapistId: therapistEntity.id, externalId: data.externalId },
            'ATS: Created new therapist'
          );
        }

        const response: ATSTherapistResponse = {
          id: therapistEntity.id,
          odId: therapistEntity.odId,
          notionId: therapistEntity.notionId,
          externalId: data.externalId,
          name: therapistEntity.name,
          email: therapistEntity.email,
          active: true,
          createdAt: therapistEntity.createdAt.toISOString(),
          updatedAt: therapistEntity.updatedAt.toISOString(),
        };

        return sendSuccess(reply, response, {
          statusCode: existingTherapist ? 200 : 201,
        });
      } catch (err) {
        logger.error({ err, requestId }, 'ATS: Failed to create/update therapist');
        return Errors.internal(reply, 'Failed to process therapist data');
      }
    }
  );

  /**
   * GET /api/v1/ats/therapists
   * List all therapists known to the scheduler.
   */
  fastify.get(
    '/api/v1/ats/therapists',
    async (request, reply) => {
      const requestId = request.id;

      try {
        const therapists = await prisma.therapist.findMany({
          orderBy: { name: 'asc' },
          select: {
            id: true,
            odId: true,
            notionId: true,
            email: true,
            name: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        // Enrich with booking status
        const enriched = await Promise.all(
          therapists.map(async (t) => {
            const bookingStatus = await therapistBookingStatusService.canAcceptNewRequest(t.notionId, '');
            return {
              id: t.id,
              odId: t.odId,
              notionId: t.notionId,
              email: t.email,
              name: t.name,
              acceptingBookings: bookingStatus.canAcceptNewRequests,
              createdAt: t.createdAt.toISOString(),
              updatedAt: t.updatedAt.toISOString(),
            };
          })
        );

        return sendSuccess(reply, enriched, { count: enriched.length });
      } catch (err) {
        logger.error({ err, requestId }, 'ATS: Failed to list therapists');
        return Errors.internal(reply, 'Failed to list therapists');
      }
    }
  );

  // ================================================
  // STATS
  // ================================================

  /**
   * GET /api/v1/ats/stats
   * Get dashboard statistics for ATS integration.
   */
  fastify.get(
    '/api/v1/ats/stats',
    async (request, reply) => {
      const requestId = request.id;

      try {
        const now = Date.now();
        const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

        const [
          statusCounts,
          totalAppointments,
          confirmedLast7Days,
          confirmedLast30Days,
          totalFeedback,
          recentFeedback,
          confirmedAppointments,
        ] = await Promise.all([
          prisma.appointmentRequest.groupBy({
            by: ['status'],
            _count: { id: true },
          }),
          prisma.appointmentRequest.count(),
          prisma.appointmentRequest.count({
            where: { status: 'confirmed', confirmedAt: { gte: sevenDaysAgo } },
          }),
          prisma.appointmentRequest.count({
            where: { status: 'confirmed', confirmedAt: { gte: thirtyDaysAgo } },
          }),
          prisma.feedbackSubmission.count(),
          prisma.feedbackSubmission.count({
            where: { createdAt: { gte: thirtyDaysAgo } },
          }),
          // For average time to confirm
          prisma.appointmentRequest.findMany({
            where: {
              status: { in: ['confirmed', 'session_held', 'feedback_requested', 'completed'] },
              confirmedAt: { not: null },
            },
            select: { createdAt: true, confirmedAt: true },
            take: 100,
            orderBy: { confirmedAt: 'desc' },
          }),
        ]);

        // Calculate average time to confirm
        let averageTimeToConfirmHours: number | null = null;
        if (confirmedAppointments.length > 0) {
          const totalHours = confirmedAppointments.reduce((sum, apt) => {
            if (apt.confirmedAt) {
              const diffMs = apt.confirmedAt.getTime() - apt.createdAt.getTime();
              return sum + diffMs / (1000 * 60 * 60);
            }
            return sum;
          }, 0);
          averageTimeToConfirmHours = Math.round((totalHours / confirmedAppointments.length) * 10) / 10;
        }

        const stats: ATSDashboardStats = {
          totalAppointments,
          byStatus: Object.fromEntries(statusCounts.map(s => [s.status, s._count.id])),
          confirmedLast7Days,
          confirmedLast30Days,
          averageTimeToConfirmHours,
          feedbackSubmissions: {
            total: totalFeedback,
            last30Days: recentFeedback,
          },
        };

        return sendSuccess(reply, stats);
      } catch (err) {
        logger.error({ err, requestId }, 'ATS: Failed to get stats');
        return Errors.internal(reply, 'Failed to get statistics');
      }
    }
  );

  // ================================================
  // EXPORTS (Bulk data for ATS sync)
  // ================================================

  /**
   * GET /api/v1/ats/export/appointments
   * Export all appointments as JSON for bulk ATS sync.
   * Supports cursor-based incremental sync via `syncCursor` (or `updatedAfter`).
   * The cursor encodes both timestamp and ID to prevent data loss from timestamp collisions.
   */
  fastify.get<{ Querystring: { updatedAfter?: string; syncCursor?: string; limit?: string } }>(
    '/api/v1/ats/export/appointments',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_ENDPOINTS.max,
          timeWindow: RATE_LIMITS.ADMIN_ENDPOINTS.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      const requestId = request.id;
      const { updatedAfter, syncCursor, limit: limitStr } = request.query;
      const limit = Math.min(1000, Math.max(1, parseInt(limitStr || '500', 10) || 500));

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const where: any = {};

        // Parse cursor: "timestamp|id" format for precise pagination
        const cursorValue = syncCursor || updatedAfter;
        if (cursorValue) {
          const [timestampPart, idPart] = cursorValue.split('|');
          const cursorDate = new Date(timestampPart);
          if (isNaN(cursorDate.getTime())) {
            return Errors.badRequest(reply, 'Invalid date format for sync cursor');
          }
          if (idPart) {
            // Cursor with ID tiebreaker: skip records at the exact same timestamp with lower/equal IDs
            where.OR = [
              { updatedAt: { gt: cursorDate } },
              { updatedAt: cursorDate, id: { gt: idPart } },
            ];
          } else {
            // Plain timestamp (first sync or legacy): use gt to avoid re-fetching last record
            where.updatedAt = { gt: cursorDate };
          }
        }

        const appointments = await prisma.appointmentRequest.findMany({
          where,
          select: APPOINTMENT_SELECT,
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: limit,
        });

        const cursorHt = await getHealthThresholds();
        const mapped = appointments.map(a => mapAppointmentToATS(a, cursorHt));
        const lastRecord = appointments.length > 0 ? appointments[appointments.length - 1] : null;
        const nextCursor = lastRecord
          ? `${lastRecord.updatedAt.toISOString()}|${lastRecord.id}`
          : null;

        return sendSuccess(reply, {
          appointments: mapped,
          count: mapped.length,
          hasMore: mapped.length === limit,
          lastUpdatedAt: lastRecord?.updatedAt.toISOString() ?? null,
          syncCursor: nextCursor,
        });
      } catch (err) {
        logger.error({ err, requestId }, 'ATS: Failed to export appointments');
        return Errors.internal(reply, 'Failed to export appointments');
      }
    }
  );

  /**
   * GET /api/v1/ats/export/feedback
   * Export all feedback submissions as JSON for bulk ATS sync.
   * Supports cursor-based incremental sync via `syncCursor` (or `createdAfter`).
   * The cursor encodes both timestamp and ID to prevent data loss from timestamp collisions.
   */
  fastify.get<{ Querystring: { createdAfter?: string; syncCursor?: string; limit?: string } }>(
    '/api/v1/ats/export/feedback',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_ENDPOINTS.max,
          timeWindow: RATE_LIMITS.ADMIN_ENDPOINTS.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      const requestId = request.id;
      const { createdAfter, syncCursor, limit: limitStr } = request.query;
      const limit = Math.min(1000, Math.max(1, parseInt(limitStr || '500', 10) || 500));

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const where: any = {};

        const cursorValue = syncCursor || createdAfter;
        if (cursorValue) {
          const [timestampPart, idPart] = cursorValue.split('|');
          const cursorDate = new Date(timestampPart);
          if (isNaN(cursorDate.getTime())) {
            return Errors.badRequest(reply, 'Invalid date format for sync cursor');
          }
          if (idPart) {
            where.OR = [
              { createdAt: { gt: cursorDate } },
              { createdAt: cursorDate, id: { gt: idPart } },
            ];
          } else {
            where.createdAt = { gt: cursorDate };
          }
        }

        const submissions = await prisma.feedbackSubmission.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: limit,
          include: {
            appointment: {
              select: {
                id: true,
                status: true,
                confirmedDateTime: true,
                trackingCode: true,
              },
            },
          },
        });

        const mapped = submissions.map(mapFeedbackToATS);

        const lastRecord = submissions.length > 0 ? submissions[submissions.length - 1] : null;
        const nextCursor = lastRecord
          ? `${lastRecord.createdAt.toISOString()}|${lastRecord.id}`
          : null;

        return sendSuccess(reply, {
          submissions: mapped,
          count: mapped.length,
          hasMore: mapped.length === limit,
          lastCreatedAt: lastRecord?.createdAt.toISOString() ?? null,
          syncCursor: nextCursor,
        });
      } catch (err) {
        logger.error({ err, requestId }, 'ATS: Failed to export feedback');
        return Errors.internal(reply, 'Failed to export feedback');
      }
    }
  );
}

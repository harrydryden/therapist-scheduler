import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { JustinTimeService } from '../services/justin-time.service';
import { notionService } from '../services/notion.service';
import { notionUsersService } from '../services/notion-users.service';
import { slackNotificationService } from '../services/slack-notification.service';
import { adminAuthHook } from '../middleware/auth';
import { sendSuccess, Errors } from '../utils/response';
import { parseTherapistAvailability } from '../utils/json-parser';
import { getOrCreateTrackingCode } from '../utils/tracking-code';
import { getOrCreateUser, getOrCreateTherapist } from '../utils/unique-id';

// FIX M2: Add max length constraints to prevent memory exhaustion
const MAX_NAME_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320; // RFC 5321 max
const MAX_NOTION_ID_LENGTH = 64;

// Validation schema for appointment request
const appointmentRequestSchema = z.object({
  userName: z.string().min(1, 'Name is required').max(MAX_NAME_LENGTH),
  userEmail: z.string().email('Invalid email address').max(MAX_EMAIL_LENGTH),
  therapistNotionId: z.string().min(1, 'Therapist ID is required').max(MAX_NOTION_ID_LENGTH),
  therapistEmail: z.string().email('Invalid therapist email').max(MAX_EMAIL_LENGTH),
  therapistName: z.string().min(1, 'Therapist name is required').max(MAX_NAME_LENGTH),
  therapistAvailability: z.any().optional(),
});

type AppointmentRequestBody = z.infer<typeof appointmentRequestSchema>;

export async function webhookRoutes(fastify: FastifyInstance) {
  // POST /api/webhooks/appointment-request - Handle new appointment request
  fastify.post<{ Body: AppointmentRequestBody }>(
    '/api/webhooks/appointment-request',
    { ...adminAuthHook },
    async (request: FastifyRequest<{ Body: AppointmentRequestBody }>, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Received appointment request webhook');

      // Validate request body
      const validation = appointmentRequestSchema.safeParse(request.body);
      if (!validation.success) {
        logger.warn({ requestId, errors: validation.error.errors }, 'Invalid request body');
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { userName, userEmail, therapistNotionId, therapistEmail, therapistName } = validation.data;

      try {
        // Fetch therapist from Notion to get current availability
        const therapist = await notionService.getTherapist(therapistNotionId);
        // FIX M1: Validate therapist availability with schema before storing
        const therapistAvailability = parseTherapistAvailability(therapist?.availability);
        const hasAvailability = therapistAvailability && therapistAvailability.slots && therapistAvailability.slots.length > 0;

        if (therapist?.availability && !therapistAvailability) {
          logger.warn(
            { requestId, therapistNotionId },
            'Therapist availability from Notion failed schema validation - storing as null'
          );
        }

        logger.info(
          { requestId, therapistNotionId, hasAvailability },
          'Fetched therapist availability from Notion'
        );

        // Get or create User and Therapist entities with unique 10-digit IDs
        const [userEntity, therapistEntity] = await Promise.all([
          getOrCreateUser(userEmail, userName),
          getOrCreateTherapist(therapistNotionId, therapistEmail, therapistName),
        ]);

        // FIX #5: Wrap tracking code generation + appointment creation in a Serializable
        // transaction to prevent TOCTOU race on tracking code sequence numbers.
        const appointmentRequest = await prisma.$transaction(
          async (tx) => {
            const trackingCode = await getOrCreateTrackingCode(userEmail, therapistEmail, tx);

            return tx.appointmentRequest.create({
              data: {
                id: uuidv4(),
                userName,
                userEmail,
                therapistNotionId,
                therapistEmail,
                therapistName,
                therapistAvailability: therapistAvailability as unknown as Prisma.InputJsonValue ?? Prisma.JsonNull,
                status: 'pending',
                trackingCode,
                userId: userEntity.id,
                therapistId: therapistEntity.id,
              },
            });
          },
          { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 }
        );

        logger.info(
          {
            requestId,
            appointmentRequestId: appointmentRequest.id,
            userEmail,
            therapistName,
            hasAvailability,
            trackingCode: appointmentRequest.trackingCode,
          },
          'Appointment request created with tracking code'
        );

        // Send Slack notification for new appointment (non-blocking)
        slackNotificationService.notifyAppointmentCreated(
          appointmentRequest.id,
          userName,
          therapistName,
          userEmail
        ).catch((err) => {
          logger.error({ err, requestId }, 'Failed to send Slack notification for new appointment');
        });

        // Ensure user exists in Notion users database (non-blocking)
        // This adds the user on their first booking request, not just after confirmation
        notionUsersService.ensureUserExists({ email: userEmail, name: userName }).catch((err) => {
          logger.error({ err, requestId, userEmail }, 'Failed to ensure user exists in Notion (non-critical)');
        });

        // Trigger Justin Time agent asynchronously
        const justinTime = new JustinTimeService(requestId);
        justinTime
          .startScheduling({
            appointmentRequestId: appointmentRequest.id,
            userName,
            userEmail,
            therapistEmail,
            therapistName,
            // FIX M1: Convert validated availability to Record<string, unknown> for SchedulingContext
            therapistAvailability: therapistAvailability as unknown as Record<string, unknown> | null,
          })
          .then(() => {
            logger.info(
              { requestId, appointmentRequestId: appointmentRequest.id },
              'Justin Time scheduling started successfully'
            );
          })
          .catch((err) => {
            logger.error(
              { err, requestId, appointmentRequestId: appointmentRequest.id },
              'Failed to start Justin Time scheduling'
            );
          });

        return sendSuccess(reply, {
          appointmentRequestId: appointmentRequest.id,
          status: appointmentRequest.status,
          message: 'Appointment request received. You will receive an email shortly.',
        }, { statusCode: 201 });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to create appointment request');
        return Errors.internal(reply, 'Failed to process appointment request');
      }
    }
  );

  // GET /api/webhooks/appointment-request/:id/status - Check appointment status
  fastify.get<{ Params: { id: string } }>(
    '/api/webhooks/appointment-request/:id/status',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const requestId = request.id;
      logger.info({ requestId, appointmentRequestId: id }, 'Checking appointment status');

      try {
        const appointmentRequest = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        if (!appointmentRequest) {
          return Errors.notFound(reply, 'Appointment request');
        }

        return sendSuccess(reply, appointmentRequest);
      } catch (err) {
        logger.error({ err, requestId, appointmentRequestId: id }, 'Failed to fetch appointment status');
        return Errors.internal(reply, 'Failed to fetch appointment status');
      }
    }
  );
}

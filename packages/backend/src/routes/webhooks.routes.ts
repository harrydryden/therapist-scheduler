/**
 * Legacy Webhook Routes (Deprecated)
 *
 * These endpoints are superseded by the ATS integration routes at /api/v1/ats/*.
 * Maintained for backward compatibility during migration.
 *
 * - POST /api/webhooks/appointment-request → Use POST /api/v1/ats/appointments
 * - GET  /api/webhooks/appointment-request/:id/status → Use GET /api/v1/ats/appointments/:id
 */

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
import { runBackgroundTask } from '../utils/background-task';
import { getSettingValue } from '../services/settings.service';
import { adminAuthHook } from '../middleware/auth';
import { sendSuccess, Errors } from '../utils/response';
import { parseTherapistAvailability } from '../utils/json-parser';
import { getOrCreateTrackingCode } from '../utils/tracking-code';
import { getOrCreateUser, getOrCreateTherapist } from '../utils/unique-id';

const MAX_NAME_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;
const MAX_NOTION_ID_LENGTH = 64;

const appointmentRequestSchema = z.object({
  userName: z.string().min(1, 'Name is required').max(MAX_NAME_LENGTH),
  userEmail: z.string().email('Invalid email address').max(MAX_EMAIL_LENGTH),
  therapistNotionId: z.string().min(1, 'Therapist ID is required').max(MAX_NOTION_ID_LENGTH),
  therapistEmail: z.string().email('Invalid therapist email').max(MAX_EMAIL_LENGTH),
  therapistName: z.string().min(1, 'Therapist name is required').max(MAX_NAME_LENGTH),
  therapistAvailability: z.any().optional(),
});

type AppointmentRequestBody = z.infer<typeof appointmentRequestSchema>;

/**
 * @deprecated Use ATS integration routes at /api/v1/ats/* instead.
 * These routes are maintained for backward compatibility during migration.
 */
export async function webhookRoutes(fastify: FastifyInstance) {
  // POST /api/webhooks/appointment-request
  // @deprecated — Use POST /api/v1/ats/appointments
  fastify.post<{ Body: AppointmentRequestBody }>(
    '/api/webhooks/appointment-request',
    { ...adminAuthHook },
    async (request: FastifyRequest<{ Body: AppointmentRequestBody }>, reply: FastifyReply) => {
      const requestId = request.id;
      logger.warn({ requestId }, 'Deprecated endpoint called: POST /api/webhooks/appointment-request — migrate to POST /api/v1/ats/appointments');

      const validation = appointmentRequestSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { userName, userEmail, therapistNotionId, therapistEmail, therapistName } = validation.data;

      try {
        const therapist = await notionService.getTherapist(therapistNotionId);
        const therapistAvailability = parseTherapistAvailability(therapist?.availability);

        const [userEntity, therapistEntity] = await Promise.all([
          getOrCreateUser(userEmail, userName),
          getOrCreateTherapist(therapistNotionId, therapistEmail, therapistName),
        ]);

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

        // Non-blocking side effects
        getSettingValue<boolean>('notifications.slack.requested')
          .then((enabled) => {
            if (enabled !== false) {
              runBackgroundTask(
                () => slackNotificationService.notifyAppointmentCreated(appointmentRequest.id, userName, therapistName, userEmail),
                { name: 'slack-notify-requested', context: { requestId, appointmentId: appointmentRequest.id }, retry: true, maxRetries: 2 }
              );
            }
          })
          .catch(() => {});

        notionUsersService.ensureUserExists({ email: userEmail, name: userName }).catch(() => {});

        const justinTime = new JustinTimeService(requestId);
        justinTime.startScheduling({
          appointmentRequestId: appointmentRequest.id,
          userName,
          userEmail,
          therapistEmail,
          therapistName,
          therapistAvailability: therapistAvailability as unknown as Record<string, unknown> | null,
        }).catch((err) => {
          logger.error({ err, requestId, appointmentRequestId: appointmentRequest.id }, 'Failed to start scheduling');
        });

        // Include deprecation notice in response
        reply.header('Deprecation', 'true');
        reply.header('Link', '</api/v1/ats/appointments>; rel="successor-version"');

        return sendSuccess(reply, {
          appointmentRequestId: appointmentRequest.id,
          status: appointmentRequest.status,
          message: 'Appointment request received. You will receive an email shortly.',
          _deprecation: 'This endpoint is deprecated. Migrate to POST /api/v1/ats/appointments',
        }, { statusCode: 201 });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to create appointment request');
        return Errors.internal(reply, 'Failed to process appointment request');
      }
    }
  );

  // GET /api/webhooks/appointment-request/:id/status
  // @deprecated — Use GET /api/v1/ats/appointments/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/webhooks/appointment-request/:id/status',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const requestId = request.id;

      logger.warn({ requestId }, 'Deprecated endpoint called: GET /api/webhooks/appointment-request/:id/status — migrate to GET /api/v1/ats/appointments/:id');

      try {
        const appointmentRequest = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: { id: true, status: true, createdAt: true, updatedAt: true },
        });

        if (!appointmentRequest) {
          return Errors.notFound(reply, 'Appointment request');
        }

        reply.header('Deprecation', 'true');
        reply.header('Link', `</api/v1/ats/appointments/${id}>; rel="successor-version"`);

        return sendSuccess(reply, appointmentRequest);
      } catch (err) {
        logger.error({ err, requestId, appointmentRequestId: id }, 'Failed to fetch appointment status');
        return Errors.internal(reply, 'Failed to fetch appointment status');
      }
    }
  );
}

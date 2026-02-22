/**
 * Admin Appointment Create Route
 * Isolated from admin-appointments.routes.ts to prevent heavy imports
 * (Notion, JustinTime, etc.) from breaking existing routes if they fail to load.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { appointmentLifecycleService } from '../services/appointment-lifecycle.service';
import { verifyWebhookSecret } from '../middleware/auth';
import { parseConfirmedDateTime } from '../utils/date-parser';
import { AppointmentStatus, APPOINTMENT_STATUS, RATE_LIMITS } from '../constants';
import { notionService } from '../services/notion.service';
import { getOrCreateUser, getOrCreateTherapist } from '../utils/unique-id';
import { getOrCreateTrackingCode } from '../utils/tracking-code';
import { JustinTimeService } from '../services/justin-time.service';
import { parseTherapistAvailability } from '../utils/json-parser';

const createAppointmentSchema = z.object({
  userEmail: z.string().email('Invalid email address').max(255),
  userName: z.string().min(1, 'Name is required').max(100),
  therapistNotionId: z.string().min(1, 'Therapist ID is required').max(100),
  stage: z.enum(['confirmed', 'session_held', 'feedback_requested']),
  confirmedDateTime: z.string().min(1, 'Appointment date/time is required'),
  adminId: z.string().min(1, 'Admin ID is required'),
  notes: z.string().optional(),
});

export async function adminAppointmentCreateRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * POST /api/admin/appointments/create
   * Manually create an appointment between a user and therapist at a specific stage.
   * Generates tracking code, walks through lifecycle transitions, triggers Slack notifications,
   * and starts the JustinTime AI agent.
   */
  fastify.post(
    '/api/admin/appointments/create',
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
      logger.info({ requestId }, 'Admin creating appointment manually');

      const validation = createAppointmentSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: validation.error.errors,
        });
      }

      const { userEmail, userName, therapistNotionId, stage, confirmedDateTime, adminId, notes } = validation.data;

      try {
        // 1. Fetch therapist from Notion (trusted source for email and name)
        const therapist = await notionService.getTherapist(therapistNotionId);
        if (!therapist) {
          return reply.status(404).send({
            success: false,
            error: 'Therapist not found in Notion',
          });
        }

        const therapistEmail = therapist.email;
        const therapistName = therapist.name;

        if (!therapistEmail || therapistEmail.trim() === '') {
          return reply.status(400).send({
            success: false,
            error: 'Therapist has no email configured in Notion',
          });
        }

        // 2. Get or create User and Therapist entities with unique IDs
        const [userEntity, therapistEntity] = await Promise.all([
          getOrCreateUser(userEmail, userName),
          getOrCreateTherapist(therapistNotionId, therapistEmail, therapistName),
        ]);

        // 3. Parse confirmed date/time
        const confirmedDateTimeParsed = parseConfirmedDateTime(confirmedDateTime);

        // 4. Parse therapist availability
        const parsedAvailability = parseTherapistAvailability(therapist.availability);
        const therapistAvailability = parsedAvailability ? JSON.parse(JSON.stringify(parsedAvailability)) : null;

        // 5. Create appointment inside Serializable transaction
        const appointmentRequest = await prisma.$transaction(
          async (tx) => {
            // Generate tracking code inside transaction to prevent duplicates
            const trackingCode = await getOrCreateTrackingCode(userEmail, therapistEmail, tx);

            // Create the appointment record at 'pending' status
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
                userId: userEntity.id,
                therapistId: therapistEntity.id,
                confirmedDateTime,
                confirmedDateTimeParsed,
                notes: notes ? `[Admin: ${adminId}] ${notes}` : `[Admin: ${adminId}] Manually created appointment`,
              },
            });

            return newRequest;
          },
          {
            isolationLevel: 'Serializable',
            maxWait: 5000,
            timeout: 10000,
          }
        );

        logger.info(
          {
            requestId,
            appointmentId: appointmentRequest.id,
            trackingCode: appointmentRequest.trackingCode,
            userEmail,
            therapistName,
            stage,
          },
          'Admin appointment created, walking through lifecycle transitions'
        );

        // 6. Walk through lifecycle transitions up to the target stage
        // pending → contacted → negotiating → confirmed → session_held → feedback_requested
        const stageOrder: AppointmentStatus[] = [
          APPOINTMENT_STATUS.CONTACTED,
          APPOINTMENT_STATUS.NEGOTIATING,
          APPOINTMENT_STATUS.CONFIRMED,
        ];

        // Add later stages if needed
        if (stage === 'session_held' || stage === 'feedback_requested') {
          stageOrder.push(APPOINTMENT_STATUS.SESSION_HELD);
        }
        if (stage === 'feedback_requested') {
          stageOrder.push(APPOINTMENT_STATUS.FEEDBACK_REQUESTED);
        }

        for (const targetStatus of stageOrder) {
          try {
            await appointmentLifecycleService.updateStatus(
              appointmentRequest.id,
              targetStatus,
              {
                source: 'admin',
                adminId,
                reason: `Admin-created appointment (target stage: ${stage})`,
                confirmedDateTime: targetStatus === APPOINTMENT_STATUS.CONFIRMED ? confirmedDateTime : undefined,
                confirmedDateTimeParsed: targetStatus === APPOINTMENT_STATUS.CONFIRMED ? confirmedDateTimeParsed : undefined,
                sendEmails: false, // Don't send emails during rapid transitions
              }
            );
          } catch (transitionErr) {
            logger.warn(
              { err: transitionErr, requestId, appointmentId: appointmentRequest.id, targetStatus },
              'Lifecycle transition warning during admin appointment creation'
            );
            // Continue to next transition — some may be skipped (idempotent)
          }
        }

        // 7. Start JustinTime agent asynchronously
        const justinTime = new JustinTimeService(requestId);
        justinTime
          .startScheduling({
            appointmentRequestId: appointmentRequest.id,
            userName,
            userEmail,
            therapistEmail,
            therapistName,
            therapistAvailability,
          })
          .then(() => {
            logger.info(
              { requestId, appointmentId: appointmentRequest.id },
              'JustinTime agent started for admin-created appointment'
            );
          })
          .catch(async (err) => {
            logger.error(
              { err, requestId, appointmentId: appointmentRequest.id },
              'Failed to start JustinTime for admin-created appointment (non-critical — appointment already created)'
            );
          });

        // Fetch final state
        const finalAppointment = await prisma.appointmentRequest.findUnique({
          where: { id: appointmentRequest.id },
          select: {
            id: true,
            trackingCode: true,
            status: true,
            confirmedDateTime: true,
          },
        });

        return reply.status(201).send({
          success: true,
          data: {
            id: finalAppointment?.id || appointmentRequest.id,
            trackingCode: finalAppointment?.trackingCode || appointmentRequest.trackingCode,
            status: finalAppointment?.status || stage,
            confirmedDateTime: finalAppointment?.confirmedDateTime || confirmedDateTime,
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to create admin appointment');
        return reply.status(500).send({
          success: false,
          error: 'Failed to create appointment',
        });
      }
    }
  );
}

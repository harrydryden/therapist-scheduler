import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { JustinTimeService } from '../services/justin-time.service';
import { notionService } from '../services/notion.service';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { notionUsersService } from '../services/notion-users.service';
import { slackNotificationService } from '../services/slack-notification.service';
import { notionSyncManager } from '../services/notion-sync-manager.service';
import { RATE_LIMITS } from '../constants';
import { parseTherapistAvailability } from '../utils/json-parser';
import { emailQueueService } from '../services/email-queue.service';
import { validateEmail, checkForTypos } from '../utils/email-validator';
import { getSettingValue, SettingKey } from '../services/settings.service';
import { getOrCreateTrackingCode } from '../utils/tracking-code';
import { getOrCreateUser, getOrCreateTherapist } from '../utils/unique-id';

// Idempotency window: 5 minutes
const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;

// Validation schema for appointment request from public frontend
// NOTE: therapistEmail and therapistName are optional - we fetch from Notion for security
const appointmentRequestSchema = z.object({
  userName: z.string().min(1, 'Name is required').max(100),
  userEmail: z.string().email('Invalid email address').max(255),
  therapistNotionId: z.string().min(1, 'Therapist ID is required').max(100),
  // Idempotency key for preventing duplicate requests (optional - will be computed if not provided)
  idempotencyKey: z.string().max(255).optional(),
  // Legacy fields - kept for backward compatibility but not used
  therapistEmail: z.string().email('Invalid therapist email').max(255).optional(),
  therapistName: z.string().min(1, 'Therapist name is required').max(200).optional(),
  therapistAvailability: z.any().optional(),
});

/**
 * Generate an idempotency key based on request content
 * Uses SHA256 hash of user+therapist+time window (rounded to minute)
 */
function generateIdempotencyKey(userEmail: string, therapistNotionId: string): string {
  const timeWindow = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
  return createHash('sha256')
    .update(`${userEmail}:${therapistNotionId}:${timeWindow}`)
    .digest('hex')
    .substring(0, 32); // Use first 32 chars for shorter key
}

type AppointmentRequestBody = z.infer<typeof appointmentRequestSchema>;

export async function appointmentsRoutes(fastify: FastifyInstance) {
  // POST /api/appointments/request - Public endpoint for frontend appointment requests
  // No webhook secret required - this is for the public frontend
  // Apply stricter rate limiting for this public endpoint to prevent abuse
  fastify.post<{ Body: AppointmentRequestBody }>(
    '/api/appointments/request',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.max,
          timeWindow: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.timeWindowMs,
          errorResponseBuilder: () => ({
            success: false,
            error: 'Too many appointment requests. Please wait a minute before trying again.',
          }),
        },
      },
    },
    async (request: FastifyRequest<{ Body: AppointmentRequestBody }>, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Received appointment request from frontend');

      // Validate request body
      const validation = appointmentRequestSchema.safeParse(request.body);
      if (!validation.success) {
        logger.warn({ requestId, errors: validation.error.errors }, 'Invalid request body');
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: validation.error.errors,
        });
      }

      const { userName, userEmail, therapistNotionId, idempotencyKey: providedKey } = validation.data;

      // Generate or use provided idempotency key
      const idempotencyKey = providedKey || generateIdempotencyKey(userEmail, therapistNotionId);

      // Check for duplicate request within idempotency window (fast path)
      const existingByIdempotency = await prisma.appointmentRequest.findFirst({
        where: {
          idempotencyKey,
          createdAt: { gte: new Date(Date.now() - IDEMPOTENCY_WINDOW_MS) }
        },
        select: {
          id: true,
          status: true,
          createdAt: true,
        }
      });

      if (existingByIdempotency) {
        logger.info(
          { requestId, existingId: existingByIdempotency.id, idempotencyKey },
          'Duplicate request detected via idempotency key - returning existing'
        );
        return reply.status(200).send({
          success: true,
          data: {
            appointmentRequestId: existingByIdempotency.id,
            status: existingByIdempotency.status,
            message: 'Appointment request already submitted.',
          },
          deduplicated: true,
        });
      }

      // Enhanced email validation (MX records, disposable email detection, typo suggestions)
      const emailValidation = await validateEmail(userEmail, {
        checkMx: true,
        blockDisposable: true,
        suggestTypos: true,
      });

      if (!emailValidation.isValid) {
        logger.warn(
          { requestId, userEmail, errors: emailValidation.errors },
          'Email validation failed'
        );
        return reply.status(400).send({
          success: false,
          error: emailValidation.errors[0] || 'Invalid email address',
          details: emailValidation.errors,
          suggestions: emailValidation.suggestions,
        });
      }

      // Warn about potential typos (but don't block)
      if (emailValidation.warnings.length > 0) {
        logger.info(
          { requestId, userEmail, warnings: emailValidation.warnings, suggestions: emailValidation.suggestions },
          'Email validation warnings (potential typo)'
        );
      }

      try {
        // Fetch therapist from Notion FIRST - this is the source of truth for email/name
        // This prevents frontend from sending fake therapist emails
        const therapist = await notionService.getTherapist(therapistNotionId);

        if (!therapist) {
          logger.warn({ requestId, therapistNotionId }, 'Therapist not found in Notion');
          return reply.status(404).send({
            success: false,
            error: 'Therapist not found',
          });
        }

        // Use therapist email and name from Notion (trusted source)
        const therapistEmail = therapist.email;
        const therapistName = therapist.name;

        // Validate therapist has an email address configured
        // Without this, the agent cannot contact the therapist and may hallucinate an email
        if (!therapistEmail || therapistEmail.trim() === '') {
          logger.error(
            { requestId, therapistNotionId, therapistName },
            'Therapist has no email address configured in Notion'
          );
          return reply.status(400).send({
            success: false,
            error: 'This therapist is not available for booking at this time. Please choose another therapist.',
          });
        }

        // Use safe parsing utility to handle malformed availability data
        // parseTherapistAvailability returns a validated object, but we need to preserve it as JSON for Prisma
        const parsedAvailability = parseTherapistAvailability(therapist.availability);
        // For Prisma JSON storage, use the raw availability data (already validated by parseTherapistAvailability)
        const therapistAvailability = parsedAvailability ? JSON.parse(JSON.stringify(parsedAvailability)) : null;
        const hasAvailability = parsedAvailability && parsedAvailability.slots && parsedAvailability.slots.length > 0;

        logger.info(
          { requestId, therapistNotionId, therapistName, hasAvailability },
          'Fetched therapist from Notion'
        );

        // Check if therapist can accept new requests (not confirmed or frozen)
        const availabilityStatus = await therapistBookingStatusService.canAcceptNewRequest(
          therapistNotionId,
          userEmail
        );

        if (!availabilityStatus.canAcceptNewRequests) {
          logger.info(
            { requestId, therapistNotionId, reason: availabilityStatus.reason },
            'Therapist not accepting new requests'
          );

          if (availabilityStatus.reason === 'confirmed') {
            return reply.status(400).send({
              success: false,
              error: 'This therapist is no longer accepting new appointment requests.',
            });
          }

          if (availabilityStatus.reason === 'frozen') {
            return reply.status(400).send({
              success: false,
              error: 'This therapist has reached maximum pending requests. Please try again later or choose another therapist.',
            });
          }
        }

        // OPTIMIZATION: Quick duplicate check outside transaction for fast rejection
        // This catches 99% of duplicates without transaction overhead
        // FIX B2: The definitive check is inside the transaction below
        const quickDuplicateCheck = await prisma.appointmentRequest.findFirst({
          where: {
            userEmail,
            therapistNotionId,
            status: { in: ['pending', 'contacted', 'negotiating'] },
          },
          select: { id: true },
        });

        if (quickDuplicateCheck) {
          logger.info(
            { requestId, existingRequestId: quickDuplicateCheck.id, userEmail, therapistNotionId },
            'Duplicate appointment request detected (quick check)'
          );
          return reply.status(400).send({
            success: false,
            error: 'You already have an active appointment request with this therapist. Please check your email for updates.',
          });
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

        // FIX B2: Use Serializable transaction to atomically:
        // 1. Re-check for duplicates (prevents race condition)
        // 2. Check therapist availability (prevents freeze bypass)
        // 3. Generate tracking code (FIX #5: prevents TOCTOU duplicate codes)
        // 4. Create appointment
        // 5. Update freeze status
        // Read setting value BEFORE the transaction to avoid external I/O inside
        // the Serializable transaction (which would extend the lock window and use
        // the default prisma client instead of tx for the DB fallback)
        const maxActiveThreads = await getSettingValue<number>('general.maxActiveThreadsPerUser');

        // Serializable isolation ensures no phantom reads between duplicate check and create
        const appointmentRequest = await prisma.$transaction(
          async (tx) => {
            // FIX B2: Re-check for duplicates INSIDE transaction
            // This is the authoritative check that prevents race conditions
            const existingRequest = await tx.appointmentRequest.findFirst({
              where: {
                userEmail,
                therapistNotionId,
                status: { in: ['pending', 'contacted', 'negotiating'] },
              },
              select: { id: true, status: true },
            });

            if (existingRequest) {
              throw new Error('DUPLICATE_REQUEST');
            }

            // Check user's total active threads limit (value read before transaction)

            if (maxActiveThreads > 0) {
              // Count user's active threads across ALL therapists
              const userActiveThreads = await tx.appointmentRequest.findMany({
                where: {
                  userEmail,
                  status: { in: ['pending', 'contacted', 'negotiating'] },
                },
                select: {
                  id: true,
                  therapistName: true,
                },
              });

              if (userActiveThreads.length >= maxActiveThreads) {
                // Get therapist names for the error message
                const therapistNames = userActiveThreads.map(t => t.therapistName);
                // Include maxAllowed in error for accurate error message
                throw new Error(`USER_THREAD_LIMIT:${JSON.stringify({ therapistNames, maxAllowed: maxActiveThreads })}`);
              }
            }

            // Re-check availability inside transaction (another request may have frozen)
            // IMPORTANT: Pass tx to ensure we read the same transaction's snapshot
            const recheck = await therapistBookingStatusService.canAcceptNewRequest(
              therapistNotionId,
              userEmail,
              tx // Pass transaction client for isolation
            );

            if (!recheck.canAcceptNewRequests) {
              throw new Error(`Therapist no longer accepting requests: ${recheck.reason}`);
            }

            // FIX #5: Generate tracking code INSIDE transaction to prevent TOCTOU race.
            // The sequence-number read and appointment create are now atomic.
            const trackingCode = await getOrCreateTrackingCode(userEmail, therapistEmail, tx);

            // Create appointment request record with tracking code and idempotency key
            const newRequest = await tx.appointmentRequest.create({
              data: {
                id: uuidv4(),
                userName,
                userEmail,
                therapistNotionId,
                therapistEmail,
                therapistName,
                therapistAvailability: therapistAvailability,
                status: 'pending',
                trackingCode, // Embed tracking code for deterministic matching
                idempotencyKey, // For preventing duplicate submissions
                userId: userEntity.id,
                therapistId: therapistEntity.id,
              },
            });

            // Record this request for freeze tracking INSIDE transaction
            // This ensures atomicity - freeze status is updated with the appointment creation
            await therapistBookingStatusService.recordNewRequest(
              therapistNotionId,
              therapistName,
              userEmail,
              tx // Pass transaction client
            );

            return newRequest;
          },
          {
            // FIX B2: Serializable isolation prevents phantom reads
            // Ensures duplicate check and create are truly atomic
            isolationLevel: 'Serializable',
            maxWait: 5000,
            timeout: 10000,
          }
        );

        logger.info(
          {
            requestId,
            appointmentRequestId: appointmentRequest.id,
            userEmail,
            therapistName,
            hasAvailability,
          },
          'Appointment request created'
        );

        // Sync therapist frozen status to Notion immediately (non-blocking)
        // Without this, the Notion profile only updates on the 5-minute background sync
        notionSyncManager.syncSingleTherapist(therapistNotionId).catch((err) => {
          logger.error({ err, requestId, therapistNotionId }, 'Failed to sync therapist freeze to Notion (non-critical)');
        });

        // Ensure user exists in Notion users database (non-blocking)
        // This adds the user on their first booking request, not just after confirmation
        notionUsersService.ensureUserExists({ email: userEmail, name: userName }).catch((err) => {
          logger.error({ err, requestId, userEmail }, 'Failed to ensure user exists in Notion (non-critical)');
        });

        // Send Slack notification for new appointment request (non-blocking)
        // Check notification settings first
        getSettingValue<boolean>('notifications.slack.requested')
          .then((enabled) => {
            if (enabled) {
              return slackNotificationService.notifyAppointmentCreated(
                appointmentRequest.id,
                userName,
                therapistName,
                userEmail
              );
            }
            return false;
          })
          .catch((err) => {
            logger.error({ err, requestId }, 'Failed to send Slack notification for new appointment (non-critical)');
          });

        // Trigger Justin Time agent asynchronously
        // The user gets a success response immediately - scheduling happens in background
        const justinTime = new JustinTimeService(requestId);
        justinTime
          .startScheduling({
            appointmentRequestId: appointmentRequest.id,
            userName,
            userEmail,
            therapistEmail,
            therapistName,
            therapistAvailability: therapistAvailability,
          })
          .then(() => {
            logger.info(
              { requestId, appointmentRequestId: appointmentRequest.id },
              'Justin Time scheduling started successfully'
            );
          })
          .catch(async (err) => {
            logger.error(
              { err, requestId, appointmentRequestId: appointmentRequest.id },
              'Failed to start Justin Time scheduling'
            );
            // FIX B6: Enhanced error handling for JustinTime failures
            // 1. Update appointment status and add error note
            // 2. Queue a retry via pending email system
            try {
              await prisma.appointmentRequest.update({
                where: { id: appointmentRequest.id },
                data: {
                  // Keep as pending (not contacted) since initial outreach failed
                  status: 'pending',
                  notes: `[SYSTEM ERROR] Initial scheduling failed at ${new Date().toISOString()}: ${err?.message || 'Unknown error'}. Retry queued.`,
                  isStale: true, // Flag for admin attention
                },
              });

              // FIX B6: Queue a retry via BullMQ (falls back to DB-only if Redis unavailable)
              await emailQueueService.enqueue({
                to: userEmail,
                subject: `[RETRY] Initial scheduling for ${therapistName}`,
                body: JSON.stringify({
                  type: 'RETRY_JUSTINTIME_START',
                  appointmentRequestId: appointmentRequest.id,
                  userName,
                  userEmail,
                  therapistEmail,
                  therapistName,
                  therapistAvailability,
                  originalError: err?.message || 'Unknown error',
                  queuedAt: new Date().toISOString(),
                }),
                appointmentId: appointmentRequest.id,
              });

              logger.info(
                { requestId, appointmentRequestId: appointmentRequest.id },
                'JustinTime failure recorded and retry queued'
              );
            } catch (updateErr) {
              logger.error(
                { err: updateErr, requestId, appointmentRequestId: appointmentRequest.id },
                'CRITICAL: Failed to record JustinTime failure - manual intervention required'
              );
            }
          });

        return reply.status(201).send({
          success: true,
          data: {
            appointmentRequestId: appointmentRequest.id,
            status: appointmentRequest.status,
            message: 'Appointment request received. You will receive an email shortly.',
          },
        });
      } catch (err) {
        // FIX B2: Handle specific errors from the transaction
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Duplicate request detected inside transaction
        if (errorMessage === 'DUPLICATE_REQUEST') {
          logger.info(
            { requestId, userEmail, therapistNotionId },
            'Duplicate appointment request detected (transaction check)'
          );
          return reply.status(400).send({
            success: false,
            error: 'You already have an active appointment request with this therapist. Please check your email for updates.',
          });
        }

        // User has reached max active threads limit
        if (errorMessage.startsWith('USER_THREAD_LIMIT:')) {
          const dataJson = errorMessage.replace('USER_THREAD_LIMIT:', '');
          let activeTherapists: string[] = [];
          let maxAllowed = 2; // Default fallback
          try {
            const parsed = JSON.parse(dataJson);
            activeTherapists = parsed.therapistNames || [];
            maxAllowed = parsed.maxAllowed || 2;
          } catch {
            activeTherapists = [];
          }

          logger.info(
            { requestId, userEmail, activeCount: activeTherapists.length, maxAllowed, activeTherapists },
            'User has reached max active threads limit'
          );

          return reply.status(400).send({
            success: false,
            error: 'You have reached the maximum number of active appointment requests.',
            code: 'USER_THREAD_LIMIT',
            details: {
              maxAllowed,
              activeCount: activeTherapists.length,
              activeTherapists,
            },
          });
        }

        // Therapist no longer accepting requests
        if (errorMessage.includes('Therapist no longer accepting requests')) {
          const reason = errorMessage.includes('confirmed') ? 'confirmed' : 'frozen';
          logger.info(
            { requestId, therapistNotionId, reason },
            'Therapist became unavailable during request processing'
          );

          if (reason === 'confirmed') {
            return reply.status(400).send({
              success: false,
              error: 'This therapist is no longer accepting new appointment requests.',
            });
          }
          return reply.status(400).send({
            success: false,
            error: 'This therapist has reached maximum pending requests. Please try again later or choose another therapist.',
          });
        }

        // Serialization conflict (concurrent transaction)
        if (errorMessage.includes('could not serialize')) {
          logger.warn(
            { requestId, userEmail, therapistNotionId },
            'Serialization conflict - likely concurrent request'
          );
          return reply.status(409).send({
            success: false,
            error: 'Another request is being processed. Please try again.',
          });
        }

        logger.error({ err, requestId }, 'Failed to create appointment request');
        return reply.status(500).send({
          success: false,
          error: 'Failed to process appointment request',
        });
      }
    }
  );

  // GET /api/appointments/:id/status - Check appointment status
  // FIX #1: Require matching userEmail query param to prevent unauthenticated IDOR.
  // The user must provide their email (which they know from the booking) to access status.
  fastify.get<{ Params: { id: string }; Querystring: { email?: string } }>(
    '/api/appointments/:id/status',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.max,
          timeWindow: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.timeWindowMs,
          errorResponseBuilder: () => ({
            success: false,
            error: 'Too many requests. Please wait before trying again.',
          }),
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string }; Querystring: { email?: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const { email } = request.query;
      const requestId = request.id;

      // Require email param to authenticate the request
      if (!email || typeof email !== 'string') {
        return reply.status(400).send({
          success: false,
          error: 'Email parameter is required',
        });
      }

      logger.info({ requestId, appointmentRequestId: id }, 'Checking appointment status');

      try {
        const appointmentRequest = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            userEmail: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        if (!appointmentRequest) {
          return reply.status(404).send({
            success: false,
            error: 'Appointment request not found',
          });
        }

        // FIX #1: Verify the caller owns this appointment
        if (appointmentRequest.userEmail.toLowerCase() !== email.toLowerCase()) {
          // Return 404 to avoid leaking existence of the appointment
          return reply.status(404).send({
            success: false,
            error: 'Appointment request not found',
          });
        }

        return reply.send({
          success: true,
          data: {
            id: appointmentRequest.id,
            status: appointmentRequest.status,
            createdAt: appointmentRequest.createdAt,
            updatedAt: appointmentRequest.updatedAt,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentRequestId: id }, 'Failed to fetch appointment status');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch appointment status',
        });
      }
    }
  );
}

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { Errors, sendError } from '../utils/response';
import { JustinTimeService } from '../services/justin-time.service';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { supersedeActiveTherapistConversationInTx } from '../domain/scheduling/availability/agent/service';
import { slackNotificationService } from '../services/slack-notification.service';
import { RATE_LIMITS, PRE_BOOKING_STATUSES, ACTIVE_STATUSES } from '../constants';
import { parseTherapistAvailability } from '../utils/json-parser';
import { sideEffectTrackerService } from '../services/side-effect-tracker.service';
import { validateEmail } from '../utils/email-validator';
import { getSettingValue } from '../services/settings.service';
import { runBackgroundTask } from '../utils/background-task';
import { getOrCreateTrackingCode } from '../services/tracking-code.service';
import { getOrCreateUser } from '../utils/unique-id';
import { validateVoucherToken, getDisplayCodeFromToken } from '../utils/voucher-token';

// Idempotency window: 5 minutes
const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;

// Validation schema for appointment request from public frontend.
// Therapist identity is resolved server-side from therapistHandle so the
// client can't spoof it; we do not accept therapist details in the body.
const appointmentRequestSchema = z.object({
  userName: z.string().min(1, 'Name is required').max(100),
  userEmail: z.string().email('Invalid email address').max(255),
  therapistHandle: z.string().min(1, 'Therapist ID is required').max(100),
  idempotencyKey: z.string().max(255).optional(),
  voucherToken: z.string().max(500).optional(),
  bookingMethod: z.enum(['agent_negotiated', 'direct_link']).default('agent_negotiated').optional(),
});

/**
 * Generate an idempotency key based on request content
 * Uses SHA256 hash of user+therapist+time window (rounded to minute)
 */
function generateIdempotencyKey(userEmail: string, therapistHandle: string): string {
  const timeWindow = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
  return createHash('sha256')
    .update(`${userEmail}:${therapistHandle}:${timeWindow}`)
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

      const { userName, userEmail, therapistHandle, idempotencyKey: providedKey, bookingMethod } = validation.data;

      // Generate or use provided idempotency key
      const idempotencyKey = providedKey || generateIdempotencyKey(userEmail, therapistHandle);

      // SECURITY: Scope the idempotency lookup by userEmail so a third
      // party who can guess or compute the deterministic key (it's a
      // SHA-256 of email:therapist:floor(time/5min), all of which an
      // attacker can manufacture) can't use the dedup endpoint as an
      // oracle for whether a victim has an active appointment.
      // Legitimate retries always come from the same client, so this
      // scoping doesn't affect the intended behaviour. Case-insensitive
      // match because we don't currently lowercase emails on storage,
      // and we don't want a casing change to break the legitimate
      // retry path.
      const existingByIdempotency = await prisma.appointmentRequest.findFirst({
        where: {
          idempotencyKey,
          userEmail: { equals: userEmail, mode: 'insensitive' },
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

      // SECURITY: Per-email submission cap across a 24h window. The IP
      // limiter handles burst floods, but it doesn't prevent a botnet
      // (or a NAT-shared client) from submitting the same victim's
      // email repeatedly across many IPs. This counter caps the total
      // platform-mediated email volume any single recipient can be
      // subjected to, regardless of source IP. Cancelled rows are
      // counted intentionally — harassers cancel-and-recreate to keep
      // active-thread caps from triggering.
      const perEmailWindow = new Date(Date.now() - RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST_PER_EMAIL.timeWindowMs);
      const perEmailCount = await prisma.appointmentRequest.count({
        where: {
          userEmail: { equals: userEmail, mode: 'insensitive' },
          createdAt: { gte: perEmailWindow },
        },
      });
      if (perEmailCount >= RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST_PER_EMAIL.max) {
        logger.warn(
          { requestId, userEmail, perEmailCount, limit: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST_PER_EMAIL.max },
          'Per-email booking rate limit exceeded',
        );
        return reply.status(429).send({
          success: false,
          error:
            'Too many booking requests for this email address in the past 24 hours. ' +
            'Please email scheduling@spill.chat if you need help.',
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

      // === Voucher validation ===
      const voucherToken = validation.data.voucherToken;
      const voucherRequired = await getSettingValue<boolean>('voucher.required');
      const voucherEnabled = await getSettingValue<boolean>('voucher.enabled');
      let voucherDisplayCode: string | null = null;

      if (voucherEnabled) {
        if (voucherToken) {
          const voucherExpiryDays = await getSettingValue<number>('voucher.expiryDays');
          const voucherValidation = validateVoucherToken(voucherToken, voucherExpiryDays);

          if (!voucherValidation.valid) {
            if (voucherValidation.expired) {
              logger.info({ requestId, userEmail }, 'Expired voucher token submitted');
              return reply.status(400).send({
                success: false,
                error: 'Your session code has expired. Check your email for a new one.',
              });
            }
            logger.warn({ requestId, userEmail }, 'Invalid voucher token submitted');
            return reply.status(400).send({
              success: false,
              error: 'Invalid session code.',
            });
          }

          // Verify voucher email matches the booking email (prevents sharing vouchers)
          if (voucherValidation.email?.toLowerCase() !== userEmail.toLowerCase()) {
            logger.warn(
              { requestId, userEmail, voucherEmail: voucherValidation.email },
              'Voucher email mismatch'
            );
            return reply.status(400).send({
              success: false,
              error: 'This session code was issued to a different email address.',
            });
          }

          // Check if voucher has been explicitly revoked by admin (token set to null).
          // Only reject when the token is null (revoked), not when a newer token exists —
          // users may legitimately use an older but still time-valid voucher from a previous email.
          const voucherTracking = await prisma.voucherTracking.findUnique({
            where: { id: userEmail.toLowerCase() },
            select: { lastVoucherToken: true },
          });
          if (voucherTracking && voucherTracking.lastVoucherToken === null) {
            logger.info({ requestId, userEmail }, 'Revoked voucher token submitted');
            return reply.status(400).send({
              success: false,
              error: 'This session code has been revoked. Check your email for a new one.',
            });
          }

          voucherDisplayCode = getDisplayCodeFromToken(voucherToken);
          logger.info({ requestId, userEmail, voucherDisplayCode }, 'Valid voucher token accepted');
        } else if (voucherRequired) {
          logger.info({ requestId, userEmail }, 'Booking attempted without voucher (required)');
          return reply.status(400).send({
            success: false,
            error: 'A session code is required to book. Check your weekly email for your personal code, or email scheduling@spill.chat to request one.',
            code: 'VOUCHER_REQUIRED',
          });
        }
      }

      try {
        // Postgres is now the source of truth for therapist data. The
        // public-facing handle is either the legacy notionId or the
        // Postgres uuid for post-Notion ingestions — accept either.
        const therapist = await prisma.therapist.findFirst({
          where: { OR: [{ notionId: therapistHandle }, { id: therapistHandle }] },
        });

        if (!therapist || !therapist.active) {
          logger.warn({ requestId, therapistHandle }, 'Therapist not found or inactive');
          return reply.status(404).send({
            success: false,
            error: 'Therapist not found',
          });
        }

        const therapistEmail = therapist.email;
        const therapistName = therapist.name;
        // Existing rows store the freeze status keyed on `notionId`; the
        // booking flow downstream still uses that key. For post-Notion
        // therapists we fall back to the Postgres id as the same handle.
        const therapistLookupKey = therapist.notionId ?? therapist.id;
        const prismaTherapist = { availability: therapist.availability };

        // Validate therapist has an email address configured
        // Without this, the agent cannot contact the therapist and may hallucinate an email
        if (!therapistEmail || therapistEmail.trim() === '') {
          logger.error(
            { requestId, therapistHandle, therapistName },
            'Therapist has no email address configured'
          );
          return reply.status(400).send({
            success: false,
            error: 'This therapist is not available for booking at this time. Please choose another therapist.',
          });
        }

        // parseTherapistAvailability validates the JSON shape and rejects
        // malformed records.
        const parsedAvailability = parseTherapistAvailability(prismaTherapist?.availability);
        const therapistAvailability = parsedAvailability ? JSON.parse(JSON.stringify(parsedAvailability)) : null;
        const hasAvailability = parsedAvailability && parsedAvailability.slots && parsedAvailability.slots.length > 0;

        logger.info(
          { requestId, therapistHandle, therapistName, hasAvailability },
          'Resolved therapist for booking'
        );

        // Check if therapist can accept new requests (not confirmed or frozen).
        // therapistLookupKey is the public handle (legacy notionId or
        // post-Notion Postgres id) — the booking-status row is keyed on the
        // same value the public listing returned.
        const availabilityStatus = await therapistBookingStatusService.canAcceptNewRequest(
          therapistLookupKey,
          userEmail
        );

        if (!availabilityStatus.canAcceptNewRequests) {
          logger.info(
            { requestId, therapistHandle, reason: availabilityStatus.reason },
            'Therapist not accepting new requests'
          );

          // 'target_reached' → graduated off the finder; 'in_session' → serial
          // guard (busy with another client); 'frozen' → manual admin freeze.
          // Any non-acceptance falls through to a generic rejection so a new
          // reason can never silently let a booking through.
          if (availabilityStatus.reason === 'target_reached') {
            return reply.status(400).send({
              success: false,
              error: 'This therapist is no longer accepting new appointment requests.',
            });
          }

          if (availabilityStatus.reason === 'in_session') {
            return reply.status(400).send({
              success: false,
              error: 'This therapist is currently with another client. Please try again later or choose another therapist.',
            });
          }

          return reply.status(400).send({
            success: false,
            error: 'This therapist is not currently accepting new appointment requests. Please choose another therapist.',
          });
        }

        // OPTIMIZATION: Quick duplicate check outside transaction for fast rejection
        // This catches 99% of duplicates without transaction overhead
        // FIX B2: The definitive check is inside the transaction below
        // Duplicate guard spans ALL active statuses (not just pre-booking) so a
        // client who already has a confirmed/held/feedback appointment with this
        // therapist cannot open a SECOND concurrent thread. Completed/cancelled
        // are terminal, so genuine re-bookings after a finished session still
        // pass.
        const quickDuplicateCheck = await prisma.appointmentRequest.findFirst({
          where: {
            userEmail,
            therapistHandle: therapistLookupKey,
            status: { in: [...ACTIVE_STATUSES] },
          },
          select: { id: true },
        });

        if (quickDuplicateCheck) {
          logger.info(
            { requestId, existingRequestId: quickDuplicateCheck.id, userEmail, therapistHandle },
            'Duplicate appointment request detected (quick check)'
          );
          return reply.status(400).send({
            success: false,
            error: 'You already have an appointment with this therapist. Please check your email for updates.',
          });
        }

        // We already have the resolved Therapist row from Postgres above;
        // only the user side needs get-or-create.
        const userEntity = await getOrCreateUser(userEmail, userName);
        const therapistEntity = therapist;

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
        const { newRequest: appointmentRequest, justinTimeEffect } = await prisma.$transaction(
          async (tx) => {
            // FIX B2: Re-check for duplicates INSIDE transaction
            // This is the authoritative check that prevents race conditions
            const existingRequest = await tx.appointmentRequest.findFirst({
              where: {
                userEmail,
                therapistHandle: therapistLookupKey,
                status: { in: [...ACTIVE_STATUSES] },
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
                  status: { in: [...PRE_BOOKING_STATUSES] },
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
              therapistLookupKey,
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
                therapistHandle: therapistLookupKey,
                therapistEmail,
                therapistName,
                therapistAvailability: therapistAvailability,
                status: 'pending',
                trackingCode, // Embed tracking code for deterministic matching
                idempotencyKey, // For preventing duplicate submissions
                userId: userEntity.id,
                therapistId: therapistEntity.id,
                voucherCode: voucherDisplayCode, // Record voucher used (analytics)
                bookingMethod: bookingMethod || 'agent_negotiated',
              },
            });

            // Record this request for freeze tracking INSIDE transaction
            // This ensures atomicity - freeze status is updated with the appointment creation
            await therapistBookingStatusService.recordNewRequest(
              therapistLookupKey,
              therapistName,
              userEmail,
              tx // Pass transaction client
            );

            // Supersede any active availability-collection conversation for
            // this therapist — the booking takes precedence. See
            // availability-agent.service.ts for the contract.
            await supersedeActiveTherapistConversationInTx(tx, therapistEntity.id, newRequest.id);

            // Outbox: register the JustinTime kickoff inside the same tx so
            // the row is committed atomically with the appointment. If the
            // process dies between this commit and the in-process call below,
            // the periodic side-effect-retry runner picks up the stale
            // pending row and re-drives startScheduling. Idempotency is
            // anchored on the appointment id + transition + effect type.
            const justinTimeEffect = await sideEffectTrackerService.registerInTransaction(
              tx,
              newRequest.id,
              'requested',
              { effectType: 'justintime_start' },
            );

            return { newRequest, justinTimeEffect };
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

        // Update voucher tracking: mark voucher as used and reset strike count.
        // Uses upsert to handle edge cases where no tracking record exists yet
        // (e.g., admin-issued voucher to a brand-new user).
        // FIX: Awaited instead of fire-and-forget to ensure tracking state is consistent.
        // If this fails, the voucher appears "unused" in admin, a spurious reminder is sent
        // next week, and strikes may be miscounted.
        if (voucherDisplayCode && voucherEnabled) {
          const usedAt = new Date();
          try {
            await prisma.voucherTracking.upsert({
              where: { id: userEmail.toLowerCase() },
              create: {
                id: userEmail.toLowerCase(),
                lastVoucherUsedAt: usedAt,
                strikeCount: 0,
              },
              update: {
                lastVoucherUsedAt: usedAt,
                strikeCount: 0,
              },
            });
          } catch (err) {
            // Log but don't fail the booking — the appointment was already created
            logger.warn({ err, requestId, userEmail }, 'Failed to update voucher tracking after booking');
          }
        }

        // Send Slack notification for new appointment request (non-blocking, respects settings)
        getSettingValue<boolean>('notifications.slack.requested')
          .then((enabled) => {
            if (enabled !== false) {
              runBackgroundTask(
                () => slackNotificationService.notifyAppointmentCreated({
                  appointmentId: appointmentRequest.id,
                  therapistName,
                }),
                {
                  name: 'slack-notify-requested',
                  context: { requestId, appointmentId: appointmentRequest.id },
                  retry: true,
                  maxRetries: 2,
                }
              );
            }
          })
          .catch((err) => {
            logger.error({ err, requestId }, 'Failed to check Slack notification settings (non-critical)');
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
            bookingMethod: bookingMethod || 'agent_negotiated',
            userCountry: userEntity.country,
            therapistCountry: therapistEntity.country,
          })
          .then(async () => {
            logger.info(
              { requestId, appointmentRequestId: appointmentRequest.id },
              'Justin Time scheduling started successfully'
            );
            await sideEffectTrackerService
              .markCompleted(justinTimeEffect.idempotencyKey)
              .catch((markErr) => {
                logger.warn(
                  { err: markErr, requestId, appointmentRequestId: appointmentRequest.id },
                  'Failed to mark justintime_start outbox row completed (will be reconciled by retry runner)'
                );
              });
          })
          .catch(async (err) => {
            logger.error(
              { err, requestId, appointmentRequestId: appointmentRequest.id },
              'Failed to start Justin Time scheduling'
            );
            // Flip the outbox row to `failed` so the periodic retry runner
            // picks it up. We also flag the appointment as stale for admin
            // visibility. The pre-commit row registration means recovery is
            // automatic even if this catch never fires (e.g. process crash).
            try {
              await prisma.appointmentRequest.update({
                where: { id: appointmentRequest.id },
                data: {
                  status: 'pending',
                  notes: `[SYSTEM ERROR] Initial scheduling failed at ${new Date().toISOString()}: ${err?.message || 'Unknown error'}. Retry queued.`,
                  isStale: true,
                },
                select: { id: true },
              });
            } catch (updateErr) {
              logger.error(
                { err: updateErr, requestId, appointmentRequestId: appointmentRequest.id },
                'Failed to flag appointment as stale after JustinTime failure'
              );
            }

            await sideEffectTrackerService
              .markFailed(
                justinTimeEffect.idempotencyKey,
                err instanceof Error ? err.message : String(err),
              )
              .catch((markErr) => {
                logger.error(
                  { err: markErr, requestId, appointmentRequestId: appointmentRequest.id },
                  'Failed to mark justintime_start outbox row failed (stale-pending path will recover)'
                );
              });
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
            { requestId, userEmail, therapistHandle },
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
            },
          });
        }

        // Therapist became unavailable during the in-transaction recheck.
        // The thrown message carries the availability reason vocabulary
        // (target_reached | in_session | frozen | error_fallback); map each to
        // accurate copy. 'target_reached' is permanent (graduated), so it must
        // NOT tell the user to try again later.
        if (errorMessage.includes('Therapist no longer accepting requests')) {
          const reason = errorMessage.includes('target_reached')
            ? 'target_reached'
            : errorMessage.includes('in_session')
              ? 'in_session'
              : 'frozen';
          logger.info(
            { requestId, therapistHandle, reason },
            'Therapist became unavailable during request processing'
          );

          if (reason === 'target_reached') {
            return reply.status(400).send({
              success: false,
              error: 'This therapist is no longer accepting new appointment requests.',
            });
          }
          if (reason === 'in_session') {
            return reply.status(400).send({
              success: false,
              error: 'This therapist is currently with another client. Please try again later or choose another therapist.',
            });
          }
          return reply.status(400).send({
            success: false,
            error: 'This therapist is not currently accepting new appointment requests. Please choose another therapist.',
          });
        }

        // Serialization conflict (concurrent transaction)
        if (errorMessage.includes('could not serialize')) {
          logger.warn(
            { requestId, userEmail, therapistHandle },
            'Serialization conflict - likely concurrent request'
          );
          return Errors.conflict(reply, 'Another request is being processed. Please try again.');
        }

        logger.error({ err, requestId }, 'Failed to create appointment request');
        return Errors.internal(reply, 'Failed to process appointment request');
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
        return Errors.internal(reply, 'Failed to fetch appointment status');
      }
    }
  );
}

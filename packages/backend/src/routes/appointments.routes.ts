import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import type { BookingVerificationPendingResponse } from '@therapist-scheduler/shared';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { config } from '../config';
import { Errors } from '../utils/response';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { RATE_LIMITS, ACTIVE_STATUSES } from '../constants';
import { parseTherapistAvailability } from '../utils/json-parser';
import { validateEmail } from '../utils/email-validator';
import { normalizeEmail } from '../utils/email-equals';
import { getSettingValue } from '../services/settings.service';
import { runBackgroundTask } from '../utils/background-task';
import { getOrCreateTrackingCode } from '../services/tracking-code.service';
import { getOrCreateUser } from '../utils/unique-id';
import { validateVoucherToken, getDisplayCodeFromToken } from '../utils/voucher-token';
import {
  bookingVerificationService,
  BOOKING_VERIFICATION_VALIDITY_HOURS,
  VERIFICATION_RESEND_INTERVAL_MS,
  activateBookingInTx,
  buildVerificationUrl,
  checkActivationPreconditions,
  consumeAddressQuota,
  runPostActivationEffects,
  type ActivationFailure,
  type ConfirmationPageState,
  type VerifyOutcome,
} from '../services/booking-verification.service';

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

/** Thrown inside a booking transaction to roll it back with a typed reason. */
class ActivationRejected extends Error {
  constructor(public readonly failure: ActivationFailure) {
    super(`ACTIVATION_REJECTED:${failure.reason}`);
  }
}

const VERIFY_RATE_LIMIT = { max: 20, timeWindow: 60_000 };

// 'target_reached' → graduated off the finder; 'in_session' → serial
// guard (busy with another client); 'frozen' → manual admin freeze.
// Any non-acceptance falls through to a generic rejection so a new
// reason can never silently let a booking through. 'target_reached' is
// permanent, so it must NOT tell the user to try again later.
function therapistUnavailableResponse(reply: FastifyReply, reason: string | undefined) {
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

function sendVerificationInBackground(appointmentId: string, requestId: string, minIntervalMs = 0) {
  runBackgroundTask(
    () => bookingVerificationService.sendVerification(appointmentId, { minIntervalMs }),
    { name: 'booking-verification-email', context: { requestId, appointmentId } },
  );
}

/** Re-send the link for an unconfirmed request, at most once per resend interval. */
function resendVerificationInBackground(appointmentId: string, requestId: string) {
  sendVerificationInBackground(appointmentId, requestId, VERIFICATION_RESEND_INTERVAL_MS);
}

function verifyActionUrl(appointmentId: string, token: string): string {
  return buildVerificationUrl(appointmentId, token);
}

async function coordinatorDisplayName(): Promise<string> {
  try {
    return (await getSettingValue<string>('agent.fromName')) || 'Justin Time';
  } catch {
    return 'Justin Time';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * The no-voucher path: store the request unverified and email a
 * confirmation link. Nothing else happens (no in-session status, no agent,
 * no Slack) until the link is followed. A duplicate of an existing request
 * gets the very same response, so this can't reveal who has booked whom.
 */
async function createUnverifiedRequest(
  reply: FastifyReply,
  p: {
    requestId: string;
    userName: string;
    userEmail: string;
    userId: string;
    therapistId: string;
    therapistLookupKey: string;
    therapistEmail: string;
    therapistName: string;
    therapistAvailability: Prisma.InputJsonValue | null;
    idempotencyKey: string;
    bookingMethod: 'agent_negotiated' | 'direct_link';
    suggestedEmail: string | null;
  },
) {
  const activeForPair = {
    userEmail: p.userEmail,
    therapistHandle: p.therapistLookupKey,
    status: { in: [...ACTIVE_STATUSES] },
  };

  const answerDuplicate = (existing: { id: string; emailVerifiedAt: Date | null } | null) => {
    logger.info({ requestId: p.requestId, therapistHandle: p.therapistLookupKey }, 'Duplicate appointment request (unverified path) - answered generically');
    if (existing && !existing.emailVerifiedAt) {
      resendVerificationInBackground(existing.id, p.requestId);
    }
    return verificationPendingResponse(reply, p.userEmail, p.suggestedEmail);
  };

  const existing = await prisma.appointmentRequest.findFirst({
    where: activeForPair,
    select: { id: true, emailVerifiedAt: true },
  });
  if (existing) return answerDuplicate(existing);

  let created: { id: string } | { duplicate: { id: string; emailVerifiedAt: Date | null } };
  try {
    created = await prisma.$transaction(
      async (tx) => {
        const dup = await tx.appointmentRequest.findFirst({
          where: activeForPair,
          select: { id: true, emailVerifiedAt: true },
        });
        if (dup) return { duplicate: dup };

        // Re-check the therapist inside the tx (another request may have
        // been confirmed or an admin may have frozen them).
        const recheck = await therapistBookingStatusService.canAcceptNewRequest(p.therapistLookupKey, '', tx);
        if (!recheck.canAcceptNewRequests) {
          throw new ActivationRejected({ ok: false, reason: 'therapist_unavailable', availability: recheck.reason });
        }

        const trackingCode = await getOrCreateTrackingCode(p.userEmail, p.therapistEmail, tx);
        return tx.appointmentRequest.create({
          data: {
            id: uuidv4(),
            userName: p.userName,
            userEmail: p.userEmail,
            therapistHandle: p.therapistLookupKey,
            therapistEmail: p.therapistEmail,
            therapistName: p.therapistName,
            therapistAvailability: p.therapistAvailability ?? Prisma.JsonNull,
            status: 'pending',
            trackingCode,
            idempotencyKey: p.idempotencyKey,
            userId: p.userId,
            therapistId: p.therapistId,
            bookingMethod: p.bookingMethod,
            emailVerifiedAt: null,
          },
          select: { id: true },
        });
      },
      { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 },
    );
  } catch (err) {
    if (err instanceof ActivationRejected && err.failure.reason === 'therapist_unavailable') {
      return therapistUnavailableResponse(reply, err.failure.availability);
    }
    // A concurrent submission for the same pair (partial unique index) or
    // the same idempotency key: it's a duplicate, answer the same way.
    if (isUniqueViolation(err)) return answerDuplicate(null);
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('could not serialize')) {
      return Errors.conflict(reply, 'Another request is being processed. Please try again.');
    }
    throw err;
  }

  if ('duplicate' in created) return answerDuplicate(created.duplicate);

  logger.info(
    { requestId: p.requestId, appointmentRequestId: created.id, therapistName: p.therapistName },
    'Appointment request created (awaiting email confirmation)',
  );
  sendVerificationInBackground(created.id, p.requestId);
  return verificationPendingResponse(reply, p.userEmail, p.suggestedEmail);
}

/**
 * The response for every booking that must be confirmed by email: a new
 * request, a duplicate of an existing one, and a retried submission all get
 * exactly this (HTTP 202), so the endpoint can't be used to learn whether
 * an address already has a request with a therapist.
 */
function verificationPendingResponse(
  reply: FastifyReply,
  email: string,
  suggestedEmail: string | null,
) {
  const body: BookingVerificationPendingResponse = {
    verificationRequired: true,
    status: 'awaiting_verification',
    email,
    expiresInHours: BOOKING_VERIFICATION_VALIDITY_HOURS,
    suggestedEmail,
    message: `Check your email: we've sent a link to ${email}. Your request is only sent to the therapist once you confirm it.`,
  };
  return reply.status(202).send({ success: true, data: body });
}

/** Shared copy for the duplicate case on the voucher path (ownership is proven there). */
const DUPLICATE_REQUEST_MESSAGE =
  "We couldn't open a new request. If you already have a request with this therapist, check your email for updates from our scheduling assistant.";

function tooManyForAddress(reply: FastifyReply, retryAfterSeconds: number) {
  reply.header('Retry-After', String(retryAfterSeconds));
  return reply.status(429).send({
    success: false,
    error: `Too many booking requests for this email address. Please wait ${formatWait(retryAfterSeconds)} and try again.`,
    code: 'ADDRESS_RATE_LIMITED',
    retryAfter: retryAfterSeconds,
  });
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only an absolute http(s) URL is ever rendered as a link. */
function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Small standalone page for the confirmation link (same approach as the
 * unsubscribe page). Every interpolated value is escaped by the caller.
 */
function renderVerificationPage(opts: {
  title: string;
  heading: string;
  tone: 'success' | 'info' | 'error';
  paragraphsHtml: string[];
  actionHtml?: string;
}): string {
  const color = opts.tone === 'success' ? '#38a169' : opts.tone === 'error' ? '#c53030' : '#1a202c';
  const siteUrl = escapeHtml(config.frontendUrl || 'https://free.spill.app');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(opts.title)} | Spill</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px 16px; text-align: center; max-width: 600px; margin: 0 auto; color: #1a202c; }
    h1 { color: ${color}; font-size: 26px; }
    p { color: #4a5568; line-height: 1.6; }
    a { color: #2b6cb0; }
    .button { display: inline-block; margin: 12px 0; padding: 12px 22px; border-radius: 8px; border: 0; background: #000; color: #fff; font-size: 16px; font-weight: 600; text-decoration: none; cursor: pointer; }
    .button:focus-visible { outline: 3px solid #90cdf4; outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(opts.heading)}</h1>
    ${opts.paragraphsHtml.map((p) => `<p>${p}</p>`).join('\n    ')}
    ${opts.actionHtml ?? ''}
    <p><a href="${siteUrl}">Back to Spill free therapy</a></p>
  </main>
</body>
</html>`;
}

function renderVerifyOutcome(
  reply: FastifyReply,
  outcome: VerifyOutcome | ConfirmationPageState,
  confirmAction: string,
  coordinatorName: string,
) {
  const coordinator = escapeHtml(coordinatorName);
  const send = (statusCode: number, html: string) => reply.status(statusCode).type('text/html').send(html);

  switch (outcome.status) {
    case 'confirm': {
      const therapist = escapeHtml(outcome.therapistName);
      return send(200, renderVerificationPage({
        title: 'Confirm your request',
        heading: 'Confirm your session request',
        tone: 'info',
        paragraphsHtml: [
          `You asked for a free session with <strong>${therapist}</strong> using ${escapeHtml(outcome.email)}.`,
          'Nothing has been sent to the therapist yet. Press the button to confirm.',
        ],
        actionHtml: `<form method="post" action="${escapeHtml(confirmAction)}"><button class="button" type="submit">Confirm my request</button></form>`,
      }));
    }
    case 'verified':
    case 'already_verified': {
      const therapist = escapeHtml(outcome.therapistName);
      const calendar = outcome.bookingMethod === 'direct_link' ? safeHttpUrl(outcome.bookingLink) : null;
      return send(200, renderVerificationPage({
        title: 'Request confirmed',
        heading: 'Thanks, your request is confirmed',
        tone: 'success',
        paragraphsHtml: calendar
          ? [`You can now pick a time on ${therapist}'s calendar. Once you've booked, ${coordinator}, our scheduling assistant, will follow up by email to confirm your session.`]
          : [`${coordinator}, our scheduling assistant, will email you shortly to find a time that works for you and ${therapist}. Keep an eye on your inbox (and your spam folder).`],
        actionHtml: calendar
          ? `<a class="button" href="${escapeHtml(calendar)}" target="_blank" rel="noopener noreferrer">Continue to ${therapist}'s calendar</a>`
          : undefined,
      }));
    }
    case 'expired':
      return send(410, renderVerificationPage({
        title: 'Link expired',
        heading: 'This link has expired',
        tone: 'error',
        paragraphsHtml: ['Confirmation links work for 24 hours. Your request was not sent. Please make a new request from the therapist directory.'],
      }));
    case 'no_longer_active':
      return send(409, renderVerificationPage({
        title: 'Request closed',
        heading: 'This request is no longer open',
        tone: 'error',
        paragraphsHtml: [`Your request with ${escapeHtml(outcome.therapistName)} has been closed. Please make a new request from the therapist directory.`],
      }));
    case 'duplicate':
      return send(409, renderVerificationPage({
        title: 'Already requested',
        heading: 'You already have a request with this therapist',
        tone: 'info',
        paragraphsHtml: [`Check your email for updates from ${coordinator} about your session with ${escapeHtml(outcome.therapistName)}.`],
      }));
    case 'thread_limit':
      return send(409, renderVerificationPage({
        title: 'Request limit reached',
        heading: 'You have the maximum number of open requests',
        tone: 'error',
        paragraphsHtml: [
          `You can have up to ${outcome.maxAllowed} open request${outcome.maxAllowed === 1 ? '' : 's'} at a time, so this request with ${escapeHtml(outcome.therapistName)} was not sent.`,
          `Once one of your current requests is confirmed or cancelled, you can try again. ${coordinator} will keep you updated by email.`,
        ],
      }));
    case 'therapist_unavailable':
      return send(409, renderVerificationPage({
        title: 'Therapist unavailable',
        heading: `${escapeHtml(outcome.therapistName)} isn't available right now`,
        tone: 'error',
        paragraphsHtml: ['They were booked by someone else before your request was confirmed, so it has not been sent. Please choose another therapist from the directory.'],
      }));
    case 'retry':
      return send(503, renderVerificationPage({
        title: 'Please try again',
        heading: 'Something went wrong',
        tone: 'error',
        paragraphsHtml: ["We couldn't confirm your request just now. Please open the link from your email again."],
      }));
    default:
      return send(400, renderVerificationPage({
        title: 'Invalid link',
        heading: "This link isn't valid",
        tone: 'error',
        paragraphsHtml: [`It may have been copied incompletely. Open the link from the most recent confirmation email, or make a new request. If you need help, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.`],
      }));
  }
}

const SUPPORT_EMAIL = 'scheduling@spill.chat';

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

      const { userName, therapistHandle, idempotencyKey: providedKey, bookingMethod } = validation.data;
      // Stored normalised (utils/email-equals is the one normaliser), so the
      // duplicate / thread-limit checks and the confirmation link all agree.
      const userEmail = normalizeEmail(validation.data.userEmail);

      // === Voucher validation ===
      // Runs first because it decides which path this request takes: a valid
      // voucher for this same address proves ownership (it was emailed there),
      // so the booking is activated immediately exactly as before. Anything
      // else waits for the requester to confirm by email.
      const voucherToken = validation.data.voucherToken;
      const voucherRequired = await getSettingValue<boolean>('voucher.required');
      const voucherEnabled = await getSettingValue<boolean>('voucher.enabled');
      let voucherDisplayCode: string | null = null;

      if (voucherEnabled) {
        if (voucherToken) {
          // Each voucher is validated against its OWN expiry (signed into
          // the token when issued, e.g. a 30-day admin voucher); the global
          // setting only applies to legacy tokens that carry none.
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

      const verifiedByVoucher = voucherDisplayCode !== null;

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
          emailVerifiedAt: true,
        }
      });

      if (existingByIdempotency) {
        logger.info(
          { requestId, existingId: existingByIdempotency.id, idempotencyKey },
          'Duplicate request detected via idempotency key - returning existing'
        );
        // Without a voucher the caller hasn't proven they own the address,
        // so they get the same "check your email" answer as a new request
        // (and the link is re-sent if the request is still unconfirmed).
        if (!verifiedByVoucher) {
          if (!existingByIdempotency.emailVerifiedAt) {
            resendVerificationInBackground(existingByIdempotency.id, requestId);
          }
          return verificationPendingResponse(reply, userEmail, null);
        }
        return reply.status(200).send({
          success: true,
          data: {
            verificationRequired: false,
            appointmentRequestId: existingByIdempotency.id,
            status: existingByIdempotency.status,
            message: 'Appointment request already submitted.',
          },
          deduplicated: true,
        });
      }

      // Per-address cap (Redis, short window) on top of the per-IP route
      // limit: a botnet or a NAT-shared client can't flood one address.
      const addressQuota = await consumeAddressQuota('booking', userEmail);
      if (!addressQuota.allowed) {
        logger.warn({ requestId, retryAfter: addressQuota.retryAfterSeconds }, 'Per-address booking rate limit exceeded');
        return tooManyForAddress(reply, addressQuota.retryAfterSeconds);
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
          suggestedEmail: emailValidation.suggestedEmail ?? null,
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
        //
        // The unverified path passes no email: the "same client continuation"
        // exemption would otherwise answer differently for an address that
        // already has a request with this therapist — an oracle.
        const availabilityStatus = await therapistBookingStatusService.canAcceptNewRequest(
          therapistLookupKey,
          verifiedByVoucher ? userEmail : ''
        );

        if (!availabilityStatus.canAcceptNewRequests) {
          logger.info(
            { requestId, therapistHandle, reason: availabilityStatus.reason },
            'Therapist not accepting new requests'
          );
          return therapistUnavailableResponse(reply, availabilityStatus.reason);
        }

        // We already have the resolved Therapist row from Postgres above;
        // only the user side needs get-or-create.
        const userEntity = await getOrCreateUser(userEmail, userName);
        const therapistEntity = therapist;

        if (!verifiedByVoucher) {
          return await createUnverifiedRequest(reply, {
            requestId,
            userName,
            userEmail,
            userId: userEntity.id,
            therapistId: therapistEntity.id,
            therapistLookupKey,
            therapistEmail,
            therapistName,
            therapistAvailability,
            idempotencyKey,
            bookingMethod: bookingMethod || 'agent_negotiated',
            suggestedEmail: emailValidation.suggestedEmail ?? null,
          });
        }

        // === Voucher path: ownership proven, activate immediately ===

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
          return reply.status(400).send({ success: false, error: DUPLICATE_REQUEST_MESSAGE });
        }

        // FIX B2: Use Serializable transaction to atomically:
        // 1. Re-check for duplicates, the thread limit and availability
        // 2. Generate tracking code (FIX #5: prevents TOCTOU duplicate codes)
        // 3. Create appointment (verified: the voucher was emailed to it)
        // 4. Activate it (outbox kickoff row, availability supersede)
        // Read setting value BEFORE the transaction to avoid external I/O inside
        // the Serializable transaction (which would extend the lock window and use
        // the default prisma client instead of tx for the DB fallback)
        const maxActiveThreads = await getSettingValue<number>('general.maxActiveThreadsPerUser');

        // Serializable isolation ensures no phantom reads between duplicate check and create
        const { newRequest: appointmentRequest, justinTimeEffect } = await prisma.$transaction(
          async (tx) => {
            const failure = await checkActivationPreconditions(tx, {
              userEmail,
              therapistHandle: therapistLookupKey,
              maxActiveThreads,
              availabilityEmail: userEmail,
            });
            if (failure) throw new ActivationRejected(failure);

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
                emailVerifiedAt: new Date(),
              },
            });

            const justinTimeEffect = await activateBookingInTx(tx, newRequest);
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

        // Slack + Justin Time kickoff. The user gets a success response
        // immediately - scheduling happens in background.
        runPostActivationEffects({
          requestId,
          justinTimeEffectKey: justinTimeEffect.idempotencyKey,
          context: {
            appointmentRequestId: appointmentRequest.id,
            userName,
            userEmail,
            therapistEmail,
            therapistName,
            therapistAvailability: therapistAvailability,
            bookingMethod: bookingMethod || 'agent_negotiated',
            userCountry: userEntity.country,
            therapistCountry: therapistEntity.country,
          },
        });

        return reply.status(201).send({
          success: true,
          data: {
            verificationRequired: false,
            appointmentRequestId: appointmentRequest.id,
            status: appointmentRequest.status,
            message: 'Appointment request received. You will receive an email shortly.',
          },
        });
      } catch (err) {
        // FIX B2: Handle specific errors from the transaction
        if (err instanceof ActivationRejected) {
          const failure = err.failure;
          if (failure.reason === 'duplicate') {
            logger.info({ requestId, userEmail, therapistHandle }, 'Duplicate appointment request detected (transaction check)');
            return reply.status(400).send({ success: false, error: DUPLICATE_REQUEST_MESSAGE });
          }
          if (failure.reason === 'thread_limit') {
            logger.info(
              { requestId, userEmail, activeCount: failure.activeCount, maxAllowed: failure.maxAllowed, activeTherapists: failure.therapistNames },
              'User has reached max active threads limit'
            );
            return reply.status(400).send({
              success: false,
              error: 'You have reached the maximum number of active appointment requests.',
              code: 'USER_THREAD_LIMIT',
              details: {
                maxAllowed: failure.maxAllowed,
                activeCount: failure.activeCount,
              },
            });
          }
          // Therapist became unavailable during the in-transaction recheck.
          logger.info({ requestId, therapistHandle, reason: failure.availability }, 'Therapist became unavailable during request processing');
          return therapistUnavailableResponse(reply, failure.availability);
        }

        const errorMessage = err instanceof Error ? err.message : String(err);

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

  // GET /api/appointments/:id/verify?token=… — the link in the confirmation
  // email. Read-only: shows what is being confirmed plus a "Confirm" button
  // (a POST to the same URL). Mail scanners fetch every link in an email, so
  // a GET that verified would auto-confirm on the requester's behalf.
  // An already-confirmed request just shows the success page (idempotent).
  fastify.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/api/appointments/:id/verify',
    { config: { rateLimit: VERIFY_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = request.params;
      const token = typeof request.query.token === 'string' ? request.query.token : '';
      const coordinatorName = await coordinatorDisplayName();
      try {
        const state = await bookingVerificationService.describeConfirmation(id, token);
        return renderVerifyOutcome(reply, state, verifyActionUrl(id, token), coordinatorName);
      } catch (err) {
        logger.error({ err, requestId: request.id, appointmentRequestId: id }, 'Failed to render booking confirmation page');
        return renderVerifyOutcome(reply, { status: 'retry' }, verifyActionUrl(id, token), coordinatorName);
      }
    },
  );

  // POST /api/appointments/:id/verify?token=… — the "Confirm my request"
  // button. Stamps emailVerifiedAt, then runs everything the create path
  // used to run straight after insert (in-session, agent, Slack).
  fastify.post<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/api/appointments/:id/verify',
    { config: { rateLimit: VERIFY_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = request.params;
      const token = typeof request.query.token === 'string' ? request.query.token : '';
      const coordinatorName = await coordinatorDisplayName();
      try {
        const outcome = await bookingVerificationService.verify(id, token, request.id);
        logger.info({ requestId: request.id, appointmentRequestId: id, outcome: outcome.status }, 'Booking verification attempt');
        return renderVerifyOutcome(reply, outcome, verifyActionUrl(id, token), coordinatorName);
      } catch (err) {
        logger.error({ err, requestId: request.id, appointmentRequestId: id }, 'Booking verification failed');
        return renderVerifyOutcome(reply, { status: 'retry' }, verifyActionUrl(id, token), coordinatorName);
      }
    },
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

/**
 * Booking email verification.
 *
 * A public booking used to take effect the moment it was submitted: the
 * therapist was marked in-session for everyone, the agent started (a paid
 * Claude turn plus an email to the therapist) and Slack was notified — with
 * no proof the requester controlled the address. One fake request per
 * therapist emptied the public directory.
 *
 * Now a booking without a voucher is stored with `emailVerifiedAt = null`
 * and nothing else happens until the requester follows the link emailed to
 * them:
 *
 *   POST /api/appointments/request  → row (unverified) + sendVerification()
 *   GET  /api/appointments/:id/verify?token=…  → confirmation page (button)
 *   POST /api/appointments/:id/verify?token=…  → verify() → activation
 *
 * The GET only renders a page with a "Confirm" button; the POST does the
 * work. Mail security scanners (Microsoft SafeLinks, Mimecast …) fetch every
 * link in an email, so a GET that verified would auto-confirm bookings for
 * exactly the corporate mailboxes most of our users have.
 *
 * Activation (shared with the voucher path, which is verified at creation)
 * is everything the old create path did after the insert: re-check
 * duplicates / the per-user thread limit / therapist availability, register
 * the justintime_start outbox row, supersede any availability conversation,
 * then (after commit) Slack + startScheduling.
 *
 * Unverified requests never count as "in session": therapist-booking-status
 * only considers rows with `emailVerifiedAt` set. `expireUnverifiedBookings`
 * deletes requests nobody confirmed within the link's 24-hour validity —
 * they never had a side effect, so there is nothing to cancel or notify.
 */

import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { config } from '../config';
import { signTimestampedToken, verifyTimestampedToken } from '../utils/hmac-token';
import { LockedPeriodicService } from '../utils/locked-periodic-service';
import { renderTemplate } from '../utils/email-templates';
import { firstName } from '../utils/first-name';
import { runBackgroundTask } from '../utils/background-task';
import { isSerializationError } from '../utils/serialization-retry';
import { sendEmail } from '../core/email';
import { ACTIVE_STATUSES, PRE_BOOKING_STATUSES } from '../constants';
import { getSettingValue } from './settings.service';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { sideEffectTrackerService } from './side-effect-tracker.service';
import { slackNotificationService } from './slack-notification.service';
import { JustinTimeService } from './justin-time.service';
import type { SchedulingContext } from './scheduling-context.service';
import { supersedeActiveTherapistConversationInTx } from '../domain/scheduling/availability/agent/service';

type TransactionClient = Prisma.TransactionClient;

// ============================================================================
// Token
// ============================================================================

/** How long a confirmation link stays valid (and how long an unverified request lives). */
export const BOOKING_VERIFICATION_VALIDITY_HOURS = 24;
const VALIDITY_MS = BOOKING_VERIFICATION_VALIDITY_HOURS * 60 * 60 * 1000;

// Purpose-scoped key: a voucher, unsubscribe or feedback signature can
// never validate as a booking confirmation (see hmac-token.ts).
const TOKEN_CONTEXT = 'booking-verification-v1';
const TOKEN_VERSION = 'v1';

/** Minimum gap between two confirmation emails for the same request. */
export const VERIFICATION_RESEND_INTERVAL_MS = 2 * 60 * 1000;

function tokenPayload(appointmentId: string, email: string): string {
  return `${appointmentId}\n${email.trim().toLowerCase()}`;
}

/** Sign a confirmation token bound to one appointment and its email address. */
export function generateBookingVerificationToken(appointmentId: string, email: string): string {
  return signTimestampedToken({
    context: TOKEN_CONTEXT,
    version: TOKEN_VERSION,
    payload: tokenPayload(appointmentId, email),
  });
}

export type TokenCheck = 'valid' | 'expired' | 'invalid';

/**
 * Check a confirmation token against the appointment it claims to confirm.
 * `invalid` covers malformed input, a bad signature (including one minted
 * for another purpose) and a token for a different appointment/address.
 */
export function checkBookingVerificationToken(
  token: string,
  appointmentId: string,
  email: string,
): TokenCheck {
  let verified: ReturnType<typeof verifyTimestampedToken>;
  try {
    verified = verifyTimestampedToken(token, {
      context: TOKEN_CONTEXT,
      expectedVersion: TOKEN_VERSION,
      validityDays: BOOKING_VERIFICATION_VALIDITY_HOURS / 24,
    });
  } catch {
    return 'invalid';
  }
  if (!verified) return 'invalid';
  if (verified.payload !== tokenPayload(appointmentId, email)) return 'invalid';
  return verified.expired ? 'expired' : 'valid';
}

/** The appointment id a (signature-valid) token was minted for, else null. */
function appointmentIdFromToken(token: string): string | null {
  try {
    const verified = verifyTimestampedToken(token, {
      context: TOKEN_CONTEXT,
      expectedVersion: TOKEN_VERSION,
      validityDays: BOOKING_VERIFICATION_VALIDITY_HOURS / 24,
    });
    return verified ? verified.payload.split('\n')[0] || null : null;
  } catch {
    return null;
  }
}

export function buildVerificationUrl(appointmentId: string, token: string): string {
  return `${config.backendUrl}/api/appointments/${encodeURIComponent(appointmentId)}/verify?token=${encodeURIComponent(token)}`;
}

// ============================================================================
// Activation (shared by the voucher path and verify())
// ============================================================================

export type ActivationFailure =
  | { ok: false; reason: 'duplicate' }
  | { ok: false; reason: 'thread_limit'; maxAllowed: number; activeCount: number; therapistNames: string[] }
  | { ok: false; reason: 'therapist_unavailable'; availability: string | undefined };

/**
 * The checks every activation re-runs inside its Serializable transaction:
 * no other active request for this client + therapist, the client is under
 * `general.maxActiveThreadsPerUser` verified pre-booking requests, and the
 * therapist can still take a new client.
 *
 * `availabilityEmail` is passed to canAcceptNewRequest's "same client
 * continuation" rule. The voucher path passes the client's email (as it
 * always has); verify() passes '' because the only same-client row is the
 * request being verified, which must not exempt itself from the serial guard.
 */
export async function checkActivationPreconditions(
  tx: TransactionClient,
  params: {
    userEmail: string;
    therapistHandle: string;
    maxActiveThreads: number;
    excludeId?: string;
    availabilityEmail: string;
  },
): Promise<ActivationFailure | null> {
  const notSelf = params.excludeId ? { id: { not: params.excludeId } } : {};

  const duplicate = await tx.appointmentRequest.findFirst({
    where: {
      userEmail: params.userEmail,
      therapistHandle: params.therapistHandle,
      status: { in: [...ACTIVE_STATUSES] },
      ...notSelf,
    },
    select: { id: true },
  });
  if (duplicate) return { ok: false, reason: 'duplicate' };

  if (params.maxActiveThreads > 0) {
    // Only verified requests count: an unconfirmed request is not real yet,
    // and counting it would let anyone block an address by submitting
    // requests in its name.
    const active = await tx.appointmentRequest.findMany({
      where: {
        userEmail: params.userEmail,
        status: { in: [...PRE_BOOKING_STATUSES] },
        emailVerifiedAt: { not: null },
        ...notSelf,
      },
      select: { id: true, therapistName: true },
    });
    if (active.length >= params.maxActiveThreads) {
      return {
        ok: false,
        reason: 'thread_limit',
        maxAllowed: params.maxActiveThreads,
        activeCount: active.length,
        therapistNames: active.map((a) => a.therapistName),
      };
    }
  }

  const availability = await therapistBookingStatusService.canAcceptNewRequest(
    params.therapistHandle,
    params.availabilityEmail,
    tx,
  );
  if (!availability.canAcceptNewRequests) {
    return { ok: false, reason: 'therapist_unavailable', availability: availability.reason };
  }
  return null;
}

/**
 * The in-transaction half of activation, run right after the row is
 * inserted (voucher path) or stamped verified (verify()). Returns the
 * justintime_start outbox row: if the process dies before the in-process
 * kickoff, the side-effect retry runner re-drives startScheduling from it.
 */
export async function activateBookingInTx(
  tx: TransactionClient,
  row: { id: string; therapistHandle: string; therapistName: string; userEmail: string; therapistId: string | null },
): Promise<{ idempotencyKey: string }> {
  // No-op under the target availability model; kept so the call site
  // (and its retry registration) stays where every create path has it.
  await therapistBookingStatusService.recordNewRequest(row.therapistHandle, row.therapistName, row.userEmail, tx);
  if (row.therapistId) {
    // The booking takes precedence over an availability-collection thread.
    await supersedeActiveTherapistConversationInTx(tx, row.therapistId, row.id);
  }
  return sideEffectTrackerService.registerInTransaction(tx, row.id, 'requested', {
    effectType: 'justintime_start',
  });
}

export interface PostActivationParams {
  requestId: string;
  justinTimeEffectKey: string;
  /** Exactly what the create path passed to startScheduling. */
  context: SchedulingContext;
}

/**
 * The post-commit half of activation: Slack (setting-gated) and the agent
 * kickoff. Fire-and-forget — the caller has already answered the user. The
 * failure handling is the create path's, unchanged: flag the row stale and
 * mark the outbox row failed so the retry runner picks it up.
 */
export function runPostActivationEffects({ requestId, justinTimeEffectKey, context }: PostActivationParams): void {
  const appointmentRequestId = context.appointmentRequestId;
  getSettingValue<boolean>('notifications.slack.requested')
    .then((enabled) => {
      if (enabled !== false) {
        runBackgroundTask(
          () => slackNotificationService.notifyAppointmentCreated({
            appointmentId: appointmentRequestId,
            therapistName: context.therapistName,
          }),
          {
            name: 'slack-notify-requested',
            context: { requestId, appointmentId: appointmentRequestId },
            retry: true,
            maxRetries: 2,
          },
        );
      }
    })
    .catch((err) => {
      logger.error({ err, requestId }, 'Failed to check Slack notification settings (non-critical)');
    });

  const justinTime = new JustinTimeService(requestId);
  justinTime
    .startScheduling(context)
    .then(async () => {
      logger.info(
        { requestId: requestId, appointmentRequestId: appointmentRequestId },
        'Justin Time scheduling started successfully',
      );
      await sideEffectTrackerService.markCompleted(justinTimeEffectKey).catch((markErr) => {
        logger.warn(
          { err: markErr, requestId: requestId, appointmentRequestId: appointmentRequestId },
          'Failed to mark justintime_start outbox row completed (will be reconciled by retry runner)',
        );
      });
    })
    .catch(async (err) => {
      logger.error(
        { err, requestId: requestId, appointmentRequestId: appointmentRequestId },
        'Failed to start Justin Time scheduling',
      );
      try {
        await prisma.appointmentRequest.update({
          where: { id: appointmentRequestId },
          data: {
            status: 'pending',
            notes: `[SYSTEM ERROR] Initial scheduling failed at ${new Date().toISOString()}: ${err?.message || 'Unknown error'}. Retry queued.`,
            isStale: true,
          },
          select: { id: true },
        });
      } catch (updateErr) {
        logger.error(
          { err: updateErr, requestId: requestId, appointmentRequestId: appointmentRequestId },
          'Failed to flag appointment as stale after JustinTime failure',
        );
      }
      await sideEffectTrackerService
        .markFailed(justinTimeEffectKey, err instanceof Error ? err.message : String(err))
        .catch((markErr) => {
          logger.error(
            { err: markErr, requestId: requestId, appointmentRequestId: appointmentRequestId },
            'Failed to mark justintime_start outbox row failed (stale-pending path will recover)',
          );
        });
    });
}

// ============================================================================
// Per-address rate limit (public booking + signup)
// ============================================================================

export interface AddressRateLimit {
  max: number;
  windowSeconds: number;
}

/** Per-address caps, on top of the per-IP route limits. */
export const ADDRESS_RATE_LIMITS = {
  // Each unverified booking emails a confirmation link to the address.
  booking: { max: 5, windowSeconds: 60 * 60 },
  // Each signup sends a welcome email with a fresh voucher.
  signup: { max: 3, windowSeconds: 24 * 60 * 60 },
} as const satisfies Record<string, AddressRateLimit>;

export type AddressRateLimitScope = keyof typeof ADDRESS_RATE_LIMITS;

const INCR_WITH_TTL = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return {n, ttl}
`;

// In-process fallback used only while Redis is unavailable. Per instance,
// so it is looser than the Redis limit, but never fails open entirely.
const memoryCounters = new Map<string, { count: number; resetAt: number }>();

function addressKey(scope: AddressRateLimitScope, email: string): string {
  const digest = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `ratelimit:address:${scope}:${digest}`;
}

/**
 * Count one attempt for `email` under `scope`. Returns whether it is within
 * the cap and, when it isn't, how many seconds until the window resets.
 * Keys hold a hash of the address, never the address itself.
 */
export async function consumeAddressQuota(
  scope: AddressRateLimitScope,
  email: string,
  limit: AddressRateLimit = ADDRESS_RATE_LIMITS[scope],
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const key = addressKey(scope, email);
  try {
    const { cacheManager } = await import('../utils/redis');
    const result = (await cacheManager.eval(INCR_WITH_TTL, 1, key, limit.windowSeconds)) as [number, number];
    const count = Number(result?.[0] ?? 0);
    const ttl = Number(result?.[1] ?? limit.windowSeconds);
    if (count > limit.max) {
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : limit.windowSeconds };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (err) {
    logger.warn({ err, scope }, 'Per-address rate limit: Redis unavailable, using in-memory counter');
    const now = Date.now();
    let entry = memoryCounters.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + limit.windowSeconds * 1000 };
      memoryCounters.set(key, entry);
    }
    entry.count++;
    if (entry.count > limit.max) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Test helper: forget in-memory fallback counters. */
export function resetAddressQuotaMemory(): void {
  memoryCounters.clear();
}

// ============================================================================
// Service
// ============================================================================

interface SuccessOutcome {
  status: 'verified' | 'already_verified';
  appointmentId: string;
  therapistName: string;
  bookingMethod: string;
  /** The therapist's external calendar, for direct-link bookings (unsanitised). */
  bookingLink: string | null;
}

export type VerifyOutcome =
  | SuccessOutcome
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'no_longer_active'; therapistName: string }
  | { status: 'duplicate'; therapistName: string }
  | { status: 'thread_limit'; therapistName: string; maxAllowed: number; activeCount: number }
  | { status: 'therapist_unavailable'; therapistName: string }
  | { status: 'retry' };

export type ConfirmationPageState =
  | { status: 'confirm'; therapistName: string; email: string }
  | (SuccessOutcome & { status: 'already_verified' })
  | Extract<VerifyOutcome, { status: 'invalid' | 'expired' | 'no_longer_active' }>;

const EXPIRY_LOCK = {
  KEY: 'lock:booking-verification-expiry',
  TTL_SECONDS: 120,
  RENEWAL_INTERVAL_MS: 30_000,
};

class BookingVerificationService extends LockedPeriodicService<{ expired: number }> {
  constructor() {
    super({
      name: 'booking-verification-expiry',
      intervalMs: 10 * 60 * 1000,
      startupDelayMs: 4 * 60 * 1000,
      lockKey: EXPIRY_LOCK.KEY,
      lockTtlSeconds: EXPIRY_LOCK.TTL_SECONDS,
      renewalIntervalMs: EXPIRY_LOCK.RENEWAL_INTERVAL_MS,
    });
  }

  protected async tick(): Promise<{ expired: number }> {
    return this.expireUnverifiedBookings();
  }

  /**
   * Email the confirmation link for an unverified request and stamp
   * `emailVerificationSentAt`. The stamp is claimed atomically BEFORE the
   * send (so two concurrent resubmits can't both send) and is skipped when
   * the last email went out less than `minIntervalMs` ago.
   */
  async sendVerification(
    appointmentId: string,
    options: { minIntervalMs?: number } = {},
  ): Promise<{ sent: boolean; reason?: 'not_found' | 'already_verified' | 'too_soon' | 'send_failed' }> {
    const row = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: { id: true, userName: true, userEmail: true, therapistName: true, emailVerifiedAt: true },
    });
    if (!row) return { sent: false, reason: 'not_found' };
    if (row.emailVerifiedAt) return { sent: false, reason: 'already_verified' };

    const now = new Date();
    const minIntervalMs = options.minIntervalMs ?? 0;
    const claim = await prisma.appointmentRequest.updateMany({
      where: {
        id: appointmentId,
        emailVerifiedAt: null,
        ...(minIntervalMs > 0
          ? { OR: [{ emailVerificationSentAt: null }, { emailVerificationSentAt: { lt: new Date(now.getTime() - minIntervalMs) } }] }
          : {}),
      },
      data: { emailVerificationSentAt: now },
    });
    if (claim.count !== 1) return { sent: false, reason: 'too_soon' };

    const token = generateBookingVerificationToken(row.id, row.userEmail);
    const verificationUrl = buildVerificationUrl(row.id, token);
    try {
      const [subjectTemplate, bodyTemplate, coordinatorName] = await Promise.all([
        getSettingValue<string>('email.bookingVerificationSubject'),
        getSettingValue<string>('email.bookingVerificationBody'),
        getSettingValue<string>('agent.fromName'),
      ]);
      const variables = {
        userName: firstName(row.userName, row.userEmail.split('@')[0]),
        therapistName: row.therapistName,
        verificationUrl,
        expiryHours: String(BOOKING_VERIFICATION_VALIDITY_HOURS),
        coordinatorName: coordinatorName || 'Justin Time',
      };
      await sendEmail({
        to: row.userEmail,
        subject: renderTemplate(subjectTemplate, variables),
        body: renderTemplate(bodyTemplate, variables),
      });
      logger.info({ appointmentId }, 'Booking verification email sent');
      return { sent: true };
    } catch (err) {
      logger.error({ err, appointmentId }, 'Failed to send booking verification email');
      return { sent: false, reason: 'send_failed' };
    }
  }

  /**
   * What the confirmation link's GET should show. Read-only: never
   * verifies (see the module doc on link scanners).
   */
  async describeConfirmation(appointmentId: string, token: string): Promise<ConfirmationPageState> {
    const loaded = await this.loadForToken(appointmentId, token);
    if (!loaded.ok) return { status: 'invalid' };
    const { row, tokenState } = loaded;
    if (row.emailVerifiedAt) return this.successOutcome(row, 'already_verified');
    if (tokenState === 'expired') return { status: 'expired' };
    if (!(PRE_BOOKING_STATUSES as readonly string[]).includes(row.status)) {
      return { status: 'no_longer_active', therapistName: row.therapistName };
    }
    return { status: 'confirm', therapistName: row.therapistName, email: row.userEmail };
  }

  /**
   * Confirm the requester owns the address and activate the booking.
   * Idempotent: an already-verified request reports `already_verified`
   * (even after the link's 24 h have passed) and runs nothing twice.
   */
  async verify(appointmentId: string, token: string, requestId = 'booking-verify'): Promise<VerifyOutcome> {
    const loaded = await this.loadForToken(appointmentId, token);
    if (!loaded.ok) return { status: 'invalid' };
    const { row, tokenState } = loaded;

    if (row.emailVerifiedAt) return this.successOutcome(row, 'already_verified');
    if (tokenState === 'expired') return { status: 'expired' };
    if (!(PRE_BOOKING_STATUSES as readonly string[]).includes(row.status)) {
      return { status: 'no_longer_active', therapistName: row.therapistName };
    }

    const maxActiveThreads = await getSettingValue<number>('general.maxActiveThreadsPerUser');

    type TxResult = ActivationFailure | { ok: false; reason: 'already_verified' } | { ok: true; effectKey: string };
    let result: TxResult;
    try {
      result = await prisma.$transaction(
        async (tx): Promise<TxResult> => {
          const failure = await checkActivationPreconditions(tx, {
            userEmail: row.userEmail,
            therapistHandle: row.therapistHandle,
            maxActiveThreads,
            excludeId: row.id,
            availabilityEmail: '',
          });
          if (failure) return failure;

          // Conditional stamp: exactly one concurrent click wins.
          const now = new Date();
          const claimed = await tx.appointmentRequest.updateMany({
            where: { id: row.id, emailVerifiedAt: null },
            data: { emailVerifiedAt: now, lastActivityAt: now },
          });
          if (claimed.count !== 1) return { ok: false, reason: 'already_verified' };

          const effect = await activateBookingInTx(tx, row);
          return { ok: true, effectKey: effect.idempotencyKey };
        },
        { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 },
      );
    } catch (err) {
      if (isSerializationError(err) || (err instanceof Error && err.message.includes('could not serialize'))) {
        logger.warn({ appointmentId }, 'Booking verification hit a serialization conflict');
        return { status: 'retry' };
      }
      throw err;
    }

    if (!result.ok) {
      switch (result.reason) {
        case 'already_verified':
          return this.successOutcome(row, 'already_verified');
        case 'duplicate':
          return { status: 'duplicate', therapistName: row.therapistName };
        case 'thread_limit':
          return {
            status: 'thread_limit',
            therapistName: row.therapistName,
            maxAllowed: result.maxAllowed,
            activeCount: result.activeCount,
          };
        default:
          logger.info({ appointmentId, availability: result.availability }, 'Verified booking but therapist is no longer available');
          return { status: 'therapist_unavailable', therapistName: row.therapistName };
      }
    }

    logger.info({ appointmentId }, 'Booking email verified; starting scheduling');

    const [user, therapist] = await Promise.all([
      row.userId ? prisma.user.findUnique({ where: { id: row.userId }, select: { country: true } }) : null,
      row.therapistId ? prisma.therapist.findUnique({ where: { id: row.therapistId }, select: { country: true } }) : null,
    ]);
    runPostActivationEffects({
      requestId,
      justinTimeEffectKey: result.effectKey,
      context: {
        appointmentRequestId: row.id,
        userName: row.userName ?? '',
        userEmail: row.userEmail,
        therapistEmail: row.therapistEmail,
        therapistName: row.therapistName,
        therapistAvailability: (row.therapistAvailability as Record<string, unknown> | null) ?? null,
        bookingMethod: row.bookingMethod === 'direct_link' ? 'direct_link' : 'agent_negotiated',
        userCountry: user?.country ?? 'UK',
        therapistCountry: therapist?.country ?? 'UK',
      },
    });

    return this.successOutcome(row, 'verified');
  }

  /**
   * Delete requests nobody confirmed within the link's validity. They never
   * reached the agent, the therapist or Slack, so deleting (rather than a
   * lifecycle cancel, which would email both parties) is the honest undo.
   */
  async expireUnverifiedBookings(now: Date = new Date()): Promise<{ expired: number }> {
    const cutoff = new Date(now.getTime() - VALIDITY_MS);
    const stale = await prisma.appointmentRequest.findMany({
      where: { emailVerifiedAt: null, createdAt: { lt: cutoff } },
      select: { id: true, therapistHandle: true, createdAt: true },
      take: 500,
    });
    if (stale.length === 0) return { expired: 0 };

    // Re-assert the predicate in the delete so a request verified between
    // the read and here survives.
    const { count } = await prisma.appointmentRequest.deleteMany({
      where: { id: { in: stale.map((s) => s.id) }, emailVerifiedAt: null, createdAt: { lt: cutoff } },
    });
    logger.info(
      { expired: count, appointmentIds: stale.map((s) => s.id), cutoff: cutoff.toISOString() },
      'Deleted booking requests whose email was never confirmed',
    );
    return { expired: count };
  }

  private async loadForToken(appointmentId: string, token: string) {
    // Cheap signature check before touching the database.
    if (!token || appointmentIdFromToken(token) !== appointmentId) {
      return { ok: false } as const;
    }
    const row = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        userName: true,
        userEmail: true,
        userId: true,
        therapistId: true,
        therapistHandle: true,
        therapistName: true,
        therapistEmail: true,
        therapistAvailability: true,
        bookingMethod: true,
        status: true,
        emailVerifiedAt: true,
      },
    });
    if (!row) return { ok: false } as const;
    const tokenState = checkBookingVerificationToken(token, row.id, row.userEmail);
    if (tokenState === 'invalid') return { ok: false } as const;
    return { ok: true, row, tokenState } as const;
  }

  private async successOutcome<S extends 'verified' | 'already_verified'>(
    row: { id: string; therapistName: string; therapistId: string | null; bookingMethod: string },
    status: S,
  ): Promise<SuccessOutcome & { status: S }> {
    let bookingLink: string | null = null;
    if (row.bookingMethod === 'direct_link' && row.therapistId) {
      const therapist = await prisma.therapist.findUnique({
        where: { id: row.therapistId },
        select: { bookingLink: true },
      });
      bookingLink = therapist?.bookingLink ?? null;
    }
    return { status, appointmentId: row.id, therapistName: row.therapistName, bookingMethod: row.bookingMethod, bookingLink };
  }
}

export const bookingVerificationService = new BookingVerificationService();

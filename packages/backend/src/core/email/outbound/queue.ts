/**
 * Pending-email delivery, shared by BOTH consumers of `pending_emails`:
 * the BullMQ worker (`services/email-queue.service.ts`) and the DB poller
 * (`processPendingEmails` below, the fallback when BullMQ/Redis is down).
 *
 * ATOMIC CLAIM (#8). Both consumers used to "check status, then send" the
 * same rows on nearly identical backoff schedules, so a retry could be
 * sent twice. Every attempt now starts with `claimPendingEmail`, a single
 * conditional UPDATE `pending → sending` — exactly one consumer wins. The
 * claim is a lease: `lastRetryAt` holds the claim time, only the holder
 * (matched on that timestamp) may move the row on, and a row stuck in
 * `sending` for longer than `SENDING_LEASE_MS` (a crashed holder) is put
 * back to `pending` by `expireStaleSendingLeases` on the next poll.
 *
 * Statuses: pending → sending → sent | pending (retry) | abandoned |
 * skipped. `skipped` = an agent conversation email whose appointment was
 * taken into human control, or closed, before it could be sent (the same
 * atomic re-check the direct send path makes).
 *
 * The DB row's retryCount is the single authority for abandonment, so the
 * two consumers can interleave attempts without either one abandoning
 * early or retrying forever.
 *
 * Idempotency is preserved via a short-lived Redis send-guard keyed by row
 * id — if Gmail succeeds but the DB update fails, the next attempt skips
 * the send and only updates the DB row.
 *
 * On permanent failure the abandonment is appended to the appointment's
 * notes AND reported through the registered abandon notifier (a deduped
 * Slack alert, wired by email-queue.service.ts — core/ cannot import the
 * Slack service directly; see core/README.md).
 *
 * The poller also:
 *   - monitors queue depth and warns at backlog thresholds
 *   - dynamically adjusts batch size under load
 *   - consumes legacy `RETRY_JUSTINTIME_START` marker rows silently
 *   - aborts the batch early if the caller's lock is invalidated
 */

import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/database';
import { redis } from '../../../utils/redis';
import { EMAIL, PENDING_EMAIL_QUEUE, TERMINAL_STATUSES } from '../../../constants';
import { extractTrackingCode } from '../../../services/tracking-code.service';
import { sendEmail } from './send';

/** A claim older than this is considered abandoned by a crashed holder. */
export const SENDING_LEASE_MS = 10 * 60 * 1000;

const SEND_GUARD_PREFIX = 'email:send-guard:';
const SEND_GUARD_TTL_SECONDS = 5 * 3600; // must exceed the max retry backoff (4h)

/** Exponential backoff with 10% jitter (1m, 5m, 15m, 1h, 4h). `attempt` is 1-based. */
export function retryDelayMs(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 1) - 1, EMAIL.RETRY_DELAYS_MS.length - 1);
  const baseDelay = EMAIL.RETRY_DELAYS_MS[idx];
  return baseDelay + Math.floor(baseDelay * 0.1 * Math.random());
}

// ─── Abandon notifier (registered by the service layer) ─────────────────

export interface EmailAbandonedEvent {
  pendingEmailId: string;
  appointmentId: string | null;
  subject: string;
  attempts: number;
  errorMessage: string;
}

let abandonedNotifier: ((event: EmailAbandonedEvent) => Promise<unknown>) | null = null;

/** Called once at startup (email-queue.service.ts) to wire the Slack alert. */
export function registerEmailAbandonedNotifier(
  notifier: ((event: EmailAbandonedEvent) => Promise<unknown>) | null,
): void {
  abandonedNotifier = notifier;
}

// ─── Claim / lease ───────────────────────────────────────────────────────

/**
 * Atomically claim a pending row for sending. Returns the claim time (the
 * lease identity) or null when the row is not `pending` — sent, abandoned,
 * or currently claimed by the other consumer.
 */
export async function claimPendingEmail(pendingEmailId: string): Promise<Date | null> {
  const claimedAt = new Date();
  const { count } = await prisma.pendingEmail.updateMany({
    where: { id: pendingEmailId, status: 'pending' },
    data: { status: 'sending', lastRetryAt: claimedAt },
  });
  return count === 1 ? claimedAt : null;
}

/** Put rows whose holder died mid-send back to `pending`. */
export async function expireStaleSendingLeases(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.pendingEmail.updateMany({
    where: { status: 'sending', lastRetryAt: { lt: new Date(now.getTime() - SENDING_LEASE_MS) } },
    data: { status: 'pending' },
  });
  if (count > 0) {
    logger.warn({ count, leaseMs: SENDING_LEASE_MS }, 'Released stale pending-email send claims back to pending');
  }
  return count;
}

/** Owner-checked transition out of `sending`. False = we no longer hold the claim. */
async function releaseClaim(
  pendingEmailId: string,
  claimedAt: Date,
  data: {
    status: string;
    errorMessage?: string | null;
    retryCount?: number;
    lastRetryAt?: Date;
    nextRetryAt?: Date | null;
    sentAt?: Date;
  },
): Promise<boolean> {
  const { count } = await prisma.pendingEmail.updateMany({
    where: { id: pendingEmailId, status: 'sending', lastRetryAt: claimedAt },
    data,
  });
  if (count === 0) {
    logger.warn(
      { pendingEmailId, targetStatus: data.status },
      'Pending-email claim no longer held (lease expired and re-claimed?) — leaving the row to its current holder',
    );
  }
  return count === 1;
}

// ─── One attempt ─────────────────────────────────────────────────────────

export type SendAttemptResult =
  /** Not ours to send: already sent/abandoned, or the other consumer holds it. */
  | { outcome: 'not-claimed' }
  | { outcome: 'sent' | 'already-sent' | 'skipped' | 'marker' }
  | { outcome: 'retrying'; error: Error; attempt: number; nextRetryAt: Date }
  | { outcome: 'abandoned'; error: Error; attempt: number };

/**
 * Claim and send one pending email. Never throws for a send failure — it
 * records the retry (or abandonment) on the row and reports it; a DB
 * failure on the claim itself does propagate.
 *
 * `threadIdHint` is the thread the enqueuer asked for (BullMQ job data);
 * otherwise the appointment's thread for the recipient is used.
 */
export async function attemptPendingEmailSend(
  pendingEmailId: string,
  traceId: string,
  threadIdHint?: string,
): Promise<SendAttemptResult> {
  const claimedAt = await claimPendingEmail(pendingEmailId);
  if (!claimedAt) return { outcome: 'not-claimed' };

  const row = await prisma.pendingEmail.findUnique({
    where: { id: pendingEmailId },
    include: {
      appointment: {
        select: { gmailThreadId: true, therapistGmailThreadId: true, therapistEmail: true, trackingCode: true },
      },
    },
  });
  if (!row) return { outcome: 'not-claimed' }; // deleted (cascade) since the claim

  try {
    const outcome = await deliverClaimed(row, claimedAt, traceId, threadIdHint);
    return { outcome };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const attempt = row.retryCount + 1;
    if (attempt >= EMAIL.MAX_RETRIES) {
      await abandonClaimed(row, claimedAt, attempt, error.message);
      return { outcome: 'abandoned', error, attempt };
    }
    const nextRetryAt = new Date(Date.now() + retryDelayMs(attempt));
    await releaseClaim(row.id, claimedAt, {
      status: 'pending',
      errorMessage: error.message,
      retryCount: attempt,
      lastRetryAt: new Date(),
      nextRetryAt,
    });
    logger.warn(
      { traceId, pendingEmailId, attempt, maxAttempts: EMAIL.MAX_RETRIES, nextRetryAt, err: error.message },
      `Email send failed - scheduling retry ${attempt}/${EMAIL.MAX_RETRIES}`,
    );
    return { outcome: 'retrying', error, attempt, nextRetryAt };
  }
}

type ClaimedRow = {
  id: string;
  toEmail: string;
  subject: string;
  body: string;
  appointmentId: string | null;
  retryCount: number;
  appointment: {
    gmailThreadId: string | null;
    therapistGmailThreadId: string | null;
    therapistEmail: string;
    trackingCode: string | null;
  } | null;
};

/**
 * An appointment email whose subject carries the appointment's own
 * tracking code was composed in an agent turn: `sendAppointmentEmail` is
 * the only writer of that prefix. Lifecycle notifications (confirmation,
 * cancellation, reminders, feedback) never carry it — and must still go
 * out for cancelled/completed or human-controlled appointments.
 */
export function isAgentConversationEmail(subject: string, trackingCode: string | null | undefined): boolean {
  if (!trackingCode) return false;
  const code = extractTrackingCode(subject);
  return code !== null && code.toUpperCase() === trackingCode.toUpperCase();
}

function isRetryMarker(body: string): boolean {
  if (!body.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(body);
    return !!parsed && parsed.type === 'RETRY_JUSTINTIME_START';
  } catch {
    return false;
  }
}

async function deliverClaimed(
  row: ClaimedRow,
  claimedAt: Date,
  traceId: string,
  threadIdHint?: string,
): Promise<'sent' | 'already-sent' | 'skipped' | 'marker'> {
  // Legacy internal retry signal stored as a PendingEmail row — not an email.
  if (isRetryMarker(row.body)) {
    logger.info({ traceId, emailId: row.id }, 'Skipping JustinTime retry marker - not a real email');
    await releaseClaim(row.id, claimedAt, { status: 'sent', sentAt: new Date() });
    return 'marker';
  }

  const apt = row.appointment;

  // Agent emails: the same atomic human-control / terminal-status re-check
  // the direct send path makes (domain/scheduling/agent/send.ts). A queued
  // agent email must not go out hours later to an appointment an admin
  // has since taken over, or that has been cancelled / completed.
  if (row.appointmentId && apt && isAgentConversationEmail(row.subject, apt.trackingCode)) {
    const canSend = await prisma.appointmentRequest.updateMany({
      where: {
        id: row.appointmentId,
        humanControlEnabled: false,
        status: { notIn: [...TERMINAL_STATUSES] },
      },
      data: { lastActivityAt: new Date() },
    });
    if (canSend.count === 0) {
      logger.warn(
        { traceId, emailId: row.id, appointmentId: row.appointmentId },
        'Queued agent email not sent: appointment is under human control or closed (atomic re-check)',
      );
      await releaseClaim(row.id, claimedAt, {
        status: 'skipped',
        errorMessage: 'Not sent: appointment was under human control or closed at send time',
      });
      return 'skipped';
    }
  }

  // Idempotent send guard: Gmail accepted this email on an earlier attempt
  // whose DB update failed — only the DB row needs updating.
  const sendGuardKey = `${SEND_GUARD_PREFIX}${row.id}`;
  if (await redis.get(sendGuardKey)) {
    logger.info({ traceId, emailId: row.id }, 'Send guard: email already sent — skipping send, updating DB only');
    await prisma.pendingEmail.update({ where: { id: row.id }, data: { status: 'sent', sentAt: new Date() } });
    return 'already-sent';
  }

  const isTherapistEmail = !!apt && row.toEmail.toLowerCase() === apt.therapistEmail.toLowerCase();
  const threadId =
    threadIdHint ?? (apt ? (isTherapistEmail ? apt.therapistGmailThreadId : apt.gmailThreadId) ?? undefined : undefined);

  const result = await sendEmail({ to: row.toEmail, subject: row.subject, body: row.body, threadId });

  // Guard before the DB update: if the update fails, the retry won't resend.
  await redis.set(sendGuardKey, 'sent', 'EX', SEND_GUARD_TTL_SECONDS).catch(() => undefined);

  await prisma.pendingEmail.update({ where: { id: row.id }, data: { status: 'sent', sentAt: new Date() } });

  if (row.appointmentId && result.threadId) {
    await storeThreadIds(row.appointmentId, isTherapistEmail, result, traceId);
  }
  return 'sent';
}

/**
 * Store the Gmail thread of the first email to each party on the
 * appointment, exactly as the direct send path does — a queued first
 * email used to start an untracked thread, so the reply matched nothing
 * and was eventually abandoned as unmatched (E11). Conditional on the
 * column still being null, so a concurrent first send can't overwrite it.
 * Best effort.
 */
async function storeThreadIds(
  appointmentId: string,
  isTherapistEmail: boolean,
  result: { threadId: string; messageId: string },
  traceId: string,
): Promise<void> {
  try {
    const updated = isTherapistEmail
      ? await prisma.appointmentRequest.updateMany({
          where: { id: appointmentId, therapistGmailThreadId: null },
          data: { therapistGmailThreadId: result.threadId },
        })
      : await prisma.appointmentRequest.updateMany({
          where: { id: appointmentId, gmailThreadId: null },
          data: { gmailThreadId: result.threadId, initialMessageId: result.messageId },
        });
    if (updated.count > 0) {
      logger.info(
        { traceId, appointmentId, threadId: result.threadId, party: isTherapistEmail ? 'therapist' : 'client' },
        'Stored Gmail thread ID for appointment (queued send)',
      );
    }
  } catch (err) {
    logger.error({ traceId, appointmentId, err }, 'CRITICAL: Failed to store thread ID after queued send - email routing may be unreliable');
  }
}

async function abandonClaimed(row: ClaimedRow, claimedAt: Date, attempts: number, errorMessage: string): Promise<void> {
  const now = new Date();
  logger.error(
    { emailId: row.id, appointmentId: row.appointmentId, attempts, err: errorMessage },
    'Email permanently failed after max retries - abandoning',
  );
  const released = await releaseClaim(row.id, claimedAt, {
    status: 'abandoned',
    errorMessage: `Abandoned after ${attempts} attempts: ${errorMessage}`,
    retryCount: attempts,
    lastRetryAt: now,
  });
  if (!released) return;

  // Propagate to the appointment for admin visibility (atomic append).
  if (row.appointmentId) {
    const note = `\n\n[EMAIL ABANDONED - ${now.toISOString()}]\nTo: ${row.toEmail}\nSubject: ${row.subject.slice(0, 100)}${row.subject.length > 100 ? '...' : ''}\nFailed after ${attempts} retries: ${errorMessage.slice(0, 200)}`;
    try {
      await prisma.$executeRaw`
        UPDATE "appointment_requests"
        SET "notes" = COALESCE("notes", '') || ${note},
            "conversation_stall_alert_at" = ${now},
            "conversation_stall_acknowledged" = false
        WHERE "id" = ${row.appointmentId}
      `;
    } catch (err) {
      logger.error({ emailId: row.id, appointmentId: row.appointmentId, err }, 'Failed to append email-abandonment note');
    }
  }

  // The note alone was invisible: the stall-alert path skips the row and
  // clears the dashboard flag within the hour (#9). Alert explicitly.
  const event: EmailAbandonedEvent = {
    pendingEmailId: row.id,
    appointmentId: row.appointmentId,
    subject: row.subject,
    attempts,
    errorMessage,
  };
  if (!abandonedNotifier) {
    logger.error({ emailId: row.id }, 'No email-abandoned notifier registered — abandonment not alerted');
    return;
  }
  await abandonedNotifier(event).catch((err) =>
    logger.error({ emailId: row.id, err }, 'Failed to send email-abandoned alert'),
  );
}

// ─── DB poller ───────────────────────────────────────────────────────────

export async function processPendingEmails(
  traceId: string,
  isLockValid?: () => boolean,
): Promise<{
  sent: number;
  failed: number;
  retrying: number;
  queueDepth: number;
  batchSize: number;
}> {
  const now = new Date();

  // STEP 0: recover rows whose sender crashed mid-send.
  try {
    await expireStaleSendingLeases(now);
  } catch (err) {
    logger.warn({ traceId, err }, 'Failed to expire stale pending-email send claims');
  }

  // STEP 1: monitor queue depth before processing.
  let queueDepth = 0;
  try {
    queueDepth = await prisma.pendingEmail.count({
      where: {
        status: 'pending',
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: now } },
        ],
      },
    });
  } catch (countError) {
    logger.warn({ traceId, error: countError }, 'Failed to count pending emails - proceeding with default batch');
  }

  if (queueDepth >= PENDING_EMAIL_QUEUE.BACKLOG_CRITICAL_THRESHOLD) {
    logger.error(
      { traceId, queueDepth, threshold: PENDING_EMAIL_QUEUE.BACKLOG_CRITICAL_THRESHOLD },
      'CRITICAL: Email queue backlog is very large - immediate attention required',
    );
  } else if (queueDepth >= PENDING_EMAIL_QUEUE.BACKLOG_WARNING_THRESHOLD) {
    logger.warn(
      { traceId, queueDepth, threshold: PENDING_EMAIL_QUEUE.BACKLOG_WARNING_THRESHOLD },
      'Email queue backlog is growing - consider investigating',
    );
  }

  // STEP 2: calculate dynamic batch size based on queue depth.
  let batchSize: number = PENDING_EMAIL_QUEUE.DEFAULT_BATCH_SIZE;
  if (queueDepth >= PENDING_EMAIL_QUEUE.BACKLOG_CRITICAL_THRESHOLD) {
    batchSize = Math.min(
      PENDING_EMAIL_QUEUE.DEFAULT_BATCH_SIZE * PENDING_EMAIL_QUEUE.BATCH_SIZE_MULTIPLIER_CRITICAL,
      PENDING_EMAIL_QUEUE.MAX_BATCH_SIZE,
    );
    logger.info({ traceId, queueDepth, batchSize }, 'Increasing batch size due to critical backlog');
  } else if (queueDepth >= PENDING_EMAIL_QUEUE.BACKLOG_WARNING_THRESHOLD) {
    batchSize = Math.min(
      PENDING_EMAIL_QUEUE.DEFAULT_BATCH_SIZE * PENDING_EMAIL_QUEUE.BATCH_SIZE_MULTIPLIER_WARNING,
      PENDING_EMAIL_QUEUE.MAX_BATCH_SIZE,
    );
    logger.info({ traceId, queueDepth, batchSize }, 'Increasing batch size due to backlog');
  }

  logger.info({ traceId, queueDepth, batchSize }, 'Processing pending emails');

  let sent = 0;
  let failed = 0;
  let retrying = 0;

  try {
    // Only emails ready for retry (nextRetryAt <= now, or null for new).
    const pendingEmails = await prisma.pendingEmail.findMany({
      where: {
        status: 'pending',
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: now } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: { id: true },
    });

    for (const email of pendingEmails) {
      // Abort early if the caller's lock was lost to another instance.
      if (isLockValid && !isLockValid()) {
        logger.warn(
          { traceId, emailId: email.id, sent, failed },
          'Aborting email processing - lock was lost to another instance',
        );
        break;
      }

      let result: SendAttemptResult;
      try {
        result = await attemptPendingEmailSend(email.id, traceId);
      } catch (err) {
        logger.error({ traceId, emailId: email.id, err }, 'Failed to claim / load pending email - will retry next run');
        continue;
      }
      switch (result.outcome) {
        case 'sent':
        case 'already-sent':
        case 'marker':
          sent++;
          break;
        case 'abandoned':
          failed++;
          break;
        case 'retrying':
          retrying++;
          break;
        case 'skipped':
        case 'not-claimed':
          break;
      }
    }
  } catch (error) {
    logger.error({ error, traceId }, 'Failed to process pending emails');
    throw error;
  }

  logger.info(
    {
      traceId,
      sent,
      failed,
      retrying,
      queueDepth,
      batchSize,
      remainingAfterBatch: Math.max(0, queueDepth - sent - failed),
    },
    'Finished processing pending emails',
  );
  return { sent, failed, retrying, queueDepth, batchSize };
}

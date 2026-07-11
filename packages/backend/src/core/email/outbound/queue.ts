/**
 * Pending-email queue drain.
 *
 * Maintains thread continuity by looking up thread IDs from linked
 * appointments. Uses exponential backoff with jitter for retries up
 * to `EMAIL.MAX_RETRIES`. Idempotency is preserved via a short-lived
 * Redis send-guard keyed by row id — if Gmail succeeds but the DB
 * update fails on a prior attempt, the next attempt skips the send
 * and only updates the DB row.
 *
 * Features:
 *   - Monitors queue depth and warns at backlog thresholds
 *   - Dynamically adjusts batch size under load (warning + critical
 *     thresholds → multipliers, capped at MAX_BATCH_SIZE)
 *   - Detects internal `RETRY_JUSTINTIME_START` markers stored as
 *     PendingEmail rows and consumes them silently (they are NOT
 *     real emails, just signals from the failure handler)
 *   - On permanent failure (max retries hit), propagates the
 *     abandonment to the linked appointment's notes column so admins
 *     can see it on the dashboard
 *   - Aborts the batch early if the caller's lock is invalidated by
 *     another instance (prevents duplicate sends across instances)
 */

import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/database';
import { redis } from '../../../utils/redis';
import { EMAIL, PENDING_EMAIL_QUEUE } from '../../../constants';
import { sendEmail } from './send';

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
    logger.info(
      { traceId, queueDepth, batchSize },
      'Increasing batch size due to critical backlog',
    );
  } else if (queueDepth >= PENDING_EMAIL_QUEUE.BACKLOG_WARNING_THRESHOLD) {
    batchSize = Math.min(
      PENDING_EMAIL_QUEUE.DEFAULT_BATCH_SIZE * PENDING_EMAIL_QUEUE.BATCH_SIZE_MULTIPLIER_WARNING,
      PENDING_EMAIL_QUEUE.MAX_BATCH_SIZE,
    );
    logger.info(
      { traceId, queueDepth, batchSize },
      'Increasing batch size due to backlog',
    );
  }

  logger.info({ traceId, queueDepth, batchSize }, 'Processing pending emails');

  let sent = 0;
  let failed = 0;
  let retrying = 0;

  try {
    // Include the appointment relation to get thread IDs. Only process
    // emails ready for retry (nextRetryAt <= now or null for new
    // emails). Use dynamic batch size based on queue depth.
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
      include: {
        appointment: {
          select: {
            gmailThreadId: true,
            therapistGmailThreadId: true,
            therapistEmail: true,
          },
        },
      },
    });

    for (const email of pendingEmails) {
      // Check lock validity before each email to abort early if lock
      // was lost. Prevents duplicate processing when another instance
      // takes over.
      if (isLockValid && !isLockValid()) {
        logger.warn(
          { traceId, emailId: email.id, sent, failed },
          'Aborting email processing - lock was lost to another instance',
        );
        break; // Exit loop immediately, don't process more emails
      }

      try {
        // Detect and skip internal retry markers stored as PendingEmail
        // records. The JustinTime failure handler stores a JSON blob with
        // type: 'RETRY_JUSTINTIME_START' as a PendingEmail body. These
        // are internal retry signals, not actual emails.
        const bodyContent: string = email.body;
        try {
          const parsed = JSON.parse(bodyContent);
          if (parsed && parsed.type === 'RETRY_JUSTINTIME_START') {
            logger.info(
              { traceId, emailId: email.id, appointmentId: parsed.appointmentRequestId },
              'Skipping JustinTime retry marker - not a real email',
            );
            await prisma.pendingEmail.update({
              where: { id: email.id },
              data: { status: 'sent', sentAt: new Date() },
            });
            sent++;
            continue;
          }
        } catch {
          // Not JSON - this is a normal email body, proceed.
        }

        // Look up the appropriate thread ID if the appointment exists.
        let threadId: string | undefined;
        if (email.appointment) {
          const isTherapistEmail = email.toEmail.toLowerCase() === email.appointment.therapistEmail.toLowerCase();
          threadId = isTherapistEmail
            ? (email.appointment.therapistGmailThreadId ?? undefined)
            : (email.appointment.gmailThreadId ?? undefined);
        }

        // Idempotent send guard: check if this email was already sent.
        // Prevents duplicate sends when Gmail succeeds but DB update
        // fails on a prior attempt.
        const sendGuardKey = `email:send-guard:${email.id}`;
        let alreadySent = false;
        try {
          const guardValue = await redis.get(sendGuardKey);
          if (guardValue) {
            alreadySent = true;
            logger.info(
              { traceId, emailId: email.id },
              'Send guard: email already sent — skipping send, updating DB only',
            );
          }
        } catch {
          // Redis unavailable — proceed with send (better duplicate
          // than no send).
        }

        if (!alreadySent) {
          await sendEmail({
            to: email.toEmail,
            subject: email.subject,
            body: bodyContent,
            threadId,
          });

          // Set send guard in Redis before DB update. TTL must exceed
          // max retry backoff (currently 4h).
          try {
            await redis.set(sendGuardKey, 'sent', 'EX', 5 * 3600);
          } catch {
            // Redis unavailable — proceed without guard.
          }
        }

        await prisma.pendingEmail.update({
          where: { id: email.id },
          data: {
            status: 'sent',
            sentAt: new Date(),
          },
        });

        sent++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const newRetryCount = email.retryCount + 1;

        if (newRetryCount >= EMAIL.MAX_RETRIES) {
          logger.error(
            { error, traceId, emailId: email.id, retryCount: newRetryCount },
            'Email permanently failed after max retries - abandoning',
          );

          await prisma.pendingEmail.update({
            where: { id: email.id },
            data: {
              status: 'abandoned',
              errorMessage: `Abandoned after ${newRetryCount} attempts: ${errorMessage}`,
              retryCount: newRetryCount,
              lastRetryAt: now,
            },
          });

          // Propagate abandonment to the appointment for admin visibility.
          // Ensures admins are notified when critical emails fail
          // permanently.
          if (email.appointmentId) {
            const abandonmentNote = `\n\n[EMAIL ABANDONED - ${now.toISOString()}]\nTo: ${email.toEmail}\nSubject: ${email.subject.slice(0, 100)}${email.subject.length > 100 ? '...' : ''}\nFailed after ${newRetryCount} retries: ${errorMessage.slice(0, 200)}`;

            // Atomic append to prevent note loss under concurrent updates.
            await prisma.$executeRaw`
              UPDATE "appointment_requests"
              SET "notes" = COALESCE("notes", '') || ${abandonmentNote},
                  "conversation_stall_alert_at" = ${now},
                  "conversation_stall_acknowledged" = false
              WHERE "id" = ${email.appointmentId}
            `;

            logger.warn(
              { traceId, emailId: email.id, appointmentId: email.appointmentId },
              'Email abandonment propagated to appointment for admin notification',
            );
          }

          failed++;
        } else {
          // Exponential backoff with jitter. Jitter prevents thundering
          // herd when multiple emails fail simultaneously.
          const baseDelayMs = EMAIL.RETRY_DELAYS_MS[Math.min(newRetryCount - 1, EMAIL.RETRY_DELAYS_MS.length - 1)];
          const jitter = Math.floor(baseDelayMs * 0.1 * Math.random());
          const delayMs = baseDelayMs + jitter;
          const nextRetryAt = new Date(now.getTime() + delayMs);

          logger.warn(
            { error, traceId, emailId: email.id, retryCount: newRetryCount, nextRetryAt },
            `Email send failed - scheduling retry ${newRetryCount}/${EMAIL.MAX_RETRIES}`,
          );

          await prisma.pendingEmail.update({
            where: { id: email.id },
            data: {
              errorMessage,
              retryCount: newRetryCount,
              lastRetryAt: now,
              nextRetryAt,
            },
          });

          retrying++;
        }
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

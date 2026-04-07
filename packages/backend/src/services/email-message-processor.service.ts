import { gmail_v1 } from 'googleapis';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { renewLock, releaseLock } from '../utils/redis-locks';
import {
  decodeHtmlEntities,
  stripHtml,
  encodeEmailHeader,
} from '../utils/email-encoding';
// FIX #5 (refactored): Dependency injection to break circular dependency.
// Instead of require() at call sites, the AgentProcessor interface is registered
// at startup by server.ts after all modules are loaded.
export interface AgentProcessor {
  processEmailReply(
    appointmentId: string,
    body: string,
    from: string,
    threadContext?: unknown,
    precomputedClassification?: unknown,
  ): Promise<{ success: boolean; message: string } | void>;
  processInquiryReply(
    inquiryId: string,
    body: string,
    from: string,
    threadContext?: unknown,
  ): Promise<{ success: boolean; message: string } | void>;
}

let agentProcessorFactory: ((traceId: string) => AgentProcessor) | null = null;

/**
 * Register the agent processor factory at startup to avoid circular imports.
 * Called from server.ts after all services are initialized.
 */
export function registerAgentProcessor(factory: (traceId: string) => AgentProcessor): void {
  agentProcessorFactory = factory;
}

function getAgentProcessor(traceId: string): AgentProcessor {
  if (!agentProcessorFactory) {
    throw new Error('AgentProcessor not registered — call registerAgentProcessor() at startup');
  }
  return agentProcessorFactory(traceId);
}
import { threadFetchingService } from './thread-fetching.service';
import { emailBounceService } from './email-bounce.service';
import { slackNotificationService } from './slack-notification.service';
import { appointmentLifecycleService } from './appointment-lifecycle.service';
import { classifyEmail } from '../utils/email-classifier';
import { EMAIL, PENDING_EMAIL_QUEUE, EMAIL_PROCESSING } from '../constants';
import {
  detectThreadDivergence,
  shouldBlockProcessing,
  getDivergenceSummary,
  logDivergence,
  recordDivergenceAlert,
  type EmailContext,
  type AppointmentContext,
} from '../utils/thread-divergence';
import { emailOAuthService, executeGmailWithProtection } from './email-oauth.service';
import { CLEANUP_CHECK_AND_RESET_SCRIPT, ATOMIC_LOCK_CHECK_SCRIPT } from '../utils/redis-scripts';
import { findMatchingAppointmentRequest } from '../utils/thread-matcher';

// Redis keys — imported from centralized constants
const {
  PROCESSED_MESSAGES_KEY,
  MESSAGE_LOCK_PREFIX,
  UNMATCHED_ATTEMPT_PREFIX,
  PROCESSING_ALERT_DEDUP_PREFIX,
  PROCESSED_MESSAGE_TTL_DAYS,
  MAX_UNMATCHED_ATTEMPTS,
  MAX_PROCESSING_FAILURES,
  UNMATCHED_ATTEMPT_TTL_SECONDS,
  PROCESSING_ALERT_DEDUP_TTL_SECONDS,
  CLEANUP_INTERVAL_MESSAGES,
  CLEANUP_COUNTER_KEY,
} = EMAIL_PROCESSING;

// Truncate processing-failure errors so a runaway stack trace can't blow up the row
const MAX_ERROR_LENGTH = 2000;

/**
 * Lock renewal configuration
 * Renew lock every 60 seconds to prevent expiry during long processing
 * Lock TTL is 300 seconds (5 minutes), so renewal at 60s gives 4x buffer
 */
const LOCK_RENEWAL_INTERVAL_MS = 60 * 1000;
const LOCK_TTL_SECONDS = 300;

/**
 * Creates a lock renewal manager that periodically extends the lock TTL.
 * Uses shared renewLock utility from redis-locks.ts.
 * Returns a cleanup function to stop renewal when processing is done.
 */
function createLockRenewal(
  lockKey: string,
  lockValue: string,
  onLockLost?: () => void
): { stop: () => void; isLockValid: () => boolean } {
  let isActive = true;
  let lockValid = true;

  const renewalInterval = setInterval(async () => {
    if (!isActive) return;

    const renewed = await renewLock(lockKey, lockValue, LOCK_TTL_SECONDS);
    if (!renewed) {
      lockValid = false;
      logger.error({ lockKey }, 'Lock renewal failed - lock was taken by another process');
      if (onLockLost) {
        onLockLost();
      }
      clearInterval(renewalInterval);
    }
  }, LOCK_RENEWAL_INTERVAL_MS);

  return {
    stop: () => {
      isActive = false;
      clearInterval(renewalInterval);
    },
    isLockValid: () => lockValid,
  };
}

/**
 * Safely execute a Redis operation, suppressing errors when Redis is unavailable.
 * This allows processing to continue in database-only mode.
 * The operation is best-effort - failure is logged but not thrown.
 */
async function safeRedisOp<T>(
  operation: () => Promise<T>,
  context: string,
  traceId?: string
): Promise<T | null> {
  try {
    return await operation();
  } catch (err) {
    logger.warn({ err, context, traceId }, 'Redis operation failed - continuing without Redis');
    return null;
  }
}

/**
 * Track a processing failure: increment the attempt counter, store the last
 * error, and return the new attempt count. Used by processMessage's catch
 * block to drive the abandonment threshold.
 *
 * Database is the source of truth (the previous Redis-only counter returned
 * 1 forever when Redis was down, so abandonment never triggered and the
 * scanner looped). No Redis cache — preview reads the DB directly via
 * getLastProcessingErrors, and the counter is only read by this same path
 * on the next failure, which already goes through the DB.
 *
 * Truncates errorMessage to MAX_ERROR_LENGTH so a runaway stack trace can't
 * blow up the row.
 */
async function trackProcessingFailure(
  messageId: string,
  errorMessage: string,
): Promise<number> {
  const truncated = errorMessage.slice(0, MAX_ERROR_LENGTH);

  const record = await prisma.messageProcessingFailure.upsert({
    where: { id: messageId },
    create: { id: messageId, lastError: truncated },
    update: {
      attempts: { increment: 1 },
      lastError: truncated,
      lastFailedAt: new Date(),
    },
  });

  return record.attempts;
}

/**
 * Mark a processing failure as abandoned (after exceeding MAX_PROCESSING_FAILURES).
 * The dedup record is created separately via markMessageProcessed; this only
 * flips the abandoned flag so the admin retry endpoint can find it.
 */
async function markFailureAbandoned(messageId: string): Promise<void> {
  await prisma.messageProcessingFailure.update({
    where: { id: messageId },
    data: { abandoned: true },
  });
}

/**
 * Look up the last recorded error for a message (or null if none). Used by
 * previewThreadMessages to annotate MISSED messages with their failure reason.
 *
 * Reads from the database (source of truth). The Redis cache holds attempt
 * counts only, not error text — error strings can be large and we want
 * persistence anyway.
 */
export async function getLastProcessingError(messageId: string): Promise<string | null> {
  const record = await prisma.messageProcessingFailure.findUnique({
    where: { id: messageId },
    select: { lastError: true },
  });
  return record?.lastError ?? null;
}

/**
 * Batch lookup of last errors for many messages, used by previewThreadMessages
 * so we don't N+1 a single thread.
 */
export async function getLastProcessingErrors(messageIds: string[]): Promise<Map<string, string>> {
  if (messageIds.length === 0) return new Map();
  const records = await prisma.messageProcessingFailure.findMany({
    where: { id: { in: messageIds } },
    select: { id: true, lastError: true },
  });
  return new Map(records.map((r) => [r.id, r.lastError]));
}

/**
 * Clear the failure record on successful processing so the UI shows a clean
 * state and a future failure starts a fresh attempt count.
 */
async function clearProcessingFailure(messageId: string): Promise<void> {
  await prisma.messageProcessingFailure.deleteMany({ where: { id: messageId } });
}

/**
 * Try to acquire a short-lived alert dedup lock. Returns true if this caller
 * owns the alert slot (and should send), false if another recent alert beat them.
 * Prevents the first-failure Slack alert from spamming when the scanner hits
 * the same broken message many times within the dedup window.
 */
async function acquireAlertDedupLock(messageId: string, traceId: string): Promise<boolean> {
  const key = `${PROCESSING_ALERT_DEDUP_PREFIX}${messageId}`;
  const result = await safeRedisOp(
    () => redis.set(key, '1', 'EX', PROCESSING_ALERT_DEDUP_TTL_SECONDS, 'NX'),
    'acquire processing alert dedup',
    traceId,
  );
  return result === 'OK';
}

/**
 * Mark a Gmail message as processed in both Redis (fast) and database (durable).
 * Extracted to eliminate 7x duplication of this pattern across processMessage().
 */
async function markMessageProcessed(messageId: string, traceId: string, context: string): Promise<void> {
  await Promise.all([
    safeRedisOp(
      () => redis.zadd(PROCESSED_MESSAGES_KEY, Date.now(), messageId),
      `mark ${context} as processed`,
      traceId
    ),
    prisma.processedGmailMessage.upsert({
      where: { id: messageId },
      create: { id: messageId },
      update: {},
    }),
  ]);
}

interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
}

/**
 * EmailMessageProcessorService — Individual message processing
 *
 * Responsibilities:
 * - processMessage(): lock acquisition, deduplication, MIME parsing
 * - Email body extraction and parsing
 * - Thread divergence detection delegation
 * - Bounce detection delegation
 * - Weekly mailing reply routing
 * - Message content extraction (HTML stripping, charset handling)
 * - sendEmail() and processPendingEmails()
 */
export class EmailMessageProcessorService {

  // ─── Single message processing ──────────────────────────────────────

  /**
   * Process a single email message
   *
   * IMPORTANT: To prevent race conditions (TOCTOU), we:
   * 1. First try to acquire a distributed lock
   * 2. Check if already in processed set (inside the lock)
   * 3. Mark as processed BEFORE doing any work (atomically with the lock)
   * 4. Then do the actual processing
   *
   * This ensures that even if multiple push notifications arrive simultaneously,
   * only one worker will process each message.
   */
  async processMessage(messageId: string, traceId: string): Promise<boolean> {
    // Acquire a distributed lock AND check if already processed atomically
    // This eliminates the TOCTOU race condition window
    const lockKey = `${MESSAGE_LOCK_PREFIX}${messageId}`;

    let lockCheckResult: number;
    let usingDatabaseFallback = false;

    try {
      // Use Lua script for atomic lock+check
      lockCheckResult = await redis.eval(
        ATOMIC_LOCK_CHECK_SCRIPT,
        2, // number of keys
        lockKey,
        PROCESSED_MESSAGES_KEY,
        messageId,
        traceId,
        LOCK_TTL_SECONDS.toString()
      ) as number;
    } catch (err) {
      // Redis unavailable - use database-only fallback
      // This is less efficient but allows processing to continue
      logger.warn(
        { traceId, messageId, err },
        'Redis unavailable - falling back to database-only deduplication'
      );
      usingDatabaseFallback = true;

      // FIX E4: Use advisory lock pattern with database
      // Check if message is already being processed or was processed
      // We use a serializable transaction to prevent race conditions
      try {
        const lockResult = await prisma.$transaction(async (tx) => {
          // Check if already processed
          const dbProcessed = await tx.processedGmailMessage.findUnique({
            where: { id: messageId },
          });
          if (dbProcessed) {
            return 'already_processed';
          }

          // Try to create a temporary lock record
          // Note: We'll delete this if processing fails to allow retries
          try {
            await tx.processedGmailMessage.create({
              data: { id: messageId },
            });
            return 'lock_acquired';
          } catch (insertErr: any) {
            // If insert fails due to unique constraint, another worker got there first
            if (insertErr?.code === 'P2002') {
              return 'already_locked';
            }
            throw insertErr;
          }
        }, {
          isolationLevel: 'Serializable',
        });

        if (lockResult === 'already_processed') {
          logger.debug({ traceId, messageId }, 'Message already processed (database check)');
          return false;
        }
        if (lockResult === 'already_locked') {
          logger.debug({ traceId, messageId }, 'Message being processed by another worker (database lock)');
          return false;
        }
        lockCheckResult = 1; // Acquired "lock" via database insert
      } catch (txErr) {
        // Transaction failed (likely serialization failure) - retry later
        logger.warn({ traceId, messageId, txErr }, 'Database lock transaction failed - will retry');
        return false;
      }
    }

    // Handle atomic result (only when using Redis)
    if (!usingDatabaseFallback) {
      if (lockCheckResult === -1) {
        logger.debug({ traceId, messageId }, 'Message already processed (Redis atomic check)');
        return false;
      }

      if (lockCheckResult === 0) {
        logger.debug({ traceId, messageId }, 'Message is being processed by another worker, skipping');
        return false;
      }
    }

    // Start lock renewal to prevent expiry during long processing
    // (thread fetch, Notion API, Claude API can each take 30+ seconds)
    // Skip lock renewal when using database fallback (no Redis lock to renew)
    const lockRenewal = usingDatabaseFallback ? null : createLockRenewal(lockKey, traceId, () => {
      logger.error(
        { traceId, messageId },
        'Lock lost during processing - another worker may have started processing'
      );
    });

    try {
      // lockCheckResult === 1: We have the lock and message wasn't processed
      // Double-check with database as fallback (Redis might have been cleared)
      // Skip this check if we're already using database fallback (we just checked)
      if (!usingDatabaseFallback) {
        // Database fallback check - if Redis was down when the message was processed,
        // it might still be in the database
        const dbProcessed = await prisma.processedGmailMessage.findUnique({
          where: { id: messageId },
        });
        if (dbProcessed) {
          logger.debug({ traceId, messageId }, 'Message already processed (database fallback)');
          // Re-add to Redis for faster future checks (best effort)
          await safeRedisOp(
            () => redis.zadd(PROCESSED_MESSAGES_KEY, Date.now(), messageId),
            're-add to Redis',
            traceId
          );
          return false;
        }

        // FIX #13: Atomic check-and-reset to prevent double-cleanup race condition.
        // Previous INCR + SET was not atomic — two instances could both see >= threshold
        // before either resets. Now a Lua script atomically increments, checks, and resets.
        const shouldCleanup = await safeRedisOp(
          () => redis.eval(
            CLEANUP_CHECK_AND_RESET_SCRIPT,
            1,
            CLEANUP_COUNTER_KEY,
            CLEANUP_INTERVAL_MESSAGES.toString()
          ),
          'atomic cleanup check',
          traceId
        );
        if (shouldCleanup === 1) {
          const cutoffTime = Date.now() - PROCESSED_MESSAGE_TTL_DAYS * 24 * 60 * 60 * 1000;
          await safeRedisOp(
            () => redis.zremrangebyscore(PROCESSED_MESSAGES_KEY, '-inf', cutoffTime),
            'cleanup old processed messages',
            traceId
          );
          logger.debug({ traceId }, 'Ran periodic cleanup of processed messages');
        }
      }

      const gmail = await emailOAuthService.ensureGmailClient();

      // Fetch full message
      const messageResponse = await executeGmailWithProtection(
        'fetch-message',
        () => gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        })
      );

      const email = this.parseEmailMessage(messageResponse.data);
      if (!email) {
        logger.warn({ traceId, messageId }, 'Failed to parse email - marking as processed to avoid retry loop');
        // Mark unparseable emails as processed to prevent infinite retries
        await markMessageProcessed(messageId, traceId, 'unparseable');
        return false;
      }

      logger.info(
        { traceId, messageId, from: email.from, subject: email.subject },
        'Processing email'
      );

      // Check if this is a bounce notification and handle accordingly
      // This unfreezes therapists when emails fail to deliver
      const bounceHandled = await emailBounceService.processPotentialBounce({
        from: email.from,
        subject: email.subject,
        body: email.body,
        threadId: email.threadId,
        messageId: messageId,
      });

      if (bounceHandled) {
        logger.info(
          { traceId, messageId, from: email.from },
          'Email bounce detected and handled - therapist unfrozen'
        );
        await markMessageProcessed(messageId, traceId, 'bounce');
        return true; // Handled as bounce
      }

      // Skip emails from the scheduler itself (these are our own outgoing emails)
      if (email.from.toLowerCase() === EMAIL.FROM_ADDRESS.toLowerCase()) {
        logger.info(
          { traceId, messageId, from: email.from },
          'Skipping own outgoing email - not processing as incoming'
        );
        await markMessageProcessed(messageId, traceId, 'own-email');
        return false;
      }

      // Check if this is a reply to the weekly promotional email
      // These get routed to the inquiry handler instead of appointment matching
      if (this.isWeeklyMailingReply(email)) {
        const handled = await this.processWeeklyMailingReply(email, messageId, traceId);
        if (handled) {
          await markMessageProcessed(messageId, traceId, 'weekly-mailing-reply');
          return true;
        }
        // If not handled, fall through to normal appointment matching
      }

      // Find matching appointment request
      const appointmentRequest = await findMatchingAppointmentRequest(email);

      if (!appointmentRequest) {
        // Track failed match attempts to prevent infinite reprocessing
        // After MAX_UNMATCHED_ATTEMPTS within the TTL window, mark as processed
        //
        // FIX ISSUE #3: Use DATABASE as single source of truth for attempt tracking.
        // Previously Redis and DB could desync when Redis failed mid-operation.
        // Now: Database is authoritative, Redis is used only for quick checks.
        const unmatchedKey = `${UNMATCHED_ATTEMPT_PREFIX}${messageId}`;

        // Always use database as authoritative source for attempt count
        const dbRecord = await prisma.unmatchedEmailAttempt.upsert({
          where: { id: messageId },
          create: {
            id: messageId,
            attempts: 1,
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
          },
          update: {
            attempts: { increment: 1 },
            lastSeenAt: new Date(),
          },
        });
        const attempts = dbRecord.attempts;

        // Update Redis as a cache (best-effort, non-blocking)
        // This allows quick checks without DB round-trips, but DB is authoritative
        safeRedisOp(
          async () => {
            await redis.set(unmatchedKey, String(attempts), 'EX', UNMATCHED_ATTEMPT_TTL_SECONDS);
          },
          'cache unmatched attempt count',
          traceId
        );

        if (attempts >= MAX_UNMATCHED_ATTEMPTS) {
          logger.warn(
            { traceId, messageId, from: email.from, subject: email.subject, attempts },
            'Email unmatched after max attempts - marking as processed to prevent infinite loop'
          );

          // Mark as processed to stop reprocessing
          await Promise.all([
            markMessageProcessed(messageId, traceId, 'unmatched-abandoned'),
            // Mark as abandoned in database
            prisma.unmatchedEmailAttempt.update({
              where: { id: messageId },
              data: { abandoned: true },
            }),
            // Clean up attempt counter cache (best-effort)
            safeRedisOp(
              () => redis.del(unmatchedKey),
              'clean up attempt counter cache',
              traceId
            ),
          ]);

          // Alert admins — an unmatched email likely means a therapist or client
          // reply was silently dropped. This needs manual review.
          slackNotificationService.notifyUnmatchedEmailAbandoned(
            messageId,
            email.from,
            email.subject,
            attempts
          ).catch((err) => {
            logger.warn({ traceId, err }, 'Failed to send Slack alert for unmatched email');
          });

          return false;
        }

        logger.info(
          { traceId, messageId, from: email.from, subject: email.subject, attempts, maxAttempts: MAX_UNMATCHED_ATTEMPTS },
          'No matching appointment request found - will retry on next poll'
        );
        return false;
      }

      logger.info(
        { traceId, messageId, appointmentRequestId: appointmentRequest.id },
        'Found matching appointment request'
      );

      // Classify the email here so we can use the result both for the
      // closure auto-dismiss gate (below) and again later in the agent path.
      // The classifier is pure and cheap, so calling it twice is fine.
      const earlyClassification = classifyEmail(
        email.body,
        email.from,
        appointmentRequest.therapistEmail,
        appointmentRequest.userEmail,
      );

      // Auto-dismiss any pending closure recommendation: the recipient has now
      // replied, so the recommendation is stale. Without this, the appointment
      // stays excluded from chase cycles forever and the admin keeps seeing the
      // closure banner even though the conversation has resumed.
      //
      // Gating: skip the auto-dismiss for auto-replies / out-of-office responses.
      // Those mean the recipient is unreachable, NOT that they've actually
      // re-engaged — closing the recommendation on an OOO would silently undo
      // a valid admin signal. Bounces and own-outbound emails were already
      // short-circuited above this point, so the only false-positive risk left
      // is auto-replies.
      if (!earlyClassification.flags.isAutoReply) {
        try {
          const result = await appointmentLifecycleService.dismissClosureRecommendation({
            appointmentId: appointmentRequest.id,
            source: 'system',
            reason: `Incoming reply from ${email.from}`,
          });
          if (result.dismissed) {
            slackNotificationService.sendAlert({
              title: 'Closure Recommendation Auto-Dismissed',
              severity: 'medium',
              appointmentId: appointmentRequest.id,
              details:
                `An incoming reply arrived on a closure-recommended thread. The closure ` +
                `recommendation was auto-dismissed and the chase cycle reset so the agent ` +
                `can resume processing.`,
              additionalFields: {
                'From': email.from,
                'Subject': email.subject.slice(0, 100),
              },
            }).catch((err) => {
              logger.warn({ traceId, err }, 'Failed to send Slack alert for closure auto-dismissal');
            });
          }
        } catch (err) {
          // Don't block message processing if dismissal fails — log and continue
          logger.warn(
            { traceId, messageId, appointmentId: appointmentRequest.id, err },
            'Failed to auto-dismiss closure recommendation; continuing with message processing'
          );
        }
      } else {
        logger.info(
          { traceId, messageId, appointmentId: appointmentRequest.id, from: email.from },
          'Skipping closure auto-dismiss: incoming email is an auto-reply / out-of-office'
        );
      }

      // Detect thread divergence (CC issues, wrong thread replies, etc.)
      // Fetch all active appointments for this user/therapist to check for cross-thread issues
      // FIX EMAIL-CONTEXT: Include 'confirmed' status to properly handle post-booking emails
      const allActiveAppointments = await prisma.appointmentRequest.findMany({
        where: {
          OR: [
            { userEmail: email.from },
            { therapistEmail: email.from },
          ],
          status: { in: ['pending', 'contacted', 'negotiating', 'confirmed'] },
        },
        select: {
          id: true,
          userEmail: true,
          therapistEmail: true,
          therapistName: true,
          gmailThreadId: true,
          therapistGmailThreadId: true,
          initialMessageId: true,
          status: true,
          createdAt: true,
        },
      });

      const emailContext: EmailContext = {
        threadId: email.threadId,
        messageId: email.id,
        from: email.from,
        to: email.to,
        cc: email.cc,
        subject: email.subject,
        body: email.body,
        inReplyTo: email.inReplyTo,
        references: email.references,
        date: email.date,
      };

      // FIX: Single lookup instead of 6 repeated .find() calls (O(n) each)
      const matchedAppointment = allActiveAppointments.find(a => a.id === appointmentRequest.id);

      const appointmentContext: AppointmentContext = {
        id: appointmentRequest.id,
        userEmail: appointmentRequest.userEmail,
        therapistEmail: appointmentRequest.therapistEmail,
        therapistName: matchedAppointment?.therapistName || '',
        gmailThreadId: matchedAppointment?.gmailThreadId || null,
        therapistGmailThreadId: matchedAppointment?.therapistGmailThreadId || null,
        initialMessageId: matchedAppointment?.initialMessageId || null,
        status: matchedAppointment?.status || 'pending',
        createdAt: matchedAppointment?.createdAt || new Date(),
      };

      const divergence = detectThreadDivergence(
        emailContext,
        appointmentContext,
        allActiveAppointments as AppointmentContext[]
      );

      // Log divergence for metrics
      logDivergence(divergence, { appointmentId: appointmentRequest.id, emailId: email.id, traceId });

      // If divergence is critical, treat it as a retriable processing failure.
      // Divergence can be transient (race in CC handling, in-flight email
      // ordering) so we give it the same MAX_PROCESSING_FAILURES retry budget
      // as any other failure. The admin alert + note still fire on the FIRST
      // occurrence so divergence is visible immediately, but the message is
      // only marked permanently processed once the budget is exhausted.
      if (shouldBlockProcessing(divergence)) {
        const divergenceError = `Thread divergence (${divergence.type}, ${divergence.severity}): ${divergence.description}`;
        const attempts = await trackProcessingFailure(messageId, divergenceError);

        logger.warn(
          {
            traceId,
            messageId,
            appointmentId: appointmentRequest.id,
            divergenceType: divergence.type,
            severity: divergence.severity,
            attempts,
            maxAttempts: MAX_PROCESSING_FAILURES,
          },
          `Thread divergence blocking processing (attempt ${attempts}/${MAX_PROCESSING_FAILURES}): ${divergence.description}`
        );

        // Record alert + note only on the first failure so we don't spam the
        // admin dashboard / notes column on every retry cycle.
        if (attempts === 1) {
          await recordDivergenceAlert(appointmentRequest.id, divergence);

          const divergenceNote = `[DIVERGENCE ALERT - ${new Date().toISOString()}]\n${getDivergenceSummary(divergence)}\n\nEmail from: ${email.from}\nSubject: ${email.subject}\n---\n`;
          await prisma.$executeRaw`
            UPDATE "AppointmentRequest"
            SET "notes" = ${divergenceNote} || COALESCE("notes", '')
            WHERE "id" = ${appointmentRequest.id}
          `;
        }

        // After max attempts, abandon to break the scanner loop.
        if (attempts >= MAX_PROCESSING_FAILURES) {
          logger.error(
            { traceId, messageId, attempts, divergenceType: divergence.type },
            'Divergence-blocked message abandoned after max attempts'
          );
          await markMessageProcessed(messageId, traceId, 'divergence-blocked-abandoned');
          await markFailureAbandoned(messageId);
        }

        return false;
      }

      // Fetch complete thread history for full context
      let threadContext: string | undefined;
      if (email.threadId) {
        try {
          const thread = await threadFetchingService.fetchThreadById(email.threadId, traceId);
          if (thread && thread.messages.length > 0) {
            threadContext = threadFetchingService.formatThreadForAgent(
              thread,
              appointmentRequest.userEmail,
              appointmentRequest.therapistEmail
            );
            logger.info(
              { traceId, messageId, threadId: email.threadId, messageCount: thread.messageCount },
              'Thread history fetched for context'
            );
          }
        } catch (threadError) {
          // Log but don't fail - process with just the new email if thread fetch fails
          logger.warn(
            { traceId, messageId, threadId: email.threadId, error: threadError },
            'Failed to fetch thread history - processing with single email only'
          );
        }
      }

      // Process with AI agent, including full thread context.
      // Pass the classification computed earlier for the closure auto-dismiss
      // gate so the agent path doesn't redo the same regex work.
      const agentProcessor = getAgentProcessor(traceId);
      await agentProcessor.processEmailReply(
        appointmentRequest.id,
        email.body,
        email.from,
        threadContext,
        earlyClassification,
      );

      // Mark as processed AFTER successful processing, then clear the failure
      // record so the UI shows a clean state and a future failure starts a
      // fresh attempt count.
      await markMessageProcessed(messageId, traceId, 'successfully-processed');
      await clearProcessingFailure(messageId);

      // Mark as read in Gmail
      const gmailClient = await emailOAuthService.ensureGmailClient();
      await gmailClient.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['UNREAD'],
        },
      });

      return true;
    } catch (error) {
      // The missed-message scanner re-discovers failed messages every hour.
      // Without retry budget + visibility, a persistently broken message loops
      // forever. trackProcessingFailure increments the DB counter (source of
      // truth, so a Redis outage can't suppress abandonment) and records the
      // error text for UI surfacing.
      const errorMessage = error instanceof Error ? error.message : String(error);
      let attempts: number;
      try {
        attempts = await trackProcessingFailure(messageId, errorMessage);
      } catch (trackErr) {
        // DB write failed — abandon this attempt cycle but log loudly so the
        // operator sees that the failure tracking itself is broken.
        logger.error(
          { trackErr, traceId, messageId, originalError: error },
          'CRITICAL: Failed to record processing failure in DB. Scanner abandonment is degraded.'
        );
        return false;
      }

      logger.error(
        { error, traceId, messageId, attempts, maxAttempts: MAX_PROCESSING_FAILURES, errorMessage },
        `Failed to process message (attempt ${attempts}/${MAX_PROCESSING_FAILURES})`
      );

      if (usingDatabaseFallback) {
        try {
          await prisma.processedGmailMessage.delete({
            where: { id: messageId },
          });
        } catch (deleteErr: any) {
          if (deleteErr?.code !== 'P2025') {
            logger.warn({ traceId, messageId, deleteErr }, 'Failed to delete database lock record');
          }
        }
      }

      // First-failure visibility: send one Slack alert per (messageId, dedup window)
      // with the actual error text so admins see the real cause immediately instead
      // of waiting for 3 silent hours.
      if (await acquireAlertDedupLock(messageId, traceId)) {
        slackNotificationService.sendAlert({
          title: 'Message Processing Failed',
          severity: 'medium',
          details:
            `A Gmail message failed to process. It will retry up to ${MAX_PROCESSING_FAILURES} times ` +
            'before being abandoned. Error details below.\n\n' +
            `\`\`\`${errorMessage.slice(0, 1500)}\`\`\``,
          additionalFields: {
            'Message ID': messageId,
            'Attempt': `${attempts}/${MAX_PROCESSING_FAILURES}`,
          },
        }).catch((slackErr) => {
          logger.warn({ traceId, slackErr }, 'Failed to send first-failure Slack alert');
        });
      }

      // After max attempts, abandon the message to break the scanner loop.
      if (attempts >= MAX_PROCESSING_FAILURES) {
        logger.error(
          { traceId, messageId, attempts, errorMessage },
          'Message processing abandoned after max attempts'
        );

        try {
          await markMessageProcessed(messageId, traceId, 'processing-failed-abandoned');
          await markFailureAbandoned(messageId);
        } catch (markErr) {
          logger.error({ traceId, messageId, markErr }, 'Failed to mark abandoned message as processed');
        }

        slackNotificationService.sendAlert({
          title: 'Message Processing Abandoned',
          severity: 'high',
          details:
            `A Gmail message failed to process after *${attempts}* attempts and has been abandoned ` +
            'to prevent the scanner from looping. Manual review required.\n\n' +
            `\`\`\`${errorMessage.slice(0, 1500)}\`\`\``,
          additionalFields: {
            'Message ID': messageId,
            'Attempts': String(attempts),
          },
        }).catch((slackErr) => {
          logger.warn({ traceId, slackErr }, 'Failed to send abandonment Slack alert');
        });
      }

      return false;
    } finally {
      // Only manage Redis lock if not using database fallback
      if (!usingDatabaseFallback && lockRenewal) {
        // Stop lock renewal first
        lockRenewal.stop();

        // FIX E7: Only attempt release if we still own the lock
        // This prevents race condition where renewal detects lock loss
        // but finally block still tries to release
        if (!lockRenewal.isLockValid()) {
          logger.info(
            { traceId, messageId },
            'Lock no longer owned (detected by renewal) - skipping release'
          );
        } else {
          // FIX E2: Release lock only if we still own it (prevents releasing another worker's lock)
          await releaseLock(lockKey, traceId, `email-processing:${messageId}`);
        }
      }
      // Note: Database "lock" (processedGmailMessage) is not deleted - it serves as
      // permanent deduplication record. This is intentional for the fallback case.
    }
  }

  // ─── Email parsing ──────────────────────────────────────────────────

  /**
   * Parse a Gmail message into our EmailMessage format
   * Returns null if message is malformed or missing required fields
   */
  parseEmailMessage(message: gmail_v1.Schema$Message): EmailMessage | null {
    // Validate required fields exist
    if (!message || !message.id || !message.threadId) {
      logger.warn({ messageId: message?.id }, 'Message missing id or threadId');
      return null;
    }

    // Safely access payload - may not exist for malformed messages
    if (!message.payload) {
      logger.warn({ messageId: message.id }, 'Message has no payload');
      return null;
    }

    const headers = message.payload.headers || [];
    const getHeader = (name: string): string =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const from = this.extractEmail(getHeader('from'));
    const to = this.extractEmail(getHeader('to'));
    const ccHeader = getHeader('cc');
    const cc = ccHeader ? this.extractAllEmails(ccHeader) : undefined;
    const subject = getHeader('subject');
    const inReplyTo = getHeader('in-reply-to');
    const references = getHeader('references')?.split(/\s+/).filter(Boolean);

    // Parse date safely
    let date: Date;
    try {
      const dateHeader = getHeader('date');
      const dateValue = dateHeader || message.internalDate;
      date = dateValue ? new Date(dateValue) : new Date();
      // Validate date is valid
      if (isNaN(date.getTime())) {
        date = new Date();
      }
    } catch {
      date = new Date();
    }

    // Extract body safely - prioritize plain text, fallback to HTML
    // Also handle charset detection for non-UTF-8 emails
    let body = '';
    try {
      if (message.payload.body?.data) {
        // Simple message with body directly in payload
        // Check mimeType to determine if HTML processing is needed
        const mimeType = message.payload.mimeType || '';
        const rawBody = this.decodeEmailBody(message.payload.body.data, mimeType);
        if (mimeType.includes('text/html')) {
          body = stripHtml(rawBody);
        } else {
          body = decodeHtmlEntities(rawBody);
        }
      } else if (message.payload.parts) {
        // Multipart message - try plain text first
        const textPart = message.payload.parts.find(
          (p) => p.mimeType === 'text/plain'
        );
        if (textPart?.body?.data) {
          // Decode with charset detection and clean up HTML entities
          const contentType = textPart.mimeType || 'text/plain; charset=utf-8';
          const rawBody = this.decodeEmailBody(textPart.body.data, contentType);
          body = decodeHtmlEntities(rawBody);
        } else {
          // Fall back to HTML if no plain text available
          const htmlPart = message.payload.parts.find(
            (p) => p.mimeType === 'text/html'
          );
          if (htmlPart?.body?.data) {
            const contentType = htmlPart.mimeType || 'text/html; charset=utf-8';
            const rawBody = this.decodeEmailBody(htmlPart.body.data, contentType);
            body = stripHtml(rawBody);
            logger.debug({ messageId: message.id }, 'Extracted body from HTML part (no plain text available)');
          }
        }
      }
    } catch (err) {
      logger.warn({ messageId: message.id, err }, 'Failed to decode email body');
      body = '';
    }

    if (!from) {
      logger.warn({ messageId: message.id }, 'Message has no from address');
      return null;
    }

    return {
      id: message.id,
      threadId: message.threadId,
      from,
      to,
      cc,
      subject,
      body,
      date,
      inReplyTo,
      references,
    };
  }

  /**
   * Extract email address from a "Name <email>" format
   */
  private extractEmail(headerValue: string): string {
    const match = headerValue.match(/<([^>]+)>/);
    return match ? match[1] : headerValue.trim();
  }

  /**
   * Extract all email addresses from a header value (e.g., CC with multiple recipients)
   * Handles formats: "Name <email>", "email", comma-separated lists
   */
  private extractAllEmails(headerValue: string): string[] {
    if (!headerValue) return [];

    const emails: string[] = [];
    const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = headerValue.match(regex);

    if (matches) {
      for (const match of matches) {
        const normalized = match.toLowerCase();
        if (!emails.includes(normalized)) {
          emails.push(normalized);
        }
      }
    }

    return emails;
  }

  /**
   * Extract charset from Content-Type header or MIME type string
   * Returns 'utf-8' as default if not found
   */
  private extractCharset(contentType: string): BufferEncoding {
    const match = contentType.match(/charset=["']?([^"';\s]+)/i);
    const charset = match ? match[1].toLowerCase() : 'utf-8';

    // Map common charset names to Node.js BufferEncoding
    const charsetMap: Record<string, BufferEncoding> = {
      'utf-8': 'utf-8',
      'utf8': 'utf-8',
      'iso-8859-1': 'latin1',
      'iso_8859-1': 'latin1',
      'latin1': 'latin1',
      'windows-1252': 'latin1', // Close enough for most cases
      'ascii': 'ascii',
      'us-ascii': 'ascii',
    };

    return charsetMap[charset] || 'utf-8';
  }

  /**
   * Decode base64 email body with proper charset handling
   *
   * IMPORTANT: Gmail API returns body data in URL-safe Base64 format:
   * - Uses '-' instead of '+'
   * - Uses '_' instead of '/'
   * - May omit padding '='
   *
   * Node.js Buffer.from('base64') handles URL-safe Base64 since v15.14.0,
   * but we convert explicitly for maximum compatibility.
   */
  private decodeEmailBody(base64Data: string, contentType: string): string {
    const charset = this.extractCharset(contentType);
    try {
      // Convert URL-safe Base64 to standard Base64 for maximum compatibility
      const standardBase64 = base64Data
        .replace(/-/g, '+')
        .replace(/_/g, '/');

      // Add padding if needed (Base64 must be multiple of 4)
      const paddedBase64 = standardBase64 + '='.repeat((4 - (standardBase64.length % 4)) % 4);

      return Buffer.from(paddedBase64, 'base64').toString(charset);
    } catch {
      // Fall back to UTF-8 if charset decoding fails
      logger.debug({ contentType, charset }, 'Charset decoding failed, falling back to UTF-8');
      try {
        const standardBase64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');
        const paddedBase64 = standardBase64 + '='.repeat((4 - (standardBase64.length % 4)) % 4);
        return Buffer.from(paddedBase64, 'base64').toString('utf-8');
      } catch {
        // Last resort: try direct decoding
        return Buffer.from(base64Data, 'base64').toString('utf-8');
      }
    }
  }

  // ─── Weekly mailing ─────────────────────────────────────────────────

  /**
   * Check if an email is a reply to the weekly promotional mailing
   * Weekly emails have subject: "Book your therapy session with Spill"
   * Replies will have: "Re: Book your therapy session with Spill"
   */
  private isWeeklyMailingReply(email: EmailMessage): boolean {
    const subjectLower = email.subject.toLowerCase().trim();
    // Check for replies to the weekly mailing subject
    // Match "re:" prefix with variations (Re:, RE:, re:, Fwd:, etc.)
    return (
      subjectLower.includes('re: book your therapy session with spill') ||
      subjectLower.includes('re:book your therapy session with spill') ||
      subjectLower === 'book your therapy session with spill' // Direct reply without Re: prefix (some clients)
    );
  }

  /**
   * Process a reply to the weekly promotional email
   * Creates or updates a WeeklyMailingInquiry and routes to the agent
   */
  private async processWeeklyMailingReply(
    email: EmailMessage,
    messageId: string,
    traceId: string
  ): Promise<boolean> {
    logger.info(
      { traceId, messageId, from: email.from, subject: email.subject },
      'Processing weekly mailing reply'
    );

    try {
      // Find or create the inquiry record
      let inquiry = await prisma.weeklyMailingInquiry.findFirst({
        where: {
          OR: [
            { gmailThreadId: email.threadId },
            { userEmail: email.from.toLowerCase() },
          ],
          status: 'active',
        },
        orderBy: { updatedAt: 'desc' },
      });

      if (!inquiry) {
        // Create new inquiry
        inquiry = await prisma.weeklyMailingInquiry.create({
          data: {
            userEmail: email.from.toLowerCase(),
            userName: this.extractNameFromEmail(email.from),
            gmailThreadId: email.threadId,
            status: 'active',
          },
        });
        logger.info(
          { traceId, inquiryId: inquiry.id, userEmail: inquiry.userEmail },
          'Created new weekly mailing inquiry'
        );
      } else {
        // Update thread ID if not set
        if (!inquiry.gmailThreadId && email.threadId) {
          await prisma.weeklyMailingInquiry.update({
            where: { id: inquiry.id },
            data: { gmailThreadId: email.threadId },
          });
        }
      }

      // Skip if human control is enabled
      if (inquiry.humanControlEnabled) {
        logger.info(
          { traceId, inquiryId: inquiry.id },
          'Human control enabled for inquiry - skipping agent processing'
        );
        return true; // Still mark as handled
      }

      // Fetch thread context if available
      let threadContext: string | undefined;
      if (email.threadId) {
        try {
          const thread = await threadFetchingService.fetchThreadById(email.threadId, traceId);
          if (thread && thread.messages.length > 0) {
            threadContext = threadFetchingService.formatThreadForAgent(
              thread,
              inquiry.userEmail,
              EMAIL.FROM_ADDRESS // Agent's email
            );
          }
        } catch (threadError) {
          logger.warn(
            { traceId, threadId: email.threadId, error: threadError },
            'Failed to fetch thread for weekly mailing inquiry'
          );
        }
      }

      // Process with AI agent inquiry handler
      const agentProcessor = getAgentProcessor(traceId);
      await agentProcessor.processInquiryReply(
        inquiry.id,
        email.body,
        email.from,
        threadContext
      );

      return true;
    } catch (error) {
      logger.error(
        { error, traceId, messageId, from: email.from },
        'Failed to process weekly mailing reply'
      );
      // Return false to allow retry
      return false;
    }
  }

  /**
   * Extract name from email address "Name <email@example.com>" format
   */
  private extractNameFromEmail(emailHeader: string): string | undefined {
    // Check for "Name <email>" format
    const match = emailHeader.match(/^([^<]+)\s*<[^>]+>$/);
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, ''); // Remove quotes if present
    }
    // Fallback: use email prefix
    const emailMatch = emailHeader.match(/([^@]+)@/);
    if (emailMatch) {
      // Convert "john.doe" to "John Doe"
      return emailMatch[1]
        .replace(/[._]/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return undefined;
  }

  // ─── Email sending ──────────────────────────────────────────────────

  /**
   * Convert plain text email body to simple HTML for proper mobile rendering.
   * This prevents awkward mid-sentence line breaks on narrow screens by allowing
   * the email client to reflow text properly.
   *
   * - Escapes HTML special characters
   * - Converts paragraph breaks (\n\n) to <p> tags
   * - Converts list items (- or * prefixed) to proper <ul>/<li> elements
   * - Preserves line breaks in email signatures (e.g., "Best wishes\nJustin")
   * - Joins other single line breaks with spaces for text reflow
   */
  private convertToHtml(body: string): string {
    // Normalize line endings
    let text = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Extract markdown formatting before escaping HTML (preserve them)
    const placeholders: { placeholder: string; html: string }[] = [];
    let placeholderIndex = 0;

    // Pattern: [link text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
      const placeholder = `__PLACEHOLDER_${placeholderIndex}__`;
      // Escape the link text but not the URL structure
      const escapedText = linkText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      placeholders.push({
        placeholder,
        html: `<a href="${url}" style="color: #0066cc; text-decoration: underline;">${escapedText}</a>`,
      });
      placeholderIndex++;
      return placeholder;
    });

    // Pattern: **bold text**
    text = text.replace(/\*\*([^*]+)\*\*/g, (_match, boldText) => {
      const placeholder = `__PLACEHOLDER_${placeholderIndex}__`;
      const escapedText = boldText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      placeholders.push({
        placeholder,
        html: `<strong>${escapedText}</strong>`,
      });
      placeholderIndex++;
      return placeholder;
    });

    // Escape HTML special characters
    text = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    // Restore placeholders with actual HTML (links, bold, etc.)
    for (const { placeholder, html } of placeholders) {
      text = text.replace(placeholder, html);
    }

    // Split into paragraphs (double newlines)
    const paragraphs = text.split(/\n\n+/);

    const htmlParts: string[] = [];

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      // Check if this paragraph is a list (lines starting with - or *)
      const lines = trimmed.split('\n');
      const isListParagraph = lines.every(
        (line) => /^\s*[-*•]\s/.test(line) || !line.trim()
      );

      if (isListParagraph && lines.some((l) => l.trim())) {
        // Convert to HTML list
        const listItems = lines
          .filter((line) => line.trim())
          .map((line) => {
            const content = line.replace(/^\s*[-*•]\s*/, '').trim();
            return `<li>${content}</li>`;
          })
          .join('');
        htmlParts.push(`<ul style="margin: 0 0 16px 0; padding-left: 20px;">${listItems}</ul>`);
      } else if (this.looksLikeSignature(lines)) {
        // Signature block - preserve line breaks with <br>
        const htmlLines = lines.map((l) => l.trim()).join('<br>');
        htmlParts.push(`<p style="margin: 0 0 16px 0;">${htmlLines}</p>`);
      } else {
        // Regular paragraph - join lines with spaces (remove single newlines within paragraph)
        const joined = lines.map((l) => l.trim()).join(' ');
        htmlParts.push(`<p style="margin: 0 0 16px 0;">${joined}</p>`);
      }
    }

    // Wrap in minimal HTML structure with responsive styling
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #333; margin: 0; padding: 0; }
p, ul { margin: 0 0 16px 0; }
p:last-child, ul:last-child { margin-bottom: 0; }
</style>
</head>
<body>
${htmlParts.join('\n')}
</body>
</html>`;
  }

  /**
   * Detect if a paragraph looks like an email signature
   * (closing phrase followed by name on separate lines)
   * This ensures signatures preserve line breaks even if templates
   * use single newlines instead of double newlines.
   */
  private looksLikeSignature(lines: string[]): boolean {
    // Signatures typically have 2-3 lines (closing phrase, optional comma, name)
    if (lines.length < 2 || lines.length > 3) return false;

    const closingPhrases = [
      'best wishes',
      'best',
      'thanks',
      'thank you',
      'regards',
      'cheers',
      'sincerely',
      'kind regards',
      'warm regards',
      'all the best',
      'many thanks',
      'with thanks',
    ];

    // Check if first line is a closing phrase (with optional comma/exclamation)
    const firstLine = lines[0].toLowerCase().replace(/[,!]?\s*$/, '').trim();
    return closingPhrases.includes(firstLine);
  }

  /**
   * Send an email via Gmail API
   * Returns both messageId and threadId for conversation tracking
   *
   * IMPORTANT: To maintain Gmail threading, pass the threadId from previous
   * messages in the same conversation. Gmail uses threadId to group messages
   * together, and this is critical for the scheduling system to work correctly.
   */
  async sendEmail(params: {
    to: string;
    subject: string;
    body: string;
    replyTo?: string;
    threadId?: string; // Pass existing threadId to maintain conversation threading
  }): Promise<{ messageId: string; threadId: string }> {
    const gmail = await emailOAuthService.ensureGmailClient();

    // Encode subject if it contains non-ASCII characters (RFC 2047)
    const encodedSubject = encodeEmailHeader(params.subject);

    // Convert plain text body to simple HTML for proper text reflow on mobile
    // This prevents awkward mid-sentence line breaks on narrow screens
    const htmlBody = this.convertToHtml(params.body);

    // Determine In-Reply-To and References headers
    // If replyTo is provided, use it directly
    // If threadId is provided but no replyTo, fetch the last message ID from the thread
    let inReplyTo = params.replyTo;
    if (!inReplyTo && params.threadId && gmail) {
      try {
        const threadResponse = await gmail.users.threads.get({
          userId: 'me',
          id: params.threadId,
          format: 'metadata',
          metadataHeaders: ['Message-ID'],
        });
        const messages = threadResponse.data.messages || [];
        if (messages.length > 0) {
          // Get the last message in the thread
          const lastMessage = messages[messages.length - 1];
          const headers = lastMessage.payload?.headers || [];
          const messageIdHeader = headers.find(
            (h) => h.name?.toLowerCase() === 'message-id'
          );
          if (messageIdHeader?.value) {
            inReplyTo = messageIdHeader.value;
            logger.debug(
              { threadId: params.threadId, inReplyTo },
              'Fetched In-Reply-To from thread for email threading'
            );
          }
        }
      } catch (err) {
        // Non-fatal: email will still be sent, just without optimal threading
        logger.warn(
          { threadId: params.threadId, err },
          'Failed to fetch last message ID for In-Reply-To header'
        );
      }
    }

    // Build the email message with proper headers (using HTML for proper mobile rendering)
    const emailLines = [
      `To: ${params.to}`,
      `Subject: ${encodedSubject}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      'MIME-Version: 1.0',
    ];

    if (inReplyTo) {
      emailLines.push(`In-Reply-To: ${inReplyTo}`);
      emailLines.push(`References: ${inReplyTo}`);
    }

    emailLines.push('', htmlBody);

    const rawMessage = emailLines.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Build the request body, including threadId if provided to maintain conversation
    const requestBody: { raw: string; threadId?: string } = {
      raw: encodedMessage,
    };

    // CRITICAL: Include threadId to keep emails in the same conversation thread
    // This is how Gmail groups messages together, and without it each email
    // would start a new thread, breaking the scheduling conversation flow
    if (params.threadId) {
      requestBody.threadId = params.threadId;
      logger.info(
        { to: params.to, existingThreadId: params.threadId },
        'Sending email with existing threadId to maintain conversation'
      );
    }

    const response = await executeGmailWithProtection(
      'send-email',
      () => gmail.users.messages.send({
        userId: 'me',
        requestBody,
      })
    );

    // Fetch the sent message to get threadId for conversation tracking
    // (in case a new thread was created)
    let threadId = params.threadId || '';
    if (response.data.id) {
      try {
        const sentMessage = await gmail.users.messages.get({
          userId: 'me',
          id: response.data.id,
          format: 'minimal',
        });
        threadId = sentMessage.data.threadId || threadId;
      } catch (err) {
        logger.warn({ err, messageId: response.data.id }, 'Failed to fetch threadId for sent message');
      }
    }

    logger.info(
      { to: params.to, subject: params.subject, messageId: response.data.id, threadId, providedThreadId: params.threadId },
      'Email sent via Gmail'
    );

    return { messageId: response.data.id || '', threadId };
  }

  // ─── Pending email queue processing ─────────────────────────────────

  /**
   * Process and send pending emails from the queue
   * Maintains thread continuity by looking up thread IDs from linked appointments
   * Uses exponential backoff for retries with max retry limit
   *
   * Features:
   * - Monitors queue depth and logs warnings for large backlogs
   * - Dynamically adjusts batch size under load
   * - Returns queue metrics for monitoring
   */
  async processPendingEmails(
    traceId: string,
    isLockValid?: () => boolean
  ): Promise<{
    sent: number;
    failed: number;
    retrying: number;
    queueDepth: number;
    batchSize: number;
  }> {
    const now = new Date();

    // STEP 1: Monitor queue depth before processing
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

    // Log warning if backlog exceeds thresholds
    if (queueDepth >= PENDING_EMAIL_QUEUE.BACKLOG_CRITICAL_THRESHOLD) {
      logger.error(
        { traceId, queueDepth, threshold: PENDING_EMAIL_QUEUE.BACKLOG_CRITICAL_THRESHOLD },
        'CRITICAL: Email queue backlog is very large - immediate attention required'
      );
    } else if (queueDepth >= PENDING_EMAIL_QUEUE.BACKLOG_WARNING_THRESHOLD) {
      logger.warn(
        { traceId, queueDepth, threshold: PENDING_EMAIL_QUEUE.BACKLOG_WARNING_THRESHOLD },
        'Email queue backlog is growing - consider investigating'
      );
    }

    // STEP 2: Calculate dynamic batch size based on queue depth
    let batchSize: number = PENDING_EMAIL_QUEUE.DEFAULT_BATCH_SIZE;
    if (queueDepth >= PENDING_EMAIL_QUEUE.BACKLOG_CRITICAL_THRESHOLD) {
      batchSize = Math.min(
        PENDING_EMAIL_QUEUE.DEFAULT_BATCH_SIZE * PENDING_EMAIL_QUEUE.BATCH_SIZE_MULTIPLIER_CRITICAL,
        PENDING_EMAIL_QUEUE.MAX_BATCH_SIZE
      );
      logger.info(
        { traceId, queueDepth, batchSize },
        'Increasing batch size due to critical backlog'
      );
    } else if (queueDepth >= PENDING_EMAIL_QUEUE.BACKLOG_WARNING_THRESHOLD) {
      batchSize = Math.min(
        PENDING_EMAIL_QUEUE.DEFAULT_BATCH_SIZE * PENDING_EMAIL_QUEUE.BATCH_SIZE_MULTIPLIER_WARNING,
        PENDING_EMAIL_QUEUE.MAX_BATCH_SIZE
      );
      logger.info(
        { traceId, queueDepth, batchSize },
        'Increasing batch size due to backlog'
      );
    }

    logger.info({ traceId, queueDepth, batchSize }, 'Processing pending emails');

    let sent = 0;
    let failed = 0;
    let retrying = 0;

    try {
      // Include the appointment relation to get thread IDs
      // Only process emails that are ready for retry (nextRetryAt <= now or null for new emails)
      // Use dynamic batch size based on queue depth
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
        // FIX: Check lock validity before each email to abort early if lock was lost
        // This prevents duplicate processing when another instance takes over
        if (isLockValid && !isLockValid()) {
          logger.warn(
            { traceId, emailId: email.id, sent, failed },
            'Aborting email processing - lock was lost to another instance'
          );
          break; // Exit loop immediately, don't process more emails
        }

        try {
          // FIX #8: Detect and skip internal retry markers stored as PendingEmail records.
          // The JustinTime failure handler stores a JSON blob with type: 'RETRY_JUSTINTIME_START'
          // as a PendingEmail body. These are internal retry signals, not actual emails.
          let bodyContent: string = email.body;
          try {
            const parsed = JSON.parse(bodyContent);
            if (parsed && parsed.type === 'RETRY_JUSTINTIME_START') {
              logger.info(
                { traceId, emailId: email.id, appointmentId: parsed.appointmentRequestId },
                'Skipping JustinTime retry marker - not a real email'
              );
              // Mark as sent (consumed) so it's not retried
              await prisma.pendingEmail.update({
                where: { id: email.id },
                data: { status: 'sent', sentAt: new Date() },
              });
              sent++;
              continue;
            }
          } catch {
            // Not JSON - this is a normal email body, proceed
          }

          // Look up the appropriate thread ID if appointment exists
          let threadId: string | undefined;
          if (email.appointment) {
            const isTherapistEmail = email.toEmail.toLowerCase() === email.appointment.therapistEmail.toLowerCase();
            threadId = isTherapistEmail
              ? (email.appointment.therapistGmailThreadId ?? undefined)
              : (email.appointment.gmailThreadId ?? undefined);
          }

          // Idempotent send guard: check if this email was already sent.
          // Prevents duplicate sends when Gmail succeeds but DB update fails on a prior attempt.
          const sendGuardKey = `email:send-guard:${email.id}`;
          let alreadySent = false;
          try {
            const guardValue = await redis.get(sendGuardKey);
            if (guardValue) {
              alreadySent = true;
              logger.info(
                { traceId, emailId: email.id },
                'Send guard: email already sent — skipping send, updating DB only'
              );
            }
          } catch {
            // Redis unavailable — proceed with send (better duplicate than no send)
          }

          if (!alreadySent) {
            await this.sendEmail({
              to: email.toEmail,
              subject: email.subject,
              body: bodyContent,
              threadId,
            });

            // Set send guard in Redis before DB update
            try {
              await redis.set(sendGuardKey, 'sent', 'EX', 5 * 3600); // 5h, must exceed max retry backoff (4h)
            } catch {
              // Redis unavailable — proceed without guard
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

          // Check if we've exceeded max retries
          if (newRetryCount >= EMAIL.MAX_RETRIES) {
            logger.error(
              { error, traceId, emailId: email.id, retryCount: newRetryCount },
              'Email permanently failed after max retries - abandoning'
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

            // FIX T3: Propagate abandonment to appointment for admin visibility
            // This ensures admins are notified when critical emails fail permanently
            if (email.appointmentId) {
              const abandonmentNote = `\n\n[EMAIL ABANDONED - ${now.toISOString()}]\nTo: ${email.toEmail}\nSubject: ${email.subject.slice(0, 100)}${email.subject.length > 100 ? '...' : ''}\nFailed after ${newRetryCount} retries: ${errorMessage.slice(0, 200)}`;

              // Atomic append to prevent note loss under concurrent updates
              await prisma.$executeRaw`
                UPDATE "AppointmentRequest"
                SET "notes" = COALESCE("notes", '') || ${abandonmentNote},
                    "conversationStallAlertAt" = ${now},
                    "conversationStallAcknowledged" = false
                WHERE "id" = ${email.appointmentId}
              `;

              logger.warn(
                { traceId, emailId: email.id, appointmentId: email.appointmentId },
                'FIX T3: Email abandonment propagated to appointment for admin notification'
              );
            }

            failed++;
          } else {
            // Calculate next retry time using exponential backoff with jitter
            // Jitter prevents thundering herd when multiple emails fail simultaneously
            const baseDelayMs = EMAIL.RETRY_DELAYS_MS[Math.min(newRetryCount - 1, EMAIL.RETRY_DELAYS_MS.length - 1)];
            const jitter = Math.floor(baseDelayMs * 0.1 * Math.random());
            const delayMs = baseDelayMs + jitter;
            const nextRetryAt = new Date(now.getTime() + delayMs);

            logger.warn(
              { error, traceId, emailId: email.id, retryCount: newRetryCount, nextRetryAt },
              `Email send failed - scheduling retry ${newRetryCount}/${EMAIL.MAX_RETRIES}`
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
      'Finished processing pending emails'
    );
    return { sent, failed, retrying, queueDepth, batchSize };
  }
}

/** Singleton instance */
export const emailMessageProcessorService = new EmailMessageProcessorService();

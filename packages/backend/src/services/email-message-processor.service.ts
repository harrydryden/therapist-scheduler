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
// FIX #5: Lazy import to break circular dependency:
// justin-time.service -> appointment-lifecycle.service -> email-processing.service -> justin-time.service
// Using dynamic import at call sites instead of top-level import.
type JustinTimeServiceType = import('./justin-time.service').JustinTimeService;
function getJustinTimeService(): typeof import('./justin-time.service').JustinTimeService {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./justin-time.service').JustinTimeService;
}
import { threadFetchingService } from './thread-fetching.service';
import { emailBounceService } from './email-bounce.service';
import { slackNotificationService } from './slack-notification.service';
import { EMAIL, PENDING_EMAIL_QUEUE } from '../constants';
import {
  detectThreadDivergence,
  shouldBlockProcessing,
  getDivergenceSummary,
  logDivergence,
  recordDivergenceAlert,
  type EmailContext,
  type AppointmentContext,
} from '../utils/thread-divergence';
import {
  extractTrackingCode,
} from '../utils/tracking-code';
import { emailOAuthService, executeGmailWithProtection } from './email-oauth.service';

// Redis keys
const PROCESSED_MESSAGES_KEY = 'gmail:processedMessages'; // ZSET with timestamp scores
const MESSAGE_LOCK_PREFIX = 'gmail:lock:message:';
const UNMATCHED_ATTEMPT_PREFIX = 'gmail:unmatched:'; // Track failed match attempts
const PROCESSED_MESSAGE_TTL_DAYS = 30;
const MAX_UNMATCHED_ATTEMPTS = 3;
const UNMATCHED_ATTEMPT_TTL_SECONDS = 3600; // 1 hour window for retry attempts

// FIX M11: Only run cleanup every N messages to reduce database load
const CLEANUP_INTERVAL_MESSAGES = 100;
// FIX #13: Use Redis atomic counter instead of module-level variable
// so cleanup is coordinated across multiple server instances
const CLEANUP_COUNTER_KEY = 'gmail:cleanupCounter';

/**
 * Lua script for atomic cleanup counter check-and-reset.
 * Prevents race condition where two instances both read >= threshold
 * and both run cleanup. Only the instance whose INCR crosses the
 * threshold resets the counter and gets permission to run cleanup.
 *
 * KEYS[1] = counter key
 * ARGV[1] = threshold
 * Returns: 1 if this instance should run cleanup, 0 otherwise
 */
const CLEANUP_CHECK_AND_RESET_SCRIPT = `
local key = KEYS[1]
local threshold = tonumber(ARGV[1])
local current = redis.call('INCR', key)
if current >= threshold then
  redis.call('SET', key, '0')
  return 1
end
return 0
`;

/**
 * Lua script for atomic lock acquisition + processed check
 * Returns:
 * - 1: Lock acquired, not previously processed
 * - 0: Already being processed by another worker (lock exists)
 * - -1: Already processed (in ZSET)
 */
const ATOMIC_LOCK_CHECK_SCRIPT = `
local lockKey = KEYS[1]
local processedKey = KEYS[2]
local messageId = ARGV[1]
local traceId = ARGV[2]
local lockTtl = tonumber(ARGV[3])

-- Check if already processed first
local score = redis.call('ZSCORE', processedKey, messageId)
if score then
  return -1
end

-- Try to acquire lock
local lockResult = redis.call('SET', lockKey, traceId, 'NX', 'EX', lockTtl)
if lockResult then
  return 1
else
  return 0
end
`;

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
      const appointmentRequest = await this.findMatchingAppointmentRequest(email);

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

      // If divergence is critical, skip automatic processing
      if (shouldBlockProcessing(divergence)) {
        logger.warn(
          {
            traceId,
            messageId,
            appointmentId: appointmentRequest.id,
            divergenceType: divergence.type,
            severity: divergence.severity,
          },
          `Thread divergence blocking processing: ${divergence.description}`
        );

        // FIX R3: Record divergence alert for admin notification dashboard
        // This ensures admins are notified via the alerts system, not just notes
        await recordDivergenceAlert(appointmentRequest.id, divergence);

        // Store divergence info for admin review in notes (legacy, keep for backwards compat)
        // Uses atomic SQL concatenation to prevent race conditions where concurrent
        // updates could overwrite each other's notes (the previous read-modify-write
        // pattern with inline findUnique had a TOCTOU window)
        const divergenceNote = `[DIVERGENCE ALERT - ${new Date().toISOString()}]\n${getDivergenceSummary(divergence)}\n\nEmail from: ${email.from}\nSubject: ${email.subject}\n---\n`;
        await prisma.$executeRaw`
          UPDATE "AppointmentRequest"
          SET "notes" = ${divergenceNote} || COALESCE("notes", '')
          WHERE "id" = ${appointmentRequest.id}
        `;

        // Mark as needing manual review but don't process automatically
        // Don't mark as processed - leave for admin to handle
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

      // Process with Justin Time, including full thread context
      const JustinTimeServiceClass = getJustinTimeService();
      const justinTime = new JustinTimeServiceClass(traceId);
      await justinTime.processEmailReply(
        appointmentRequest.id,
        email.body,
        email.from,
        threadContext
      );

      // Mark as processed AFTER successful processing
      await markMessageProcessed(messageId, traceId, 'successfully-processed');

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
      logger.error({ error, traceId, messageId }, 'Failed to process message - will retry on next poll');
      // FIX E4: If using database fallback, delete the lock record to allow retry
      if (usingDatabaseFallback) {
        try {
          await prisma.processedGmailMessage.delete({
            where: { id: messageId },
          });
          logger.debug({ traceId, messageId }, 'Deleted database lock record to allow retry');
        } catch (deleteErr: any) {
          // Record might already be deleted or not exist - that's fine
          if (deleteErr?.code !== 'P2025') { // P2025 = Record not found
            logger.warn({ traceId, messageId, deleteErr }, 'Failed to delete database lock record');
          }
        }
      }
      // Don't mark as processed on error - will retry
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

  // ─── Appointment matching ───────────────────────────────────────────

  /**
   * Find an appointment request that matches this email
   * Priority order:
   * 1. Gmail thread ID (deterministic - ensures correct routing for multi-therapist scenarios)
   * 2. In-Reply-To/References headers (email chain tracking)
   * 3. Sender email + therapist name in subject (legacy fallback)
   *
   * FIX EMAIL-CONTEXT: Include 'confirmed' status to handle post-booking emails
   * (e.g., reschedule requests, questions about the session).
   * Without this, emails about confirmed appointments were unmatched and the agent
   * was never invoked with proper context (including therapistEmail), causing it
   * to hallucinate email addresses.
   */
  private async findMatchingAppointmentRequest(
    email: EmailMessage
  ): Promise<{ id: string; userEmail: string; therapistEmail: string } | null> {
    // All statuses are matchable so that final emails (e.g. thank-you notes,
    // cancellation confirmations) are still threaded into the correct appointment.

    // PRIORITIES 1-3: Combined into a single query to reduce sequential DB round-trips.
    // The query fetches all potential matches and post-query logic applies priority ordering:
    //   1. Gmail thread ID match (most deterministic)
    //   2. In-Reply-To/References header match
    //   3. Tracking code match (with sender verification)
    const trackingCode = extractTrackingCode(email.subject);
    const messageIds: string[] = [];
    if (email.references?.length || email.inReplyTo) {
      messageIds.push(...(email.references || []));
      if (email.inReplyTo && !messageIds.includes(email.inReplyTo)) {
        messageIds.push(email.inReplyTo);
      }
    }

    // Build OR conditions for all deterministic match types
    const deterministicConditions: Array<Record<string, unknown>> = [];
    if (email.threadId) {
      deterministicConditions.push({ gmailThreadId: email.threadId });
      deterministicConditions.push({ therapistGmailThreadId: email.threadId });
    }
    if (messageIds.length > 0) {
      deterministicConditions.push({ initialMessageId: { in: messageIds } });
    }
    if (trackingCode) {
      deterministicConditions.push({ trackingCode });
    }

    if (deterministicConditions.length > 0) {
      const candidates = await prisma.appointmentRequest.findMany({
        where: {
          OR: deterministicConditions,
        },
        select: {
          id: true,
          userEmail: true,
          therapistEmail: true,
          gmailThreadId: true,
          therapistGmailThreadId: true,
          initialMessageId: true,
          trackingCode: true,
        },
      });

      if (candidates.length > 0) {
        // Priority 1: Thread ID match
        if (email.threadId) {
          const threadMatch = candidates.find(
            (c) => c.gmailThreadId === email.threadId || c.therapistGmailThreadId === email.threadId
          );
          if (threadMatch) {
            logger.info(
              { appointmentId: threadMatch.id, threadId: email.threadId },
              'Matched appointment by Gmail thread ID'
            );
            return { id: threadMatch.id, userEmail: threadMatch.userEmail, therapistEmail: threadMatch.therapistEmail };
          }
        }

        // Priority 2: In-Reply-To/References match
        if (messageIds.length > 0) {
          const refMatch = candidates.find(
            (c) => c.initialMessageId && messageIds.includes(c.initialMessageId)
          );
          if (refMatch) {
            logger.info(
              { appointmentId: refMatch.id, inReplyTo: email.inReplyTo },
              'Matched appointment by In-Reply-To header'
            );
            return { id: refMatch.id, userEmail: refMatch.userEmail, therapistEmail: refMatch.therapistEmail };
          }
        }

        // Priority 3: Tracking code match (with sender verification)
        if (trackingCode) {
          const trackingMatch = candidates.find((c) => c.trackingCode === trackingCode);
          if (trackingMatch) {
            const senderIsUser = email.from.toLowerCase() === trackingMatch.userEmail.toLowerCase();
            const senderIsTherapist = email.from.toLowerCase() === trackingMatch.therapistEmail.toLowerCase();

            if (senderIsUser || senderIsTherapist) {
              logger.info(
                { appointmentId: trackingMatch.id, trackingCode, senderType: senderIsUser ? 'user' : 'therapist' },
                'Matched appointment by tracking code (deterministic match)'
              );
              return { id: trackingMatch.id, userEmail: trackingMatch.userEmail, therapistEmail: trackingMatch.therapistEmail };
            } else {
              logger.warn(
                { trackingCode, from: email.from, expectedUser: trackingMatch.userEmail, expectedTherapist: trackingMatch.therapistEmail },
                'Tracking code found but sender not recognized - possible forwarded email'
              );
              // Fall through to Priority 4
            }
          }
        }
      }
    }

    // PRIORITY 4: Fallback to sender + therapist name matching (for legacy appointments without tracking codes)
    // Limited to 50 to prevent memory issues with high-volume users
    /** Sort by most recently updated, with ID as deterministic tiebreaker */
    const byMostRecent = (
      a: { updatedAt: Date; id: string },
      b: { updatedAt: Date; id: string },
    ) => {
      const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    };

    const matchingRequests = await prisma.appointmentRequest.findMany({
      where: {
        OR: [
          { userEmail: email.from },
          { therapistEmail: email.from },
        ],
      },
      orderBy: {
        updatedAt: 'desc',
      },
      take: 50, // Limit to prevent unbounded queries
      select: {
        id: true,
        userEmail: true,
        therapistEmail: true,
        therapistName: true,
        updatedAt: true, // FIX E8: Needed for deterministic sorting after filtering
      },
    });

    if (matchingRequests.length === 0) {
      return null;
    }

    // If only one matching request, return it
    if (matchingRequests.length === 1) {
      return matchingRequests[0];
    }

    // Multiple matching requests - try to match by therapist name in subject
    // FIX E8: Collect ALL matches, then select deterministically (most recently updated)
    const subjectLower = email.subject.toLowerCase();
    const nameMatches: typeof matchingRequests = [];

    for (const request of matchingRequests) {
      // Skip if therapistName is null/undefined to prevent crash
      if (!request.therapistName) {
        logger.warn(
          { appointmentId: request.id },
          'Appointment has null therapistName - skipping name-based matching'
        );
        continue;
      }

      const therapistNameLower = request.therapistName.toLowerCase();
      const firstName = therapistNameLower.split(' ')[0];

      if (subjectLower.includes(therapistNameLower) || subjectLower.includes(firstName)) {
        nameMatches.push(request);
      }
    }

    // FIX E8: If exactly one name match, use it
    if (nameMatches.length === 1) {
      logger.info(
        { appointmentId: nameMatches[0].id, therapistName: nameMatches[0].therapistName },
        'Matched appointment by therapist name in subject (unique match)'
      );
      return nameMatches[0];
    }

    // FIX E8 + H4: If multiple name matches, select deterministically
    if (nameMatches.length > 1) {
      nameMatches.sort(byMostRecent);
      logger.warn(
        {
          matchCount: nameMatches.length,
          selectedAppointmentId: nameMatches[0].id,
          therapistName: nameMatches[0].therapistName,
        },
        'Multiple appointments matched therapist name - selecting most recently updated'
      );
      return nameMatches[0];
    }

    // Fallback: if sender is a therapist, match by their email
    // If multiple appointments have the same therapist email, prefer most recently active
    const therapistMatches = matchingRequests.filter(r => r.therapistEmail === email.from);
    if (therapistMatches.length === 1) {
      logger.info(
        { appointmentId: therapistMatches[0].id, therapistEmail: email.from },
        'Matched appointment by therapist email (unique match)'
      );
      return therapistMatches[0];
    } else if (therapistMatches.length > 1) {
      therapistMatches.sort(byMostRecent);
      logger.warn(
        {
          therapistEmail: email.from,
          matchCount: therapistMatches.length,
          selectedAppointmentId: therapistMatches[0].id,
        },
        'Multiple appointments for same therapist - selecting most recently updated'
      );
      return therapistMatches[0];
    }

    // SAFETY: Reject ambiguous emails rather than guessing wrong
    // This prevents sending responses to the wrong therapist/user
    logger.error(
      { from: email.from, subject: email.subject, matchingRequestCount: matchingRequests.length },
      'AMBIGUOUS MATCH: Could not deterministically match email to appointment. ' +
      'Email will be skipped to prevent misdirected responses. Manual intervention required.'
    );
    return null;
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

      // Process with Justin Time inquiry handler
      const JustinTimeServiceClass2 = getJustinTimeService();
      const justinTime = new JustinTimeServiceClass2(traceId);
      await justinTime.processInquiryReply(
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

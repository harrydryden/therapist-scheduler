import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { emailOAuthService, executeGmailWithProtection } from './email-oauth.service';
import { emailMessageProcessorService } from './email-message-processor.service';
import {
  acquireTokenRefreshLock,
  releaseTokenRefreshLock,
} from '../utils/gmail-auth';

// Redis keys
const HISTORY_ID_KEY = 'gmail:lastHistoryId';
const PROCESSED_MESSAGES_KEY = 'gmail:processedMessages'; // ZSET with timestamp scores
const MESSAGE_LOCK_PREFIX = 'gmail:lock:message:';

// DB key for Gmail history ID persistence (SystemSetting id)
const HISTORY_ID_SETTING_KEY = 'gmail.lastHistoryId';

/**
 * Safely execute a Redis operation, suppressing errors when Redis is unavailable.
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
 * EmailIngestService — Email receipt and routing
 *
 * Responsibilities:
 * - processGmailNotification(): the main entry for push notifications
 * - Polling fallback logic
 * - History fetching and message enumeration
 * - Thread recovery (checkThreadForUnprocessedReplies, reprocessThread)
 * - Preview thread messages for admin UI
 * - Retry failed notifications
 */
export class EmailIngestService {

  // ─── History ID checkpoint management ───────────────────────────────

  /**
   * Read the Gmail history ID checkpoint from Redis with database fallback.
   * If Redis has no value (e.g., after a Redis restart), falls back to the
   * durable copy in the SystemSetting table.
   */
  private async getHistoryId(): Promise<number> {
    // Try Redis first (fast path)
    try {
      const redisValue = await redis.get(HISTORY_ID_KEY);
      if (redisValue) {
        return parseInt(redisValue, 10);
      }
    } catch {
      // Redis unavailable — fall through to DB
    }

    // Fallback to database
    try {
      const setting = await prisma.systemSetting.findUnique({
        where: { id: HISTORY_ID_SETTING_KEY },
      });
      if (setting) {
        const dbValue = parseInt(JSON.parse(setting.value), 10);
        // Re-populate Redis for future fast lookups
        await safeRedisOp(
          () => redis.set(HISTORY_ID_KEY, dbValue.toString()),
          'restore history ID to Redis from DB'
        );
        logger.info({ historyId: dbValue }, 'Restored Gmail history ID from database fallback');
        return dbValue;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to read history ID from database fallback');
    }

    return 0;
  }

  /**
   * Persist the Gmail history ID checkpoint to both Redis and database.
   * Redis provides fast access; database provides durability across Redis restarts.
   *
   * Public so the facade can store the history ID after setupPushNotifications().
   */
  async setHistoryId(historyId: number): Promise<void> {
    // Write to Redis (fast, primary)
    await safeRedisOp(
      () => redis.set(HISTORY_ID_KEY, historyId.toString()),
      'set history ID in Redis'
    );

    // Write to database (durable fallback) — awaited to ensure checkpoint persistence
    try {
      await prisma.systemSetting.upsert({
        where: { id: HISTORY_ID_SETTING_KEY },
        create: {
          id: HISTORY_ID_SETTING_KEY,
          value: JSON.stringify(historyId),
          category: 'gmail',
          label: 'Last Gmail History ID',
          description: 'Durable checkpoint for Gmail push notification sync. Do not edit manually.',
          valueType: 'number',
          defaultValue: JSON.stringify(0),
        },
        update: {
          value: JSON.stringify(historyId),
        },
      });
    } catch (err: unknown) {
      logger.warn({ err, historyId }, 'Failed to persist history ID to database (non-critical)');
    }
  }

  // ─── Push notification handling ─────────────────────────────────────

  /**
   * Process a Gmail push notification
   *
   * IMPORTANT: Pub/Sub can deliver notifications out of order.
   * We do NOT skip based on incoming historyId. Instead:
   * 1. Always fetch history from our last known point
   * 2. The individual message deduplication (processMessage) handles duplicates
   * 3. Update historyId to the ACTUAL latest from the API response, not the notification
   */
  async processGmailNotification(
    emailAddress: string,
    notificationHistoryId: number,
    traceId: string
  ): Promise<void> {
    logger.info({ traceId, emailAddress, notificationHistoryId }, 'Processing Gmail notification');

    const gmail = await emailOAuthService.ensureGmailClient();

    try {
      // Get the last processed history ID (our sync point)
      // Uses Redis with database fallback for durability across Redis restarts
      const lastHistoryIdNum = await this.getHistoryId();

      // Don't skip out-of-order notifications - always fetch from our sync point
      // The message-level deduplication handles any duplicates safely
      // This prevents missing messages when Pub/Sub delivers [100, 105, 102]

      const startHistoryId = lastHistoryIdNum > 0 ? lastHistoryIdNum : notificationHistoryId - 1;

      let history;
      try {
        // Fetch history since last processed
        history = await gmail.users.history.list({
          userId: 'me',
          startHistoryId: startHistoryId.toString(),
          historyTypes: ['messageAdded'],
        });
      } catch (historyError: any) {
        const errorCode = historyError?.code || historyError?.status;

        // Handle 401 - Token expired, try to refresh
        // FIX T1: Use mutex to prevent concurrent refresh attempts
        if (errorCode === 401) {
          logger.warn(
            { traceId, errorCode },
            'Gmail API 401 - Token may be expired, attempting refresh'
          );
          try {
            const oauth2Client = emailOAuthService.getOAuth2ClientRaw();
            if (oauth2Client) {
              // FIX T1: Acquire lock before refreshing to prevent race condition
              const lockValue = await acquireTokenRefreshLock(traceId);
              if (lockValue) {
                try {
                  await oauth2Client.getAccessToken();
                } finally {
                  await releaseTokenRefreshLock(lockValue);
                }
              }
              // Retry the request once after refresh (or after waiting for another refresh)
              history = await gmail.users.history.list({
                userId: 'me',
                startHistoryId: startHistoryId.toString(),
                historyTypes: ['messageAdded'],
              });
            } else {
              throw new Error('OAuth client not initialized');
            }
          } catch (refreshError) {
            logger.error(
              { traceId, refreshError },
              'Failed to refresh Gmail token - manual reauthorization may be required'
            );
            throw new Error('Gmail token refresh failed - reauthorization required');
          }
        }
        // Handle 403 - Permission denied
        else if (errorCode === 403) {
          logger.error(
            { traceId, errorCode, errorMessage: historyError?.message },
            'Gmail API 403 - Permission denied. Check OAuth scopes and account permissions.'
          );
          throw new Error('Gmail permission denied - check OAuth configuration');
        }
        // Handle 429 - Rate limit exceeded
        else if (errorCode === 429) {
          const retryAfter = historyError?.response?.headers?.['retry-after'] || 60;
          // Do NOT advance the history checkpoint on 429.
          // The previous fix (E6) skipped unprocessed messages by jumping to notificationHistoryId.
          // Instead, keep the checkpoint unchanged so the next notification retries from
          // the same position. Message-level deduplication prevents double-processing.
          logger.warn(
            { traceId, errorCode, retryAfterSeconds: retryAfter, currentCheckpoint: lastHistoryIdNum },
            'Gmail API rate limit - keeping checkpoint unchanged to avoid skipping messages'
          );
          return;
        }
        // Handle 404 error - history ID doesn't exist (account switch or stale data)
        // FIX M12: Detect history gaps and trigger full sync fallback
        else if (errorCode === 404) {
          logger.warn(
            { traceId, startHistoryId, notificationHistoryId },
            'History gap detected (404) - triggering partial sync of recent messages'
          );

          // Instead of just resetting, try to fetch recent messages directly
          // This ensures we don't miss any messages during the gap
          try {
            const recentMessages = await gmail.users.messages.list({
              userId: 'me',
              maxResults: 50, // Fetch last 50 messages to cover the gap
              q: 'newer_than:1d', // Only last 24 hours to limit scope
            });

            if (recentMessages.data.messages) {
              logger.info(
                { traceId, messageCount: recentMessages.data.messages.length },
                'Processing recent messages to cover history gap'
              );
              for (const msg of recentMessages.data.messages) {
                if (msg.id) {
                  await emailMessageProcessorService.processMessage(msg.id, traceId);
                }
              }
            }
          } catch (syncError) {
            logger.error(
              { traceId, error: syncError },
              'Failed to sync recent messages after history gap - some emails may be missed'
            );
          }

          // Reset to notification history ID and persist to both Redis and DB
          await this.setHistoryId(notificationHistoryId);
          return;
        }
        // Unknown error - rethrow
        else {
          throw historyError;
        }
      }

      // Get the actual latest historyId from the API response
      // This is the correct value to store, NOT the notification's historyId
      const actualLatestHistoryId = history.data.historyId
        ? parseInt(history.data.historyId, 10)
        : notificationHistoryId;

      if (!history.data.history) {
        logger.info({ traceId }, 'No new messages in history');
        // Use MAX to ensure we only move forward, never backward
        if (actualLatestHistoryId > lastHistoryIdNum) {
          await this.setHistoryId(actualLatestHistoryId);
        }
        return;
      }

      // Collect unique messageIds first — Gmail history can contain the same
      // messageId in multiple history records (e.g. messageAdded + labelAdded).
      // Deduplicating here avoids unnecessary Redis lock round-trips in processMessage.
      const seenMessageIds = new Set<string>();
      for (const historyRecord of history.data.history) {
        if (historyRecord.messagesAdded) {
          for (const messageAdded of historyRecord.messagesAdded) {
            const messageId = messageAdded.message?.id;
            if (messageId) {
              seenMessageIds.add(messageId);
            }
          }
        }
      }

      // Process each unique message
      for (const messageId of seenMessageIds) {
        await emailMessageProcessorService.processMessage(messageId, traceId);
      }

      // Update to the actual latest history ID from the API response
      // Only move forward to prevent re-processing on out-of-order notifications
      if (actualLatestHistoryId > lastHistoryIdNum) {
        await this.setHistoryId(actualLatestHistoryId);
        logger.info(
          { traceId, previousHistoryId: lastHistoryIdNum, newHistoryId: actualLatestHistoryId },
          'Updated history ID checkpoint'
        );
      }
    } catch (error) {
      logger.error({ error, traceId }, 'Failed to process Gmail notification');
      throw error;
    }
  }

  // ─── Polling ────────────────────────────────────────────────────────

  /**
   * Poll for new emails (fallback when push isn't available)
   *
   * Uses two passes:
   * 1. Unread emails (fast path - most common case)
   * 2. All recent inbox emails regardless of read status (catches emails
   *    that were read by admin/mobile but never processed by the application)
   *
   * The processMessage() deduplication (Redis ZSET + DB check) ensures
   * already-processed messages are skipped cheaply, so the broader query
   * in pass 2 only adds minimal overhead.
   */
  async pollForNewEmails(traceId: string): Promise<{ processed: number }> {
    logger.info({ traceId }, 'Polling for new emails');

    const gmail = await emailOAuthService.ensureGmailClient();

    try {
      let processed = 0;

      // Pass 1: Unread emails (fast path - handles the common case efficiently)
      const unreadResponse = await executeGmailWithProtection(
        'poll-unread-messages',
        () => gmail.users.messages.list({
          userId: 'me',
          q: 'is:unread in:inbox newer_than:3d',
          maxResults: 20,
        })
      );

      const unreadMessages = unreadResponse.data.messages || [];
      const processedIds = new Set<string>();

      for (const message of unreadMessages) {
        if (message.id) {
          processedIds.add(message.id);
          const wasProcessed = await emailMessageProcessorService.processMessage(message.id, traceId);
          if (wasProcessed) processed++;
        }
      }

      // Pass 2: All recent inbox emails (catches emails read by admin/mobile
      // but never processed by the application). Uses a shorter window (1d)
      // since the stale recovery handles older messages via thread checking.
      // The processMessage dedup ensures this doesn't reprocess pass 1 results.
      const allRecentResponse = await executeGmailWithProtection(
        'poll-all-recent-messages',
        () => gmail.users.messages.list({
          userId: 'me',
          q: 'in:inbox newer_than:1d',
          maxResults: 20,
        })
      );

      const allRecentMessages = allRecentResponse.data.messages || [];

      for (const message of allRecentMessages) {
        if (message.id && !processedIds.has(message.id)) {
          const wasProcessed = await emailMessageProcessorService.processMessage(message.id, traceId);
          if (wasProcessed) processed++;
        }
      }

      // Also retry any failed push notifications
      const retriedCount = await this.retryFailedNotifications(traceId);
      if (retriedCount > 0) {
        processed += retriedCount;
      }

      return { processed };
    } catch (error) {
      logger.error({ error, traceId }, 'Failed to poll for emails');
      throw error;
    }
  }

  /**
   * Retry failed Gmail push notifications that were stored in Redis
   *
   * When push notifications fail to process (e.g., due to temporary errors),
   * they are stored in Redis with a TTL. This method retrieves and retries them.
   *
   * Keys are stored as: gmail:failed:{historyId}
   * Value format: { emailAddress, historyId, requestId, failedAt }
   */
  async retryFailedNotifications(traceId: string): Promise<number> {
    const MAX_RETRY_AGE_MS = 55 * 60 * 1000; // Only retry notifications < 55 minutes old (before 1h TTL expires)
    const MAX_RETRIES_PER_RUN = 10; // Limit retries per run to avoid overload
    const FAILED_SET_KEY = 'gmail:failed:set';

    let retriedCount = 0;

    try {
      // Use Redis Set (SMEMBERS) instead of JSON list to avoid read-modify-write race conditions.
      // The webhook handler uses SADD (atomic) to add failed notification IDs.
      // Also check the legacy JSON list key for backwards compatibility during rollout.
      let failedHistoryIds: string[] = await redis.smembers(FAILED_SET_KEY);

      // Backwards compatibility: also check legacy JSON list key
      const legacyListKey = 'gmail:failed:list';
      const legacyList = await redis.get(legacyListKey);
      if (legacyList) {
        try {
          const legacyIds = JSON.parse(legacyList);
          if (Array.isArray(legacyIds)) {
            // Migrate legacy entries to Set and clean up
            for (const id of legacyIds) {
              if (!failedHistoryIds.includes(id)) {
                failedHistoryIds.push(id);
                await redis.sadd(FAILED_SET_KEY, id);
              }
            }
            await redis.del(legacyListKey);
            logger.info({ traceId, migratedCount: legacyIds.length }, 'Migrated legacy failed notification list to Set');
          }
        } catch {
          await redis.del(legacyListKey);
        }
      }

      if (failedHistoryIds.length === 0) {
        return 0;
      }

      logger.info(
        { traceId, failedCount: failedHistoryIds.length },
        'Found failed notifications to retry'
      );

      for (const historyId of failedHistoryIds.slice(0, MAX_RETRIES_PER_RUN)) {
        const failedKey = `gmail:failed:${historyId}`;

        try {
          const failedData = await redis.get(failedKey);
          if (!failedData) {
            // Already expired or deleted, remove from set
            await redis.srem(FAILED_SET_KEY, historyId);
            continue;
          }

          const notification = JSON.parse(failedData);
          const { emailAddress, failedAt } = notification;

          // Check age
          if (Date.now() - failedAt > MAX_RETRY_AGE_MS) {
            logger.info({ traceId, historyId }, 'Skipping retry - notification too old');
            await redis.srem(FAILED_SET_KEY, historyId);
            await redis.del(failedKey);
            continue;
          }

          // Attempt to reprocess
          logger.info({ traceId, historyId, emailAddress }, 'Retrying failed notification');

          await this.processGmailNotification(
            emailAddress,
            parseInt(historyId, 10),
            `${traceId}:retry`
          );

          // Success - remove from failed set atomically
          await redis.srem(FAILED_SET_KEY, historyId);
          await redis.del(failedKey);
          retriedCount++;

          logger.info({ traceId, historyId }, 'Successfully retried failed notification');
        } catch (err) {
          logger.warn(
            { traceId, historyId, err },
            'Failed to retry notification - will try again later'
          );
          // Leave in the failed set for next retry attempt
        }
      }

      return retriedCount;
    } catch (err) {
      logger.warn({ traceId, err }, 'Error during failed notification retry');
      return retriedCount;
    }
  }

  // ─── Thread recovery ────────────────────────────────────────────────

  /**
   * Check a specific Gmail thread for unprocessed replies.
   * Used by the stale check service to recover missed therapist replies
   * that fell outside the normal polling window.
   *
   * Returns the number of messages successfully processed.
   */
  async checkThreadForUnprocessedReplies(threadId: string, traceId: string): Promise<number> {
    const gmail = await emailOAuthService.ensureGmailClient();

    try {
      const threadResponse = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'minimal',
      });

      const messages = threadResponse.data.messages || [];
      let processed = 0;

      // FIX: Collect all non-SENT message IDs from the thread, then cross-reference
      // against the processedGmailMessage table to find truly unprocessed messages.
      // Previously this only checked the UNREAD label, which misses replies that were
      // read in Gmail (by admin, mobile notification, etc.) but never processed by
      // the application. The database is the source of truth for processing state,
      // not Gmail's UNREAD label.
      const candidateMessages: Array<{ id: string; labels: string[] }> = [];
      for (const message of messages) {
        if (!message.id) continue;

        const labels = message.labelIds || [];

        // Skip messages in SENT (our outgoing emails)
        if (labels.includes('SENT') && !labels.includes('INBOX')) continue;

        candidateMessages.push({ id: message.id, labels });
      }

      if (candidateMessages.length === 0) {
        return 0;
      }

      // Batch-check which messages have already been processed using the database
      // as the authoritative source of truth (not Gmail labels)
      const alreadyProcessed = await prisma.processedGmailMessage.findMany({
        where: { id: { in: candidateMessages.map((m) => m.id) } },
        select: { id: true },
      });
      const processedIds = new Set(alreadyProcessed.map((p) => p.id));

      for (const message of candidateMessages) {
        // Skip messages already processed by our system
        if (processedIds.has(message.id)) continue;

        logger.info(
          { traceId, threadId, messageId: message.id, hadUnreadLabel: message.labels.includes('UNREAD') },
          'Found unprocessed message in stale thread - attempting recovery'
        );

        const wasProcessed = await emailMessageProcessorService.processMessage(message.id, traceId);
        if (wasProcessed) processed++;
      }

      return processed;
    } catch (error: any) {
      if (error?.code === 404 || error?.status === 404) {
        logger.warn({ traceId, threadId }, 'Thread not found during stale recovery check');
        return 0;
      }
      logger.error({ traceId, threadId, error }, 'Failed to check thread for unprocessed replies');
      return 0;
    }
  }

  /**
   * Preview which messages in a thread are unprocessed vs already processed.
   * Used by the admin UI to show a dry-run before triggering reprocessing.
   */
  async previewThreadMessages(
    threadId: string,
    traceId: string
  ): Promise<{
    messages: Array<{
      messageId: string;
      from: string;
      subject: string;
      date: string;
      status: 'processed' | 'unprocessed';
      snippet: string;
    }>;
  }> {
    const gmail = await emailOAuthService.ensureGmailClient();

    // Fetch thread with full format to get headers for preview
    const threadResponse = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });

    const gmailMessages = threadResponse.data.messages || [];
    if (gmailMessages.length === 0) {
      return { messages: [] };
    }

    // Collect inbound messages (skip SENT-only)
    const inboundMessages: Array<{ id: string; labels: string[]; headers: Record<string, string>; snippet: string }> = [];
    for (const message of gmailMessages) {
      if (!message.id) continue;
      const labels = message.labelIds || [];
      if (labels.includes('SENT') && !labels.includes('INBOX')) continue;

      const headers: Record<string, string> = {};
      for (const h of message.payload?.headers || []) {
        if (h.name && h.value) headers[h.name.toLowerCase()] = h.value;
      }
      inboundMessages.push({
        id: message.id,
        labels,
        headers,
        snippet: message.snippet || '',
      });
    }

    if (inboundMessages.length === 0) {
      return { messages: [] };
    }

    // Check which are already processed
    const alreadyProcessed = await prisma.processedGmailMessage.findMany({
      where: { id: { in: inboundMessages.map((m) => m.id) } },
      select: { id: true },
    });
    const processedIds = new Set(alreadyProcessed.map((p) => p.id));

    const messages = inboundMessages.map((m) => ({
      messageId: m.id,
      from: m.headers['from'] || 'Unknown',
      subject: m.headers['subject'] || '(no subject)',
      date: m.headers['date'] || '',
      status: processedIds.has(m.id) ? 'processed' as const : 'unprocessed' as const,
      snippet: m.snippet.substring(0, 120),
    }));

    logger.info(
      { traceId, threadId, total: messages.length, unprocessed: messages.filter(m => m.status === 'unprocessed').length },
      'Thread preview generated'
    );

    return { messages };
  }

  /**
   * Reprocess a Gmail thread safely with two modes:
   *
   * 1. Safe mode (default, forceMessageIds empty/undefined):
   *    Only processes messages that were NEVER processed. This is safe because
   *    it delegates to checkThreadForUnprocessedReplies without clearing anything.
   *    Use this for recovering genuinely missed messages.
   *
   * 2. Force mode (forceMessageIds provided):
   *    Clears processed records ONLY for the specified message IDs, then reprocesses.
   *    Use this for messages that were partially processed or erroneously marked as
   *    handled. The admin must explicitly select which messages to force-reprocess
   *    via the preview UI.
   *
   * This design prevents the dangerous scenario of blindly reprocessing all messages,
   * which would cause duplicate emails, duplicate conversation state entries, and
   * duplicate side effects through the JustinTime AI agent pipeline.
   */
  async reprocessThread(
    threadId: string,
    traceId: string,
    forceMessageIds?: string[]
  ): Promise<{ cleared: number; reprocessed: number }> {
    await emailOAuthService.ensureGmailClient();

    // If force-reprocessing specific messages, clear only those records
    let cleared = 0;
    if (forceMessageIds && forceMessageIds.length > 0) {
      logger.info(
        { traceId, threadId, forceMessageIds },
        'Force-clearing processed records for specific messages'
      );

      // Clear from database
      const { count: dbCleared } = await prisma.processedGmailMessage.deleteMany({
        where: { id: { in: forceMessageIds } },
      });
      cleared = dbCleared;

      // Clear from Redis (best effort)
      for (const messageId of forceMessageIds) {
        try {
          await redis.zrem(PROCESSED_MESSAGES_KEY, messageId);
          // Also clear any lingering locks
          await redis.del(`${MESSAGE_LOCK_PREFIX}${messageId}`);
        } catch {
          // Redis failure is non-fatal
        }
      }

      logger.info(
        { traceId, threadId, dbCleared, forceCount: forceMessageIds.length },
        'Cleared processed records for force-reprocessed messages'
      );
    }

    // Now run standard thread recovery — processes only messages NOT in processedGmailMessage
    const reprocessed = await this.checkThreadForUnprocessedReplies(threadId, traceId);

    logger.info(
      { traceId, threadId, cleared, reprocessed },
      'Thread reprocessing complete'
    );

    return { cleared, reprocessed };
  }
}

/** Singleton instance */
export const emailIngestService = new EmailIngestService();

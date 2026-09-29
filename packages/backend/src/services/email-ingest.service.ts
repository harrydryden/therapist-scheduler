import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { emailOAuthService, executeGmailWithProtection } from './email-oauth.service';
import { getLastProcessingErrors } from '../core/email';
import { processMessage } from '../domain/scheduling/inbound';
import type { gmail_v1 } from 'googleapis';
import {
  acquireTokenRefreshLock,
  releaseTokenRefreshLock,
  refreshAccessToken,
} from '../utils/gmail-auth';
import { EMAIL_PROCESSING, GMAIL_SYNC } from '../constants';
import { isGmail404 } from '../utils/gmail-errors';
import { parseGmailInternalDate } from '../utils/email-mime-parser';
import { clearMessageDedupState } from '../core/messaging/message-dedup';

// Redis keys
const HISTORY_ID_KEY = 'gmail:lastHistoryId';
const { SCANNER_MAX_MESSAGE_AGE_DAYS } = EMAIL_PROCESSING;

// DB key for Gmail history ID persistence (SystemSetting id)
const HISTORY_ID_SETTING_KEY = 'gmail.lastHistoryId';

const DAY_MS = 24 * 60 * 60 * 1000;

function gmailErrorCode(err: unknown): number | undefined {
  const e = err as { code?: unknown; status?: unknown } | null;
  const code = typeof e?.code === 'number' ? e.code : typeof e?.status === 'number' ? e.status : undefined;
  return code;
}

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
   * durable copy in the SystemSetting table. 0 = no checkpoint (or unreadable).
   */
  private async getHistoryId(): Promise<number> {
    try {
      return (await this.loadCheckpoint()) ?? 0;
    } catch (err) {
      logger.warn({ err }, 'Failed to read history ID from database fallback');
      return 0;
    }
  }

  /**
   * Checkpoint lookup that distinguishes "no checkpoint" (null) from "could
   * not read it" (throws) — watch renewal must not initialise a checkpoint
   * over one it merely failed to read.
   */
  private async loadCheckpoint(): Promise<number | null> {
    // Try Redis first (fast path)
    const redisValue = await redis.get(HISTORY_ID_KEY);
    if (redisValue) {
      const parsed = parseInt(redisValue, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    // Fallback to database
    const setting = await prisma.systemSetting.findUnique({
      where: { id: HISTORY_ID_SETTING_KEY },
    });
    if (!setting) return null;
    const dbValue = parseInt(JSON.parse(setting.value), 10);
    if (!Number.isFinite(dbValue) || dbValue <= 0) return null;
    // Re-populate Redis for future fast lookups
    await safeRedisOp(
      () => redis.set(HISTORY_ID_KEY, dbValue.toString()),
      'restore history ID to Redis from DB'
    );
    logger.info({ historyId: dbValue }, 'Restored Gmail history ID from database fallback');
    return dbValue;
  }

  /**
   * Register Gmail push notifications (watch).
   *
   * CHECKPOINT RULE (#7): the watch response's historyId is the mailbox's
   * CURRENT position. Storing it on every renewal (every boot and every 6
   * days) silently skipped everything between the old checkpoint and now
   * — every deploy, and the mandatory restart after re-auth. It is now
   * used only to INITIALISE a checkpoint that does not exist yet. An
   * existing checkpoint is never moved by watch renewal; a checkpoint
   * Gmail no longer recognises is repaired by the 404 gap path in
   * processGmailNotification (recoverFromHistoryGap). If the checkpoint
   * cannot be read, it is left alone.
   */
  async setupPushNotifications(topicName: string): Promise<{ historyId: string; expiration: string }> {
    const result = await emailOAuthService.setupPushNotifications(topicName);
    const watchHistoryId = parseInt(result.historyId, 10);

    let existing: number | null;
    try {
      existing = await this.loadCheckpoint();
    } catch (err) {
      logger.warn(
        { err, watchHistoryId },
        'Gmail watch renewed but the history checkpoint could not be read — leaving it untouched',
      );
      return result;
    }

    if (existing !== null) {
      logger.info(
        { checkpoint: existing, watchHistoryId },
        'Gmail watch renewed — keeping the existing history checkpoint (watch renewal never moves it)',
      );
    } else if (Number.isFinite(watchHistoryId) && watchHistoryId > 0) {
      await this.setHistoryId(watchHistoryId);
      logger.info({ historyId: watchHistoryId }, 'Initialised Gmail history checkpoint from watch registration');
    }
    return result;
  }

  /**
   * Persist the Gmail history ID checkpoint to both Redis and database.
   * Redis provides fast access; database provides durability across Redis restarts.
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
   *
   * PAGINATION (#7): history.list returns at most one page per call. Every
   * page is followed (nextPageToken), so a burst of more than one page of
   * history records — our own sent mail counts, so a mailing blast does it
   * — no longer silently skips everything past page 1. The checkpoint
   * advances to the FIRST page's historyId (the mailbox position when the
   * listing started): everything up to it has been listed. If the page cap
   * is hit, it advances only to the last history record listed, and the
   * next notification continues from there.
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

      let firstPage;
      try {
        firstPage = await this.listHistoryPage(gmail, startHistoryId, undefined, traceId);
      } catch (historyError: unknown) {
        const errorCode = gmailErrorCode(historyError);

        // Handle 403 - Permission denied
        if (errorCode === 403) {
          logger.error(
            { traceId, errorCode, errorMessage: (historyError as Error)?.message },
            'Gmail API 403 - Permission denied. Check OAuth scopes and account permissions.'
          );
          throw new Error('Gmail permission denied - check OAuth configuration');
        }
        // Handle 429 - Rate limit exceeded
        if (errorCode === 429) {
          const retryAfter =
            (historyError as { response?: { headers?: Record<string, string> } })?.response?.headers?.['retry-after'] || 60;
          // Do NOT advance the history checkpoint on 429: the next
          // notification retries from the same position; message-level
          // deduplication prevents double-processing.
          logger.warn(
            { traceId, errorCode, retryAfterSeconds: retryAfter, currentCheckpoint: lastHistoryIdNum },
            'Gmail API rate limit - keeping checkpoint unchanged to avoid skipping messages'
          );
          return;
        }
        // Handle 404 - the stored history ID is no longer valid (older than
        // Gmail's history retention, or from another mailbox).
        if (errorCode === 404) {
          await this.recoverFromHistoryGap(gmail, traceId, notificationHistoryId, startHistoryId);
          return;
        }
        throw historyError;
      }

      // The mailbox's position when the listing started. Everything up to
      // it is covered once every page has been read.
      const snapshotHistoryId = firstPage.data.historyId
        ? parseInt(firstPage.data.historyId, 10)
        : notificationHistoryId;

      // Collect unique messageIds across ALL pages — Gmail history can contain
      // the same messageId in multiple history records (e.g. messageAdded +
      // labelAdded), and deduplicating avoids redundant lock round-trips.
      const seenMessageIds = new Set<string>();
      let page = firstPage;
      let pages = 1;
      let lastRecordId = 0;
      let truncated = false;
      for (;;) {
        for (const historyRecord of page.data.history ?? []) {
          const recordId = historyRecord.id ? parseInt(historyRecord.id, 10) : NaN;
          if (Number.isFinite(recordId) && recordId > lastRecordId) lastRecordId = recordId;
          for (const messageAdded of historyRecord.messagesAdded ?? []) {
            const messageId = messageAdded.message?.id;
            if (messageId) seenMessageIds.add(messageId);
          }
        }
        const nextPageToken = page.data.nextPageToken;
        if (!nextPageToken) break;
        if (pages >= GMAIL_SYNC.MAX_HISTORY_PAGES) {
          truncated = true;
          logger.warn(
            { traceId, pages, lastRecordId, maxPages: GMAIL_SYNC.MAX_HISTORY_PAGES },
            'Gmail history listing hit the page cap — processing what was listed; the next notification continues from here'
          );
          break;
        }
        page = await this.listHistoryPage(gmail, startHistoryId, nextPageToken, traceId);
        pages++;
      }

      if (seenMessageIds.size === 0) {
        logger.info({ traceId, pages }, 'No new messages in history');
      }

      // Process each unique message
      for (const messageId of seenMessageIds) {
        await processMessage(messageId, traceId);
      }

      // Advance the checkpoint (forward only). When truncated, only as far
      // as the last history record actually listed.
      const newCheckpoint = truncated && lastRecordId > 0 ? lastRecordId : snapshotHistoryId;
      if (newCheckpoint > lastHistoryIdNum) {
        await this.setHistoryId(newCheckpoint);
        logger.info(
          { traceId, previousHistoryId: lastHistoryIdNum, newHistoryId: newCheckpoint, pages, messages: seenMessageIds.size },
          'Updated history ID checkpoint'
        );
      }
    } catch (error) {
      logger.error({ error, traceId }, 'Failed to process Gmail notification');
      throw error;
    }
  }

  /**
   * One page of `users.history.list`. A 401 triggers one mutex-guarded,
   * time-bounded token refresh and a single retry (FIX T1); every other
   * error propagates to the caller.
   */
  private async listHistoryPage(
    gmail: gmail_v1.Gmail,
    startHistoryId: number,
    pageToken: string | undefined,
    traceId: string,
  ) {
    const params = {
      userId: 'me',
      startHistoryId: startHistoryId.toString(),
      historyTypes: ['messageAdded'],
      maxResults: GMAIL_SYNC.HISTORY_PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    };
    try {
      return await gmail.users.history.list(params);
    } catch (err) {
      if (gmailErrorCode(err) !== 401) throw err;
      logger.warn({ traceId }, 'Gmail API 401 - Token may be expired, attempting refresh');
      try {
        const oauth2Client = emailOAuthService.getOAuth2ClientRaw();
        if (!oauth2Client) throw new Error('OAuth client not initialized');
        // Acquire lock before refreshing to prevent concurrent refreshes
        const lockValue = await acquireTokenRefreshLock(traceId);
        if (lockValue) {
          try {
            await refreshAccessToken(oauth2Client, 'history-list-token-refresh');
          } finally {
            await releaseTokenRefreshLock(lockValue);
          }
        }
        // Retry the request once after refresh (or after waiting for another refresh)
        return await gmail.users.history.list(params);
      } catch (refreshError) {
        logger.error(
          { traceId, refreshError },
          'Failed to refresh Gmail token - manual reauthorization may be required'
        );
        throw new Error('Gmail token refresh failed - reauthorization required');
      }
    }
  }

  /**
   * History gap (404 on history.list): the stored checkpoint is no longer
   * valid, so the history API cannot say what was missed.
   *
   * Recovery lists every message received since the checkpoint was last
   * written (its SystemSetting row's updatedAt, minus a margin), clamped
   * to [GAP_RECOVERY_MIN_LOOKBACK_DAYS, GAP_RECOVERY_MAX_LOOKBACK_DAYS]
   * and paginated up to GAP_RECOVERY_MAX_MESSAGES — it used to be only
   * the 50 newest messages of the last day. Messages are replayed oldest
   * first; the dedup layer makes already-processed ones a no-op.
   *
   * The new checkpoint is the mailbox's current historyId from Gmail's
   * own profile, snapshotted BEFORE the listing so anything arriving
   * during recovery is picked up by the next history.list — never the
   * notification's historyId, which is only as trustworthy as the push
   * that carried it. If the listing fails the checkpoint is left as it is
   * and the error propagates, so the failed-notification retry re-runs
   * the recovery instead of skipping the gap.
   */
  private async recoverFromHistoryGap(
    gmail: gmail_v1.Gmail,
    traceId: string,
    notificationHistoryId: number,
    staleHistoryId: number,
  ): Promise<void> {
    let resumeHistoryId: number | null = null;
    try {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const parsed = profile.data.historyId ? parseInt(profile.data.historyId, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) resumeHistoryId = parsed;
    } catch (err) {
      logger.warn({ traceId, err }, 'History gap: could not read the mailbox historyId from the Gmail profile');
    }

    const sinceMs = await this.gapRecoveryStartMs();
    logger.warn(
      { traceId, staleHistoryId, notificationHistoryId, since: new Date(sinceMs).toISOString() },
      'History gap detected (404) - recovering every message received since the last checkpoint'
    );

    const messageIds: string[] = [];
    let pageToken: string | undefined;
    do {
      const response = await gmail.users.messages.list({
        userId: 'me',
        // `after:` takes epoch seconds; our own sent mail is skipped
        // downstream anyway, so leave it out of the listing.
        q: `after:${Math.floor(sinceMs / 1000)} -from:me`,
        maxResults: GMAIL_SYNC.GAP_RECOVERY_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const msg of response.data.messages ?? []) {
        if (msg.id) messageIds.push(msg.id);
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken && messageIds.length < GMAIL_SYNC.GAP_RECOVERY_MAX_MESSAGES);

    if (pageToken) {
      logger.error(
        { traceId, listed: messageIds.length, cap: GMAIL_SYNC.GAP_RECOVERY_MAX_MESSAGES },
        'History gap recovery hit its message cap — older messages in the gap are left to the missed-message scanner'
      );
    }

    // messages.list is newest first; replay in arrival order.
    const toProcess = messageIds.slice(0, GMAIL_SYNC.GAP_RECOVERY_MAX_MESSAGES).reverse();
    logger.info({ traceId, messageCount: toProcess.length }, 'Processing messages to cover history gap');
    for (const messageId of toProcess) {
      try {
        await processMessage(messageId, traceId);
      } catch (err) {
        logger.warn({ traceId, messageId, err }, 'History gap recovery: message failed — continuing');
      }
    }

    await this.setHistoryId(resumeHistoryId ?? notificationHistoryId);
  }

  /** Start of the gap-recovery window (epoch ms); see recoverFromHistoryGap. */
  private async gapRecoveryStartMs(): Promise<number> {
    const now = Date.now();
    const earliest = now - GMAIL_SYNC.GAP_RECOVERY_MAX_LOOKBACK_DAYS * DAY_MS;
    const latest = now - GMAIL_SYNC.GAP_RECOVERY_MIN_LOOKBACK_DAYS * DAY_MS;
    let lastCheckpointAt: number | null = null;
    try {
      const row = await prisma.systemSetting.findUnique({
        where: { id: HISTORY_ID_SETTING_KEY },
        select: { updatedAt: true },
      });
      if (row?.updatedAt) lastCheckpointAt = row.updatedAt.getTime() - GMAIL_SYNC.GAP_RECOVERY_MARGIN_MS;
    } catch (err) {
      logger.warn({ err }, 'History gap: could not read when the checkpoint was last written — using the maximum lookback');
    }
    if (lastCheckpointAt === null) return earliest;
    return Math.min(latest, Math.max(earliest, lastCheckpointAt));
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
          maxResults: GMAIL_SYNC.POLL_MAX_RESULTS,
        })
      );

      const unreadMessages = unreadResponse.data.messages || [];
      const processedIds = new Set<string>();

      for (const message of unreadMessages) {
        if (message.id) {
          processedIds.add(message.id);
          const wasProcessed = await processMessage(message.id, traceId);
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
          maxResults: GMAIL_SYNC.POLL_MAX_RESULTS,
        })
      );

      const allRecentMessages = allRecentResponse.data.messages || [];

      for (const message of allRecentMessages) {
        if (message.id && !processedIds.has(message.id)) {
          const wasProcessed = await processMessage(message.id, traceId);
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
   * Used by the missed-message scanner, the human-control release replay
   * and the chase pre-send check to recover replies that fell outside the
   * normal polling window.
   *
   * AGE GUARD (E1): messages whose Gmail `internalDate` is older than
   * EMAIL_PROCESSING.SCANNER_MAX_MESSAGE_AGE_DAYS are never re-delivered.
   * "Unprocessed" is decided from the DB dedup table alone, and its rows
   * expire (DATA_RETENTION.PROCESSED_MESSAGE_RETENTION_DAYS) — without the
   * guard a long-running appointment's first replies were replayed to the
   * agent as NEW emails once their rows aged out (or after a Redis flush).
   * `options.forceMessageIds` (admin force-reprocess) bypasses the guard
   * for exactly those ids.
   *
   * Returns the number of messages successfully processed. A thread that no
   * longer exists (404) counts as 0; any other Gmail failure THROWS so the
   * caller (the scanner's failure count, the admin route) sees it.
   */
  async checkThreadForUnprocessedReplies(
    threadId: string,
    traceId: string,
    options: { forceMessageIds?: string[] } = {},
  ): Promise<number> {
    const gmail = await emailOAuthService.ensureGmailClient();

    try {
      const threadResponse = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'minimal',
      });

      const messages = threadResponse.data.messages || [];
      let processed = 0;
      const forced = new Set(options.forceMessageIds ?? []);
      const cutoffMs = Date.now() - SCANNER_MAX_MESSAGE_AGE_DAYS * 24 * 60 * 60 * 1000;
      let skippedTooOld = 0;

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

        // Age guard. Gmail's internalDate is an epoch-ms STRING — parse
        // with Number(), not new Date(). Missing/unparseable → no guard
        // (Gmail always sends it; recovery errs on processing).
        const internalMs = parseGmailInternalDate(message.internalDate);
        if (internalMs !== null && internalMs < cutoffMs && !forced.has(message.id)) {
          skippedTooOld++;
          continue;
        }

        candidateMessages.push({ id: message.id, labels });
      }

      if (skippedTooOld > 0) {
        logger.debug(
          { traceId, threadId, skippedTooOld, maxAgeDays: SCANNER_MAX_MESSAGE_AGE_DAYS },
          'Skipped messages older than the recovery age guard',
        );
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

        const wasProcessed = await processMessage(message.id, traceId);
        if (wasProcessed) processed++;
      }

      return processed;
    } catch (error: unknown) {
      if (isGmail404(error)) {
        logger.warn({ traceId, threadId }, 'Thread not found during stale recovery check');
        return 0;
      }
      // Rethrow everything else (O7). Returning 0 here made the scanner
      // count a failed Gmail fetch as a clean "nothing to recover", so it
      // reported healthy and wrote its heartbeat while every fetch failed.
      logger.error({ traceId, threadId, error }, 'Failed to check thread for unprocessed replies');
      throw error;
    }
  }

  /**
   * Check whether a Gmail thread contains any inbound (non-system) messages.
   *
   * Unlike checkThreadForUnprocessedReplies, this does NOT filter by processing
   * status — it answers the question "did anyone reply in this thread at all?"
   * regardless of whether the reply was successfully processed, failed, or was
   * abandoned after MAX_UNMATCHED_ATTEMPTS / MAX_PROCESSING_FAILURES.
   *
   * Used as a pre-flight check before sending chase follow-ups to avoid chasing
   * someone who already replied (even if our system failed to handle their reply).
   *
   * When `sinceMs` is provided, only inbound messages with `internalDate >= sinceMs`
   * count. Replies older than the cutoff are assumed to have already been accounted
   * for (e.g. they're what advanced the checkpoint into its current stage), so a
   * fresh chase against the OTHER party is legitimate even though they sit on the
   * thread. Pass the current checkpoint's `checkpoint_at` epoch ms to scope the
   * abandonment check to replies that arrived after the latest stage transition.
   */
  async threadContainsInboundReplies(
    threadId: string,
    traceId: string,
    sinceMs?: number,
  ): Promise<boolean> {
    const gmail = await emailOAuthService.ensureGmailClient();

    let threadResponse;
    try {
      threadResponse = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'minimal',
      });
    } catch (err) {
      // Thread deleted from Gmail (404). The caller is the chase
      // pre-flight check — bubbling a throw here triggers the
      // caller's catch-all warn ("Pre-chase thread check failed —
      // proceeding with chase send"), which is noisy. Returning
      // `false` (no inbound replies) preserves the same chase-
      // proceeding behaviour without the misleading log.
      if (isGmail404(err)) {
        logger.warn(
          { traceId, threadId },
          'Thread not found in Gmail (404) during inbound-reply check — treating as no replies',
        );
        return false;
      }
      throw err;
    }

    const messages = threadResponse.data.messages || [];

    for (const message of messages) {
      if (!message.id) continue;
      const labels = message.labelIds || [];
      // Messages with SENT (but not INBOX) are our outgoing emails — skip.
      // Anything else is an inbound reply.
      if (labels.includes('SENT') && !labels.includes('INBOX')) continue;

      // Optional stage-scoped filter: ignore inbound messages that pre-date
      // the cutoff. Gmail returns `internalDate` as a string of epoch ms;
      // if it's missing or unparseable, fall back to counting the message
      // (preserves the old safety-first behaviour for malformed data).
      if (sinceMs !== undefined) {
        const internalMs = message.internalDate ? Number(message.internalDate) : NaN;
        if (Number.isFinite(internalMs) && internalMs < sinceMs) continue;
      }

      return true; // Found at least one inbound message after the cutoff
    }

    return false;
  }

  /**
   * Preview which messages in a thread are unprocessed vs already processed.
   * Used by the admin UI to show a dry-run before triggering reprocessing.
   *
   * Each unprocessed message is annotated with the last recorded processing
   * error (if any) so the admin can see WHY it's failing without diving into
   * the logs.
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
      lastError?: string;
      processedContext?: string;
    }>;
  }> {
    const gmail = await emailOAuthService.ensureGmailClient();

    // Fetch thread with full format to get headers for preview.
    // If the thread no longer exists in Gmail (404), return an empty
    // preview rather than letting the throw propagate up to the
    // admin route's catch-all — which would surface a generic 404
    // to the operator for ONE deleted thread even when the other
    // (e.g. therapist-side thread) is still readable. Empty messages
    // is the same shape as a thread with zero messages, so the
    // existing admin UI renders "All processed" without changes.
    let threadResponse;
    try {
      threadResponse = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
    } catch (err) {
      if (isGmail404(err)) {
        logger.warn(
          { traceId, threadId },
          'Thread not found in Gmail (404) during preview — returning empty preview',
        );
        return { messages: [] };
      }
      throw err;
    }

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

    // Check which are already processed, and fetch the context tag so the UI
    // can show WHY (successfully processed vs divergence-blocked-abandoned etc).
    const alreadyProcessed = await prisma.processedGmailMessage.findMany({
      where: { id: { in: inboundMessages.map((m) => m.id) } },
      select: { id: true, context: true },
    });
    const processedMap = new Map(alreadyProcessed.map((p) => [p.id, p.context]));

    // Fetch last-known processing errors for unprocessed messages so the UI
    // can show the admin exactly why each message is stuck. Single batched
    // DB query rather than N+1.
    const unprocessedIds = inboundMessages.filter(m => !processedMap.has(m.id)).map(m => m.id);
    const errorMap = await getLastProcessingErrors(unprocessedIds);

    const messages = inboundMessages.map((m) => {
      const status = processedMap.has(m.id) ? 'processed' as const : 'unprocessed' as const;
      const processedContext = processedMap.get(m.id);
      const lastError = status === 'unprocessed' ? errorMap.get(m.id) || undefined : undefined;
      return {
        messageId: m.id,
        from: m.headers['from'] || 'Unknown',
        subject: m.headers['subject'] || '(no subject)',
        date: m.headers['date'] || '',
        status,
        snippet: m.snippet.substring(0, 120),
        ...(lastError ? { lastError } : {}),
        ...(processedContext ? { processedContext } : {}),
      };
    });

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

      // Clear every dedup layer (DB row, Redis ZSET/lock/unmatched keys)
      // and reset the DB retry budgets so a previously abandoned message
      // gets a fresh attempt budget — shared with the bulk admin retry.
      const { processedDeleted: dbCleared } = await clearMessageDedupState(forceMessageIds, traceId);
      cleared = dbCleared;

      logger.info(
        { traceId, threadId, dbCleared, forceCount: forceMessageIds.length },
        'Cleared processed records for force-reprocessed messages'
      );
    }

    // Now run standard thread recovery — processes only messages NOT in
    // processedGmailMessage. Explicitly force-selected ids bypass the
    // recovery age guard (the admin chose them); nothing else does.
    const reprocessed = await this.checkThreadForUnprocessedReplies(threadId, traceId, {
      forceMessageIds,
    });

    logger.info(
      { traceId, threadId, cleared, reprocessed },
      'Thread reprocessing complete'
    );

    return { cleared, reprocessed };
  }
}

/** Singleton instance */
export const emailIngestService = new EmailIngestService();

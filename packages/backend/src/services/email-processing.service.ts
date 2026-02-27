import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { DEFAULT_TIMEOUTS, TimeoutError } from '../utils/timeout';
import { circuitBreakerRegistry, CIRCUIT_BREAKER_CONFIGS, CircuitBreakerError } from '../utils/circuit-breaker';
// FIX #5: Lazy import to break circular dependency:
// justin-time.service → appointment-lifecycle.service → email-processing.service → justin-time.service
// Using dynamic import at call sites instead of top-level import.
type JustinTimeServiceType = import('./justin-time.service').JustinTimeService;
function getJustinTimeService(): typeof import('./justin-time.service').JustinTimeService {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./justin-time.service').JustinTimeService;
}
import { threadFetchingService } from './thread-fetching.service';
import { emailBounceService } from './email-bounce.service';
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
import {
  loadGmailCredentials,
  createOAuth2Client,
  acquireTokenRefreshLock,
  releaseTokenRefreshLock,
} from '../utils/gmail-auth';

// Redis keys
const HISTORY_ID_KEY = 'gmail:lastHistoryId';
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
 * Gmail API Circuit Breaker
 * Protects against cascading failures when Gmail API is degraded or unavailable.
 * - Opens after 5 failures in 60 seconds
 * - Attempts recovery after 30 seconds
 * - Requires 2 successes to close
 */
const gmailCircuitBreaker = circuitBreakerRegistry.getOrCreate(CIRCUIT_BREAKER_CONFIGS.GMAIL_API);

/**
 * Execute a Gmail API call with circuit breaker and timeout protection
 * @param operation - Name of the operation for logging
 * @param fn - The Gmail API function to execute
 * @param timeoutMs - Optional timeout (default: 30s)
 */
async function executeGmailWithProtection<T>(
  operation: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUTS.HTTP_FETCH
): Promise<T> {
  return gmailCircuitBreaker.execute(async () => {
    // Create timeout wrapper
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError(operation, timeoutMs));
      }, timeoutMs);
    });

    // Race against timeout
    return Promise.race([fn(), timeoutPromise]);
  });
}

/**
 * Check if Gmail operations should be attempted
 * Returns false if circuit breaker is open
 */
function canAttemptGmailOperation(): boolean {
  return !gmailCircuitBreaker.isOpen();
}

/**
 * Get Gmail circuit breaker stats for health checks
 */
export function getGmailCircuitStats() {
  return gmailCircuitBreaker.getStats();
}

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
 * Lua script to renew a lock only if we still own it
 * Returns 1 if renewed, 0 if lock was taken by someone else
 */
const LOCK_RENEWAL_SCRIPT = `
local lockKey = KEYS[1]
local expectedValue = ARGV[1]
local newTtl = tonumber(ARGV[2])

local currentValue = redis.call('GET', lockKey)
if currentValue == expectedValue then
  redis.call('EXPIRE', lockKey, newTtl)
  return 1
else
  return 0
end
`;

/**
 * Lua script to release a lock only if we still own it (FIX E2)
 * Prevents accidentally releasing another worker's lock
 * Returns 1 if released, 0 if lock was owned by someone else
 */
const LOCK_RELEASE_SCRIPT = `
local lockKey = KEYS[1]
local expectedValue = ARGV[1]

local currentValue = redis.call('GET', lockKey)
if currentValue == expectedValue then
  redis.call('DEL', lockKey)
  return 1
else
  return 0
end
`;

/**
 * Creates a lock renewal manager that periodically extends the lock TTL
 * Returns a cleanup function to stop renewal when processing is done
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

    try {
      const result = await redis.eval(
        LOCK_RENEWAL_SCRIPT,
        1,
        lockKey,
        lockValue,
        LOCK_TTL_SECONDS
      );

      if (result === 0) {
        // Lock was taken by someone else
        lockValid = false;
        logger.error(
          { lockKey },
          'Lock renewal failed - lock was taken by another process'
        );
        if (onLockLost) {
          onLockLost();
        }
        // Stop trying to renew
        clearInterval(renewalInterval);
      }
    } catch (err) {
      logger.error({ err, lockKey }, 'Lock renewal Redis error');
      // Don't invalidate lock on Redis errors - it might recover
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

export class EmailProcessingService {
  private gmail: gmail_v1.Gmail | null = null;
  private oauth2Client: OAuth2Client | null = null;

  constructor() {
    this.initializeGmailClient();
  }

  /**
   * Initialize the Gmail API client using stored OAuth credentials
   */
  private async initializeGmailClient(): Promise<void> {
    try {
      const creds = loadGmailCredentials('EmailProcessingService');
      if (!creds) {
        // Startup validation: warn loudly if credentials unavailable
        const isProduction = process.env.NODE_ENV === 'production';
        const level = isProduction ? 'error' : 'warn';
        logger[level](
          'Gmail client not initialized - email sending and receiving will be disabled. ' +
          'Set GMAIL_CREDENTIALS_BASE64 and GMAIL_TOKEN_BASE64 environment variables.'
        );
        return;
      }

      this.oauth2Client = createOAuth2Client(creds.credentials, creds.token);

      // Configure Gmail client with timeout to prevent hanging requests
      this.gmail = google.gmail({
        version: 'v1',
        auth: this.oauth2Client,
        timeout: DEFAULT_TIMEOUTS.HTTP_FETCH,
        retry: true,
      });
      logger.info('Gmail client initialized with timeout protection');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Gmail client');

      if (!this.gmail) {
        const isProduction = process.env.NODE_ENV === 'production';
        const level = isProduction ? 'error' : 'warn';
        logger[level](
          'Gmail client not initialized - email sending and receiving will be disabled. ' +
          'Set GMAIL_CREDENTIALS_BASE64 and GMAIL_TOKEN_BASE64 environment variables.'
        );
      }
    }
  }

  /**
   * Proactively refresh OAuth token if it's close to expiry
   * Call this before critical operations to prevent mid-operation failures
   *
   * @param minValidityMinutes - Minimum minutes of validity required (default: 10)
   * @returns Token status info
   */
  async ensureValidToken(minValidityMinutes: number = 10): Promise<{
    valid: boolean;
    expiresInMinutes?: number;
    refreshed?: boolean;
    error?: string;
  }> {
    if (!this.oauth2Client) {
      return { valid: false, error: 'OAuth client not initialized' };
    }

    try {
      const credentials = this.oauth2Client.credentials;
      const expiryDate = credentials.expiry_date;

      if (!expiryDate) {
        // No expiry date - try to refresh to get one
        logger.warn('No token expiry date - attempting refresh');
        await this.oauth2Client.getAccessToken();
        return { valid: true, refreshed: true };
      }

      const now = Date.now();
      const expiresInMs = expiryDate - now;
      const expiresInMinutes = Math.floor(expiresInMs / 60000);

      // If token expires soon, proactively refresh
      if (expiresInMinutes < minValidityMinutes) {
        logger.info(
          { expiresInMinutes, minValidityMinutes },
          'Token expiring soon - proactively refreshing'
        );

        // Use lock to prevent concurrent refresh attempts
        const lockValue = await acquireTokenRefreshLock('proactive-refresh');
        if (lockValue) {
          try {
            await this.oauth2Client.getAccessToken();
            const newExpiry = this.oauth2Client.credentials.expiry_date;
            const newExpiresIn = newExpiry ? Math.floor((newExpiry - Date.now()) / 60000) : undefined;

            logger.info({ newExpiresInMinutes: newExpiresIn }, 'Token refreshed successfully');
            return { valid: true, expiresInMinutes: newExpiresIn, refreshed: true };
          } finally {
            await releaseTokenRefreshLock(lockValue);
          }
        } else {
          // Another process is refreshing - wait briefly and check again
          await new Promise(resolve => setTimeout(resolve, 500));
          const updatedExpiry = this.oauth2Client.credentials.expiry_date;
          if (updatedExpiry && updatedExpiry - Date.now() > minValidityMinutes * 60000) {
            return { valid: true, expiresInMinutes: Math.floor((updatedExpiry - Date.now()) / 60000), refreshed: true };
          }
        }
      }

      return { valid: true, expiresInMinutes };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Failed to ensure valid token');
      return { valid: false, error: errorMessage };
    }
  }

  /**
   * Get token status for health checks
   */
  getTokenStatus(): {
    initialized: boolean;
    hasRefreshToken: boolean;
    expiresInMinutes?: number;
  } {
    if (!this.oauth2Client) {
      return { initialized: false, hasRefreshToken: false };
    }

    const credentials = this.oauth2Client.credentials;
    const hasRefreshToken = !!credentials.refresh_token;
    const expiryDate = credentials.expiry_date;
    const expiresInMinutes = expiryDate
      ? Math.floor((expiryDate - Date.now()) / 60000)
      : undefined;

    return {
      initialized: true,
      hasRefreshToken,
      expiresInMinutes,
    };
  }

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

    if (!this.gmail) {
      await this.initializeGmailClient();
      if (!this.gmail) {
        throw new Error('Gmail client not initialized');
      }
    }

    try {
      // Get the last processed history ID (our sync point)
      const lastHistoryId = await redis.get(HISTORY_ID_KEY);
      const lastHistoryIdNum = lastHistoryId ? parseInt(lastHistoryId, 10) : 0;

      // Don't skip out-of-order notifications - always fetch from our sync point
      // The message-level deduplication handles any duplicates safely
      // This prevents missing messages when Pub/Sub delivers [100, 105, 102]

      const startHistoryId = lastHistoryIdNum > 0 ? lastHistoryIdNum : notificationHistoryId - 1;

      let history;
      try {
        // Fetch history since last processed
        history = await this.gmail.users.history.list({
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
            if (this.oauth2Client) {
              // FIX T1: Acquire lock before refreshing to prevent race condition
              const lockValue = await acquireTokenRefreshLock(traceId);
              if (lockValue) {
                try {
                  await this.oauth2Client.getAccessToken();
                } finally {
                  await releaseTokenRefreshLock(lockValue);
                }
              }
              // Retry the request once after refresh (or after waiting for another refresh)
              history = await this.gmail.users.history.list({
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
            const recentMessages = await this.gmail!.users.messages.list({
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
                  await this.processMessage(msg.id, traceId);
                }
              }
            }
          } catch (syncError) {
            logger.error(
              { traceId, error: syncError },
              'Failed to sync recent messages after history gap - some emails may be missed'
            );
          }

          // Reset to notification history ID and update Redis
          await redis.set(HISTORY_ID_KEY, notificationHistoryId.toString());
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
          await redis.set(HISTORY_ID_KEY, actualLatestHistoryId.toString());
        }
        return;
      }

      // Process each new message
      // Individual messages have their own deduplication via processMessage
      for (const historyRecord of history.data.history) {
        if (historyRecord.messagesAdded) {
          for (const messageAdded of historyRecord.messagesAdded) {
            const messageId = messageAdded.message?.id;
            if (messageId) {
              await this.processMessage(messageId, traceId);
            }
          }
        }
      }

      // Update to the actual latest history ID from the API response
      // Only move forward to prevent re-processing on out-of-order notifications
      if (actualLatestHistoryId > lastHistoryIdNum) {
        await redis.set(HISTORY_ID_KEY, actualLatestHistoryId.toString());
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

  /**
   * Poll for new emails (fallback when push isn't available)
   */
  async pollForNewEmails(traceId: string): Promise<{ processed: number }> {
    logger.info({ traceId }, 'Polling for new emails');

    if (!this.gmail) {
      await this.initializeGmailClient();
      if (!this.gmail) {
        throw new Error('Gmail client not initialized');
      }
    }

    try {
      // Search for recent unread emails that are replies
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread in:inbox newer_than:1d',
        maxResults: 20,
      });

      const messages = response.data.messages || [];
      let processed = 0;

      for (const message of messages) {
        if (message.id) {
          const wasProcessed = await this.processMessage(message.id, traceId);
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
  private async processMessage(messageId: string, traceId: string): Promise<boolean> {
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

      if (!this.gmail) {
        throw new Error('Gmail client not initialized');
      }

      // Fetch full message
      const messageResponse = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

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
        await prisma.appointmentRequest.update({
          where: { id: appointmentRequest.id },
          data: {
            notes: `[DIVERGENCE ALERT - ${new Date().toISOString()}]\n${getDivergenceSummary(divergence)}\n\nEmail from: ${email.from}\nSubject: ${email.subject}\n---\n${(await prisma.appointmentRequest.findUnique({ where: { id: appointmentRequest.id }, select: { notes: true } }))?.notes || ''}`,
          },
        });

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
      await this.gmail.users.messages.modify({
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
          try {
            const released = await redis.eval(
              LOCK_RELEASE_SCRIPT,
              1,
              lockKey,
              traceId // traceId was used as lock value
            );
            if (released === 0) {
              logger.warn(
                { traceId, messageId },
                'Lock was taken by another process before release - lock ownership lost'
              );
            }
          } catch (err) {
            // Log but don't throw - lock will expire naturally
            logger.warn({ traceId, messageId, err }, 'Failed to release Redis lock - will expire naturally');
          }
        }
      }
      // Note: Database "lock" (processedGmailMessage) is not deleted - it serves as
      // permanent deduplication record. This is intentional for the fallback case.
    }
  }

  /**
   * Parse a Gmail message into our EmailMessage format
   * Returns null if message is malformed or missing required fields
   */
  private parseEmailMessage(message: gmail_v1.Schema$Message): EmailMessage | null {
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
          body = this.stripHtml(rawBody);
        } else {
          body = this.decodeHtmlEntities(rawBody);
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
          body = this.decodeHtmlEntities(rawBody);
        } else {
          // Fall back to HTML if no plain text available
          const htmlPart = message.payload.parts.find(
            (p) => p.mimeType === 'text/html'
          );
          if (htmlPart?.body?.data) {
            const contentType = htmlPart.mimeType || 'text/html; charset=utf-8';
            const rawBody = this.decodeEmailBody(htmlPart.body.data, contentType);
            body = this.stripHtml(rawBody);
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

  /**
   * Decode common HTML entities to their character equivalents
   * Some email clients include HTML entities even in plain text parts
   *
   * IMPORTANT: Order matters - specific entities first, then numeric
   * This prevents double-decoding of escaped numeric entities like &amp;#123;
   */
  private decodeHtmlEntities(text: string): string {
    return text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&ndash;/g, '\u2013')  // en-dash
      .replace(/&mdash;/g, '\u2014')  // em-dash
      .replace(/&hellip;/g, '\u2026') // horizontal ellipsis
      .replace(/&lsquo;/g, '\u2018')  // left single quote
      .replace(/&rsquo;/g, '\u2019')  // right single quote
      .replace(/&ldquo;/g, '\u201C')  // left double quote
      .replace(/&rdquo;/g, '\u201D')  // right double quote
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  /**
   * Strip HTML tags from content and convert to plain text
   * Preserves paragraph structure by converting block elements to newlines
   */
  private stripHtml(html: string): string {
    const stripped = html
      // Remove script and style blocks entirely
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      // Convert block elements to newlines for structure
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      // Remove all remaining HTML tags
      .replace(/<[^>]+>/g, '')
      // Normalize whitespace (preserve intentional line breaks)
      .replace(/[ \t]+/g, ' ')           // Collapse horizontal whitespace
      .replace(/ *\n */g, '\n')          // Trim spaces around newlines
      .replace(/\n{3,}/g, '\n\n')        // Collapse excessive newlines
      .trim();

    return this.decodeHtmlEntities(stripped);
  }

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
    // FIX EMAIL-CONTEXT: Statuses that should be matched for incoming emails
    // - Pre-booking: pending, contacted, negotiating
    // - Post-booking (active): confirmed (session not yet held)
    // - NOT included: session_held, feedback_requested, completed (post-session)
    // - NOT included: cancelled (terminal state)
    const MATCHABLE_STATUSES = ['pending', 'contacted', 'negotiating', 'confirmed'];

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
          status: { in: MATCHABLE_STATUSES as any },
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
    const activeRequests = await prisma.appointmentRequest.findMany({
      where: {
        OR: [
          { userEmail: email.from },
          { therapistEmail: email.from },
        ],
        status: {
          in: MATCHABLE_STATUSES as any,
        },
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

    if (activeRequests.length === 0) {
      return null;
    }

    // If only one active request, return it
    if (activeRequests.length === 1) {
      return activeRequests[0];
    }

    // Multiple active requests - try to match by therapist name in subject
    // FIX E8: Collect ALL matches, then select deterministically (most recently updated)
    const subjectLower = email.subject.toLowerCase();
    const nameMatches: typeof activeRequests = [];

    for (const request of activeRequests) {
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
      // Sort by updatedAt (descending), then by ID (ascending) as tiebreaker
      // This ensures deterministic selection even if two appointments have identical updatedAt
      nameMatches.sort((a, b) => {
        const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id); // Deterministic tiebreaker
      });
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
    const therapistMatches = activeRequests.filter(r => r.therapistEmail === email.from);
    if (therapistMatches.length === 1) {
      logger.info(
        { appointmentId: therapistMatches[0].id, therapistEmail: email.from },
        'Matched appointment by therapist email (unique match)'
      );
      return therapistMatches[0];
    } else if (therapistMatches.length > 1) {
      // FIX E8 + H4: Sort with ID as tiebreaker for deterministic selection
      therapistMatches.sort((a, b) => {
        const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id); // Deterministic tiebreaker
      });
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
      { from: email.from, subject: email.subject, activeRequestCount: activeRequests.length },
      'AMBIGUOUS MATCH: Could not deterministically match email to appointment. ' +
      'Email will be skipped to prevent misdirected responses. Manual intervention required.'
    );
    return null;
  }

  /**
   * Set up Gmail push notifications (watch)
   */
  async setupPushNotifications(topicName: string): Promise<{ historyId: string; expiration: string }> {
    if (!this.gmail) {
      await this.initializeGmailClient();
      if (!this.gmail) {
        throw new Error('Gmail client not initialized');
      }
    }

    const response = await this.gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName,
        labelIds: ['INBOX'],
      },
    });

    const historyId = response.data.historyId || '';
    const expiration = response.data.expiration || '';

    // Store initial history ID
    await redis.set(HISTORY_ID_KEY, historyId);

    logger.info({ historyId, expiration, topicName }, 'Gmail push notifications set up');

    return { historyId, expiration };
  }

  /**
   * Encode email header value for non-ASCII characters using RFC 2047 (MIME encoded-word)
   * Uses Base64 encoding (B) which is more reliable than quoted-printable (Q)
   */
  private encodeHeaderValue(value: string): string {
    // Check if the value contains any non-ASCII characters
    if (!/[^\x20-\x7E]/.test(value)) {
      return value; // ASCII-only, no encoding needed
    }
    // Use RFC 2047 Base64 encoding for non-ASCII
    return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
  }

  /**
   * Normalize line endings to CRLF as required by email RFC 5322
   */
  private normalizeLineEndings(text: string): string {
    return text
      .replace(/\r\n/g, '\n')  // First normalize all to LF
      .replace(/\r/g, '\n')    // Handle standalone CR
      .split('\n')
      .join('\r\n');           // Convert all to CRLF
  }

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
    if (!this.gmail) {
      await this.initializeGmailClient();
      if (!this.gmail) {
        throw new Error('Gmail client not initialized');
      }
    }

    // Encode subject if it contains non-ASCII characters (RFC 2047)
    const encodedSubject = this.encodeHeaderValue(params.subject);

    // Convert plain text body to simple HTML for proper text reflow on mobile
    // This prevents awkward mid-sentence line breaks on narrow screens
    const htmlBody = this.convertToHtml(params.body);

    // Determine In-Reply-To and References headers
    // If replyTo is provided, use it directly
    // If threadId is provided but no replyTo, fetch the last message ID from the thread
    let inReplyTo = params.replyTo;
    if (!inReplyTo && params.threadId && this.gmail) {
      try {
        const threadResponse = await this.gmail.users.threads.get({
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

    const response = await this.gmail.users.messages.send({
      userId: 'me',
      requestBody,
    });

    // Fetch the sent message to get threadId for conversation tracking
    // (in case a new thread was created)
    let threadId = params.threadId || '';
    if (response.data.id) {
      try {
        const sentMessage = await this.gmail.users.messages.get({
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

          await this.sendEmail({
            to: email.toEmail,
            subject: email.subject,
            body: bodyContent,
            threadId,
          });

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
              const existingApt = await prisma.appointmentRequest.findUnique({
                where: { id: email.appointmentId },
                select: { notes: true },
              });

              const abandonmentNote = `[EMAIL ABANDONED - ${now.toISOString()}]\nTo: ${email.toEmail}\nSubject: ${email.subject.slice(0, 100)}${email.subject.length > 100 ? '...' : ''}\nFailed after ${newRetryCount} retries: ${errorMessage.slice(0, 200)}`;

              await prisma.appointmentRequest.update({
                where: { id: email.appointmentId },
                data: {
                  notes: existingApt?.notes
                    ? `${existingApt.notes}\n\n${abandonmentNote}`
                    : abandonmentNote,
                  // Flag for admin attention via stall alert
                  conversationStallAlertAt: new Date(),
                  conversationStallAcknowledged: false,
                },
              });

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

  /**
   * Check Gmail integration health
   */
  async checkHealth(): Promise<{
    initialized: boolean;
    credentialsFound: boolean;
    tokenFound: boolean;
    canConnect: boolean;
    emailAddress?: string;
  }> {
    const credentialsFound = fs.existsSync(CREDENTIALS_PATH);
    const tokenFound = fs.existsSync(TOKEN_PATH);

    let canConnect = false;
    let emailAddress: string | undefined;
    if (this.gmail) {
      try {
        const profile = await this.gmail.users.getProfile({ userId: 'me' });
        canConnect = true;
        emailAddress = profile.data.emailAddress || undefined;
      } catch {
        canConnect = false;
      }
    }

    return {
      initialized: !!this.gmail,
      credentialsFound,
      tokenFound,
      canConnect,
      emailAddress,
    };
  }

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
}

export const emailProcessingService = new EmailProcessingService();

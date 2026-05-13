/**
 * Single entry point for Gmail message deduplication.
 *
 * Wraps the five existing primitives (Redis ZSET, Redis per-msg lock,
 * Redis unmatched-attempt counter, Redis Slack-alert dedup, DB
 * `ProcessedGmailMessage`) behind a typed API so future callers don't
 * have to remember which key prefix is canonical or what the DB
 * fallback looks like.
 *
 * Behaviour mirrors the in-place implementation in
 * `email-message-processor.processMessage` exactly — the same Lua
 * script, the same serializable-transaction DB fallback, the same
 * upsert pattern for marking processed. The point isn't to change
 * semantics, it's to give the contract a single home.
 *
 * See `core/messaging/README.md` for the migration plan; this PR
 * does NOT migrate existing callsites.
 */

import { prisma } from '../../utils/database';
import { logger } from '../../utils/logger';
import { redis } from '../../utils/redis';
import { ATOMIC_LOCK_CHECK_SCRIPT } from '../../utils/redis-scripts';
import { EMAIL_PROCESSING } from '../../constants';

const {
  PROCESSED_MESSAGES_KEY,
  MESSAGE_LOCK_PREFIX,
  UNMATCHED_ATTEMPT_PREFIX,
  PROCESSING_ALERT_DEDUP_PREFIX,
  MAX_UNMATCHED_ATTEMPTS,
  MAX_PROCESSING_FAILURES,
  UNMATCHED_ATTEMPT_TTL_SECONDS,
  PROCESSING_ALERT_DEDUP_TTL_SECONDS,
} = EMAIL_PROCESSING;

const LOCK_TTL_SECONDS = 300;

/** All possible outcomes of `acquireMessageLock`. */
export type LockResult =
  /** Lock held; caller is the unique worker for this message. */
  | { outcome: 'acquired' }
  /** Message already processed; caller should skip silently. */
  | { outcome: 'already_processed' }
  /** Another worker currently holds the lock; caller should skip. */
  | { outcome: 'held_by_other' }
  /** Redis was unavailable AND the DB fallback found prior work. */
  | { outcome: 'already_processed_db_fallback' }
  /** Redis was unavailable AND the DB advisory-lock succeeded. */
  | { outcome: 'acquired_db_fallback' };

/**
 * Atomic "lock and check" — try to claim the message AND verify it
 * hasn't been processed before, in a single round-trip. Mirrors the
 * `ATOMIC_LOCK_CHECK_SCRIPT` semantics:
 *
 *   - return  1 → lock acquired, not previously processed
 *   - return  0 → another worker is already processing this message
 *   - return -1 → message already in processed ZSET
 *
 * When Redis is unavailable, falls back to a serializable DB
 * transaction that races to insert a `ProcessedGmailMessage` row.
 * Unique-constraint failure on the row means another worker beat us
 * to it.
 */
export async function acquireMessageLock(
  messageId: string,
  traceId: string,
): Promise<LockResult> {
  const lockKey = `${MESSAGE_LOCK_PREFIX}${messageId}`;

  try {
    const result = (await redis.eval(
      ATOMIC_LOCK_CHECK_SCRIPT,
      2,
      lockKey,
      PROCESSED_MESSAGES_KEY,
      messageId,
      traceId,
      LOCK_TTL_SECONDS.toString(),
    )) as number;

    if (result === 1) return { outcome: 'acquired' };
    if (result === -1) return { outcome: 'already_processed' };
    return { outcome: 'held_by_other' };
  } catch (err) {
    logger.warn(
      { traceId, messageId, err },
      'Redis unavailable — falling back to database-only deduplication',
    );
    return acquireMessageLockViaDb(messageId, traceId);
  }
}

async function acquireMessageLockViaDb(
  messageId: string,
  traceId: string,
): Promise<LockResult> {
  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.processedGmailMessage.findUnique({
          where: { id: messageId },
        });
        if (existing) return 'already_processed_db_fallback' as const;

        try {
          await tx.processedGmailMessage.create({ data: { id: messageId } });
          return 'acquired_db_fallback' as const;
        } catch (insertErr: unknown) {
          if (
            insertErr &&
            typeof insertErr === 'object' &&
            'code' in insertErr &&
            (insertErr as { code?: string }).code === 'P2002'
          ) {
            return 'already_processed_db_fallback' as const;
          }
          throw insertErr;
        }
      },
      { isolationLevel: 'Serializable' },
    );
    return { outcome };
  } catch (err) {
    logger.error(
      { traceId, messageId, err },
      'DB fallback for message lock failed; treating as held_by_other',
    );
    return { outcome: 'held_by_other' };
  }
}

/**
 * Mark a message as fully processed. Writes to both the Redis ZSET
 * (fast path) and the DB row (authoritative record), idempotently.
 *
 * The `context` enum is the same as the existing
 * `ProcessedGmailMessage.context` field — it explains WHY this
 * message ended up here (matched & handled vs. unparseable vs.
 * abandoned after N failures vs. legacy backfill).
 */
export type ProcessedContext =
  | 'successfully-processed'
  | 'unparseable'
  | 'bounce'
  | 'own-email'
  | 'weekly-mailing-reply'
  | 'therapist-nudge-reply'
  | 'invitation-reply'
  | 'unmatched-abandoned'
  | 'divergence-blocked-abandoned'
  | 'processing-failed-abandoned'
  // Inbound replies routed to the availability-collection agent's
  // TherapistConversation. The four variants correspond to the four
  // lifecycle statuses; admin UI can distinguish them without needing
  // to JOIN the conversation row.
  | 'availability-agent-active'
  | 'availability-agent-superseded'
  | 'availability-agent-completed'
  | 'availability-agent-abandoned'
  | 'legacy';

export async function markMessageProcessed(
  messageId: string,
  context: ProcessedContext,
): Promise<void> {
  await Promise.all([
    redis.zadd(PROCESSED_MESSAGES_KEY, Date.now(), messageId).catch((err) => {
      logger.warn({ messageId, err }, 'Failed to update Redis processed ZSET; DB record still authoritative');
    }),
    prisma.processedGmailMessage.upsert({
      where: { id: messageId },
      create: { id: messageId, context },
      update: { context },
    }),
  ]);
}

/**
 * Release the per-message Redis lock without marking the message as
 * processed. Use this when processing fails in a recoverable way and
 * the message should be re-attempted on the next scanner pass.
 *
 * Lock is keyed by the trace ID (the value stored at the SET) so we
 * only delete if WE still own it — prevents accidentally releasing a
 * lock another worker has since claimed.
 */
export async function releaseMessageLock(messageId: string, traceId: string): Promise<void> {
  const lockKey = `${MESSAGE_LOCK_PREFIX}${messageId}`;
  try {
    // GET-then-DEL is racy in theory, but EVAL with a check-and-delete
    // Lua wins on safety. We reuse the standard pattern via SET... NX
    // semantics: only delete if the current value matches our traceId.
    const current = await redis.get(lockKey);
    if (current === traceId) {
      await redis.del(lockKey);
    }
  } catch (err) {
    logger.debug({ messageId, traceId, err }, 'Lock release failed; will expire on its own');
  }
}

/**
 * Release the DB-fallback advisory lock created by `acquireMessageLock`
 * when Redis was unavailable. The fallback creates a `ProcessedGmailMessage`
 * row to serve as a lock placeholder — if processing then fails, this
 * removes the placeholder so the next scanner pass can retry.
 *
 * Idempotent: P2025 (RecordNotFound) is treated as success. Other errors
 * are logged at WARN but swallowed so failure handling can continue.
 */
export async function releaseDbLock(messageId: string): Promise<void> {
  try {
    await prisma.processedGmailMessage.delete({ where: { id: messageId } });
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'P2025') return;
    logger.warn({ messageId, err }, 'Failed to release DB fallback lock');
  }
}

/**
 * Check whether a message is already in the processed set. Read-only
 * helper for scanners that want to filter a batch before locking.
 *
 * Truth source preference: Redis first (fast), DB on miss. The DB
 * read protects against the case where Redis was flushed but the
 * authoritative row still exists.
 */
export async function isMessageProcessed(messageId: string): Promise<boolean> {
  try {
    const score = await redis.zscore(PROCESSED_MESSAGES_KEY, messageId);
    if (score !== null && score !== undefined) return true;
  } catch (err) {
    logger.debug({ messageId, err }, 'Redis zscore failed; falling through to DB');
  }
  const row = await prisma.processedGmailMessage.findUnique({
    where: { id: messageId },
    select: { id: true },
  });
  return !!row;
}

/**
 * Filter a batch of message IDs down to those NOT yet processed.
 *
 * Used by the missed-message scanner and ingestion-recovery paths.
 * Single DB query (the authoritative source); Redis is bypassed
 * because scanner runs are infrequent and we want the canonical answer.
 */
export async function filterUnprocessed(messageIds: string[]): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const rows = await prisma.processedGmailMessage.findMany({
    where: { id: { in: messageIds } },
    select: { id: true },
  });
  const seen = new Set(rows.map((r) => r.id));
  return messageIds.filter((id) => !seen.has(id));
}

/**
 * Record a failure to MATCH a message to an appointment (no recipient
 * found, no thread matched). Returns the new attempt count and a
 * boolean indicating whether the message should be abandoned (count
 * has reached `MAX_UNMATCHED_ATTEMPTS`).
 *
 * The TTL means a transient routing problem (e.g. a recipient row
 * not yet created) re-arms after an hour rather than permanently
 * locking the message out.
 */
export async function recordUnmatchedAttempt(
  messageId: string,
): Promise<{ attempts: number; abandon: boolean }> {
  const key = `${UNMATCHED_ATTEMPT_PREFIX}${messageId}`;
  try {
    const attempts = await redis.incr(key);
    if (attempts === 1) {
      await redis.expire(key, UNMATCHED_ATTEMPT_TTL_SECONDS);
    }
    return { attempts, abandon: attempts >= MAX_UNMATCHED_ATTEMPTS };
  } catch (err) {
    logger.warn({ messageId, err }, 'Failed to record unmatched attempt in Redis; treating as first attempt');
    return { attempts: 1, abandon: false };
  }
}

/**
 * Acquire a one-shot dedup window for a Slack alert about a specific
 * message. Returns true the FIRST time the alert is requested for a
 * given message; false for every subsequent request within the
 * 1-hour TTL.
 *
 * Stops the hourly missed-message scanner from spamming Slack with
 * the same "could not process message X" alert across runs.
 */
export async function shouldEmitProcessingAlert(messageId: string): Promise<boolean> {
  const key = `${PROCESSING_ALERT_DEDUP_PREFIX}${messageId}`;
  try {
    const set = await redis.set(key, '1', 'EX', PROCESSING_ALERT_DEDUP_TTL_SECONDS, 'NX');
    return set === 'OK';
  } catch (err) {
    logger.warn({ messageId, err }, 'Failed to acquire alert dedup; emitting alert anyway');
    return true;
  }
}

export const DEDUP_CONSTANTS = {
  MAX_UNMATCHED_ATTEMPTS,
  MAX_PROCESSING_FAILURES,
  LOCK_TTL_SECONDS,
} as const;

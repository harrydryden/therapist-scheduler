/**
 * Single entry point for Gmail message deduplication.
 *
 * Wraps the five existing primitives (Redis ZSET, Redis per-msg lock,
 * Redis unmatched-attempt counter, Redis Slack-alert dedup, DB
 * `ProcessedGmailMessage`) behind a typed API so callers don't have
 * to remember which key prefix is canonical or what the DB fallback
 * looks like.
 *
 * The Redis path is the original Lua script; marking processed is the
 * original ZSET + DB upsert. The Redis-down fallback is a DB *lease*,
 * separate from the dedup record (see `DB_LEASE_ID_PREFIX`).
 *
 * The primary callsites in `domain/scheduling/inbound/process.ts`
 * (moved there from core/email/inbound/ in Stage D3) were migrated to
 * this facade in Phase 2b. `releaseMessageLock` is
 * available but unused — the email pipeline currently uses the
 * lower-level `utils/redis-locks.releaseLock` to match the pre-
 * refactor pattern. Migrating that callsite is a small follow-up
 * tracked in `docs/REFACTOR_PLAN.md`.
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

/**
 * DB-fallback processing lease (only used while Redis is unavailable).
 *
 * The lease is a `ProcessedGmailMessage` row in its own id namespace
 * (`lease:<messageId>`), NOT the message's dedup row. The old fallback
 * inserted the message's own processed row as the lock and deleted it only
 * on the generic error path, so every other non-success return — paused,
 * deferred, unmatched-within-budget, divergence retry, optimistic-lock
 * conflict, a crash — left the message permanently "processed" (E7). A
 * lease never marks the message processed; the caller releases it on
 * every return, and a crashed holder's lease expires after
 * `DB_LEASE_TTL_SECONDS` (`processedAt` is the lease start, refreshed by
 * `renewDbLock`). `context` carries a per-acquisition owner token so a
 * holder whose lease expired cannot release or renew its successor's.
 *
 * Nothing else reads these rows: every dedup query is by exact message id,
 * and the retention sweep ages out any lease a crash left behind.
 */
const DB_LEASE_ID_PREFIX = 'lease:';
const DB_LEASE_CONTEXT_PREFIX = 'processing-lease:';
export const DB_LEASE_TTL_SECONDS = LOCK_TTL_SECONDS;

function dbLeaseId(messageId: string): string {
  return `${DB_LEASE_ID_PREFIX}${messageId}`;
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';
}

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
  /**
   * Redis was unavailable AND the DB lease was acquired. `leaseToken`
   * identifies this holder: pass it to `renewDbLock` / `releaseDbLock`,
   * and release on EVERY return path.
   */
  | { outcome: 'acquired_db_fallback'; leaseToken: string };

/**
 * Atomic "lock and check" — try to claim the message AND verify it
 * hasn't been processed before, in a single round-trip. Mirrors the
 * `ATOMIC_LOCK_CHECK_SCRIPT` semantics:
 *
 *   - return  1 → lock acquired, not previously processed
 *   - return  0 → another worker is already processing this message
 *   - return -1 → message already in processed ZSET
 *
 * When Redis is unavailable, falls back to a DB lease (see
 * `DB_LEASE_ID_PREFIX`): the insert of the lease row is the atomic
 * claim, and a unique-constraint failure means another worker holds it.
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
  const leaseId = dbLeaseId(messageId);
  const leaseToken = `${DB_LEASE_CONTEXT_PREFIX}${traceId}:${Math.random().toString(36).slice(2, 10)}`;
  try {
    if (await processedRowExists(messageId)) {
      return { outcome: 'already_processed_db_fallback' };
    }

    // Expire a lease whose holder crashed or hung past the TTL. Scoped by
    // age, so a live holder's (renewed) lease is never touched.
    await prisma.processedGmailMessage.deleteMany({
      where: { id: leaseId, processedAt: { lt: new Date(Date.now() - DB_LEASE_TTL_SECONDS * 1000) } },
    });

    try {
      await prisma.processedGmailMessage.create({ data: { id: leaseId, context: leaseToken } });
    } catch (insertErr: unknown) {
      if (isUniqueViolation(insertErr)) return { outcome: 'held_by_other' };
      throw insertErr;
    }

    // A holder that finished between our first check and our insert has
    // marked the message processed and released its lease — re-check now
    // that we own the lease so we don't process it a second time.
    if (await processedRowExists(messageId)) {
      await releaseDbLock(messageId, leaseToken, traceId);
      return { outcome: 'already_processed_db_fallback' };
    }
    return { outcome: 'acquired_db_fallback', leaseToken };
  } catch (err) {
    logger.error(
      { traceId, messageId, err },
      'DB fallback for message lock failed; treating as held_by_other',
    );
    return { outcome: 'held_by_other' };
  }
}

async function processedRowExists(messageId: string): Promise<boolean> {
  const row = await prisma.processedGmailMessage.findUnique({
    where: { id: messageId },
    select: { id: true },
  });
  return !!row;
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
  // The message no longer exists in Gmail (404 on fetch) — typically
  // because the mailbox owner deleted it, the spam classifier hard-
  // deleted it, or permissions changed between the watch notification
  // and our fetch. Distinct from `processing-failed-abandoned` because
  // there's nothing transient to retry — the entity is gone.
  | 'message-not-found-in-gmail'
  // Inbound replies routed to the availability-collection agent's
  // TherapistConversation. The four variants correspond to the four
  // lifecycle statuses; admin UI can distinguish them without needing
  // to JOIN the conversation row.
  | 'availability-agent-active'
  | 'availability-agent-superseded'
  | 'availability-agent-completed'
  | 'availability-agent-abandoned'
  // RFC 3834 auto-submitted / out-of-office reply: recorded and never
  // handed to an agent (no Claude turn for an autoresponder).
  | 'auto-reply'
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
 * Release the DB-fallback lease taken by `acquireMessageLock` when Redis
 * was unavailable. Must be called on EVERY return path of the holder —
 * success, skip, retry and failure alike — because the lease is not the
 * dedup record (`markMessageProcessed` writes that). Owner-checked: only
 * the holder whose token matches deletes it.
 *
 * Idempotent; errors are logged at WARN and swallowed (an unreleased
 * lease expires after `DB_LEASE_TTL_SECONDS`).
 */
export async function releaseDbLock(messageId: string, leaseToken: string, traceId?: string): Promise<void> {
  try {
    await prisma.processedGmailMessage.deleteMany({
      where: { id: dbLeaseId(messageId), context: leaseToken },
    });
  } catch (err: unknown) {
    // traceId is also surfaced via the pino mixin when the caller
    // runs inside runWithTrace (which the email pipeline does), but
    // pass it explicitly so the log line is self-contained even when
    // an external caller invokes this outside a trace context.
    logger.warn({ traceId, messageId, err }, 'Failed to release DB fallback lease (expires on its own)');
  }
}

/**
 * Extend the DB-fallback lease (the DB twin of the Redis lock renewal).
 * Returns false only when the lease is gone or owned by someone else — a
 * transient DB error keeps the holder going (the lease has plenty of TTL
 * left and the next renewal retries).
 */
export async function renewDbLock(messageId: string, leaseToken: string): Promise<boolean> {
  try {
    const { count } = await prisma.processedGmailMessage.updateMany({
      where: { id: dbLeaseId(messageId), context: leaseToken },
      data: { processedAt: new Date() },
    });
    return count === 1;
  } catch (err) {
    logger.warn({ messageId, err }, 'Failed to renew DB fallback lease — will retry at the next renewal');
    return true;
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

export interface DedupClearResult {
  /** ProcessedGmailMessage rows deleted. */
  processedDeleted: number;
  /** MessageProcessingFailure rows deleted (0 if the delete failed). */
  failuresDeleted: number;
  /** UnmatchedEmailAttempt rows deleted (0 if the delete failed). */
  unmatchedDeleted: number;
}

/**
 * Forget that a set of messages was ever processed, so the next
 * processMessage call re-runs them from scratch. Used by the admin
 * recovery paths (per-thread force-reprocess and the bulk
 * `/api/admin/processing-failures/retry`).
 *
 * Clears EVERY dedup layer:
 *   - the DB `ProcessedGmailMessage` row (awaited — errors propagate),
 *   - the Redis processed-ZSET member, the per-message lock and the
 *     unmatched-attempt counter (best effort). Clearing only the DB row
 *     is a silent no-op: ATOMIC_LOCK_CHECK_SCRIPT still finds the ZSET
 *     member and reports `already_processed` for up to 30 days (E8).
 *   - the DB retry budgets (`MessageProcessingFailure`,
 *     `UnmatchedEmailAttempt`), so a previously abandoned message gets a
 *     fresh attempt budget instead of re-abandoning on its first failure
 *     (best effort — logged, reported as 0).
 */
export async function clearMessageDedupState(
  messageIds: string[],
  traceId?: string,
): Promise<DedupClearResult> {
  const result: DedupClearResult = { processedDeleted: 0, failuresDeleted: 0, unmatchedDeleted: 0 };
  if (messageIds.length === 0) return result;

  const { count } = await prisma.processedGmailMessage.deleteMany({
    where: { id: { in: messageIds } },
  });
  result.processedDeleted = count;

  // Best effort: a Redis outage must not block recovery (the DB is
  // authoritative and the lock path falls back to it when Redis is down).
  const bestEffort = async (op: () => Promise<unknown>): Promise<void> => {
    try {
      await op();
    } catch (err) {
      logger.debug({ traceId, err }, 'Redis dedup clear failed (non-fatal)');
    }
  };
  await Promise.all(
    messageIds.flatMap((messageId) => [
      bestEffort(() => redis.zrem(PROCESSED_MESSAGES_KEY, messageId)),
      bestEffort(() => redis.del(`${MESSAGE_LOCK_PREFIX}${messageId}`)),
      bestEffort(() => redis.del(`${UNMATCHED_ATTEMPT_PREFIX}${messageId}`)),
    ]),
  );

  try {
    const [failures, unmatched] = await Promise.all([
      prisma.messageProcessingFailure.deleteMany({ where: { id: { in: messageIds } } }),
      prisma.unmatchedEmailAttempt.deleteMany({ where: { id: { in: messageIds } } }),
    ]);
    result.failuresDeleted = failures.count;
    result.unmatchedDeleted = unmatched.count;
  } catch (err) {
    logger.warn({ traceId, err }, 'Failed to clear attempt tracking records while clearing dedup state');
  }

  return result;
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

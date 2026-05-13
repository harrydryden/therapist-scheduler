/**
 * Tracking for emails that don't match an active appointment thread.
 *
 * A persistently unmatched email would otherwise reprocess on every
 * scanner pass forever. This module bounds the retry count via the
 * `UnmatchedEmailAttempt` table — DB-authoritative so a Redis outage
 * can't suppress abandonment.
 *
 *   - `trackUnmatchedAttempt` upserts the attempt row and returns the
 *     new count. Redis is updated as a best-effort cache only.
 *   - `abandonUnmatched` marks the DB row as abandoned and tears down
 *     the Redis cache.
 *
 * This module is DELIBERATELY separate from
 * `core/messaging/message-dedup.recordUnmatchedAttempt`. The facade's
 * version uses Redis-only counters with TTL — adequate for callers
 * that haven't been hit by the "Redis flap = stuck-at-1 forever" bug
 * we hit here. Aligning the two is a future PR; for now, keep the
 * DB-authoritative version local to inbound processing where we
 * learned the lesson.
 */

import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { redis } from '../../../utils/redis';
import { EMAIL_PROCESSING } from '../../../constants';

const { UNMATCHED_ATTEMPT_PREFIX, UNMATCHED_ATTEMPT_TTL_SECONDS } = EMAIL_PROCESSING;

export async function trackUnmatchedAttempt(messageId: string): Promise<number> {
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

  // Update Redis as a cache (best-effort, non-blocking). Allows quick
  // checks without DB round-trips, but DB is authoritative.
  const cacheKey = `${UNMATCHED_ATTEMPT_PREFIX}${messageId}`;
  redis.set(cacheKey, String(attempts), 'EX', UNMATCHED_ATTEMPT_TTL_SECONDS).catch((err) => {
    logger.warn({ messageId, err }, 'Failed to cache unmatched attempt count in Redis');
  });

  return attempts;
}

/**
 * Mark the DB row as abandoned and clean up the Redis cache. The
 * caller is responsible for the corresponding `markMessageProcessed`
 * with context='unmatched-abandoned' on the dedup table.
 */
export async function abandonUnmatched(messageId: string): Promise<void> {
  await prisma.unmatchedEmailAttempt.update({
    where: { id: messageId },
    data: { abandoned: true },
  });
  // Best-effort cache cleanup.
  const cacheKey = `${UNMATCHED_ATTEMPT_PREFIX}${messageId}`;
  redis.del(cacheKey).catch((err) => {
    logger.debug({ messageId, err }, 'Failed to delete unmatched-attempt Redis cache');
  });
}

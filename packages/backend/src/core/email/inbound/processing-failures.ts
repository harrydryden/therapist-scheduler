/**
 * Tracking for per-message processing failures.
 *
 * The missed-message scanner re-discovers failed messages every hour.
 * Without a retry budget + visibility, a persistently broken message
 * would loop forever. This module is the single owner of the
 * `MessageProcessingFailure` table:
 *
 *   - `trackProcessingFailure` increments the attempt counter and
 *     stores the last error text. Called from `processMessage`'s catch
 *     block.
 *   - `markFailureAbandoned` flips the abandoned flag after the budget
 *     is exhausted, so the admin retry endpoint can find the row.
 *   - `clearProcessingFailure` deletes the record on a successful
 *     pass — the UI shows a clean state and a future failure starts
 *     a fresh attempt count.
 *   - `getLastProcessingError` / `getLastProcessingErrors` are the
 *     read side, used by `previewThreadMessages` to annotate MISSED
 *     messages with their failure reason in the admin UI.
 *
 * DB is the source of truth (the previous Redis-only counter returned
 * 1 forever when Redis was down, so abandonment never triggered and
 * the scanner looped). No Redis cache here — error strings can be
 * large and we want persistence anyway. Counter reads happen only on
 * the next failure, which already goes through DB.
 */

import { prisma } from '../../../utils/database';

// Truncate failure messages so a runaway stack trace can't blow up the row.
const MAX_ERROR_LENGTH = 2000;

export async function trackProcessingFailure(
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
 * Mark a processing failure as abandoned (after exceeding the failure
 * budget). The dedup record itself is created separately via
 * `markMessageProcessed`; this only flips the abandoned flag so the
 * admin retry endpoint can find it.
 */
export async function markFailureAbandoned(messageId: string): Promise<void> {
  await prisma.messageProcessingFailure.update({
    where: { id: messageId },
    data: { abandoned: true },
  });
}

/**
 * Look up the last recorded error for a message (or null if none).
 * Used by `previewThreadMessages` to annotate MISSED messages with
 * their failure reason.
 */
export async function getLastProcessingError(messageId: string): Promise<string | null> {
  const record = await prisma.messageProcessingFailure.findUnique({
    where: { id: messageId },
    select: { lastError: true },
  });
  return record?.lastError ?? null;
}

/**
 * Batch lookup of last errors for many messages, used by
 * `previewThreadMessages` so we don't N+1 a single thread.
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
 * Clear the failure record on successful processing so the UI shows
 * a clean state and a future failure starts a fresh attempt count.
 */
export async function clearProcessingFailure(messageId: string): Promise<void> {
  await prisma.messageProcessingFailure.deleteMany({ where: { id: messageId } });
}

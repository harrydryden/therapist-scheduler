/**
 * Per-appointment turn lock.
 *
 * `startScheduling` and `processEmailReply` both read the current
 * conversation state, run the agent, and write it back guarded by an
 * optimistic-lock `updatedAt` check. Nothing previously prevented two
 * overlapping turns for the SAME appointment (a fast double-reply, or a
 * reply arriving while `startScheduling`'s initial save is still in
 * flight) from racing on that check-then-write — the loser's turn either
 * silently discards its own conversation state or (with the old
 * `ConcurrentModificationError` handling) has the newer version adopted
 * out from under it without its changes ever landing.
 *
 * This lock serializes turns per appointment so that race can't happen.
 * Gated behind the `agent.turnSerialization` setting — see
 * docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md for the rollout rationale.
 */

import { logger } from '../utils/logger';
import { acquireLock, releaseLock } from '../utils/redis-locks';
import { createLockRenewal, LOCK_TTL_SECONDS } from '../core/email/inbound/lock-renewal';

const TURN_LOCK_PREFIX = 'turn-lock:appointment:';
const ACQUIRE_POLL_INTERVAL_MS = 500;
const ACQUIRE_MAX_WAIT_MS = 30_000;

export type TurnLockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false };

/**
 * Run `fn` while holding an exclusive per-appointment turn lock.
 *
 * If another turn already holds the lock, polls for up to
 * `ACQUIRE_MAX_WAIT_MS` before giving up. A give-up returns
 * `{ acquired: false }` rather than throwing — callers treat it as "defer
 * this turn" (leave the triggering message/request to be retried by
 * whatever mechanism already re-drives it) rather than a hard error.
 */
export async function withAppointmentTurnLock<T>(
  appointmentId: string,
  traceId: string,
  fn: () => Promise<T>,
): Promise<TurnLockResult<T>> {
  const lockKey = `${TURN_LOCK_PREFIX}${appointmentId}`;
  const deadline = Date.now() + ACQUIRE_MAX_WAIT_MS;

  let acquired = await acquireLock(lockKey, traceId, LOCK_TTL_SECONDS);
  while (!acquired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ACQUIRE_POLL_INTERVAL_MS));
    acquired = await acquireLock(lockKey, traceId, LOCK_TTL_SECONDS);
  }

  if (!acquired) {
    logger.warn(
      { traceId, appointmentId },
      'Could not acquire appointment turn lock within the wait budget; deferring this turn',
    );
    return { acquired: false };
  }

  // Turns can run long (Claude API calls, multiple tool round-trips), so
  // the lock is renewed periodically the same way the per-message
  // processing lock is — same TTL, same renewal cadence, same
  // only-release-if-still-owned discipline in the finally block below.
  const renewal = createLockRenewal(lockKey, traceId, () => {
    logger.error(
      { traceId, appointmentId },
      'Appointment turn lock lost during processing — another turn may now be running concurrently',
    );
  });

  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    renewal.stop();
    if (renewal.isLockValid()) {
      await releaseLock(lockKey, traceId, `turn-lock:${appointmentId}`);
    } else {
      logger.info(
        { traceId, appointmentId },
        'Turn lock no longer owned (detected by renewal) — skipping release',
      );
    }
  }
}

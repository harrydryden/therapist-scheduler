/**
 * Periodic lock renewal for long-running message processing.
 *
 * Thread fetches and Claude API calls can each take 30+ seconds, so
 * the message-lock TTL (5 minutes) would expire mid-processing if not
 * renewed. The renewal manager extends the TTL every 60 seconds and
 * stops when processing completes.
 *
 * Two lock kinds share the same manager: the Redis message lock
 * (`createLockRenewal`) and the DB-fallback lease used while Redis is
 * down (`createLeaseRenewal` with `renewDbLock`).
 *
 * If renewal ever fails (another worker took the lock), `onLockLost`
 * fires and `isLockValid` flips false — the caller checks this in its
 * `finally` block so a stolen lock isn't released by the original
 * owner (which would let a third worker race in).
 */

import { logger } from '../../../utils/logger';
import { renewLock } from '../../../utils/redis-locks';

const LOCK_RENEWAL_INTERVAL_MS = 60 * 1000;
export const LOCK_TTL_SECONDS = 300;

export interface LockRenewal {
  stop: () => void;
  isLockValid: () => boolean;
}

/**
 * Renew any lock via `renew` (true = still ours, false = lost) every
 * `LOCK_RENEWAL_INTERVAL_MS` until `stop()`.
 */
export function createLeaseRenewal(
  renew: () => Promise<boolean>,
  describe: string,
  onLockLost?: () => void,
): LockRenewal {
  let isActive = true;
  let lockValid = true;

  const renewalInterval = setInterval(async () => {
    if (!isActive) return;

    const renewed = await renew();
    if (!renewed) {
      lockValid = false;
      logger.error({ lock: describe }, 'Lock renewal failed - lock was taken by another process');
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

/** Renewal for the Redis message lock (`SET key value EX ttl`). */
export function createLockRenewal(
  lockKey: string,
  lockValue: string,
  onLockLost?: () => void,
): LockRenewal {
  return createLeaseRenewal(() => renewLock(lockKey, lockValue, LOCK_TTL_SECONDS), lockKey, onLockLost);
}

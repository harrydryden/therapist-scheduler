/**
 * Periodic Redis-lock renewal for long-running message processing.
 *
 * Thread fetches and Claude API calls can each take 30+ seconds, so
 * the message-lock TTL (5 minutes) would expire mid-processing if not
 * renewed. The renewal manager extends the TTL every 60 seconds and
 * stops when processing completes.
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

export function createLockRenewal(
  lockKey: string,
  lockValue: string,
  onLockLost?: () => void,
): LockRenewal {
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

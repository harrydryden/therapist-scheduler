/**
 * Shared Redis Lua Scripts for Distributed Locking
 *
 * These scripts run atomically on the Redis server to prevent race conditions
 * in lock operations. Previously duplicated across 5+ services.
 *
 * Used by: stale-check, pending-email, notion-sync-manager, weekly-mailing-list,
 *          slack-weekly-summary, email-processing
 */

import { redis } from './redis';
import { logger } from './logger';

/**
 * Lua script to release a lock only if the caller owns it.
 * Prevents accidentally releasing another instance's lock.
 *
 * KEYS[1] = lock key
 * ARGV[1] = expected lock value (owner identifier)
 * Returns: 1 if released, 0 if not owned
 */
export const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/**
 * Lua script to renew a lock only if the caller owns it.
 * Used for long-running operations that need to extend their lock TTL.
 *
 * KEYS[1] = lock key
 * ARGV[1] = expected lock value (owner identifier)
 * ARGV[2] = new TTL in seconds
 * Returns: 1 if renewed, 0 if lock was taken by another instance
 */
export const RENEW_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('expire', KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Release a distributed lock only if the caller owns it.
 *
 * @param lockKey - Redis key for the lock
 * @param instanceId - The value set when the lock was acquired (owner identifier)
 * @param context - Optional context string for log messages
 */
export async function releaseLock(
  lockKey: string,
  instanceId: string,
  context?: string,
): Promise<void> {
  try {
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, instanceId);
  } catch (error) {
    logger.warn({ error, lockKey, context }, 'Failed to release lock');
  }
}

/**
 * Renew a distributed lock only if the caller owns it.
 *
 * @param lockKey - Redis key for the lock
 * @param instanceId - The value set when the lock was acquired (owner identifier)
 * @param ttlSeconds - New TTL in seconds
 * @returns true if renewed successfully, false if lock was lost
 */
export async function renewLock(
  lockKey: string,
  instanceId: string,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    const result = await redis.eval(
      RENEW_LOCK_SCRIPT,
      1,
      lockKey,
      instanceId,
      ttlSeconds,
    );
    return result === 1;
  } catch (error) {
    logger.warn({ error, lockKey }, 'Failed to renew lock');
    return false;
  }
}

/**
 * Attempt to acquire a distributed lock using SET NX EX.
 *
 * @param lockKey - Redis key for the lock
 * @param instanceId - Unique value identifying this lock holder
 * @param ttlSeconds - Lock expiration in seconds
 * @returns true if lock acquired, false if held by another instance
 */
export async function acquireLock(
  lockKey: string,
  instanceId: string,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    const result = await redis.set(lockKey, instanceId, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (error) {
    logger.warn({ error, lockKey }, 'Redis unavailable for lock - using local guard only');
    return true; // Allow single-instance operation when Redis is down
  }
}

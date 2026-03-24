/**
 * Barrel re-export for Redis utilities.
 *
 * All consumer code should continue to import from this module:
 *   import { redis, cacheManager, CacheManager } from '../utils/redis';
 *
 * Internals are split across:
 *   - redis-client.ts  — Redis connection, health tracking, backpressure
 *   - cache-manager.ts — CacheManager class with caching methods
 */

import { redisClientManager } from './redis-client';
import { CacheManager } from './cache-manager';

// Re-export types and constants so any deep imports keep working
export { RedisHealthState, BACKPRESSURE_CONFIG } from './redis-client';
export { CacheManager, CACHE_TTL } from './cache-manager';

// Create singleton CacheManager wired to the shared RedisClientManager
export const cacheManager = new CacheManager(redisClientManager);

// Export redis-like interface for email processing
export const redis = {
  get: (key: string) => cacheManager.getString(key),

  /**
   * SET command with optional EX/NX modifiers
   *
   * FIX ISSUE #9: Clarified return type semantics:
   * - With NX flag: Returns 'OK' if lock acquired, 'EXISTS' if key exists (lock failed)
   * - Without NX flag: Returns 'OK' always (normal set operation, NOT a lock)
   *
   * IMPORTANT: For lock acquisition, ALWAYS use EX + NX flags. Using set() without
   * NX is NOT a lock operation - the 'OK' return does not mean lock was acquired.
   */
  set: async (
    key: string,
    value: string,
    ex?: 'EX',
    ttl?: number,
    nx?: 'NX'
  ): Promise<'OK' | 'EXISTS'> => {
    // Lock acquisition: SET key value EX ttl NX
    if (ex === 'EX' && nx === 'NX' && ttl) {
      return cacheManager.setNX(key, value, ttl);
    }

    // Normal set (NOT a lock): SET key value [EX ttl]
    // Returns 'OK' but this does NOT mean a lock was acquired
    if (ex === 'EX' && ttl) {
      // Use setex for TTL
      await cacheManager.set(key, value, ttl);
    } else {
      await cacheManager.setString(key, value);
    }
    return 'OK';
  },

  /**
   * Explicit lock acquisition function - use this instead of set() for locks
   * Returns true if lock acquired, false if lock exists (another process holds it)
   * Throws if Redis is unavailable
   */
  acquireLock: async (key: string, value: string, ttlSeconds: number): Promise<boolean> => {
    const result = await cacheManager.setNX(key, value, ttlSeconds);
    return result === 'OK';
  },

  del: (key: string) => cacheManager.delete(key),
  sismember: (key: string, member: string) => cacheManager.sismember(key, member),
  sadd: (key: string, member: string) => cacheManager.sadd(key, member),
  smembers: (key: string) => cacheManager.smembers(key),
  srem: (key: string, member: string) => cacheManager.srem(key, member),
  expire: (key: string, ttlSeconds: number) => cacheManager.expire(key, ttlSeconds),
  incr: (key: string) => cacheManager.incr(key),
  // ZSET methods for per-item TTL tracking
  zadd: (key: string, score: number, member: string) => cacheManager.zadd(key, score, member),
  zscore: (key: string, member: string) => cacheManager.zscore(key, member),
  zrem: (key: string, member: string) => cacheManager.zrem(key, member),
  zremrangebyscore: (key: string, min: string | number, max: string | number) => cacheManager.zremrangebyscore(key, min, max),
  // List operations (for write-ahead log / queue support)
  rpush: (key: string, value: string) => cacheManager.rpush(key, value),
  lpop: (key: string) => cacheManager.lpop(key),
  llen: (key: string) => cacheManager.llen(key),
  lrange: (key: string, start: number, stop: number) => cacheManager.lrange(key, start, stop),
  scard: (key: string) => cacheManager.scard(key),
  // Lua script execution for atomic operations
  eval: (script: string, numKeys: number, ...args: (string | number)[]) => cacheManager.eval(script, numKeys, ...args),
  // Health check for readiness probe
  checkHealth: () => cacheManager.checkHealth(),
  // Backpressure state for monitoring
  getHealthState: () => cacheManager.getHealthState(),
  // Check if operations should be attempted
  shouldAttemptOperation: () => cacheManager.shouldAttemptOperation(),
  shouldAttemptDistributedLock: () => cacheManager.shouldAttemptDistributedLock(),
  // Stale lock cleanup
  cleanupStaleLocks: (patterns: string[], maxAgeSeconds: number) => cacheManager.cleanupStaleLocks(patterns, maxAgeSeconds),
  // Graceful shutdown
  quit: () => cacheManager.quit(),
};

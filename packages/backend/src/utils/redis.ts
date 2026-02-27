import Redis from 'ioredis';
import { createHash } from 'crypto';
import { config } from '../config';
import { logger } from './logger';

const CACHE_TTL = 3600; // 1 hour default

// Redis health tracking for backpressure
interface RedisHealthState {
  isHealthy: boolean;
  consecutiveFailures: number;
  lastFailureTime: Date | null;
  lastSuccessTime: Date | null;
  backpressureLevel: 'none' | 'light' | 'moderate' | 'severe';
}

// Backpressure thresholds
const BACKPRESSURE_CONFIG = {
  /** After this many consecutive failures, enter light backpressure */
  LIGHT_THRESHOLD: 3,
  /** After this many consecutive failures, enter moderate backpressure */
  MODERATE_THRESHOLD: 5,
  /** After this many consecutive failures, enter severe backpressure */
  SEVERE_THRESHOLD: 10,
  /** Time in ms to wait before attempting recovery */
  RECOVERY_WAIT_MS: 5000,
  /** Multiplier for backoff during backpressure */
  BACKOFF_MULTIPLIER: 2,
};

export class CacheManager {
  private redis: Redis | null = null;
  private healthState: RedisHealthState = {
    isHealthy: true,
    consecutiveFailures: 0,
    lastFailureTime: null,
    lastSuccessTime: null,
    backpressureLevel: 'none',
  };

  constructor() {
    try {
      this.redis = new Redis(config.redisUrl);
      this.redis.on('error', (err) => {
        this.recordFailure();
        logger.error({ err, backpressure: this.healthState.backpressureLevel }, 'Redis connection error');
      });
      this.redis.on('connect', () => {
        this.recordSuccess();
        logger.info('Redis connected');
      });
      this.redis.on('ready', () => {
        this.recordSuccess();
        logger.info('Redis ready');
      });
      this.redis.on('reconnecting', () => {
        logger.info({ backpressure: this.healthState.backpressureLevel }, 'Redis reconnecting');
      });
    } catch (err) {
      logger.warn(
        { err },
        'Redis not available - caching and distributed locking disabled. ' +
        'Running multiple instances without Redis will cause race conditions in email processing and lock acquisition.'
      );
    }
  }

  /**
   * Record a successful Redis operation - reduces backpressure
   */
  private recordSuccess(): void {
    const previousLevel = this.healthState.backpressureLevel;
    this.healthState.isHealthy = true;
    this.healthState.consecutiveFailures = 0;
    this.healthState.lastSuccessTime = new Date();
    this.healthState.backpressureLevel = 'none';

    if (previousLevel !== 'none') {
      logger.info(
        { previousLevel },
        'Redis backpressure cleared - connection restored'
      );
    }
  }

  /**
   * Record a failed Redis operation - increases backpressure
   */
  private recordFailure(): void {
    this.healthState.consecutiveFailures++;
    this.healthState.lastFailureTime = new Date();

    // Update backpressure level based on consecutive failures
    const failures = this.healthState.consecutiveFailures;
    let newLevel: RedisHealthState['backpressureLevel'] = 'none';

    if (failures >= BACKPRESSURE_CONFIG.SEVERE_THRESHOLD) {
      newLevel = 'severe';
    } else if (failures >= BACKPRESSURE_CONFIG.MODERATE_THRESHOLD) {
      newLevel = 'moderate';
    } else if (failures >= BACKPRESSURE_CONFIG.LIGHT_THRESHOLD) {
      newLevel = 'light';
    }

    if (newLevel !== this.healthState.backpressureLevel) {
      this.healthState.backpressureLevel = newLevel;
      logger.warn(
        { backpressureLevel: newLevel, consecutiveFailures: failures },
        'Redis backpressure level changed'
      );
    }

    this.healthState.isHealthy = failures < BACKPRESSURE_CONFIG.LIGHT_THRESHOLD;
  }

  /**
   * Get current Redis health state for monitoring
   */
  getHealthState(): RedisHealthState {
    return { ...this.healthState };
  }

  /**
   * Check if Redis operations should be attempted based on backpressure level
   * Returns true if operations should proceed, false if they should be skipped
   */
  shouldAttemptOperation(): boolean {
    // Always allow operations during light backpressure
    if (this.healthState.backpressureLevel === 'none' ||
        this.healthState.backpressureLevel === 'light') {
      return true;
    }

    // During moderate/severe backpressure, check if enough time has passed for recovery
    if (this.healthState.lastFailureTime) {
      const timeSinceFailure = Date.now() - this.healthState.lastFailureTime.getTime();
      const waitTime = BACKPRESSURE_CONFIG.RECOVERY_WAIT_MS *
        (this.healthState.backpressureLevel === 'severe' ?
          BACKPRESSURE_CONFIG.BACKOFF_MULTIPLIER : 1);

      // Allow periodic retry attempts even during backpressure
      if (timeSinceFailure >= waitTime) {
        return true;
      }
    }

    // Skip operation during active backpressure
    return false;
  }

  /**
   * Check if distributed locks should be attempted
   * More conservative than regular operations - locks are critical
   */
  shouldAttemptDistributedLock(): boolean {
    // Don't attempt locks during any backpressure
    // This prevents race conditions in multi-instance deployments
    if (this.healthState.backpressureLevel !== 'none') {
      logger.warn(
        { backpressure: this.healthState.backpressureLevel },
        'Distributed lock skipped due to Redis backpressure'
      );
      return false;
    }
    return true;
  }

  private async get(key: string): Promise<string | null> {
    if (!this.redis) return null;
    // Skip during severe backpressure
    if (!this.shouldAttemptOperation()) {
      logger.debug({ key, backpressure: this.healthState.backpressureLevel }, 'Cache read skipped due to backpressure');
      return null;
    }
    try {
      const result = await this.redis.get(key);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      logger.warn({ err, key }, 'Cache read error');
      return null;
    }
  }

  async set(key: string, value: string, ttl: number = CACHE_TTL): Promise<void> {
    if (!this.redis) return;
    // Skip during severe backpressure
    if (!this.shouldAttemptOperation()) {
      logger.debug({ key, backpressure: this.healthState.backpressureLevel }, 'Cache write skipped due to backpressure');
      return;
    }
    try {
      await this.redis.setex(key, ttl, value);
      // FIX: Track write success for backpressure recovery (get() already did this)
      this.recordSuccess();
    } catch (err) {
      this.recordFailure();
      logger.warn({ err, key }, 'Cache write error');
    }
  }

  // FIX #17: Use SHA-256 instead of djb2 to prevent hash collisions serving wrong cached data
  private hashKey(input: string): string {
    return createHash('sha256').update(input).digest('hex').substring(0, 16);
  }

  // Classification caching
  async getCachedClassification(input: string): Promise<string | null> {
    const key = `classification:${this.hashKey(input)}`;
    return this.get(key);
  }

  async cacheClassification(input: string, classification: string): Promise<void> {
    const key = `classification:${this.hashKey(input)}`;
    await this.set(key, classification);
  }

  // Safety check caching
  async getCachedSafetyCheck(content: string): Promise<{ safe: boolean; reason?: string; confidence: number } | null> {
    const key = `safety:${this.hashKey(content)}`;
    const cached = await this.get(key);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        return null;
      }
    }
    return null;
  }

  async cacheSafetyCheck(content: string, result: { safe: boolean; reason?: string; confidence: number }): Promise<void> {
    const key = `safety:${this.hashKey(content)}`;
    await this.set(key, JSON.stringify(result));
  }

  // Relevance caching
  async getCachedRelevance(query: string, content: string): Promise<number | null> {
    const key = `relevance:${this.hashKey(query + content)}`;
    const cached = await this.get(key);
    if (cached !== null) {
      const parsed = parseFloat(cached);
      return isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  async cacheRelevance(query: string, content: string, score: number): Promise<void> {
    const key = `relevance:${this.hashKey(query + content)}`;
    await this.set(key, score.toString());
  }

  // Generic cache methods
  async getJson<T>(key: string): Promise<T | null> {
    const cached = await this.get(key);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        return null;
      }
    }
    return null;
  }

  async setJson(key: string, value: unknown, ttl: number = CACHE_TTL): Promise<void> {
    await this.set(key, JSON.stringify(value), ttl);
  }

  /**
   * Get JSON with stale fallback strategy
   *
   * This implements a two-tier caching strategy:
   * 1. Primary cache with normal TTL (fast, fresh data)
   * 2. Stale cache with longer TTL (fallback when primary expires)
   *
   * When primary cache expires, stale cache can still serve data
   * while a background refresh happens.
   *
   * @param key - Cache key
   * @returns Object with value and staleness flag
   */
  async getJsonWithStale<T>(key: string): Promise<{ value: T | null; stale: boolean }> {
    // Try primary cache first
    const primary = await this.getJson<T>(key);
    if (primary !== null) {
      return { value: primary, stale: false };
    }

    // Try stale cache
    const staleKey = `stale:${key}`;
    const stale = await this.getJson<T>(staleKey);
    if (stale !== null) {
      logger.debug({ key }, 'Serving stale cached data');
      return { value: stale, stale: true };
    }

    return { value: null, stale: false };
  }

  /**
   * Set JSON with stale fallback
   *
   * Writes to both primary and stale caches.
   * Stale cache has 10x longer TTL as fallback.
   *
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttl - Primary cache TTL in seconds
   * @param staleTtlMultiplier - Multiplier for stale TTL (default: 10)
   */
  async setJsonWithStale(
    key: string,
    value: unknown,
    ttl: number = CACHE_TTL,
    staleTtlMultiplier: number = 10
  ): Promise<void> {
    const staleKey = `stale:${key}`;
    const staleTtl = ttl * staleTtlMultiplier;

    // Write to both caches concurrently
    await Promise.all([
      this.setJson(key, value, ttl),
      this.setJson(staleKey, value, staleTtl),
    ]);
  }

  /**
   * Get or set with stale fallback strategy
   *
   * This is the recommended way to use caching with external services:
   * 1. Try to get fresh value from cache
   * 2. If cache miss or stale, call the factory function
   * 3. On factory success, update both caches
   * 4. On factory failure, return stale value if available
   *
   * @param key - Cache key
   * @param factory - Function to get fresh value
   * @param options - Cache options
   */
  async getOrSetWithStale<T>(
    key: string,
    factory: () => Promise<T>,
    options: {
      ttl?: number;
      staleTtlMultiplier?: number;
      /** If true, serve stale immediately while refreshing in background */
      staleWhileRevalidate?: boolean;
    } = {}
  ): Promise<{ value: T; stale: boolean; fromCache: boolean }> {
    const { ttl = CACHE_TTL, staleTtlMultiplier = 10, staleWhileRevalidate = false } = options;

    // Try primary cache first
    const primary = await this.getJson<T>(key);
    if (primary !== null) {
      return { value: primary, stale: false, fromCache: true };
    }

    // Try stale cache
    const staleKey = `stale:${key}`;
    const staleValue = await this.getJson<T>(staleKey);

    // If stale-while-revalidate enabled and we have stale data, return it
    // and refresh in background
    if (staleWhileRevalidate && staleValue !== null) {
      // Refresh in background (fire and forget)
      factory()
        .then(async (freshValue) => {
          await this.setJsonWithStale(key, freshValue, ttl, staleTtlMultiplier);
          logger.debug({ key }, 'Background cache refresh completed');
        })
        .catch((err) => {
          logger.warn({ err, key }, 'Background cache refresh failed');
        });

      return { value: staleValue, stale: true, fromCache: true };
    }

    // No cache hit, call factory
    try {
      const freshValue = await factory();
      await this.setJsonWithStale(key, freshValue, ttl, staleTtlMultiplier);
      return { value: freshValue, stale: false, fromCache: false };
    } catch (err) {
      // Factory failed - return stale if available
      if (staleValue !== null) {
        logger.warn({ err, key }, 'Factory failed, serving stale cache');
        return { value: staleValue, stale: true, fromCache: true };
      }

      // No stale cache, propagate error
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(key);
    } catch (err) {
      logger.warn({ err, key }, 'Cache delete error');
    }
  }

  /**
   * Delete all keys matching a pattern using SCAN (non-blocking)
   *
   * PERFORMANCE FIX: Replaced KEYS with SCAN command
   * - KEYS blocks Redis server thread and scans entire keyspace
   * - SCAN uses cursor-based iteration that doesn't block
   * - Batches deletions to avoid large DEL commands
   */
  async deletePattern(pattern: string): Promise<void> {
    if (!this.redis) return;

    const SCAN_COUNT = 100; // Keys per SCAN iteration
    const DELETE_BATCH_SIZE = 100; // Keys per DEL command

    try {
      let cursor = '0';
      let totalDeleted = 0;

      do {
        // SCAN returns [nextCursor, keys[]]
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          SCAN_COUNT
        );
        cursor = nextCursor;

        if (keys.length > 0) {
          // Delete in batches to avoid huge DEL commands
          for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
            const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
            await this.redis.del(...batch);
            totalDeleted += batch.length;
          }
        }
      } while (cursor !== '0');

      if (totalDeleted > 0) {
        logger.debug({ pattern, totalDeleted }, 'Cache pattern delete completed');
      }
    } catch (err) {
      logger.warn({ err, pattern }, 'Cache pattern delete error');
    }
  }

  // Direct Redis methods for email processing
  async getString(key: string): Promise<string | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get(key);
    } catch (err) {
      logger.warn({ err, key }, 'Redis get error');
      return null;
    }
  }

  async setString(key: string, value: string, ttlSeconds: number = 86400): Promise<void> {
    if (!this.redis) return;
    try {
      // Always set a TTL to prevent unbounded key growth (default: 24h)
      await this.redis.setex(key, ttlSeconds, value);
    } catch (err) {
      logger.warn({ err, key }, 'Redis set error');
    }
  }

  async sismember(key: string, member: string): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const result = await this.redis.sismember(key, member);
      return result === 1;
    } catch (err) {
      logger.warn({ err, key }, 'Redis sismember error');
      return false;
    }
  }

  async sadd(key: string, member: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.sadd(key, member);
    } catch (err) {
      logger.warn({ err, key }, 'Redis sadd error');
    }
  }

  /**
   * Get all members of a set
   */
  async smembers(key: string): Promise<string[]> {
    if (!this.redis) return [];
    try {
      return await this.redis.smembers(key);
    } catch (err) {
      logger.warn({ err, key }, 'Redis smembers error');
      return [];
    }
  }

  /**
   * Remove a member from a set
   */
  async srem(key: string, member: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.srem(key, member);
    } catch (err) {
      logger.warn({ err, key }, 'Redis srem error');
    }
  }

  /**
   * Set expiration on a key
   */
  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.expire(key, ttlSeconds);
    } catch (err) {
      logger.warn({ err, key }, 'Redis expire error');
    }
  }

  /**
   * Increment a key's value (atomic counter)
   * Returns the new value after increment
   */
  async incr(key: string): Promise<number> {
    if (!this.redis) {
      throw new Error('Redis not available - cannot increment');
    }
    try {
      return await this.redis.incr(key);
    } catch (err) {
      logger.error({ err, key }, 'Redis incr error');
      throw err;
    }
  }

  /**
   * Set a key only if it doesn't exist (for distributed locks)
   * Returns: 'OK' if lock acquired, 'EXISTS' if key exists, throws if Redis unavailable/error
   */
  async setNX(key: string, value: string, ttlSeconds: number): Promise<'OK' | 'EXISTS'> {
    if (!this.redis) {
      throw new Error('Redis not available - cannot acquire distributed lock');
    }
    // For distributed locks, check backpressure more strictly
    if (!this.shouldAttemptDistributedLock()) {
      throw new Error('Redis backpressure active - distributed lock skipped to prevent race conditions');
    }
    try {
      const result = await this.redis.set(key, value, 'EX', ttlSeconds, 'NX');
      this.recordSuccess();
      return result === 'OK' ? 'OK' : 'EXISTS';
    } catch (err) {
      this.recordFailure();
      logger.error({ err, key }, 'Redis setNX error - lock operation failed');
      throw err;
    }
  }

  /**
   * ZSET operations for per-item TTL tracking
   */
  async zadd(key: string, score: number, member: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.zadd(key, score, member);
    } catch (err) {
      logger.warn({ err, key }, 'Redis zadd error');
    }
  }

  async zscore(key: string, member: string): Promise<number | null> {
    if (!this.redis) return null;
    try {
      const result = await this.redis.zscore(key, member);
      return result !== null ? parseFloat(result) : null;
    } catch (err) {
      logger.warn({ err, key }, 'Redis zscore error');
      return null;
    }
  }

  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
    if (!this.redis) return 0;
    try {
      return await this.redis.zremrangebyscore(key, min, max);
    } catch (err) {
      logger.warn({ err, key }, 'Redis zremrangebyscore error');
      return 0;
    }
  }

  /**
   * Health check for Redis connectivity
   * Used by /health/ready endpoint
   */
  async checkHealth(): Promise<{
    connected: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    if (!this.redis) {
      return { connected: false, error: 'Redis client not initialized' };
    }

    const startTime = Date.now();
    try {
      await this.redis.ping();
      return {
        connected: true,
        latencyMs: Date.now() - startTime,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        connected: false,
        error: message,
      };
    }
  }

  // ============================================
  // List operations (for write-ahead log / queue support)
  // ============================================

  /**
   * Push a value to the right end of a list (RPUSH).
   * Returns the length of the list after the push.
   */
  async rpush(key: string, value: string): Promise<number> {
    if (!this.redis) {
      throw new Error('Redis not available - cannot rpush');
    }
    try {
      const result = await this.redis.rpush(key, value);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Pop and return the leftmost element of a list (LPOP).
   * Returns null if the list is empty or does not exist.
   */
  async lpop(key: string): Promise<string | null> {
    if (!this.redis) {
      throw new Error('Redis not available - cannot lpop');
    }
    try {
      const result = await this.redis.lpop(key);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Get the length of a list (LLEN).
   * Returns 0 if the key does not exist.
   */
  async llen(key: string): Promise<number> {
    if (!this.redis) {
      throw new Error('Redis not available - cannot llen');
    }
    try {
      const result = await this.redis.llen(key);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Get a range of elements from a list (LRANGE).
   * Indices are 0-based. Use -1 for the last element.
   */
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    if (!this.redis) {
      throw new Error('Redis not available - cannot lrange');
    }
    try {
      const result = await this.redis.lrange(key, start, stop);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Get the number of members in a set (SCARD).
   */
  async scard(key: string): Promise<number> {
    if (!this.redis) {
      throw new Error('Redis not available - cannot scard');
    }
    try {
      const result = await this.redis.scard(key);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Execute a Lua script atomically
   * Used for atomic lock+check operations to prevent race conditions
   */
  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (!this.redis) {
      throw new Error('Redis not available - cannot execute Lua script');
    }
    try {
      // ioredis eval signature: (script, numKeys, ...args)
      return await this.redis.eval(script, numKeys, ...args);
    } catch (err) {
      logger.error({ err, numKeys }, 'Redis eval error');
      throw err;
    }
  }

  /**
   * Get TTL for a key (in seconds)
   * Returns -2 if key doesn't exist, -1 if no TTL set
   */
  async ttl(key: string): Promise<number> {
    if (!this.redis) return -2;
    try {
      return await this.redis.ttl(key);
    } catch (err) {
      logger.warn({ err, key }, 'Redis TTL error');
      return -2;
    }
  }

  /**
   * Gracefully close the Redis connection during shutdown
   */
  async quit(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
      logger.info('Redis connection closed gracefully');
    } catch (err) {
      logger.warn({ err }, 'Error closing Redis connection');
    }
  }

  /**
   * Cleanup stale locks that may have been orphaned
   *
   * This runs on startup to recover from crashes where locks weren't released.
   * Scans for keys matching lock patterns and checks their age.
   * Locks older than maxAgeSeconds are considered stale and deleted.
   *
   * @param patterns - Array of glob patterns to scan (e.g., ['gmail:lock:*', 'appointment:lock:*'])
   * @param maxAgeSeconds - Maximum age in seconds before a lock is considered stale
   * @returns Number of stale locks cleaned up
   */
  async cleanupStaleLocks(patterns: string[], maxAgeSeconds: number): Promise<number> {
    if (!this.redis) {
      logger.warn('Redis not available - skipping stale lock cleanup');
      return 0;
    }

    const SCAN_COUNT = 100;
    let totalCleaned = 0;

    for (const pattern of patterns) {
      try {
        let cursor = '0';

        do {
          const [nextCursor, keys] = await this.redis.scan(
            cursor,
            'MATCH',
            pattern,
            'COUNT',
            SCAN_COUNT
          );
          cursor = nextCursor;

          for (const key of keys) {
            // Check TTL - if TTL is -1 (no expiry) or very high, it might be orphaned
            // If TTL is positive but less than maxAgeSeconds, it's probably fine
            const ttl = await this.redis.ttl(key);

            // TTL of -1 means no expiry set - this is a stale lock
            // TTL of -2 means key doesn't exist (already cleaned)
            if (ttl === -1) {
              logger.warn({ key }, 'Found lock with no TTL - cleaning up as potentially orphaned');
              await this.redis.del(key);
              totalCleaned++;
            }
            // Note: We don't delete locks with valid TTLs even if old,
            // as they will expire naturally and may still be valid
          }
        } while (cursor !== '0');
      } catch (err) {
        logger.error({ err, pattern }, 'Error during stale lock cleanup');
      }
    }

    if (totalCleaned > 0) {
      logger.info({ totalCleaned, patterns }, 'Stale lock cleanup completed');
    }

    return totalCleaned;
  }
}

// Export singleton instance
export const cacheManager = new CacheManager();

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

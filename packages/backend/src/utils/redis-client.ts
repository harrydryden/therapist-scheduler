import Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';
import { REDIS_BACKPRESSURE } from '../constants';

// Hard ceiling on a single Redis command (see constructor note).
const REDIS_COMMAND_TIMEOUT_MS = 5000;

// ioredis emits 'error' on every failed reconnect (~every 2s during an
// outage). Log the first at error level, then at most one summary per
// interval with the number suppressed in between.
export const REDIS_ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Build a connection-error logger that emits at most one line per
 * `intervalMs`, carrying the count of errors suppressed since the last
 * line. `reset()` (on reconnect) makes the next error log immediately.
 */
export function createRateLimitedErrorLogger(
  log: (fields: Record<string, unknown>, message: string) => void,
  intervalMs: number = REDIS_ERROR_LOG_INTERVAL_MS,
  now: () => number = Date.now,
): { onError: (err: unknown, fields?: Record<string, unknown>) => void; reset: () => void } {
  let lastLoggedAt: number | null = null;
  let suppressed = 0;
  return {
    onError(err, fields = {}) {
      const t = now();
      if (lastLoggedAt !== null && t - lastLoggedAt < intervalMs) {
        suppressed++;
        return;
      }
      log({ err, ...fields, suppressedSinceLastLog: suppressed }, 'Redis connection error');
      lastLoggedAt = t;
      suppressed = 0;
    },
    reset() {
      lastLoggedAt = null;
      suppressed = 0;
    },
  };
}

// Redis health tracking for backpressure
export interface RedisHealthState {
  isHealthy: boolean;
  consecutiveFailures: number;
  lastFailureTime: Date | null;
  lastSuccessTime: Date | null;
  backpressureLevel: 'none' | 'light' | 'moderate' | 'severe';
}

// Backpressure thresholds (sourced from centralised constants)
export const BACKPRESSURE_CONFIG = REDIS_BACKPRESSURE;

/**
 * Manages the raw Redis connection, health tracking, and backpressure logic.
 * Used internally by CacheManager — consumers should use CacheManager or the
 * `redis` / `cacheManager` singletons exported from `./redis`.
 */
export class RedisClientManager {
  public client: Redis | null = null;
  private healthState: RedisHealthState = {
    isHealthy: true,
    consecutiveFailures: 0,
    lastFailureTime: null,
    lastSuccessTime: null,
    backpressureLevel: 'none',
  };

  constructor() {
    // In Jest, transitive imports of services that depend on this module
    // were opening real ioredis sockets at module load — the timers /
    // sockets never closed, producing the "worker process force exited"
    // warning. Guard so the singleton stays inert in tests; consumers
    // already handle `client === null` (see cache-manager.ts:20).
    if (config.env === 'test') {
      this.client = null;
      return;
    }
    try {
      this.client = new Redis(config.redisUrl, {
        // Bound every command's latency. ioredis defaults to an unbounded
        // offline queue with up to 20 reconnect-gated retries, so during an
        // outage a plain GET could hang for ~40s (refused connection) or
        // minutes (blackholed host). Correctness guards (idempotency, auth
        // limiter, send-once markers) rely on getting a fast error instead;
        // ioredis applies this timeout to queued commands too.
        commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      });
      const errorLog = createRateLimitedErrorLogger((fields, message) => logger.error(fields, message));
      this.client.on('error', (err) => {
        this.recordFailure();
        errorLog.onError(err, { backpressure: this.healthState.backpressureLevel });
      });
      this.client.on('connect', () => {
        this.recordSuccess();
        logger.info('Redis connected');
      });
      this.client.on('ready', () => {
        this.recordSuccess();
        errorLog.reset();
        logger.info('Redis ready');
      });
      this.client.on('reconnecting', () => {
        // Debug: fires on every reconnect attempt; the rate-limited error
        // log above already reports the outage.
        logger.debug({ backpressure: this.healthState.backpressureLevel }, 'Redis reconnecting');
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
  recordSuccess(): void {
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
  recordFailure(): void {
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
}

/** Singleton Redis client manager instance */
export const redisClientManager = new RedisClientManager();

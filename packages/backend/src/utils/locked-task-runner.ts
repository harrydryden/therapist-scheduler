/**
 * Locked Task Runner
 *
 * A reusable abstraction for the "acquire distributed lock → run task → release"
 * pattern that was previously duplicated across 5+ background services:
 *   - PendingEmailService
 *   - StaleCheckService (2x: stale check + retention cleanup)
 *   - SideEffectRetryService
 *   - WeeklyMailingListService
 *
 * Each service copied ~80 lines of lock acquisition, renewal interval setup,
 * lock-loss detection, cleanup, and error handling. This module consolidates
 * that into a single, well-tested utility.
 *
 * Usage:
 *   const runner = new LockedTaskRunner({
 *     lockKey: 'my-service:lock',
 *     lockTtlSeconds: 120,
 *     renewalIntervalMs: 30_000,
 *     instanceId: 'my-service-pid-123',
 *   });
 *
 *   const result = await runner.run(async (ctx) => {
 *     // ctx.isLockValid() — check before expensive work
 *     await doWork();
 *   });
 */

import { acquireLock, releaseLock, renewLock } from './redis-locks';
import { logger } from './logger';

export interface LockedTaskRunnerConfig {
  /** Redis key for the distributed lock */
  lockKey: string;
  /** Lock TTL in seconds */
  lockTtlSeconds: number;
  /** How often to renew the lock (ms) */
  renewalIntervalMs: number;
  /** Unique identifier for this instance (for lock ownership) */
  instanceId: string;
  /** Context label for log messages (e.g., 'pending-email', 'stale-check') */
  context?: string;
}

export interface LockedTaskContext {
  /** Returns false if the lock was lost during execution */
  isLockValid: () => boolean;
}

export interface LockedTaskResult<T> {
  /** Whether the lock was acquired */
  acquired: boolean;
  /** The result from the task function (undefined if lock was not acquired) */
  result?: T;
  /** Any error thrown during execution */
  error?: Error;
}

export class LockedTaskRunner {
  private readonly config: Required<LockedTaskRunnerConfig>;

  constructor(config: LockedTaskRunnerConfig) {
    this.config = {
      ...config,
      context: config.context || config.lockKey,
    };
  }

  /**
   * Attempt to acquire the lock and run the given task.
   *
   * - If the lock cannot be acquired, returns { acquired: false } immediately.
   * - If the lock is acquired, starts renewal and runs the task.
   * - On completion (success or error), stops renewal and releases the lock.
   */
  async run<T>(
    task: (ctx: LockedTaskContext) => Promise<T>
  ): Promise<LockedTaskResult<T>> {
    const { lockKey, lockTtlSeconds, renewalIntervalMs, instanceId, context } = this.config;

    const acquired = await acquireLock(lockKey, instanceId, lockTtlSeconds);
    if (!acquired) {
      logger.debug({ lockKey, instanceId, context }, 'Lock held by another instance — skipping');
      return { acquired: false };
    }

    let lockValid = true;
    let renewalId: NodeJS.Timeout | null = null;

    // Start lock renewal
    renewalId = setInterval(async () => {
      const renewed = await renewLock(lockKey, instanceId, lockTtlSeconds);
      if (!renewed) {
        lockValid = false;
        logger.warn({ lockKey, instanceId, context }, 'Lock renewal failed — lock was taken by another instance');
        if (renewalId) {
          clearInterval(renewalId);
          renewalId = null;
        }
      }
    }, renewalIntervalMs);

    const ctx: LockedTaskContext = {
      isLockValid: () => lockValid,
    };

    try {
      const result = await task(ctx);
      return { acquired: true, result };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ err: error, lockKey, context }, 'Locked task failed');
      return { acquired: true, error };
    } finally {
      if (renewalId) {
        clearInterval(renewalId);
        renewalId = null;
      }
      await releaseLock(lockKey, instanceId, context);
    }
  }
}

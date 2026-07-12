/**
 * Locked Periodic Service
 *
 * Base class for the "schedule a recurring tick that takes a distributed
 * lock before doing work" pattern. Composes PeriodicService (start/stop/
 * interval/startup-delay/overlap-guard) with LockedTaskRunner (acquire/
 * renew/release/timeout) so subclasses don't have to wire either piece.
 *
 * Before this base existed, several services each reimplemented some
 * subset of: instanceId construction, LockedTaskRunner setup, start/stop,
 * runSafe with skip/error/lastRun bookkeeping, getStatus.
 *
 * Subclasses implement `tick(ctx)`. We deliberately do NOT name that
 * method `runCheck` — PeriodicService has its own abstract `runCheck()`
 * with no args, and TypeScript would reject the override-by-narrowing.
 * Instead we provide a concrete `runCheck()` here that delegates into
 * the locked runner, which then calls the subclass's `tick(ctx)`.
 *
 * Usage:
 *   class MyService extends LockedPeriodicService<{ processed: number }> {
 *     constructor() {
 *       super({
 *         name: 'my-service',
 *         intervalMs: 60_000,
 *         startupDelayMs: 5_000,
 *         lockKey: 'lock:my-service',
 *         lockTtlSeconds: 120,
 *         renewalIntervalMs: 30_000,
 *       });
 *     }
 *     protected async tick() {
 *       const processed = await doWork();
 *       return { processed };
 *     }
 *   }
 */

import { PeriodicService, PeriodicServiceOptions } from './periodic-service';
import { LockedTaskRunner, LockedTaskContext, LockedTaskResult } from './locked-task-runner';
import { logger } from './logger';

export interface LockedPeriodicServiceOptions extends PeriodicServiceOptions {
  /** Redis key for the distributed lock (must be unique per service). */
  lockKey: string;
  /** Lock TTL in seconds. */
  lockTtlSeconds: number;
  /** Lock renewal cadence in ms. Should be < lockTtlSeconds × 1000. */
  renewalIntervalMs: number;
  /** Optional hard timeout for tick. Forwards to LockedTaskRunner. */
  maxExecutionMs?: number;
}

export interface LockedPeriodicStatus<TResult> {
  running: boolean;
  intervalMs: number;
  /** When the last tick completed (success, skip, or error). Null until first tick. */
  lastRunAt: Date | null;
  /** The last tick's outcome — same shape that trigger() returns. */
  lastResult: LockedTaskResult<TResult> | null;
}

export abstract class LockedPeriodicService<TResult = void> extends PeriodicService {
  protected readonly instanceId: string;
  private readonly lockedRunner: LockedTaskRunner;
  private lastRunAt: Date | null = null;
  private lastResult: LockedTaskResult<TResult> | null = null;

  constructor(options: LockedPeriodicServiceOptions) {
    super({
      name: options.name,
      intervalMs: options.intervalMs,
      startupDelayMs: options.startupDelayMs,
    });
    // The instance ID is included in lock ownership so this process can
    // renew/release a lock it holds, but a different process can't.
    this.instanceId = `${process.pid}-${Date.now().toString(36)}-${options.name}`;
    this.lockedRunner = new LockedTaskRunner({
      lockKey: options.lockKey,
      lockTtlSeconds: options.lockTtlSeconds,
      renewalIntervalMs: options.renewalIntervalMs,
      instanceId: this.instanceId,
      context: options.name,
      maxExecutionMs: options.maxExecutionMs,
    });
  }

  /**
   * Subclass implements with the per-tick work. The `LockedTaskContext`
   * exposes `isLockValid()` for long-running ticks that want to abort
   * cleanly if the lock is lost mid-run. `trigger` distinguishes the
   * delayed first run, a regular scheduled run, and an explicit
   * `.trigger()` call — most subclasses ignore it (a 0- or 1-arg override
   * is a valid implementation of this abstract method).
   */
  protected abstract tick(ctx: LockedTaskContext, trigger: 'startup' | 'scheduled' | 'manual'): Promise<TResult>;

  /**
   * Hook called when tick throws. Default behaviour is a no-op —
   * LockedTaskRunner already logs the failure. Subclasses can override
   * for extras like exponential-backoff retry. Returning normally means
   * the scheduler continues; throwing here is swallowed by the safety net.
   */
  protected onError(err: Error, trigger: 'startup' | 'scheduled' | 'manual'): void {
    void err;
    void trigger;
  }

  /**
   * Hook called when the lock could not be acquired (another instance
   * holds it). Default behaviour is a no-op — LockedTaskRunner already
   * logs this at debug level. Subclasses that track consecutive-skip
   * health (e.g. missed-message-scanner: repeated lock contention across
   * ticks can mean a stuck lock) can override.
   */
  protected onLockNotAcquired(trigger: 'startup' | 'scheduled' | 'manual'): void {
    void trigger;
  }

  /** Concrete implementation of PeriodicService's abstract runCheck. */
  protected async runCheck(trigger: 'startup' | 'scheduled'): Promise<void> {
    await this.runOnceWithLock(trigger);
  }

  private async runOnceWithLock(trigger: 'startup' | 'scheduled' | 'manual'): Promise<LockedTaskResult<TResult>> {
    const taskResult = await this.lockedRunner.run((ctx) => this.tick(ctx, trigger));
    this.lastRunAt = new Date();
    this.lastResult = taskResult;
    if (!taskResult.acquired) {
      try {
        this.onLockNotAcquired(trigger);
      } catch (hookErr) {
        logger.error({ err: hookErr, service: this.serviceName }, 'onLockNotAcquired hook threw');
      }
    } else if (taskResult.error) {
      try {
        this.onError(taskResult.error, trigger);
      } catch (hookErr) {
        logger.error({ err: hookErr, service: this.serviceName }, 'onError hook threw');
      }
    }
    return taskResult;
  }

  /**
   * Manual trigger — same path as the scheduled tick. Returns the raw
   * LockedTaskResult so callers can distinguish "lock held" (acquired=false)
   * from "ran with result" from "ran but errored".
   */
  async trigger(): Promise<LockedTaskResult<TResult>> {
    return this.runOnceWithLock('manual');
  }

  getStatus(): LockedPeriodicStatus<TResult> {
    return {
      ...super.getStatus(),
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
    };
  }
}

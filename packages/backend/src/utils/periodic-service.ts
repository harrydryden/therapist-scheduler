/**
 * Base class for periodic background services.
 *
 * Encapsulates the common start/stop/guard lifecycle pattern shared by:
 * PostBookingFollowupService, WeeklyMailingListService, SideEffectRetryService, etc.
 *
 * Subclasses implement `runCheck()` with the service-specific logic.
 * The base class handles:
 * - setInterval management
 * - Overlapping execution guard
 * - Safe error catching to prevent interval breakage
 * - Startup delay (jittered by default, so a restart doesn't fire every
 *   sweep at t=0 alongside WAL recovery and the Pub/Sub backlog)
 * - stop() that resolves once any in-flight run has finished
 * - getStatus() for health checks
 */

import { logger } from './logger';

/**
 * First-run delay for services that don't set `startupDelayMs`: a random
 * point in [MIN, MIN + JITTER). Staggers the boot-time sweeps (stale-check,
 * post-booking, weekly-mailing, Slack summary, work report) instead of
 * running them all the instant the process starts.
 */
export const DEFAULT_STARTUP_DELAY_MIN_MS = 30_000;
export const DEFAULT_STARTUP_DELAY_JITTER_MS = 90_000;

export interface PeriodicServiceOptions {
  /** Human-readable name for logging */
  name: string;
  /** Interval between runs in milliseconds */
  intervalMs: number;
  /**
   * Delay before the first run. Omitted → a jittered default (see
   * DEFAULT_STARTUP_DELAY_MIN_MS); 0 → run immediately on start().
   */
  startupDelayMs?: number;
}

export abstract class PeriodicService {
  protected intervalId: NodeJS.Timeout | null = null;
  private startupTimeoutId: NodeJS.Timeout | null = null;
  protected isRunning = false;
  protected readonly serviceName: string;
  protected readonly intervalMs: number;
  private readonly startupDelayMs: number;
  /** Runs (scheduled or manual) that haven't settled yet; stop() awaits them. */
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Set by stop() so long-running work can bail out early. */
  private stopping = false;

  constructor(options: PeriodicServiceOptions) {
    this.serviceName = options.name;
    this.intervalMs = options.intervalMs;
    this.startupDelayMs = options.startupDelayMs
      ?? DEFAULT_STARTUP_DELAY_MIN_MS + Math.floor(Math.random() * DEFAULT_STARTUP_DELAY_JITTER_MS);
  }

  /**
   * Implement this with the service's core logic. `trigger` distinguishes
   * the delayed first run after `start()` from every subsequent scheduled
   * run — most subclasses ignore it (a 0-arg override is a valid
   * implementation of this abstract method), but a subclass whose
   * health-monitoring needs to reason about "have we ever completed a
   * scheduled run" (e.g. missed-message-scanner's trigger-reason logging)
   * can accept it.
   */
  protected abstract runCheck(trigger: 'startup' | 'scheduled'): Promise<void>;

  start(): void {
    if (this.intervalId) {
      logger.warn(`${this.serviceName} already running`);
      return;
    }
    this.stopping = false;

    logger.info(
      { startupDelayMs: this.startupDelayMs },
      `Starting ${this.serviceName} (interval: ${this.intervalMs}ms)`,
    );

    if (this.startupDelayMs > 0) {
      this.startupTimeoutId = setTimeout(() => {
        this.startupTimeoutId = null;
        void this.runSafe('startup');
      }, this.startupDelayMs);
    } else {
      void this.runSafe('startup');
    }

    this.intervalId = setInterval(() => {
      void this.runSafe('scheduled');
    }, this.intervalMs);
  }

  /**
   * Stop scheduling new runs. The returned promise resolves once any run
   * already in progress has finished, so shutdown can wait for it before
   * closing Redis and Prisma underneath it. Long runs can check
   * isStopping() to finish early.
   */
  stop(): Promise<void> {
    this.stopping = true;
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId);
      this.startupTimeoutId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info(`${this.serviceName} stopped`);
    }
    return Promise.allSettled([...this.inFlight]).then(() => undefined);
  }

  /** True once stop() has been called (until the next start()). */
  protected isStopping(): boolean {
    return this.stopping;
  }

  getStatus(): { running: boolean; intervalMs: number } {
    return {
      running: this.intervalId !== null,
      intervalMs: this.intervalMs,
    };
  }

  /** Register a run so stop() waits for it. Returns the same promise. */
  protected trackRun<T>(run: Promise<T>): Promise<T> {
    this.inFlight.add(run);
    const settle = () => { this.inFlight.delete(run); };
    run.then(settle, settle);
    return run;
  }

  private async runSafe(trigger: 'startup' | 'scheduled'): Promise<void> {
    if (this.isRunning) {
      logger.debug(`${this.serviceName} already in progress, skipping`);
      return;
    }

    this.isRunning = true;
    try {
      await this.trackRun(this.runCheck(trigger));
    } catch (error) {
      logger.error({ error }, `Unhandled error in ${this.serviceName} — will retry next interval`);
    } finally {
      this.isRunning = false;
    }
  }
}

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
 * - Optional startup delay
 * - getStatus() for health checks
 */

import { logger } from './logger';

export interface PeriodicServiceOptions {
  /** Human-readable name for logging */
  name: string;
  /** Interval between runs in milliseconds */
  intervalMs: number;
  /** Optional delay before the first run (0 = run immediately) */
  startupDelayMs?: number;
}

export abstract class PeriodicService {
  protected intervalId: NodeJS.Timeout | null = null;
  private startupTimeoutId: NodeJS.Timeout | null = null;
  protected isRunning = false;
  protected readonly serviceName: string;
  protected readonly intervalMs: number;
  private readonly startupDelayMs: number;

  constructor(options: PeriodicServiceOptions) {
    this.serviceName = options.name;
    this.intervalMs = options.intervalMs;
    this.startupDelayMs = options.startupDelayMs ?? 0;
  }

  /** Implement this with the service's core logic */
  protected abstract runCheck(): Promise<void>;

  start(): void {
    if (this.intervalId) {
      logger.warn(`${this.serviceName} already running`);
      return;
    }

    logger.info(`Starting ${this.serviceName} (interval: ${this.intervalMs}ms)`);

    if (this.startupDelayMs > 0) {
      this.startupTimeoutId = setTimeout(() => {
        this.startupTimeoutId = null;
        this.runSafe();
      }, this.startupDelayMs);
    } else {
      this.runSafe();
    }

    this.intervalId = setInterval(() => {
      this.runSafe();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId);
      this.startupTimeoutId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info(`${this.serviceName} stopped`);
    }
  }

  getStatus(): { running: boolean; intervalMs: number } {
    return {
      running: this.intervalId !== null,
      intervalMs: this.intervalMs,
    };
  }

  private async runSafe(): Promise<void> {
    if (this.isRunning) {
      logger.debug(`${this.serviceName} already in progress, skipping`);
      return;
    }

    this.isRunning = true;
    try {
      await this.runCheck();
    } catch (error) {
      logger.error({ error }, `Unhandled error in ${this.serviceName} — will retry next interval`);
    } finally {
      this.isRunning = false;
    }
  }
}

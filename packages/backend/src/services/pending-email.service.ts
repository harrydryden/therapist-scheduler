import { emailProcessingService } from './email-processing.service';
import { logger } from '../utils/logger';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { PENDING_EMAIL_LOCK } from '../constants';

/**
 * Pending Email Processor Service
 *
 * Periodically processes the pending email queue to retry failed sends.
 * This ensures emails that failed to send (due to temporary Gmail issues,
 * rate limits, etc.) eventually get delivered.
 *
 * Features:
 * - Processes pending emails every 2 minutes by default
 * - Uses LockedTaskRunner for distributed lock management
 * - Handles failures gracefully without crashing
 * - Logs success/failure counts for monitoring
 * - Prevents overlapping processing runs across all instances
 */

// Default processing interval: 2 minutes
const DEFAULT_PROCESS_INTERVAL_MS = 2 * 60 * 1000;

// Minimum interval: 30 seconds
const MIN_INTERVAL_MS = 30 * 1000;

// Maximum interval: 10 minutes
const MAX_INTERVAL_MS = 10 * 60 * 1000;

// Startup delay to allow services to initialize
const STARTUP_DELAY_MS = 20000; // 20 seconds

class PendingEmailService {
  private intervalId: NodeJS.Timeout | null = null;
  private startupTimeoutId: NodeJS.Timeout | null = null;
  private processIntervalMs: number;
  private instanceId: string;
  private lockedRunner: LockedTaskRunner;
  private stats = {
    totalProcessed: 0,
    totalSent: 0,
    totalFailed: 0,
    lastRunTime: null as Date | null,
    lastRunSent: 0,
    lastRunFailed: 0,
    lastQueueDepth: 0,
    lastBatchSize: 0,
  };

  constructor() {
    // Generate unique instance ID for distributed lock ownership
    // Combines process ID with timestamp to ensure uniqueness
    this.instanceId = `${process.pid}-${Date.now().toString(36)}`;

    this.lockedRunner = new LockedTaskRunner({
      lockKey: PENDING_EMAIL_LOCK.KEY,
      lockTtlSeconds: PENDING_EMAIL_LOCK.TTL_SECONDS,
      renewalIntervalMs: PENDING_EMAIL_LOCK.RENEWAL_INTERVAL_MS,
      instanceId: this.instanceId,
      context: 'pending-email',
    });

    const envInterval = process.env.PENDING_EMAIL_INTERVAL_MS
      ? parseInt(process.env.PENDING_EMAIL_INTERVAL_MS, 10)
      : DEFAULT_PROCESS_INTERVAL_MS;

    this.processIntervalMs = Math.max(
      MIN_INTERVAL_MS,
      Math.min(MAX_INTERVAL_MS, envInterval || DEFAULT_PROCESS_INTERVAL_MS)
    );
  }

  /**
   * Start the pending email processor service
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Pending email service already running');
      return;
    }

    const intervalMinutes = (this.processIntervalMs / 60000).toFixed(1);
    logger.info(
      { intervalMs: this.processIntervalMs, intervalMinutes, instanceId: this.instanceId },
      `Starting pending email processor (runs every ${intervalMinutes} minutes)`
    );

    // Run after startup delay
    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null;
      this.runSafeProcess('startup');
    }, STARTUP_DELAY_MS);

    // Then run at the configured interval
    this.intervalId = setInterval(() => {
      this.runSafeProcess('scheduled');
    }, this.processIntervalMs);
  }

  /**
   * Stop the pending email processor service
   */
  stop(): void {
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId);
      this.startupTimeoutId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info({ instanceId: this.instanceId }, 'Pending email service stopped');
  }

  /**
   * Safe wrapper for processing that catches errors.
   * Uses LockedTaskRunner for distributed lock management.
   */
  private async runSafeProcess(trigger: 'startup' | 'scheduled' | 'manual'): Promise<
    { sent: number; failed: number; queueDepth?: number; batchSize?: number } | undefined
  > {
    const processId = Date.now().toString(36);

    const taskResult = await this.lockedRunner.run(async (ctx) => {
      logger.debug({ processId, trigger, instanceId: this.instanceId }, 'Processing pending emails');
      return emailProcessingService.processPendingEmails(processId, ctx.isLockValid);
    });

    if (!taskResult.acquired) {
      logger.debug(
        { instanceId: this.instanceId, trigger },
        'Skipping pending email processing - another instance holds the lock'
      );
      return undefined;
    }

    if (taskResult.error) {
      logger.error(
        { processId, trigger, error: taskResult.error },
        'Error processing pending emails - will retry next interval'
      );
      return undefined;
    }

    const result = taskResult.result!;

    // Update stats
    this.stats.totalProcessed += result.sent + result.failed;
    this.stats.totalSent += result.sent;
    this.stats.totalFailed += result.failed;
    this.stats.lastRunTime = new Date();
    this.stats.lastRunSent = result.sent;
    this.stats.lastRunFailed = result.failed;
    this.stats.lastQueueDepth = result.queueDepth ?? 0;
    this.stats.lastBatchSize = result.batchSize ?? 0;

    if (result.sent > 0 || result.failed > 0) {
      logger.info(
        {
          processId,
          trigger,
          sent: result.sent,
          failed: result.failed,
          queueDepth: result.queueDepth,
          batchSize: result.batchSize,
        },
        'Pending email processing complete'
      );
    } else {
      logger.debug({ processId, trigger }, 'No pending emails to process');
    }

    return result;
  }

  /**
   * Manually trigger pending email processing
   */
  async triggerManualProcess(): Promise<{ sent: number; failed: number }> {
    const result = await this.runSafeProcess('manual');
    return result ?? { sent: 0, failed: 0 };
  }

  /**
   * Get service status and statistics
   */
  getStatus(): {
    running: boolean;
    processIntervalMs: number;
    processIntervalMinutes: number;
    instanceId: string;
    stats: typeof this.stats;
  } {
    return {
      running: this.intervalId !== null,
      processIntervalMs: this.processIntervalMs,
      processIntervalMinutes: this.processIntervalMs / 60000,
      instanceId: this.instanceId,
      stats: {
        ...this.stats,
        lastRunTime: this.stats.lastRunTime,
      },
    };
  }
}

export const pendingEmailService = new PendingEmailService();

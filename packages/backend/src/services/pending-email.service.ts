import { emailProcessingService } from './email-processing.service';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { releaseLock, renewLock } from '../utils/redis-locks';
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
 * - Uses Redis distributed lock for multi-instance safety
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
  private lockRenewalId: NodeJS.Timeout | null = null;
  private processIntervalMs: number;
  private instanceId: string;
  // FIX P1/P2: Track lock validity to prevent continued processing after lock loss
  private lockValid: boolean = true;
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
    this.stopLockRenewal();
    // Release lock on shutdown (best effort)
    this.releaseInstanceLock().catch(() => {});
    logger.info({ instanceId: this.instanceId }, 'Pending email service stopped');
  }

  /**
   * Try to acquire the distributed lock
   * Returns true if lock acquired, false if another instance holds it
   *
   * FIX: Improved error handling to distinguish between:
   * - Lock exists (another instance holds it) -> return false
   * - Redis unavailable on startup (no connection) -> allow single-instance mode
   * - Redis connection lost mid-operation -> deny to prevent duplicates
   */
  private async tryAcquireLock(): Promise<boolean> {
    try {
      const result = await redis.set(
        PENDING_EMAIL_LOCK.KEY,
        this.instanceId,
        'EX',
        PENDING_EMAIL_LOCK.TTL_SECONDS,
        'NX'
      );
      return result === 'OK';
    } catch (err) {
      // Check if this is a "Redis not available" error (startup scenario)
      // vs a connection lost error (mid-operation scenario)
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isRedisUnavailable = errorMessage.includes('Redis not available');

      if (isRedisUnavailable) {
        // Check if we're explicitly in single-instance mode
        // In production multi-instance deployments, we should fail closed to prevent duplicates
        const isSingleInstanceMode = process.env.SINGLE_INSTANCE_MODE === 'true';

        if (isSingleInstanceMode) {
          // Explicitly configured for single-instance - allow processing without Redis
          logger.warn(
            { err: errorMessage, instanceId: this.instanceId },
            'Redis not available but SINGLE_INSTANCE_MODE=true - proceeding without distributed lock'
          );
          return true;
        }

        // Production default: fail closed to prevent duplicates in multi-instance deployment
        // If this is actually single-instance, set SINGLE_INSTANCE_MODE=true
        logger.error(
          { err: errorMessage, instanceId: this.instanceId },
          'Redis not available for distributed lock - DENYING to prevent duplicates (set SINGLE_INSTANCE_MODE=true to override)'
        );
        return false;
      }

      // Redis connection was lost or other error - deny to prevent duplicates
      // Another instance might have acquired the lock before we lost connection
      logger.error(
        { err, instanceId: this.instanceId },
        'Redis lock operation failed - denying to prevent duplicate processing'
      );
      return false;
    }
  }

  /**
   * Release the distributed lock (only if we own it)
   */
  private async releaseInstanceLock(): Promise<void> {
    await releaseLock(PENDING_EMAIL_LOCK.KEY, this.instanceId, 'pending-email');
  }

  /**
   * Start lock renewal to keep the lock alive during long processing
   * FIX P1/P2: Now tracks lock validity to stop processing when lock is lost
   */
  private startLockRenewal(): void {
    this.lockValid = true; // Reset on new lock acquisition
    this.lockRenewalId = setInterval(async () => {
      const renewed = await renewLock(PENDING_EMAIL_LOCK.KEY, this.instanceId, PENDING_EMAIL_LOCK.TTL_SECONDS);
      if (!renewed) {
        // FIX P1/P2: Mark lock as invalid so processing can check and abort
        this.lockValid = false;
        logger.warn(
          { instanceId: this.instanceId },
          'Lock renewal failed - lock was taken by another instance'
        );
        this.stopLockRenewal();
      }
    }, PENDING_EMAIL_LOCK.RENEWAL_INTERVAL_MS);
  }

  /**
   * FIX P1/P2: Check if we still hold the lock (for aborting processing early)
   */
  isLockValid(): boolean {
    return this.lockValid;
  }

  /**
   * Stop the lock renewal interval
   */
  private stopLockRenewal(): void {
    if (this.lockRenewalId) {
      clearInterval(this.lockRenewalId);
      this.lockRenewalId = null;
    }
  }

  /**
   * Safe wrapper for processing that catches errors
   * Uses distributed lock for multi-instance safety
   */
  private async runSafeProcess(trigger: 'startup' | 'scheduled' | 'manual'): Promise<void> {
    // Try to acquire distributed lock
    const acquired = await this.tryAcquireLock();
    if (!acquired) {
      logger.debug(
        { instanceId: this.instanceId, trigger },
        'Skipping pending email processing - another instance holds the lock'
      );
      return;
    }

    // Start lock renewal
    this.startLockRenewal();
    const processId = Date.now().toString(36);

    try {
      logger.debug({ processId, trigger, instanceId: this.instanceId }, 'Processing pending emails');

      // Pass a lock validity checker so email processing can abort if lock is lost mid-batch
      const result = await emailProcessingService.processPendingEmails(processId, () => this.isLockValid());

      // Update stats with new queue metrics
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
    } catch (error) {
      logger.error(
        { processId, trigger, error },
        'Error processing pending emails - will retry next interval'
      );
    } finally {
      this.stopLockRenewal();
      await this.releaseInstanceLock();
    }
  }

  /**
   * Manually trigger pending email processing
   */
  async triggerManualProcess(): Promise<{ sent: number; failed: number }> {
    const acquired = await this.tryAcquireLock();
    if (!acquired) {
      logger.info(
        { instanceId: this.instanceId },
        'Manual process requested but another instance is processing'
      );
      return { sent: 0, failed: 0 };
    }

    this.startLockRenewal();
    const processId = Date.now().toString(36);

    try {
      logger.info({ processId, instanceId: this.instanceId }, 'Manual pending email processing triggered');
      // Pass a lock validity checker so email processing can abort if lock is lost mid-batch
      const result = await emailProcessingService.processPendingEmails(processId, () => this.isLockValid());

      this.stats.totalProcessed += result.sent + result.failed;
      this.stats.totalSent += result.sent;
      this.stats.totalFailed += result.failed;
      this.stats.lastRunTime = new Date();
      this.stats.lastRunSent = result.sent;
      this.stats.lastRunFailed = result.failed;
      this.stats.lastQueueDepth = result.queueDepth ?? 0;
      this.stats.lastBatchSize = result.batchSize ?? 0;

      logger.info({ processId, sent: result.sent, failed: result.failed }, 'Manual processing complete');
      return result;
    } catch (error) {
      logger.error({ processId, error }, 'Manual processing failed');
      throw error;
    } finally {
      this.stopLockRenewal();
      await this.releaseInstanceLock();
    }
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

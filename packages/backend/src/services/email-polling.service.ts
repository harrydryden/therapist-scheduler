import { emailProcessingService } from './email-processing.service';
import { logger } from '../utils/logger';

/**
 * Backup Email Polling Service
 *
 * This service provides resilience against missed Gmail push notifications.
 * Push notifications can be lost during:
 * - Server restarts/deployments
 * - Network issues
 * - Gmail Pub/Sub outages
 *
 * By polling every few minutes, we ensure no emails are missed for more than
 * the polling interval, while still primarily relying on push for real-time
 * responsiveness.
 */

// Default polling interval: 3 minutes
// Can be overridden with EMAIL_POLL_INTERVAL_MS environment variable
const DEFAULT_POLL_INTERVAL_MS = 3 * 60 * 1000;

// Minimum polling interval to prevent abuse: 1 minute
const MIN_POLL_INTERVAL_MS = 60 * 1000;

// Maximum polling interval: 15 minutes
const MAX_POLL_INTERVAL_MS = 15 * 60 * 1000;

class EmailPollingService {
  private intervalId: NodeJS.Timeout | null = null;
  private startupTimeoutId: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;
  private isPolling: boolean = false;

  constructor() {
    // Parse interval from environment, with bounds checking
    const envInterval = process.env.EMAIL_POLL_INTERVAL_MS
      ? parseInt(process.env.EMAIL_POLL_INTERVAL_MS, 10)
      : DEFAULT_POLL_INTERVAL_MS;

    this.pollIntervalMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      Math.min(MAX_POLL_INTERVAL_MS, envInterval || DEFAULT_POLL_INTERVAL_MS)
    );
  }

  /**
   * Start the periodic email polling job
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Email polling service already running');
      return;
    }

    const intervalMinutes = Math.round(this.pollIntervalMs / 60000);
    logger.info(
      { intervalMs: this.pollIntervalMs, intervalMinutes },
      `Starting backup email polling service (runs every ${intervalMinutes} minutes)`
    );

    // Run after a short delay on startup to allow Gmail client initialization
    // This ensures the Gmail client is fully ready before first poll
    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null;
      this.runSafePoll('startup');
    }, 10000); // 10 second delay

    // Then run at the configured interval
    this.intervalId = setInterval(() => {
      this.runSafePoll('scheduled');
    }, this.pollIntervalMs);
  }

  /**
   * Stop the periodic email polling job
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
    logger.info('Email polling service stopped');
  }

  /**
   * Safe wrapper for pollForEmails that catches and logs errors
   * without crashing the interval
   */
  private async runSafePoll(trigger: 'startup' | 'scheduled' | 'manual'): Promise<void> {
    // Prevent overlapping polls
    if (this.isPolling) {
      logger.debug('Skipping poll - previous poll still in progress');
      return;
    }

    this.isPolling = true;
    const pollId = Date.now().toString(36);

    try {
      logger.info({ pollId, trigger }, 'Running backup email poll');

      const result = await emailProcessingService.pollForNewEmails(pollId);

      if (result.processed > 0) {
        logger.info(
          { pollId, trigger, processed: result.processed },
          'Backup poll processed emails that may have been missed by push notifications'
        );
      } else {
        logger.debug({ pollId, trigger }, 'Backup poll complete - no new emails');
      }
    } catch (error) {
      logger.error(
        { pollId, trigger, error },
        'Error in backup email poll - will retry next interval'
      );
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Manually trigger a poll (useful for admin/debugging)
   */
  async triggerManualPoll(): Promise<{ processed: number }> {
    const pollId = Date.now().toString(36);

    if (this.isPolling) {
      logger.info({ pollId }, 'Manual poll requested but poll already in progress');
      return { processed: 0 };
    }

    this.isPolling = true;

    try {
      logger.info({ pollId }, 'Manual email poll triggered');
      const result = await emailProcessingService.pollForNewEmails(pollId);
      logger.info({ pollId, processed: result.processed }, 'Manual poll complete');
      return result;
    } catch (error) {
      logger.error({ pollId, error }, 'Manual poll failed');
      throw error;
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Get service status
   */
  getStatus(): {
    running: boolean;
    intervalMs: number;
    intervalMinutes: number;
    isCurrentlyPolling: boolean;
  } {
    return {
      running: this.intervalId !== null,
      intervalMs: this.pollIntervalMs,
      intervalMinutes: Math.round(this.pollIntervalMs / 60000),
      isCurrentlyPolling: this.isPolling,
    };
  }
}

export const emailPollingService = new EmailPollingService();

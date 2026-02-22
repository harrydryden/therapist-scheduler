import { emailProcessingService } from './email-processing.service';
import { logger } from '../utils/logger';
import { config } from '../config';

/**
 * Gmail Watch Auto-Renewal Service
 *
 * Gmail push notification "watches" expire after 7 days. This service
 * automatically renews the watch before expiration to ensure continuous
 * push notification delivery.
 *
 * Features:
 * - Renews watch every 6 days (1 day buffer before expiration)
 * - Attempts renewal on startup (after delay for Gmail client init)
 * - Logs success/failure for monitoring
 * - Graceful handling of missing Pub/Sub configuration
 */

// Renewal interval: 6 days (watches expire after 7 days)
// Default can be overridden with GMAIL_WATCH_RENEWAL_INTERVAL_MS
const DEFAULT_RENEWAL_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000; // 6 days

// Startup delay to allow Gmail client initialization
const STARTUP_DELAY_MS = 30000; // 30 seconds

class GmailWatchService {
  private intervalId: NodeJS.Timeout | null = null;
  private startupTimeoutId: NodeJS.Timeout | null = null;
  private renewalIntervalMs: number;
  private lastRenewalTime: Date | null = null;
  private lastExpirationTime: string | null = null;

  constructor() {
    const envInterval = process.env.GMAIL_WATCH_RENEWAL_INTERVAL_MS
      ? parseInt(process.env.GMAIL_WATCH_RENEWAL_INTERVAL_MS, 10)
      : DEFAULT_RENEWAL_INTERVAL_MS;

    // Minimum 1 hour, maximum 6.5 days
    const MIN_INTERVAL = 60 * 60 * 1000; // 1 hour
    const MAX_INTERVAL = 6.5 * 24 * 60 * 60 * 1000; // 6.5 days

    this.renewalIntervalMs = Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, envInterval));
  }

  /**
   * Start the Gmail watch auto-renewal service
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Gmail watch service already running');
      return;
    }

    // Check if Pub/Sub topic is configured
    const topicName = config.googlePubsubTopic;
    if (!topicName) {
      logger.warn(
        'Gmail watch service not starting - GOOGLE_PUBSUB_TOPIC not configured. ' +
        'Push notifications will not work without this.'
      );
      return;
    }

    const intervalDays = (this.renewalIntervalMs / (24 * 60 * 60 * 1000)).toFixed(1);
    logger.info(
      { intervalMs: this.renewalIntervalMs, intervalDays, topicName },
      `Starting Gmail watch auto-renewal service (renews every ${intervalDays} days)`
    );

    // Attempt renewal after startup delay (allows Gmail client to initialize)
    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null;
      this.renewWatch('startup');
    }, STARTUP_DELAY_MS);

    // Then renew at the configured interval
    this.intervalId = setInterval(() => {
      this.renewWatch('scheduled');
    }, this.renewalIntervalMs);
  }

  /**
   * Stop the Gmail watch auto-renewal service
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
    logger.info('Gmail watch service stopped');
  }

  /**
   * Renew the Gmail watch
   */
  private async renewWatch(trigger: 'startup' | 'scheduled' | 'manual'): Promise<boolean> {
    const topicName = config.googlePubsubTopic;
    if (!topicName) {
      logger.warn('Cannot renew Gmail watch - GOOGLE_PUBSUB_TOPIC not configured');
      return false;
    }

    const renewalId = Date.now().toString(36);
    logger.info({ renewalId, trigger, topicName }, 'Attempting Gmail watch renewal');

    try {
      const result = await emailProcessingService.setupPushNotifications(topicName);

      this.lastRenewalTime = new Date();
      this.lastExpirationTime = result.expiration;

      // Calculate when the watch will expire
      const expirationDate = new Date(parseInt(result.expiration, 10));
      const daysUntilExpiry = (expirationDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000);

      logger.info(
        {
          renewalId,
          trigger,
          historyId: result.historyId,
          expiration: result.expiration,
          expirationDate: expirationDate.toISOString(),
          daysUntilExpiry: daysUntilExpiry.toFixed(2),
        },
        'Gmail watch renewed successfully'
      );

      return true;
    } catch (error) {
      logger.error(
        { renewalId, trigger, error },
        'Failed to renew Gmail watch - push notifications may stop working'
      );
      return false;
    }
  }

  /**
   * Manually trigger a watch renewal (useful for admin/debugging)
   */
  async triggerManualRenewal(): Promise<{
    success: boolean;
    expiration?: string;
    error?: string;
  }> {
    const topicName = config.googlePubsubTopic;
    if (!topicName) {
      return { success: false, error: 'GOOGLE_PUBSUB_TOPIC not configured' };
    }

    try {
      const result = await emailProcessingService.setupPushNotifications(topicName);
      this.lastRenewalTime = new Date();
      this.lastExpirationTime = result.expiration;
      return { success: true, expiration: result.expiration };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get service status
   */
  getStatus(): {
    running: boolean;
    renewalIntervalMs: number;
    renewalIntervalDays: number;
    lastRenewalTime: string | null;
    lastExpirationTime: string | null;
    pubsubConfigured: boolean;
  } {
    return {
      running: this.intervalId !== null,
      renewalIntervalMs: this.renewalIntervalMs,
      renewalIntervalDays: this.renewalIntervalMs / (24 * 60 * 60 * 1000),
      lastRenewalTime: this.lastRenewalTime?.toISOString() || null,
      lastExpirationTime: this.lastExpirationTime,
      pubsubConfigured: !!config.googlePubsubTopic,
    };
  }
}

export const gmailWatchService = new GmailWatchService();

/**
 * Slack Weekly Summary Service
 *
 * Sends a weekly summary of scheduling activity to Slack every Monday at 9am UK time.
 * Uses distributed locking to ensure only one instance sends the summary.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { releaseLock, acquireLock } from '../utils/redis-locks';
import { slackNotificationService } from './slack-notification.service';
import { SLACK_NOTIFICATIONS } from '../constants';

const LOCK_KEY = SLACK_NOTIFICATIONS.LOCK_KEY;
const LOCK_TTL_SECONDS = SLACK_NOTIFICATIONS.LOCK_TTL_SECONDS;
const LAST_SUMMARY_KEY = SLACK_NOTIFICATIONS.LAST_SUMMARY_KEY;
const CHECK_INTERVAL_MS = SLACK_NOTIFICATIONS.CHECK_INTERVAL_MS;

class SlackWeeklySummaryService {
  private intervalId: NodeJS.Timeout | null = null;
  private instanceId: string;

  constructor() {
    this.instanceId = `summary-${process.pid}-${Date.now().toString(36)}`;
  }

  /**
   * Start the periodic summary check
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Slack weekly summary service already running');
      return;
    }

    if (!slackNotificationService.isEnabled()) {
      logger.info('Slack weekly summary service not starting - Slack notifications disabled');
      return;
    }

    logger.info('Starting Slack weekly summary service (checks every hour)');

    // Run immediately on startup
    this.checkAndSend().catch((err) => {
      logger.error({ err }, 'Error in initial weekly summary check');
    });

    // Then check every hour
    this.intervalId = setInterval(() => {
      this.checkAndSend().catch((err) => {
        logger.error({ err }, 'Error in periodic weekly summary check');
      });
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Stop the service
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Slack weekly summary service stopped');
    }
  }

  /**
   * Check if it's time to send and send if needed
   */
  private async checkAndSend(): Promise<void> {
    // Get current time in UK timezone
    const now = new Date();
    const ukTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
    const day = ukTime.getDay();
    const hour = ukTime.getHours();

    // Check if it's Monday (day 1) and 9am hour
    if (day !== SLACK_NOTIFICATIONS.WEEKLY_SUMMARY_DAY || hour !== SLACK_NOTIFICATIONS.WEEKLY_SUMMARY_HOUR) {
      return;
    }

    // Check if we already sent today
    const lastSendDate = await redis.get(LAST_SUMMARY_KEY);
    const today = ukTime.toISOString().split('T')[0];

    if (lastSendDate === today) {
      logger.debug('Weekly summary already sent today');
      return;
    }

    // Try to acquire lock
    const acquired = await acquireLock(LOCK_KEY, this.instanceId, LOCK_TTL_SECONDS);

    if (!acquired) {
      logger.debug('Another instance is handling weekly summary');
      return;
    }

    try {
      await this.sendWeeklySummary();

      // Mark as sent
      await redis.set(LAST_SUMMARY_KEY, today, 'EX', 7 * 24 * 60 * 60); // Expire in 7 days
    } finally {
      await releaseLock(LOCK_KEY, this.instanceId, 'slack-weekly-summary');
    }
  }

  /**
   * Gather stats and send the weekly summary
   */
  private async sendWeeklySummary(): Promise<void> {
    logger.info('Sending weekly Slack summary');

    // Get date for one week ago
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    // Gather statistics
    const [
      pending,
      contacted,
      negotiating,
      confirmed,
      stalled,
      completedThisWeek,
      cancelledThisWeek,
    ] = await Promise.all([
      prisma.appointmentRequest.count({
        where: { status: 'pending' },
      }),
      prisma.appointmentRequest.count({
        where: { status: 'contacted' },
      }),
      prisma.appointmentRequest.count({
        where: { status: 'negotiating' },
      }),
      prisma.appointmentRequest.count({
        where: { status: 'confirmed' },
      }),
      prisma.appointmentRequest.count({
        where: {
          conversationStallAlertAt: { not: null },
          conversationStallAcknowledged: false,
          status: { in: ['pending', 'contacted', 'negotiating'] },
        },
      }),
      prisma.appointmentRequest.count({
        where: {
          status: 'completed',
          updatedAt: { gte: oneWeekAgo },
        },
      }),
      prisma.appointmentRequest.count({
        where: {
          status: 'cancelled',
          updatedAt: { gte: oneWeekAgo },
        },
      }),
    ]);

    const totalActive = pending + contacted + negotiating + confirmed;

    // Count needing attention (stalled + diverged + human flagged)
    const needingAttention = await prisma.appointmentRequest.count({
      where: {
        status: { in: ['pending', 'contacted', 'negotiating', 'confirmed'] },
        OR: [
          { conversationStallAlertAt: { not: null }, conversationStallAcknowledged: false },
          { threadDivergedAt: { not: null }, threadDivergenceAcknowledged: false },
          { humanControlEnabled: true },
        ],
      },
    });

    await slackNotificationService.sendWeeklySummary({
      totalActive,
      pending,
      contacted,
      negotiating,
      confirmed,
      stalled,
      needingAttention,
      completedThisWeek,
      cancelledThisWeek,
    });

    logger.info(
      {
        totalActive,
        pending,
        contacted,
        negotiating,
        confirmed,
        stalled,
        needingAttention,
        completedThisWeek,
        cancelledThisWeek,
      },
      'Weekly summary sent to Slack'
    );
  }
}

export const slackWeeklySummaryService = new SlackWeeklySummaryService();

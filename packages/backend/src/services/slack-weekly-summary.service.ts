/**
 * Slack Weekly Summary Service
 *
 * Sends a weekly summary of scheduling activity to Slack every Monday at 9am UK time.
 * Uses LockedTaskRunner for distributed locking to ensure only one instance sends.
 * Extends PeriodicService for standard start/stop/interval lifecycle.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { PeriodicService } from '../utils/periodic-service';
import { slackNotificationService } from './slack-notification.service';
import { SLACK_NOTIFICATIONS } from '../constants';

const LAST_SUMMARY_KEY = SLACK_NOTIFICATIONS.LAST_SUMMARY_KEY;

class SlackWeeklySummaryService extends PeriodicService {
  private instanceId: string;
  private lockedRunner: LockedTaskRunner;

  constructor() {
    super({
      name: 'slack-weekly-summary',
      intervalMs: SLACK_NOTIFICATIONS.CHECK_INTERVAL_MS,
    });

    this.instanceId = `summary-${process.pid}-${Date.now().toString(36)}`;
    this.lockedRunner = new LockedTaskRunner({
      lockKey: SLACK_NOTIFICATIONS.LOCK_KEY,
      lockTtlSeconds: SLACK_NOTIFICATIONS.LOCK_TTL_SECONDS,
      renewalIntervalMs: 30_000,
      instanceId: this.instanceId,
      context: 'slack-weekly-summary',
    });
  }

  start(): void {
    if (!slackNotificationService.isEnabled()) {
      logger.info('Slack weekly summary service not starting - Slack notifications disabled');
      return;
    }
    super.start();
  }

  protected async runCheck(): Promise<void> {
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

    const taskResult = await this.lockedRunner.run(async () => {
      await this.sendWeeklySummary();
      // Mark as sent
      await redis.set(LAST_SUMMARY_KEY, today, 'EX', 7 * 24 * 60 * 60);
    });

    if (!taskResult.acquired) {
      logger.debug('Another instance is handling weekly summary');
      return;
    }

    if (taskResult.error) {
      logger.error({ error: taskResult.error }, 'Error sending weekly summary');
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

/**
 * Slack Weekly Summary Service
 *
 * Sends a weekly summary of scheduling activity to Slack every Monday at 9am UK time.
 * Extends LockedPeriodicService for the standard start/stop/interval +
 * distributed-lock lifecycle (previously hand-rolled a LockedTaskRunner
 * on top of PeriodicService — see utils/locked-periodic-service.ts).
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { LockedPeriodicService } from '../utils/locked-periodic-service';
import { slackNotificationService } from './slack-notification.service';
import { SLACK_NOTIFICATIONS, PRE_BOOKING_STATUSES } from '../constants';
import { getDateInTimezone } from '../utils/date';

const LAST_SUMMARY_KEY = SLACK_NOTIFICATIONS.LAST_SUMMARY_KEY;

class SlackWeeklySummaryService extends LockedPeriodicService<void> {
  constructor() {
    super({
      name: 'slack-weekly-summary',
      intervalMs: SLACK_NOTIFICATIONS.CHECK_INTERVAL_MS,
      lockKey: SLACK_NOTIFICATIONS.LOCK_KEY,
      lockTtlSeconds: SLACK_NOTIFICATIONS.LOCK_TTL_SECONDS,
      renewalIntervalMs: 30_000,
    });
  }

  start(): void {
    if (!slackNotificationService.isEnabled()) {
      logger.info('Slack weekly summary service not starting - Slack notifications disabled');
      return;
    }
    super.start();
  }

  protected async tick(): Promise<void> {
    // Get current time in UK timezone. Intl-based — never round-trip a
    // toLocaleString rendering through new Date(), which re-parses it in
    // the SERVER's zone and only works while the server happens to run UTC.
    const now = new Date();
    const uk = getDateInTimezone(now, 'Europe/London');
    const day = uk.dayOfWeek;
    const hour = uk.hours;

    // Check if it's Monday (day 1) and 9am hour
    if (day !== SLACK_NOTIFICATIONS.WEEKLY_SUMMARY_DAY || hour !== SLACK_NOTIFICATIONS.WEEKLY_SUMMARY_HOUR) {
      return;
    }

    // Check if we already sent today (dedupe key = the LONDON calendar date)
    const lastSendDate = await redis.get(LAST_SUMMARY_KEY);
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${uk.year}-${pad(uk.month + 1)}-${pad(uk.day)}`;

    if (lastSendDate === today) {
      logger.debug('Weekly summary already sent today');
      return;
    }

    await this.sendWeeklySummary();
    // Mark as sent
    await redis.set(LAST_SUMMARY_KEY, today, 'EX', 7 * 24 * 60 * 60);
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
          status: { in: [...PRE_BOOKING_STATUSES] },
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
        status: { in: [...PRE_BOOKING_STATUSES, 'confirmed'] },
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

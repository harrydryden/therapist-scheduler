/**
 * Work Report Service
 *
 * Generates daily work reports summarising agent activity since the last report.
 * Reports are created every working day (Mon–Fri) at 9am UK time.
 * Monday reports cover Fri 9am → Mon 9am (including the weekend).
 *
 * Uses LockedTaskRunner for distributed locking to ensure only one instance generates.
 * Extends PeriodicService for standard start/stop/interval lifecycle.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { PeriodicService } from '../utils/periodic-service';
import { slackNotificationService } from './slack-notification.service';
import { WORK_REPORT } from '../constants';

class WorkReportService extends PeriodicService {
  private instanceId: string;
  private lockedRunner: LockedTaskRunner;

  constructor() {
    super({
      name: 'work-report',
      intervalMs: WORK_REPORT.CHECK_INTERVAL_MS,
    });

    this.instanceId = `work-report-${process.pid}-${Date.now().toString(36)}`;
    this.lockedRunner = new LockedTaskRunner({
      lockKey: WORK_REPORT.LOCK_KEY,
      lockTtlSeconds: WORK_REPORT.LOCK_TTL_SECONDS,
      renewalIntervalMs: 30_000,
      instanceId: this.instanceId,
      context: 'work-report',
    });
  }

  start(): void {
    if (!slackNotificationService.isEnabled()) {
      logger.info('Work report service not starting - Slack notifications disabled');
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

    // Only run on weekdays (Mon=1 to Fri=5) at 9am
    if (day < 1 || day > 5 || hour !== WORK_REPORT.REPORT_HOUR) {
      return;
    }

    // Check if we already generated today
    const lastReportDate = await redis.get(WORK_REPORT.LAST_REPORT_KEY);
    const today = ukTime.toISOString().split('T')[0];

    if (lastReportDate === today) {
      logger.debug('Work report already generated today');
      return;
    }

    const taskResult = await this.lockedRunner.run(async () => {
      await this.generateAndSendReport();
      // Mark as generated
      await redis.set(WORK_REPORT.LAST_REPORT_KEY, today, 'EX', 7 * 24 * 60 * 60);
    });

    if (!taskResult.acquired) {
      logger.debug('Another instance is handling work report generation');
      return;
    }

    if (taskResult.error) {
      logger.error({ error: taskResult.error }, 'Error generating work report');
    }
  }

  /**
   * Calculate the start of the report period.
   * For Mon reports: previous Friday 9am UK.
   * For Tue–Fri: previous day 9am UK.
   */
  private getPeriodStart(ukNow: Date): Date {
    const day = ukNow.getDay();
    const daysBack = day === 1 ? 3 : 1; // Monday = 3 days back (to Friday), otherwise 1

    const periodStart = new Date(ukNow);
    periodStart.setDate(periodStart.getDate() - daysBack);
    periodStart.setHours(WORK_REPORT.REPORT_HOUR, 0, 0, 0);

    // Convert back to UTC for database queries
    // Create the date in UK timezone and get its UTC equivalent
    const ukDateStr = periodStart.toLocaleString('en-US', { timeZone: 'Europe/London' });
    const ukDate = new Date(ukDateStr);
    const utcOffset = ukDate.getTime() - periodStart.getTime();
    return new Date(periodStart.getTime() - utcOffset);
  }

  /**
   * Generate the work report, save to DB, and send to Slack.
   */
  async generateAndSendReport(): Promise<void> {
    logger.info('Generating daily work report');

    const now = new Date();
    const ukNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
    const periodStart = this.getPeriodStart(ukNow);
    const periodEnd = now; // Current time

    // Query all metrics in parallel
    const [
      emailsSent,
      emailsReceived,
      appointmentsCreated,
      appointmentsConfirmed,
      appointmentsCompleted,
      appointmentsCancelled,
      staleConversationsFlagged,
      humanControlTakeovers,
      chaseFollowUpsSent,
      closureRecommendations,
      pipelinePending,
      pipelineContacted,
      pipelineNegotiating,
      pipelineConfirmed,
      feedbackSubmissions,
    ] = await Promise.all([
      // Emails sent by agent in period
      prisma.appointmentAuditEvent.count({
        where: {
          eventType: 'email_sent',
          actor: 'agent',
          createdAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Emails received from users/therapists in period
      prisma.appointmentAuditEvent.count({
        where: {
          eventType: 'email_received',
          createdAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Appointments created in period
      prisma.appointmentRequest.count({
        where: {
          createdAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Appointments confirmed in period
      prisma.appointmentRequest.count({
        where: {
          confirmedAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Appointments completed in period
      prisma.appointmentAuditEvent.count({
        where: {
          eventType: 'status_change',
          createdAt: { gte: periodStart, lte: periodEnd },
          payload: {
            path: ['newStatus'],
            equals: 'completed',
          },
        },
      }),
      // Appointments cancelled in period
      prisma.appointmentAuditEvent.count({
        where: {
          eventType: 'status_change',
          createdAt: { gte: periodStart, lte: periodEnd },
          payload: {
            path: ['newStatus'],
            equals: 'cancelled',
          },
        },
      }),
      // Stale conversations flagged in period
      prisma.appointmentAuditEvent.count({
        where: {
          eventType: 'stale_flagged',
          createdAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Human control takeovers in period
      prisma.appointmentAuditEvent.count({
        where: {
          eventType: 'human_control',
          createdAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Chase follow-ups sent in period
      prisma.appointmentRequest.count({
        where: {
          chaseSentAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Closure recommendations in period
      prisma.appointmentRequest.count({
        where: {
          closureRecommendedAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Current pipeline snapshot
      prisma.appointmentRequest.count({ where: { status: 'pending' } }),
      prisma.appointmentRequest.count({ where: { status: 'contacted' } }),
      prisma.appointmentRequest.count({ where: { status: 'negotiating' } }),
      prisma.appointmentRequest.count({ where: { status: 'confirmed' } }),
      // Feedback submissions in period
      prisma.feedbackSubmission.count({
        where: {
          createdAt: { gte: periodStart, lte: periodEnd },
        },
      }),
    ]);

    // Save report to database
    const report = await prisma.workReport.create({
      data: {
        periodStart,
        periodEnd,
        emailsSent,
        emailsReceived,
        appointmentsCreated,
        appointmentsConfirmed,
        appointmentsCompleted,
        appointmentsCancelled,
        staleConversationsFlagged,
        humanControlTakeovers,
        chaseFollowUpsSent,
        closureRecommendations,
        pipelinePending,
        pipelineContacted,
        pipelineNegotiating,
        pipelineConfirmed,
        feedbackSubmissions,
      },
    });

    // Send to Slack
    const slackSent = await slackNotificationService.sendWorkReport({
      periodStart,
      periodEnd,
      emailsSent,
      emailsReceived,
      appointmentsCreated,
      appointmentsConfirmed,
      appointmentsCompleted,
      appointmentsCancelled,
      staleConversationsFlagged,
      humanControlTakeovers,
      chaseFollowUpsSent,
      closureRecommendations,
      pipelinePending,
      pipelineContacted,
      pipelineNegotiating,
      pipelineConfirmed,
      feedbackSubmissions,
    });

    // Update slack delivery time
    if (slackSent) {
      await prisma.workReport.update({
        where: { id: report.id },
        data: { slackSentAt: new Date() },
      });
    }

    logger.info(
      {
        reportId: report.id,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        emailsSent,
        emailsReceived,
        appointmentsCreated,
        appointmentsConfirmed,
        slackSent,
      },
      'Daily work report generated'
    );
  }
}

export const workReportService = new WorkReportService();

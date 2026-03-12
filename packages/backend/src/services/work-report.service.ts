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
    // Always start — reports are saved to the database for admin panel viewing
    // even if Slack is not configured. Slack delivery is best-effort.
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
   * Calculate the start of the report period as a UTC Date.
   * For Mon reports: previous Friday 9am UK time.
   * For Tue–Fri: previous day 9am UK time.
   *
   * Uses Intl.DateTimeFormat to determine the current UK offset (handles BST/GMT)
   * and builds the UTC equivalent of "9am UK time on the target day".
   */
  private getPeriodStart(now: Date): Date {
    // Determine the current UK date/time parts
    const ukParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const get = (type: string) => ukParts.find(p => p.type === type)?.value || '';
    const ukDay = now.toLocaleDateString('en-US', { timeZone: 'Europe/London', weekday: 'short' });
    const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(ukDay);
    const daysBack = dayOfWeek === 1 ? 3 : 1; // Monday → back to Friday, else → yesterday

    // Build "target day 09:00 UK time" as an ISO string, then compute UTC offset
    const year = parseInt(get('year'));
    const month = parseInt(get('month')) - 1;
    const day = parseInt(get('day')) - daysBack;

    // Create a date at 09:00 UK time by using the UK-to-UTC offset
    // First, get the UTC time that corresponds to this UK local time
    const candidateUtc = new Date(Date.UTC(year, month, day, WORK_REPORT.REPORT_HOUR, 0, 0));
    // What UK time does this UTC correspond to?
    const ukCheck = new Date(candidateUtc.toLocaleString('en-US', { timeZone: 'Europe/London' }));
    const offsetMs = ukCheck.getTime() - candidateUtc.getTime();
    // Subtract the offset to get the UTC equivalent of 9am UK
    return new Date(candidateUtc.getTime() - offsetMs);
  }

  /**
   * Generate the work report, save to DB, and send to Slack.
   */
  async generateAndSendReport(): Promise<void> {
    logger.info('Generating daily work report');

    const now = new Date();
    const periodStart = this.getPeriodStart(now);
    const periodEnd = now; // Current time

    // Query all metrics in parallel.
    //
    // Data source strategy:
    // - Emails: audit events (email_sent/email_received are reliably logged)
    // - Appointment lifecycle: appointment table fields (confirmedAt, updatedAt+status)
    //   rather than audit event JSON payloads, which use inconsistent key names
    //   (toStatus in lifecycle service vs newStatus in agent tools)
    // - Stale/human control: appointment table fields (isStale, humanControlTakenAt)
    //   because audit events for these operations are not consistently created
    // - Chase/closure: appointment table fields (chaseSentAt, closureRecommendedAt)
    // - Pipeline: appointment table status counts (point-in-time snapshot)
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
      // Emails sent by agent in period (audit events are reliably created for emails)
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
      // Appointments confirmed in period (confirmedAt is set atomically on confirmation)
      prisma.appointmentRequest.count({
        where: {
          confirmedAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Appointments completed in period (updatedAt tracks the status transition time)
      prisma.appointmentRequest.count({
        where: {
          status: 'completed',
          updatedAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Appointments cancelled in period
      prisma.appointmentRequest.count({
        where: {
          status: 'cancelled',
          updatedAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Conversations newly flagged stale in period.
      // conversationStallAlertAt is set by stale-check.service when a conversation stalls;
      // isStale alone would also catch 48h inactivity but stall alerts better represent
      // "needing attention" events the admin cares about.
      prisma.appointmentRequest.count({
        where: {
          conversationStallAlertAt: { gte: periodStart, lte: periodEnd },
        },
      }),
      // Human control takeovers in period (humanControlTakenAt is set on each takeover)
      prisma.appointmentRequest.count({
        where: {
          humanControlTakenAt: { gte: periodStart, lte: periodEnd },
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

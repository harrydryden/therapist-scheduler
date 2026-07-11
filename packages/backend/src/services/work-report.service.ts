/**
 * Work Report Service
 *
 * Generates daily work reports summarising agent activity since the last report.
 * Reports are created every working day (Mon–Fri) at 9am UK time.
 * Monday reports cover Fri 9am → Mon 9am (including the weekend).
 *
 * Extends LockedPeriodicService for the standard start/stop/interval +
 * distributed-lock lifecycle (previously hand-rolled a LockedTaskRunner
 * on top of PeriodicService — see utils/locked-periodic-service.ts).
 *
 * Always started (not gated on Slack being configured) — reports are
 * saved to the database for admin panel viewing even if Slack delivery
 * (best-effort) isn't set up.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { LockedPeriodicService } from '../utils/locked-periodic-service';
import { slackNotificationService } from './slack-notification.service';
import { WORK_REPORT } from '../constants';
import { anthropicClient } from '../utils/anthropic-client';
import { CLAUDE_MODELS } from '../config/models';
import { wallClockToUtc } from '../utils/date';

class WorkReportService extends LockedPeriodicService<void> {
  constructor() {
    super({
      name: 'work-report',
      intervalMs: WORK_REPORT.CHECK_INTERVAL_MS,
      lockKey: WORK_REPORT.LOCK_KEY,
      lockTtlSeconds: WORK_REPORT.LOCK_TTL_SECONDS,
      renewalIntervalMs: 30_000,
    });
  }

  /**
   * Extract the current UK hour and weekday using Intl.DateTimeFormat (handles BST/GMT correctly).
   */
  private getUkTimeParts(now: Date): { hour: number; dayOfWeek: number; dateStr: string } {
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
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayOfWeek = dayMap[get('weekday')] ?? 0;
    const hour = parseInt(get('hour'));
    const dateStr = `${get('year')}-${get('month')}-${get('day')}`;

    return { hour, dayOfWeek, dateStr };
  }

  protected async tick(): Promise<void> {
    const now = new Date();
    const { hour, dayOfWeek, dateStr } = this.getUkTimeParts(now);

    // Only run on weekdays (Mon=1 to Fri=5) at 9am UK time. Runs inside
    // the acquired lock (a cheap no-op Redis round-trip most ticks,
    // every 30 minutes) rather than short-circuiting before it, so the
    // lock/tick lifecycle stays uniform with every other
    // LockedPeriodicService subclass.
    if (dayOfWeek < 1 || dayOfWeek > 5 || hour !== WORK_REPORT.REPORT_HOUR) {
      return;
    }

    // Re-check the cache inside the lock to prevent duplicate generation.
    const lastReportDate = await redis.get(WORK_REPORT.LAST_REPORT_KEY);
    if (lastReportDate === dateStr) {
      logger.debug('Work report already generated today');
      return;
    }

    await this.generateAndSendReport();
    await redis.set(WORK_REPORT.LAST_REPORT_KEY, dateStr, 'EX', 7 * 24 * 60 * 60);
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
    const { dayOfWeek } = this.getUkTimeParts(now);

    // Extract UK date parts for date arithmetic
    const ukParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);

    const get = (type: string) => ukParts.find(p => p.type === type)?.value || '';
    const daysBack = dayOfWeek === 1 ? 3 : 1; // Monday → back to Friday, else → yesterday

    const year = parseInt(get('year'));
    const month = parseInt(get('month')) - 1;
    const day = parseInt(get('day')) - daysBack; // may go ≤0; Date.UTC rolls over correctly

    // "Target day 09:00 UK wall-clock" → UTC instant, DST-safe and
    // independent of the server's own timezone.
    return wallClockToUtc(year, month, day, WORK_REPORT.REPORT_HOUR, 0, 'Europe/London');
  }

  /**
   * Generate an AI synopsis of appointment activity during the report period.
   * Fetches recent audit events grouped by appointment and asks Claude to summarise.
   * Returns null on failure so the report still sends without a synopsis.
   */
  private async generateSynopsis(periodStart: Date, periodEnd: Date): Promise<string | null> {
    try {
      // Fetch appointments that had activity in the period, with their recent audit events
      const activeAppointments = await prisma.appointmentRequest.findMany({
        where: {
          auditEvents: {
            some: {
              createdAt: { gte: periodStart, lte: periodEnd },
              eventType: { in: ['email_sent', 'email_received', 'status_change', 'human_control'] },
            },
          },
        },
        select: {
          id: true,
          userName: true,
          therapistName: true,
          status: true,
          checkpointStage: true,
          humanControlEnabled: true,
          isStale: true,
          auditEvents: {
            where: {
              createdAt: { gte: periodStart, lte: periodEnd },
              eventType: { in: ['email_sent', 'email_received', 'status_change', 'human_control'] },
            },
            select: {
              eventType: true,
              actor: true,
              payload: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
            take: 10, // Cap events per appointment to control token usage
          },
        },
        take: 20, // Cap total appointments to control prompt size
      });

      if (activeAppointments.length === 0) {
        return null;
      }

      // Build a compact summary of activity per appointment for the prompt
      const appointmentSummaries = activeAppointments.map(apt => {
        const events = apt.auditEvents.map(e => {
          const payload = e.payload as Record<string, unknown> | null;
          const subject = payload?.subject ? ` — "${payload.subject}"` : '';
          const bodyPreview = payload?.bodyPreview ? ` (${(payload.bodyPreview as string).slice(0, 80)})` : '';
          return `  ${e.eventType} [${e.actor}]${subject}${bodyPreview}`;
        });

        const client = 'client';
        const flags: string[] = [];
        if (apt.humanControlEnabled) flags.push('HUMAN CONTROL');
        if (apt.isStale) flags.push('STALE');
        const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';

        return `• ${client} ↔ ${apt.therapistName} | Status: ${apt.status} | Stage: ${apt.checkpointStage || 'n/a'}${flagStr}\n${events.join('\n')}`;
      });

      const response = await anthropicClient.messages.create({
        model: CLAUDE_MODELS.FAST,
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `Summarise this scheduling agent activity for a Slack daily report in max 300 chars. One short bullet per appointment with therapist name + what happened. Flag issues. No headers, no markdown.

${appointmentSummaries.join('\n\n')}`,
          },
        ],
      });

      const text = response.content[0]?.type === 'text' ? response.content[0].text : null;
      if (!text) return null;

      return text.length > 400 ? text.slice(0, 397) + '...' : text;
    } catch (error) {
      logger.warn({ error }, 'Failed to generate work report synopsis — report will send without it');
      return null;
    }
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
      synopsis,
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
      // AI synopsis of appointment activity
      this.generateSynopsis(periodStart, periodEnd),
    ]);

    // If nothing actually happened in the period, skip both the DB write
    // and the Slack post — quiet days shouldn't produce a noisy report.
    // Pipeline counts are excluded from the check because they're a
    // point-in-time snapshot, not "work done since the last report".
    const activityTotal =
      emailsSent +
      emailsReceived +
      appointmentsCreated +
      appointmentsConfirmed +
      appointmentsCompleted +
      appointmentsCancelled +
      staleConversationsFlagged +
      humanControlTakeovers +
      chaseFollowUpsSent +
      closureRecommendations +
      feedbackSubmissions;
    if (activityTotal === 0) {
      logger.info(
        {
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
        },
        'No activity in period — skipping work report',
      );
      return;
    }

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
        synopsis,
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
      synopsis,
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
        hasSynopsis: !!synopsis,
        slackSent,
      },
      'Daily work report generated'
    );
  }
}

export const workReportService = new WorkReportService();

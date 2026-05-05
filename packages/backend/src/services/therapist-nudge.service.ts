import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { getSettingValue } from './settings.service';
import { emailProcessingService } from './email-processing.service';
import { renderTemplate } from '../utils/email-templates';
import { ACTIVE_STATUSES } from '../constants';
import { therapistBookingStatusService } from './therapist-booking-status.service';

// Check every 6 hours whether any therapists are due a nudge
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Distributed lock to prevent duplicate sends across instances
const LOCK_CONFIG = {
  KEY: 'therapist-nudge:processing-lock',
  TTL_SECONDS: 300,
  RENEWAL_INTERVAL_MS: 60 * 1000,
};

class TherapistNudgeService {
  private intervalId: NodeJS.Timeout | null = null;
  private instanceId: string;
  private taskRunner: LockedTaskRunner;

  constructor() {
    this.instanceId = `${process.pid}-${Date.now().toString(36)}-nudge`;
    this.taskRunner = new LockedTaskRunner({
      lockKey: LOCK_CONFIG.KEY,
      lockTtlSeconds: LOCK_CONFIG.TTL_SECONDS,
      renewalIntervalMs: LOCK_CONFIG.RENEWAL_INTERVAL_MS,
      instanceId: this.instanceId,
      context: 'therapist-nudge',
    });
  }

  start(): void {
    if (this.intervalId) {
      logger.warn('Therapist nudge service already running');
      return;
    }

    logger.info('Starting therapist nudge service (checks every 6 hours)');

    // Delay initial run by 3 minutes to let other services initialize
    setTimeout(() => {
      this.runSafe();
    }, 3 * 60 * 1000);

    this.intervalId = setInterval(() => {
      this.runSafe();
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('Therapist nudge service stopped');
  }

  private async runSafe(): Promise<void> {
    try {
      await this.taskRunner.run((ctx) => this.sendNudges(ctx.isLockValid));
    } catch (err) {
      logger.error({ err }, 'Therapist nudge check failed');
    }
  }

  /**
   * Find therapists due for a nudge and send them an email.
   *
   * A therapist is eligible if ALL of the following are true:
   *  1. They have an ingestedAt date (were added through the ingestion flow)
   *  2. They have NO appointments in an active status (pending → feedback_requested)
   *  3. They have NO completed appointments (they've never been matched)
   *  4. Enough time has passed since ingestedAt or lastNudgeAt (whichever is later)
   *  5. They are active in Postgres (active = true)
   *  6. They are not frozen/unavailable (no active booking threads)
   */
  private async sendNudges(isLockValid: () => boolean): Promise<void> {
    const enabled = await getSettingValue<boolean>('therapistNudge.enabled');
    if (!enabled) {
      logger.debug('Therapist nudge emails disabled');
      return;
    }

    // Fetch all independent data in parallel:
    //  - settings (intervalWeeks, agentName, email templates)
    //  - appointment exclusions
    //  - active therapists from Postgres
    //  - frozen/unavailable therapist IDs
    const [
      intervalWeeks,
      agentName,
      subjectTemplate,
      bodyTemplate,
      therapistsWithAppointments,
      activeTherapists,
      unavailableIds,
    ] = await Promise.all([
      getSettingValue<number>('therapistNudge.intervalWeeks'),
      getSettingValue<string>('agent.fromName'),
      getSettingValue<string>('email.therapistNudgeSubject'),
      getSettingValue<string>('email.therapistNudgeBody'),
      prisma.appointmentRequest.findMany({
        where: {
          status: { in: [...ACTIVE_STATUSES, 'completed'] },
        },
        select: { therapistNotionId: true },
        distinct: ['therapistNotionId'],
      }),
      // Active therapist set (post-Notion-deprecation: read from Postgres).
      // Returns null on error so the run aborts cleanly rather than nudging
      // therapists who may have been deactivated.
      prisma.therapist.findMany({
        where: { active: true },
        select: { id: true, notionId: true },
      }).catch((err) => {
        logger.error({ err }, 'Failed to fetch active therapists for nudge filtering — aborting nudge run');
        return null;
      }),
      therapistBookingStatusService.getUnavailableTherapistIds(),
    ]);

    // If we can't determine which therapists are active, skip this run
    // to avoid sending nudges to inactive therapists
    if (!activeTherapists) {
      return;
    }

    const cutoff = new Date(Date.now() - intervalWeeks * 7 * 24 * 60 * 60 * 1000);
    const agentFirstName = agentName.split(' ')[0];

    const excludedNotionIds = new Set(therapistsWithAppointments.map(a => a.therapistNotionId));
    // The public handle is notionId for legacy rows and the Postgres uuid
    // for post-Notion ingestions. Compose the active-set from both fields
    // so the filter below still excludes inactive therapists either way.
    const activeNotionIds = new Set<string>();
    for (const t of activeTherapists) {
      if (t.notionId) activeNotionIds.add(t.notionId);
      activeNotionIds.add(t.id);
    }
    const unavailableNotionIds = new Set(unavailableIds);

    // Find eligible therapists:
    //  - Have an ingestedAt date
    //  - Either never nudged (lastNudgeAt is null, ingestedAt before cutoff)
    //    or last nudged before the cutoff
    const candidates = await prisma.therapist.findMany({
      where: {
        ingestedAt: { not: null },
        OR: [
          {
            lastNudgeAt: null,
            ingestedAt: { lte: cutoff },
          },
          {
            lastNudgeAt: { lte: cutoff },
          },
        ],
      },
      select: {
        id: true,
        notionId: true,
        name: true,
        email: true,
      },
    });

    // Filter out:
    //  - therapists with active/completed appointments (already have a thread)
    //  - therapists not active (deactivated)
    //  - therapists that are frozen/unavailable (have active booking threads)
    //
    // The public handle is notionId for legacy rows and the Postgres uuid
    // for post-Notion ingestions; check both against each set.
    const eligible = candidates.filter(t => {
      const handle = t.notionId ?? t.id;
      return (
        !excludedNotionIds.has(handle) &&
        activeNotionIds.has(handle) &&
        !unavailableNotionIds.has(handle)
      );
    });

    if (eligible.length === 0) {
      logger.debug('No therapists due for nudge email');
      return;
    }

    logger.info({ count: eligible.length, intervalWeeks }, 'Sending therapist nudge emails');

    let sent = 0;
    let failed = 0;

    for (const therapist of eligible) {
      if (!isLockValid()) {
        logger.warn('Lost lock during therapist nudge — aborting');
        break;
      }

      try {
        const firstName = therapist.name.split(' ')[0];
        const variables = {
          therapistFirstName: firstName,
          therapistName: therapist.name,
          agentFirstName,
        };

        const subject = renderTemplate(subjectTemplate, variables);
        const body = renderTemplate(bodyTemplate, variables);

        const { threadId } = await emailProcessingService.sendEmail({
          to: therapist.email,
          subject,
          body,
        });

        // Mark as nudged and store the Gmail thread ID so replies can be
        // identified as nudge responses (not routed to an appointment).
        await prisma.therapist.update({
          where: { id: therapist.id },
          data: {
            lastNudgeAt: new Date(),
            lastNudgeThreadId: threadId || null,
          },
        });

        sent++;
        logger.info(
          { therapistId: therapist.id, name: therapist.name },
          'Sent therapist nudge email'
        );
      } catch (err) {
        failed++;
        logger.error(
          { err, therapistId: therapist.id, name: therapist.name },
          'Failed to send therapist nudge email'
        );
      }
    }

    logger.info({ sent, failed, total: eligible.length }, 'Therapist nudge run complete');
  }
}

export const therapistNudgeService = new TherapistNudgeService();

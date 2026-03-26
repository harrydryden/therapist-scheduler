import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { getSettingValue } from './settings.service';
import { emailProcessingService } from './email-processing.service';
import { getEmailSubject, getEmailBody } from '../utils/email-templates';
import { ACTIVE_STATUSES } from '../constants';

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
      await this.taskRunner.run((isLockValid) => this.sendNudges(isLockValid));
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
   */
  private async sendNudges(isLockValid: () => boolean): Promise<void> {
    const enabled = await getSettingValue<boolean>('therapistNudge.enabled');
    if (!enabled) {
      logger.debug('Therapist nudge emails disabled');
      return;
    }

    const intervalWeeks = await getSettingValue<number>('therapistNudge.intervalWeeks');
    const intervalMs = intervalWeeks * 7 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - intervalMs);

    const agentName = await getSettingValue<string>('agent.fromName');
    const agentFirstName = agentName.split(' ')[0];

    // Find therapists with active or completed appointments (to exclude)
    const therapistsWithAppointments = await prisma.appointmentRequest.findMany({
      where: {
        status: { in: [...ACTIVE_STATUSES, 'completed'] },
      },
      select: { therapistNotionId: true },
      distinct: ['therapistNotionId'],
    });
    const excludedNotionIds = new Set(therapistsWithAppointments.map(a => a.therapistNotionId));

    // Find eligible therapists:
    //  - Have an ingestedAt date
    //  - Either never nudged (lastNudgeAt is null, ingestedAt before cutoff)
    //    or last nudged before the cutoff
    const candidates = await prisma.therapist.findMany({
      where: {
        ingestedAt: { not: null },
        OR: [
          // Never nudged — use ingestedAt as the anchor
          {
            lastNudgeAt: null,
            ingestedAt: { lte: cutoff },
          },
          // Previously nudged — use lastNudgeAt as the anchor
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

    // Filter out therapists with active/completed appointments
    const eligible = candidates.filter(t => !excludedNotionIds.has(t.notionId));

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

        const subject = await getEmailSubject('therapistNudge', variables);
        const body = await getEmailBody('therapistNudge', variables);

        await emailProcessingService.sendEmail({
          to: therapist.email,
          subject,
          body,
        });

        // Mark as nudged
        await prisma.therapist.update({
          where: { id: therapist.id },
          data: { lastNudgeAt: new Date() },
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

/**
 * Invitation Lifecycle Service
 *
 * Periodic background task that handles two lifecycle responsibilities for
 * signup invitations:
 *
 * 1. Pre-expiry reminders — send a single nudge email a configurable number
 *    of days before each pending invitation expires. The reminder doesn't
 *    contain the link (the raw token isn't retrievable post-issue), it
 *    just asks the recipient to use the original email or to ask for a
 *    re-issue.
 *
 * 2. Archival — soft-delete (set archived_at) on expired and revoked
 *    invitations older than the configured lookback. Accepted invitations
 *    are kept indefinitely so conversion reporting stays accurate.
 *
 * Runs hourly. Each tick is bounded in batch size; if there's a backlog
 * the next tick picks up the rest.
 */

import { logger } from '../utils/logger';
import { acquireLock, releaseLock } from '../utils/redis-locks';
import { getSettingValue } from './settings.service';
import {
  archiveOldInvitations,
  findInvitationsNeedingReminder,
  sendInvitationReminder,
} from './signup-invitation.service';

const TICK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STARTUP_DELAY_MS = 5 * 60 * 1000;  // 5 minutes
const LOCK_TTL_SECONDS = 600;            // 10 minutes
const LOCK_KEY = 'lock:invitation-lifecycle';
const REMINDER_BATCH_SIZE = 50;

class InvitationLifecycleService {
  private intervalId: NodeJS.Timeout | null = null;
  private startupTimeout: NodeJS.Timeout | null = null;
  private running = false;
  private instanceId: string;
  private lastRun: { time: Date; remindersSent: number; archived: number } | null = null;

  constructor() {
    this.instanceId = `${process.pid}-${Date.now().toString(36)}-invitation-lifecycle`;
  }

  start(): void {
    logger.info('Starting invitation lifecycle service');
    this.startupTimeout = setTimeout(() => {
      this.startupTimeout = null;
      this.runWithLock();
    }, STARTUP_DELAY_MS);
    this.intervalId = setInterval(() => this.runWithLock(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('Stopped invitation lifecycle service');
  }

  /** Manual trigger used by an admin diagnostics endpoint, if one exists. */
  async trigger(): Promise<{ remindersSent: number; archived: number; skipped?: boolean }> {
    return this.runWithLock();
  }

  getStatus() {
    return {
      running: this.running,
      intervalMs: TICK_INTERVAL_MS,
      lastRun: this.lastRun?.time ?? null,
      lastRemindersSent: this.lastRun?.remindersSent ?? null,
      lastArchived: this.lastRun?.archived ?? null,
    };
  }

  private async runWithLock(): Promise<{ remindersSent: number; archived: number; skipped?: boolean }> {
    if (this.running) {
      return { remindersSent: 0, archived: 0, skipped: true };
    }

    const acquired = await acquireLock(LOCK_KEY, this.instanceId, LOCK_TTL_SECONDS);
    if (!acquired) {
      return { remindersSent: 0, archived: 0, skipped: true };
    }

    this.running = true;
    try {
      const result = await this.runOnce();
      this.lastRun = { time: new Date(), ...result };
      return result;
    } catch (err) {
      logger.error({ err }, 'Invitation lifecycle tick failed');
      return { remindersSent: 0, archived: 0 };
    } finally {
      await releaseLock(LOCK_KEY, this.instanceId, 'invitation-lifecycle');
      this.running = false;
    }
  }

  private async runOnce(): Promise<{ remindersSent: number; archived: number }> {
    const [reminderDaysBefore, archiveAfterDays] = await Promise.all([
      getSettingValue<number>('invitation.reminderDaysBefore'),
      getSettingValue<number>('invitation.archiveAfterDays'),
    ]);

    let remindersSent = 0;
    if (reminderDaysBefore > 0) {
      const due = await findInvitationsNeedingReminder(reminderDaysBefore, REMINDER_BATCH_SIZE);
      for (const inv of due) {
        const sent = await sendInvitationReminder(inv.id);
        if (sent) remindersSent++;
      }
      if (due.length > 0) {
        logger.info(
          { dueCount: due.length, remindersSent },
          'Invitation reminder pass complete',
        );
      }
    }

    let archived = 0;
    try {
      archived = await archiveOldInvitations(archiveAfterDays);
      if (archived > 0) {
        logger.info({ archived, olderThanDays: archiveAfterDays }, 'Invitation archival pass complete');
      }
    } catch (err) {
      logger.error({ err }, 'Invitation archival pass failed (non-fatal)');
    }

    return { remindersSent, archived };
  }
}

export const invitationLifecycleService = new InvitationLifecycleService();

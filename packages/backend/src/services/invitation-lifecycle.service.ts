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
import { LockedPeriodicService } from '../utils/locked-periodic-service';
import { getSettingValue } from './settings.service';
import {
  archiveOldInvitations,
  findInvitationsNeedingReminder,
  sendInvitationReminder,
} from './signup-invitation.service';

const TICK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STARTUP_DELAY_MS = 5 * 60 * 1000;  // 5 minutes
const LOCK_TTL_SECONDS = 600;            // 10 minutes
const RENEWAL_INTERVAL_MS = 60 * 1000;   // 1 minute
const LOCK_KEY = 'lock:invitation-lifecycle';
const REMINDER_BATCH_SIZE = 50;

interface TickResult {
  remindersSent: number;
  archived: number;
}

class InvitationLifecycleService extends LockedPeriodicService<TickResult> {
  constructor() {
    super({
      name: 'invitation-lifecycle',
      intervalMs: TICK_INTERVAL_MS,
      startupDelayMs: STARTUP_DELAY_MS,
      lockKey: LOCK_KEY,
      lockTtlSeconds: LOCK_TTL_SECONDS,
      renewalIntervalMs: RENEWAL_INTERVAL_MS,
    });
  }

  protected async tick(): Promise<TickResult> {
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

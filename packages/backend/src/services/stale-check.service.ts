import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { LockedPeriodicService } from '../utils/locked-periodic-service';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { slackNotificationService } from './slack-notification.service';
import { emailQueueService } from './email-queue.service';
import { DATA_RETENTION, STALE_CHECK_LOCK, RETENTION_CLEANUP_LOCK, STALE_CHECK_INTERVALS, PRE_BOOKING_STATUSES, POST_BOOKING_STATUSES, RESCHEDULE_OVERDUE_GRACE_MS, TERMINAL_STATUSES } from '../constants';
import { parseConfirmedDateTime } from '../utils/date';
import { getSettingValue } from './settings.service';
import { chaseEmailService } from './chase-email.service';
import { auditEventService } from './audit-event.service';

const { CHECK_INTERVAL_MS, RETENTION_CHECK_INTERVAL_MS } = STALE_CHECK_INTERVALS;

/**
 * The retention sweep runs on its own (slower, daily) cadence with its own
 * lock, so it can't share the LockedPeriodicService primary tick. We keep
 * a separate LockedTaskRunner + setInterval pair for that, started/stopped
 * alongside the primary tick via the start/stop overrides below.
 */
class StaleCheckService extends LockedPeriodicService {
  private retentionIntervalId: NodeJS.Timeout | null = null;
  private retentionStartupTimeoutId: NodeJS.Timeout | null = null;
  private retentionRunner: LockedTaskRunner;

  constructor() {
    super({
      name: 'stale-check',
      intervalMs: CHECK_INTERVAL_MS,
      lockKey: STALE_CHECK_LOCK.KEY,
      lockTtlSeconds: STALE_CHECK_LOCK.TTL_SECONDS,
      renewalIntervalMs: STALE_CHECK_LOCK.RENEWAL_INTERVAL_MS,
    });

    // Retention cleanup uses its own lock and its own (slower) cadence,
    // so it gets its own runner. Reuses our instanceId for ownership.
    this.retentionRunner = new LockedTaskRunner({
      lockKey: RETENTION_CLEANUP_LOCK.KEY,
      lockTtlSeconds: RETENTION_CLEANUP_LOCK.TTL_SECONDS,
      renewalIntervalMs: RETENTION_CLEANUP_LOCK.RENEWAL_INTERVAL_MS,
      instanceId: this.instanceId,
      context: 'retention-cleanup',
    });
  }

  protected async tick(): Promise<void> {
    const startTime = Date.now();
    await this.checkAndMarkStale();
    const durationMs = Date.now() - startTime;
    if (durationMs > 60000) {
      logger.warn({ durationMs }, 'Stale check took longer than expected');
    }
  }

  /**
   * Start: spin up the primary tick (via base class) and the slower
   * retention sweep on its own cadence.
   */
  start(): void {
    super.start();

    logger.info('Starting data retention cleanup (runs every 24 hours)');

    this.retentionStartupTimeoutId = setTimeout(() => {
      this.retentionStartupTimeoutId = null;
      this.runSafeRetentionCleanup();
    }, 5 * 60 * 1000);

    this.retentionIntervalId = setInterval(() => {
      this.runSafeRetentionCleanup();
    }, RETENTION_CHECK_INTERVAL_MS);
  }

  /**
   * Stop both timers — primary tick via super, retention sweep here.
   */
  stop(): void {
    if (this.retentionStartupTimeoutId) {
      clearTimeout(this.retentionStartupTimeoutId);
      this.retentionStartupTimeoutId = null;
    }
    if (this.retentionIntervalId) {
      clearInterval(this.retentionIntervalId);
      this.retentionIntervalId = null;
    }
    super.stop();
  }

  /**
   * Safe wrapper for data retention cleanup using LockedTaskRunner.
   */
  private async runSafeRetentionCleanup(): Promise<void> {
    const startTime = Date.now();

    const taskResult = await this.retentionRunner.run(async () => {
      await this.cleanupOldData();
    });

    if (!taskResult.acquired) {
      logger.debug('Retention cleanup lock held by another instance - skipping');
      return;
    }

    if (taskResult.error) {
      logger.error({ error: taskResult.error }, 'Unhandled error in retention cleanup - will retry next interval');
    }

    const durationMs = Date.now() - startTime;
    logger.debug({ durationMs }, 'Retention cleanup completed');
  }

  /**
   * Clean up old data according to retention policy
   * Removes cancelled and old confirmed appointments, processed messages, etc.
   */
  async cleanupOldData(): Promise<{
    cancelledArchived: number;
    completedArchived: number;
    processedMessagesDeleted: number;
    abandonedEmailsDeleted: number;
  }> {
    const cleanupId = Date.now().toString(36);
    logger.info({ cleanupId }, 'Running data retention cleanup');

    const now = new Date();
    let cancelledArchived = 0;
    let completedArchived = 0;
    let processedMessagesDeleted = 0;
    let abandonedEmailsDeleted = 0;

    try {
      // 1. Archive old cancelled appointments
      const cancelledThreshold = new Date(
        now.getTime() - DATA_RETENTION.CANCELLED_RETENTION_DAYS * 24 * 60 * 60 * 1000
      );

      // FIX B7: Properly handle cascade delete to prevent orphaned records
      // When deleting appointments, we must delete children first:
      // 1. Delete associated pendingEmail records
      // 2. Delete associated unmatched email attempts
      // 3. Then delete the appointment itself
      //
      // Using a transaction ensures atomicity
      const cancelledCount = await prisma.$transaction(async (tx) => {
        // Find appointments to delete
        const toDelete = await tx.appointmentRequest.findMany({
          where: {
            status: 'cancelled',
            updatedAt: { lt: cancelledThreshold },
          },
          select: { id: true },
          take: DATA_RETENTION.CLEANUP_BATCH_SIZE,
        });

        if (toDelete.length === 0) return 0;

        const appointmentIds = toDelete.map((a) => a.id);

        // Delete children first (cascade)
        await tx.pendingEmail.deleteMany({
          where: { appointmentId: { in: appointmentIds } },
        });

        // Then delete the appointments
        const deleted = await tx.appointmentRequest.deleteMany({
          where: { id: { in: appointmentIds } },
        });

        return deleted.count;
      });

      if (cancelledCount > 0) {
        logger.info(
          {
            cleanupId,
            deletedCount: cancelledCount,
            thresholdDays: DATA_RETENTION.CANCELLED_RETENTION_DAYS,
          },
          'Deleted old cancelled appointments with cascade cleanup'
        );
        cancelledArchived = cancelledCount;
      }

      // 2. Delete old confirmed/completed/session_held/feedback_requested appointments
      const completedThreshold = new Date(
        now.getTime() - DATA_RETENTION.COMPLETED_RETENTION_DAYS * 24 * 60 * 60 * 1000
      );

      const completedCount = await prisma.$transaction(async (tx) => {
        const toDelete = await tx.appointmentRequest.findMany({
          where: {
            status: { in: [...POST_BOOKING_STATUSES] },
            updatedAt: { lt: completedThreshold },
          },
          select: { id: true },
          take: DATA_RETENTION.CLEANUP_BATCH_SIZE,
        });

        if (toDelete.length === 0) return 0;

        const appointmentIds = toDelete.map((a) => a.id);

        // Delete children first (cascade)
        await tx.pendingEmail.deleteMany({
          where: { appointmentId: { in: appointmentIds } },
        });

        const deleted = await tx.appointmentRequest.deleteMany({
          where: { id: { in: appointmentIds } },
        });

        return deleted.count;
      });

      if (completedCount > 0) {
        logger.info(
          {
            cleanupId,
            deletedCount: completedCount,
            thresholdDays: DATA_RETENTION.COMPLETED_RETENTION_DAYS,
          },
          'Deleted old completed/confirmed appointments with cascade cleanup'
        );
        completedArchived = completedCount;
      }

      // 3. Delete old processed Gmail messages (deduplication records)
      const processedThreshold = new Date(
        now.getTime() - DATA_RETENTION.PROCESSED_MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000
      );

      const deletedMessages = await prisma.processedGmailMessage.deleteMany({
        where: {
          processedAt: { lt: processedThreshold },
        },
      });

      processedMessagesDeleted = deletedMessages.count;
      if (processedMessagesDeleted > 0) {
        logger.info(
          {
            cleanupId,
            deletedCount: processedMessagesDeleted,
            thresholdDays: DATA_RETENTION.PROCESSED_MESSAGE_RETENTION_DAYS,
          },
          'Deleted old processed Gmail message records'
        );
      }

      // 4. Delete old abandoned pending emails
      const abandonedThreshold = new Date(
        now.getTime() - DATA_RETENTION.ABANDONED_EMAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000
      );

      const deletedEmails = await prisma.pendingEmail.deleteMany({
        where: {
          status: 'abandoned',
          lastRetryAt: { lt: abandonedThreshold },
        },
      });

      abandonedEmailsDeleted = deletedEmails.count;
      if (abandonedEmailsDeleted > 0) {
        logger.info(
          {
            cleanupId,
            deletedCount: abandonedEmailsDeleted,
            thresholdDays: DATA_RETENTION.ABANDONED_EMAIL_RETENTION_DAYS,
          },
          'Deleted old abandoned pending emails'
        );
      }

      // 5. FIX S3: Delete old abandoned unmatched email attempts
      // These are tracking records for emails that couldn't be matched
      // Keep them for 7 days after abandonment for debugging, then clean up
      const unmatchedThreshold = new Date(
        now.getTime() - 7 * 24 * 60 * 60 * 1000 // 7 days
      );

      const deletedUnmatched = await prisma.unmatchedEmailAttempt.deleteMany({
        where: {
          abandoned: true,
          lastSeenAt: { lt: unmatchedThreshold },
        },
      });

      if (deletedUnmatched.count > 0) {
        logger.info(
          {
            cleanupId,
            deletedCount: deletedUnmatched.count,
          },
          'Deleted old unmatched email attempt records'
        );
      }

      // 5b. Delete old abandoned message processing failures.
      // These accumulate during incidents (e.g. the booking_method migration
      // gap in March 2026) and are useful for post-mortem debugging. 30 days
      // is enough to investigate after the fact without growing unbounded.
      const failureThreshold = new Date(
        now.getTime() - 30 * 24 * 60 * 60 * 1000
      );
      const deletedFailures = await prisma.messageProcessingFailure.deleteMany({
        where: {
          abandoned: true,
          lastFailedAt: { lt: failureThreshold },
        },
      });
      if (deletedFailures.count > 0) {
        logger.info(
          { cleanupId, deletedCount: deletedFailures.count },
          'Deleted old abandoned message processing failure records'
        );
      }

      // 6. Log orphaned appointments (missing User/Therapist links) for visibility
      const orphanedCount = await prisma.appointmentRequest.count({
        where: {
          OR: [
            { userId: null },
            { therapistId: null },
          ],
          status: { notIn: [...TERMINAL_STATUSES] },
        },
      });
      if (orphanedCount > 0) {
        logger.warn(
          { cleanupId, orphanedCount },
          'Active appointments with missing User/Therapist links detected — consider backfilling'
        );
      }

      // 7. Clean up old completed WeeklyMailingInquiry records (30 days)
      const inquiryThreshold = new Date(
        now.getTime() - 30 * 24 * 60 * 60 * 1000
      );
      const deletedInquiries = await prisma.weeklyMailingInquiry.deleteMany({
        where: {
          status: { in: ['completed', 'closed'] },
          updatedAt: { lt: inquiryThreshold },
        },
      });
      if (deletedInquiries.count > 0) {
        logger.info(
          { cleanupId, deletedCount: deletedInquiries.count },
          'Deleted old completed weekly mailing inquiries'
        );
      }

      logger.info(
        {
          cleanupId,
          cancelledArchived,
          completedArchived,
          processedMessagesDeleted,
          abandonedEmailsDeleted,
          unmatchedAttemptsDeleted: deletedUnmatched.count,
          weeklyMailingInquiriesDeleted: deletedInquiries.count,
          orphanedAppointments: orphanedCount,
        },
        'Data retention cleanup completed'
      );

      return {
        cancelledArchived,
        completedArchived,
        processedMessagesDeleted,
        abandonedEmailsDeleted,
      };
    } catch (error) {
      logger.error({ cleanupId, error }, 'Failed to run data retention cleanup');
      throw error;
    }
  }

  /**
   * Check all active conversations and mark stale ones
   */
  async checkAndMarkStale(): Promise<void> {
    const checkId = Date.now().toString(36);
    logger.info({ checkId }, 'Running stale check');

    try {
      const staleHours = await getSettingValue<number>('general.staleThresholdHours');
      const staleThreshold = new Date(Date.now() - staleHours * 60 * 60 * 1000);

      // Find conversations that should be marked stale:
      // - lastActivityAt > 48 hours ago
      // - status is active (pre-booking OR confirmed-but-rescheduling)
      // - not already marked stale
      // Note: lastActivityAt is non-nullable with @default(now()), so null check is unnecessary
      // Active conversations: pre-booking statuses OR confirmed-but-rescheduling
      const activeStatusFilter = [
        { status: { in: [...PRE_BOOKING_STATUSES] } },
        { status: 'confirmed' as const, reschedulingInProgress: true },
      ];

      // First find candidates that will be marked stale (so we know exactly which IDs are affected)
      const staleCandidates = await prisma.appointmentRequest.findMany({
        where: {
          lastActivityAt: { lt: staleThreshold },
          OR: activeStatusFilter,
          isStale: false,
        },
        select: { id: true },
      });

      if (staleCandidates.length > 0) {
        const staleCandidateIds = staleCandidates.map(a => a.id);

        await prisma.appointmentRequest.updateMany({
          where: {
            id: { in: staleCandidateIds },
          },
          data: {
            isStale: true,
          },
        });

        logger.info({ checkId, markedStale: staleCandidateIds.length }, 'Marked conversations as stale');

        // Log stale_flagged audit events only for newly stale appointments
        for (const apt of staleCandidates) {
          auditEventService.log(apt.id, 'stale_flagged', 'system', {
            reason: 'No activity for configured threshold',
          });
        }
      }

      // Also unmark stale if activity has resumed
      // (in case lastActivityAt was updated but isStale wasn't reset)
      // Only for active appointments - don't touch cancelled/settled confirmed
      const unmarkedResult = await prisma.appointmentRequest.updateMany({
        where: {
          lastActivityAt: { gte: staleThreshold },
          OR: activeStatusFilter,
          isStale: true,
        },
        data: {
          isStale: false,
        },
      });

      if (unmarkedResult.count > 0) {
        logger.info(
          { checkId, unmarkedStale: unmarkedResult.count },
          'Unmarked conversations as no longer stale'
        );
      }

      // Clear stale flag on any post-confirmation appointments.
      // Stale only applies to pre-confirmation statuses; appointments that were
      // marked stale before being confirmed should not retain the flag.
      const clearedPostConfirmResult = await prisma.appointmentRequest.updateMany({
        where: {
          status: { in: [...POST_BOOKING_STATUSES, 'cancelled'] },
          isStale: true,
        },
        data: {
          isStale: false,
        },
      });

      if (clearedPostConfirmResult.count > 0) {
        logger.info(
          { checkId, cleared: clearedPostConfirmResult.count },
          'Cleared stale flag from post-confirmation appointments'
        );
      }

      // Clear stall alerts on terminal-status appointments (completed/cancelled)
      // These appointments are no longer active and should not show alerts
      const clearedTerminalStallResult = await prisma.appointmentRequest.updateMany({
        where: {
          status: { in: [...TERMINAL_STATUSES] },
          conversationStallAlertAt: { not: null },
        },
        data: {
          conversationStallAlertAt: null,
        },
      });

      if (clearedTerminalStallResult.count > 0) {
        logger.info(
          { checkId, cleared: clearedTerminalStallResult.count },
          'Cleared stall alerts from terminal-status appointments'
        );
      }

      // Get configurable inactivity threshold (unified for admin alert + auto-unfreeze)
      const inactivityHours = await getSettingValue<number>('notifications.inactivityAlertHours');
      const inactivityThreshold = new Date(Date.now() - inactivityHours * 60 * 60 * 1000);

      // Check for and auto-unfreeze therapists with inactive conversations
      const { flaggedCount, unfrozenCount } = await therapistBookingStatusService.checkAndHandleInactiveTherapists(
        inactivityThreshold
      );
      if (flaggedCount > 0) {
        logger.info(
          { checkId, flaggedForAdmin: flaggedCount },
          'Flagged therapists for admin attention'
        );
      }
      if (unfrozenCount > 0) {
        logger.info(
          { checkId, unfrozenCount },
          'Auto-unfroze therapists due to conversation inactivity'
        );
      }

      // Get configurable stall detection threshold
      const stallHours = await getSettingValue<number>('notifications.stallDetectionHours');
      const stallThresholdMs = stallHours * 60 * 60 * 1000;

      // Conversation stall detection
      // A "stall" is different from inactivity - stall means activity is happening
      // but no forward progress (tool executions) is being made.
      // This catches conversations where emails are being processed but the
      // agent isn't taking any actions (possible loop or confusion state).
      const stallThreshold = new Date(Date.now() - stallThresholdMs);

      // Find conversations with recent activity but no recent tool execution
      // These are "spinning" - emails being processed but no forward progress
      const stalledResult = await prisma.appointmentRequest.updateMany({
        where: {
          AND: [
            { OR: activeStatusFilter },
            {
              lastActivityAt: { gte: stallThreshold }, // Has recent activity
              OR: [
                { lastToolExecutedAt: null }, // Never executed a tool
                { lastToolExecutedAt: { lt: stallThreshold } }, // Tool executed >24h ago
              ],
              conversationStallAlertAt: null, // Not already alerted
            },
          ],
        },
        data: {
          conversationStallAlertAt: new Date(),
          conversationStallAcknowledged: false,
        },
      });

      if (stalledResult.count > 0) {
        logger.warn(
          { checkId, stalledCount: stalledResult.count },
          'Flagged stalled conversations for admin review (activity but no tool execution)'
        );

        // Send Slack notifications for NEWLY stalled conversations only.
        // Filter by conversationStallAlertAt within the last 2 minutes to avoid
        // re-notifying previously flagged (but unacknowledged) appointments on
        // every hourly stale-check cycle.
        const recentStallCutoff = new Date(Date.now() - 2 * 60 * 1000);
        const stalledAppointments = await prisma.appointmentRequest.findMany({
          where: {
            OR: activeStatusFilter,
            conversationStallAlertAt: { gte: recentStallCutoff },
            conversationStallAcknowledged: false,
          },
          select: {
            id: true,
            userName: true,
            therapistName: true,
            lastActivityAt: true,
            lastToolExecutedAt: true,
            lastToolFailureReason: true,
          },
          take: 50,
        });

        for (const apt of stalledAppointments) {
          const stallHours = apt.lastToolExecutedAt
            ? Math.round((Date.now() - apt.lastToolExecutedAt.getTime()) / (60 * 60 * 1000))
            : Math.round((Date.now() - (apt.lastActivityAt?.getTime() || Date.now())) / (60 * 60 * 1000));

          await slackNotificationService.notifyConversationStall({
            appointmentId: apt.id,
            therapistName: apt.therapistName,
            stallDurationHours: stallHours,
            lastToolFailure: apt.lastToolFailureReason || undefined,
          });

          // Log stale_flagged audit event for stalled conversation
          auditEventService.log(apt.id, 'stale_flagged', 'system', {
            reason: `Conversation stalled - activity but no tool execution for ${stallHours}h`,
          });
        }
      }

      // Also clear stall alerts if tool was recently executed
      const clearedStallResult = await prisma.appointmentRequest.updateMany({
        where: {
          OR: activeStatusFilter,
          lastToolExecutedAt: { gte: stallThreshold }, // Tool executed recently
          conversationStallAlertAt: { not: null }, // Has an alert
          conversationStallAcknowledged: false, // Not yet acknowledged
        },
        data: {
          conversationStallAlertAt: null, // Clear the alert - conversation is progressing
        },
      });

      if (clearedStallResult.count > 0) {
        logger.info(
          { checkId, clearedStallAlerts: clearedStallResult.count },
          'Cleared stall alerts for conversations that are now progressing'
        );
      }

      // NOTE: Missed reply recovery is handled by missedMessageScannerService (hourly,
      // all active statuses, no batch limit). The previous recoverMissedReplies() here
      // was redundant — same function, same cadence, but limited to contacted/negotiating
      // with take:10. Removed to avoid duplicate Gmail API calls.

      // Periodic WAL recovery: sync any emails buffered in Redis during DB downtime.
      // WAL entries expire after 24h, so hourly recovery prevents silent email loss
      // if the server didn't restart after the DB recovered.
      try {
        const walRecovered = await emailQueueService.recoverFromWAL();
        if (walRecovered > 0) {
          logger.info(
            { checkId, walRecovered },
            'Recovered emails from write-ahead log during periodic check'
          );
        }
      } catch (walErr) {
        logger.warn({ checkId, error: walErr }, 'Periodic WAL recovery failed (non-critical)');
      }

      // Reschedule-overdue watchdog: surface appointments stranded mid-
      // reschedule whose abandoned slot has passed. Inactivity staleness
      // can't catch these — any new email resets the clock while the row
      // stays invisible to the lifecycle tick (no confirmed datetime).
      const rescheduleOverdueCount = await this.checkOverdueReschedules(checkId);
      if (rescheduleOverdueCount > 0) {
        logger.warn(
          { checkId, rescheduleOverdueCount },
          'Flagged overdue reschedules whose previous session date has passed'
        );
      }

      // Edge Case #7: Auto-escalation to human control
      // Automatically escalate conversations that have been stalled for too long
      const autoEscalatedCount = await this.autoEscalateStalled(checkId);
      if (autoEscalatedCount > 0) {
        logger.warn(
          { checkId, autoEscalatedCount },
          'Auto-escalated stalled conversations to human control'
        );
      }

      // Chase follow-up: send one follow-up email to non-responding party
      const chaseEnabled = await getSettingValue<boolean>('chase.enabled');
      if (chaseEnabled) {
        const chasedCount = await chaseEmailService.sendChaseFollowUps(checkId);
        if (chasedCount > 0) {
          logger.info(
            { checkId, chasedCount },
            'Sent chase follow-up emails to non-responding parties'
          );
        }

        // Closure recommendation: recommend admin close threads where chase went unanswered
        const closureCount = await chaseEmailService.recommendClosures(checkId);
        if (closureCount > 0) {
          logger.info(
            { checkId, closureCount },
            'Recommended closures for unresponsive threads'
          );
        }

        // Auto-cancel unresponsive PRE-BOOKING threads whose closure
        // recommendation went un-actioned past the closure window. Under the
        // target-availability model a therapist is hidden while any active
        // appointment exists, so a ghosted pre-booking would otherwise hide
        // them from the finder indefinitely. Cancelling frees the therapist.
        const autoCancelPreBooking = await getSettingValue<boolean>('chase.autoCancelStalledPreBooking');
        if (autoCancelPreBooking) {
          const autoCancelledCount = await chaseEmailService.autoCancelStalledPreBooking(checkId);
          if (autoCancelledCount > 0) {
            logger.info(
              { checkId, autoCancelledCount },
              'Auto-cancelled unresponsive pre-booking appointments (freed therapists)'
            );
          }
        }
      }

      // Auto-complete feedback_requested dead-ends (separate from chase enabled toggle)
      let feedbackCompleted = 0;
      const autoCompleteFeedback = await getSettingValue<boolean>('chase.autoCompleteFeedback');
      if (autoCompleteFeedback) {
        feedbackCompleted = await chaseEmailService.autoCompleteFeedbackDeadEnds(checkId);
      } else {
        logger.debug({ checkId }, 'Feedback auto-completion disabled - skipping');
      }
      if (feedbackCompleted > 0) {
        logger.info(
          { checkId, feedbackCompleted },
          'Auto-completed feedback_requested appointments with no response'
        );
      }
    } catch (error) {
      logger.error({ checkId, error }, 'Failed to run stale check');
    }
  }

  /**
   * Reschedule-overdue watchdog.
   *
   * Entering a reschedule clears `confirmedDateTime(Parsed)`, which removes
   * the appointment from the lifecycle tick's confirmed → session_held
   * query. If the reschedule never finalises, the row sits in
   * `confirmed` + reschedulingInProgress forever: no session_held, no
   * feedback form, no completion — and generic inactivity staleness misses
   * it whenever the conversation keeps receiving email. This sweep alerts
   * admins once per stuck reschedule, when the ABANDONED slot
   * (`previousConfirmedDateTime`) is comfortably in the past: at that point
   * either the session happened off the books (status needs a manual fix)
   * or the client silently lost their booking. `rescheduleOverdueAlertAt`
   * is the once-only sentinel; it's cleared with the rest of the
   * rescheduling state when a reschedule resolves.
   */
  private async checkOverdueReschedules(checkId: string): Promise<number> {
    const now = Date.now();

    const candidates = await prisma.appointmentRequest.findMany({
      where: {
        status: 'confirmed',
        reschedulingInProgress: true,
        rescheduleOverdueAlertAt: null,
      },
      select: {
        id: true,
        therapistName: true,
        previousConfirmedDateTime: true,
        reschedulingInitiatedBy: true,
      },
      take: 50,
    });

    if (candidates.length === 0) return 0;

    let alerted = 0;

    for (const apt of candidates) {
      // The abandoned slot is stored as the raw display string; parse it
      // with forwardDate: false — it describes a slot booked in the past,
      // and the parser's default forward bias would resolve year-less
      // strings to the future, so the alert would never fire.
      if (!apt.previousConfirmedDateTime) continue;
      const previousSlot = parseConfirmedDateTime(
        apt.previousConfirmedDateTime,
        new Date(),
        { forwardDate: false },
      );
      if (!previousSlot) {
        logger.debug(
          { checkId, appointmentId: apt.id, previousConfirmedDateTime: apt.previousConfirmedDateTime },
          'Reschedule-overdue check: previous slot not parseable - skipping'
        );
        continue;
      }
      if (now - previousSlot.getTime() <= RESCHEDULE_OVERDUE_GRACE_MS) continue;

      try {
        // Preconditions re-checked in the write so a reschedule that
        // resolved (or a concurrent sweep) between the candidate query and
        // here doesn't get a spurious alert — count 0 means we lost the
        // race and stay silent.
        const stamped = await prisma.appointmentRequest.updateMany({
          where: {
            id: apt.id,
            status: 'confirmed',
            reschedulingInProgress: true,
            rescheduleOverdueAlertAt: null,
          },
          data: { rescheduleOverdueAlertAt: new Date() },
        });
        if (stamped.count === 0) continue;

        alerted++;

        auditEventService.log(apt.id, 'reschedule_overdue', 'system', {
          previousConfirmedDateTime: apt.previousConfirmedDateTime,
          reschedulingInitiatedBy: apt.reschedulingInitiatedBy,
          note:
            'Reschedule was initiated but never finalised, and the previously booked session time has passed. ' +
            'Confirm whether the session took place; the appointment cannot reach session_held/feedback until a new date is set.',
        });

        await slackNotificationService.notifyRescheduleOverdue({
          appointmentId: apt.id,
          therapistName: apt.therapistName,
          previousConfirmedDateTime: apt.previousConfirmedDateTime,
        });
      } catch (error) {
        logger.error(
          { checkId, appointmentId: apt.id, error },
          'Failed to flag overdue reschedule'
        );
      }
    }

    return alerted;
  }

  /**
   * Auto-escalate stalled conversations to human control
   * If a conversation has been stalled (no tool execution) for too long,
   * automatically enable human control so admin can intervene.
   * Uses the stall detection threshold setting.
   */
  private async autoEscalateStalled(checkId: string): Promise<number> {
    // Use stall detection threshold for escalation (same setting, simple model)
    const stallHours = await getSettingValue<number>('notifications.stallDetectionHours');
    // Auto-escalate after 3x the stall detection threshold
    const escalationThreshold = new Date(Date.now() - (stallHours * 3) * 60 * 60 * 1000);

    // Find conversations that:
    // - Have an active stall alert older than the escalation threshold
    // - Are not already under human control
    // - Have not been auto-escalated before
    const candidates = await prisma.appointmentRequest.findMany({
      where: {
        OR: [
          { status: { in: [...PRE_BOOKING_STATUSES] } },
          { status: 'confirmed' as const, reschedulingInProgress: true },
        ],
        conversationStallAlertAt: {
          not: null,
          lt: escalationThreshold, // Stall alert is older than threshold
        },
        humanControlEnabled: false,
        autoEscalatedAt: null, // Not previously auto-escalated
      },
      select: {
        id: true,
        userName: true,
        userEmail: true,
        therapistName: true,
        conversationStallAlertAt: true,
      },
      take: 50, // Process in batches
    });

    if (candidates.length === 0) {
      return 0;
    }

    // Batch update all candidates in a single query instead of N individual updates.
    // The `humanControlEnabled: false` precondition closes the race where the agent
    // flipped the row to human control between our candidate query above and the
    // update — without it, we'd auto-escalate a row that's already under agent-
    // initiated review, double-writing audit + Slack alert for the same root cause.
    const now = new Date();
    const candidateIds = candidates.map(c => c.id);

    try {
      const batchResult = await prisma.appointmentRequest.updateMany({
        where: {
          id: { in: candidateIds },
          humanControlEnabled: false,
          autoEscalatedAt: null,
        },
        data: {
          humanControlEnabled: true,
          humanControlTakenBy: 'system-auto-escalation',
          humanControlTakenAt: now,
          autoEscalatedAt: now,
        },
      });

      // Resolve which rows actually flipped. In the common case (no race), every
      // candidate flipped and we audit/alert for all of them. In the rare case
      // where batchResult.count < candidates.length, the agent (or another path)
      // beat us on some rows; we re-query for `autoEscalatedAt: now` to identify
      // exactly which rows we own and skip the rest — preventing the duplicate-
      // alert noise the operability audit flagged.
      let flippedAppointments = candidates;
      if (batchResult.count < candidates.length) {
        const flippedRows = await prisma.appointmentRequest.findMany({
          where: { id: { in: candidateIds }, autoEscalatedAt: now },
          select: { id: true },
        });
        const flippedIds = new Set(flippedRows.map((r) => r.id));
        flippedAppointments = candidates.filter((c) => flippedIds.has(c.id));
        logger.info(
          {
            checkId,
            queried: candidates.length,
            flipped: flippedAppointments.length,
            raced: candidates.length - flippedAppointments.length,
          },
          'Auto-escalation race-loss: some rows were already under human control before the update landed',
        );
      }

      // Log human_control audit events ONLY for rows we actually flipped.
      for (const appointment of flippedAppointments) {
        auditEventService.log(appointment.id, 'human_control', 'system', {
          enabled: true,
          reason: 'Auto-escalated: stalled conversation with no tool execution progress',
        });
      }

      // Send Slack notifications concurrently (fire-and-forget with error isolation).
      // Same flippedAppointments restriction — don't alert on rows where another
      // path won the race.
      const notificationPromises = flippedAppointments.map(async (appointment) => {
        try {
          const aptStallHours = Math.round(
            (Date.now() - (appointment.conversationStallAlertAt?.getTime() || 0)) / (60 * 60 * 1000)
          );

          logger.warn(
            {
              checkId,
              appointmentId: appointment.id,
              userName: appointment.userName,
              therapistName: appointment.therapistName,
              stallHours: aptStallHours,
            },
            'Auto-escalated stalled conversation to human control'
          );

          await slackNotificationService.notifyAutoEscalation({
            appointmentId: appointment.id,
            therapistName: appointment.therapistName,
            stallDurationHours: aptStallHours,
          });
        } catch (error) {
          logger.error(
            { checkId, appointmentId: appointment.id, error },
            'Failed to send auto-escalation Slack notification'
          );
        }
      });

      await Promise.all(notificationPromises);
      // Return the count we actually flipped (matches batchResult.count in the
      // common case; smaller if we lost the race on some rows).
      return flippedAppointments.length;
    } catch (error) {
      logger.error({ checkId, error }, 'Failed to batch auto-escalate appointments');
      return 0;
    }
  }

  /**
   * Recover missed replies from threads.
   *
   * When a conversation is in 'contacted' or 'negotiating' status,
   * the therapist (or client) may have replied but the reply was missed due to:
   * - Lost push notification (server restart, network issue)
   * - Reply arriving after the polling window expired
   * - Email marked as read in Gmail (by admin, mobile notification, etc.)
   *   before the polling service could detect it as unread
   *
   * This method checks the Gmail threads associated with waiting appointments
   * for any messages that were never processed by the application.
   *
   * Unlike the polling fallback (which relies on is:unread and newer_than:3d),
   * this method cross-references thread messages against the processedGmailMessage
   * database table — the authoritative source of truth for processing state.
   * This means it can recover emails that were read in Gmail but never processed.
   *
   * Recovery runs on two tiers:
   * - Tier 1: Appointments inactive for 1+ hour (quick recovery for missed push notifications)
   * - Tier 2: Stale appointments (48h+ inactive, already flagged by the isStale check)
   */
  // recoverMissedReplies removed — now handled by missedMessageScannerService
  // (hourly, all active statuses, no batch limit, with Slack alerting)

  /**
   * Update lastActivityAt for an appointment (call when email sent/received)
   */
  async recordActivity(appointmentRequestId: string): Promise<void> {
    try {
      await prisma.appointmentRequest.update({
        where: { id: appointmentRequestId },
        data: {
          lastActivityAt: new Date(),
          isStale: false, // Reset stale flag on activity
        },
        select: { id: true },
      });
    } catch (error) {
      logger.warn({ error, appointmentRequestId }, 'Failed to record activity for appointment');
    }
  }
}

export const staleCheckService = new StaleCheckService();

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { slackNotificationService } from './slack-notification.service';
import { emailProcessingService } from './email-processing.service';
import { emailQueueService } from './email-queue.service';
import { STALE_THRESHOLDS, STALL_DETECTION, DATA_RETENTION, STALE_CHECK_LOCK, RETENTION_CLEANUP_LOCK, INACTIVITY_THRESHOLDS, CHASE_FOLLOWUP } from '../constants';
import { getSettingValue } from './settings.service';
import { getEmailSubject, getEmailBody } from '../utils/email-templates';
import { appointmentLifecycleService } from './appointment-lifecycle.service';

// Convert hours to milliseconds (used for isStale flag - visual indicator only)
const STALE_THRESHOLD_MS = STALE_THRESHOLDS.MARK_STALE_HOURS * 60 * 60 * 1000;

// Check interval: every hour
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Data retention cleanup interval: every 24 hours
const RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

class StaleCheckService {
  private intervalId: NodeJS.Timeout | null = null;
  private retentionIntervalId: NodeJS.Timeout | null = null;
  private startupTimeoutId: NodeJS.Timeout | null = null;
  private instanceId: string;
  private staleCheckRunner: LockedTaskRunner;
  private retentionRunner: LockedTaskRunner;

  constructor() {
    this.instanceId = `${process.pid}-${Date.now().toString(36)}-stale`;

    this.staleCheckRunner = new LockedTaskRunner({
      lockKey: STALE_CHECK_LOCK.KEY,
      lockTtlSeconds: STALE_CHECK_LOCK.TTL_SECONDS,
      renewalIntervalMs: STALE_CHECK_LOCK.RENEWAL_INTERVAL_MS,
      instanceId: this.instanceId,
      context: 'stale-check',
    });

    this.retentionRunner = new LockedTaskRunner({
      lockKey: RETENTION_CLEANUP_LOCK.KEY,
      lockTtlSeconds: RETENTION_CLEANUP_LOCK.TTL_SECONDS,
      renewalIntervalMs: RETENTION_CLEANUP_LOCK.RENEWAL_INTERVAL_MS,
      instanceId: this.instanceId,
      context: 'retention-cleanup',
    });
  }

  /**
   * Start the periodic stale check job and data retention cleanup
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Stale check service already running');
      return;
    }

    logger.info('Starting stale check service (runs every hour)');

    // Run immediately on startup
    this.runSafeCheck();

    // Then run every hour
    this.intervalId = setInterval(() => {
      this.runSafeCheck();
    }, CHECK_INTERVAL_MS);

    // Start data retention cleanup (runs daily)
    logger.info('Starting data retention cleanup (runs every 24 hours)');

    // Run retention cleanup after 5 minutes (don't run immediately on startup)
    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null;
      this.runSafeRetentionCleanup();
    }, 5 * 60 * 1000);

    this.retentionIntervalId = setInterval(() => {
      this.runSafeRetentionCleanup();
    }, RETENTION_CHECK_INTERVAL_MS);
  }

  /**
   * Safe wrapper for checkAndMarkStale using LockedTaskRunner.
   */
  private async runSafeCheck(): Promise<void> {
    const startTime = Date.now();

    const taskResult = await this.staleCheckRunner.run(async () => {
      await this.checkAndMarkStale();
    });

    if (!taskResult.acquired) {
      logger.debug('Stale check lock held by another instance - skipping');
      return;
    }

    if (taskResult.error) {
      logger.error({ error: taskResult.error }, 'Unhandled error in stale check - will retry next interval');
    }

    const durationMs = Date.now() - startTime;
    if (durationMs > 60000) {
      logger.warn({ durationMs }, 'Stale check took longer than expected');
    }
  }

  /**
   * Stop the periodic stale check job and retention cleanup
   */
  stop(): void {
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId);
      this.startupTimeoutId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.retentionIntervalId) {
      clearInterval(this.retentionIntervalId);
      this.retentionIntervalId = null;
    }
    logger.info('Stale check service stopped');
  }

  /**
   * Get service status (for health checks)
   */
  getStatus(): {
    running: boolean;
  } {
    return {
      running: this.intervalId !== null,
    };
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
            status: { in: ['confirmed', 'completed', 'session_held', 'feedback_requested'] },
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

      // 6. Log orphaned appointments (missing User/Therapist links) for visibility
      const orphanedCount = await prisma.appointmentRequest.count({
        where: {
          OR: [
            { userId: null },
            { therapistId: null },
          ],
          status: { notIn: ['cancelled', 'completed'] },
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
      const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

      // Find conversations that should be marked stale:
      // - lastActivityAt > 48 hours ago
      // - status is active (not confirmed/cancelled)
      // - not already marked stale
      // Note: lastActivityAt is non-nullable with @default(now()), so null check is unnecessary
      const result = await prisma.appointmentRequest.updateMany({
        where: {
          lastActivityAt: { lt: staleThreshold },
          status: { in: ['pending', 'contacted', 'negotiating'] },
          isStale: false,
        },
        data: {
          isStale: true,
        },
      });

      if (result.count > 0) {
        logger.info({ checkId, markedStale: result.count }, 'Marked conversations as stale');
      }

      // Also unmark stale if activity has resumed
      // (in case lastActivityAt was updated but isStale wasn't reset)
      // Only for active appointments - don't touch cancelled/confirmed
      const unmarkedResult = await prisma.appointmentRequest.updateMany({
        where: {
          lastActivityAt: { gte: staleThreshold },
          status: { in: ['pending', 'contacted', 'negotiating'] },
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
          status: { in: ['pending', 'contacted', 'negotiating'] },
          lastActivityAt: { gte: stallThreshold }, // Has recent activity
          OR: [
            { lastToolExecutedAt: null }, // Never executed a tool
            { lastToolExecutedAt: { lt: stallThreshold } }, // Tool executed >24h ago
          ],
          conversationStallAlertAt: null, // Not already alerted
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
            status: { in: ['pending', 'contacted', 'negotiating'] },
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

          await slackNotificationService.notifyConversationStall(
            apt.id,
            apt.userName,
            apt.therapistName,
            stallHours,
            apt.lastToolFailureReason || undefined
          );
        }
      }

      // Also clear stall alerts if tool was recently executed
      const clearedStallResult = await prisma.appointmentRequest.updateMany({
        where: {
          status: { in: ['pending', 'contacted', 'negotiating'] },
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

      // Stale thread recovery: check for missed therapist replies
      // When a conversation is stale and in 'contacted' status with a therapist thread ID,
      // the therapist may have replied but the reply was missed (push notification lost,
      // poll window expired). Check these threads directly for unread messages.
      const recoveredCount = await this.recoverMissedReplies(checkId);
      if (recoveredCount > 0) {
        logger.info(
          { checkId, recoveredCount },
          'Recovered missed replies from stale threads'
        );
      }

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
        const chasedCount = await this.sendChaseFollowUps(checkId);
        if (chasedCount > 0) {
          logger.info(
            { checkId, chasedCount },
            'Sent chase follow-up emails to non-responding parties'
          );
        }

        // Closure recommendation: recommend admin close threads where chase went unanswered
        const closureCount = await this.recommendClosures(checkId);
        if (closureCount > 0) {
          logger.info(
            { checkId, closureCount },
            'Recommended closures for unresponsive threads'
          );
        }
      }

      // Auto-complete feedback_requested dead-ends (separate from chase enabled toggle)
      let feedbackCompleted = 0;
      const autoCompleteFeedback = await getSettingValue<boolean>('chase.autoCompleteFeedback');
      if (autoCompleteFeedback) {
        feedbackCompleted = await this.autoCompleteFeedbackDeadEnds(checkId);
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
        status: { in: ['pending', 'contacted', 'negotiating'] },
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

    // Batch update all candidates in a single query instead of N individual updates
    const now = new Date();
    const candidateIds = candidates.map(c => c.id);

    try {
      const batchResult = await prisma.appointmentRequest.updateMany({
        where: { id: { in: candidateIds } },
        data: {
          humanControlEnabled: true,
          humanControlTakenBy: 'system-auto-escalation',
          humanControlTakenAt: now,
          autoEscalatedAt: now,
        },
      });

      // Send Slack notifications concurrently (fire-and-forget with error isolation)
      const notificationPromises = candidates.map(async (appointment) => {
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

          await slackNotificationService.notifyAutoEscalation(
            appointment.id,
            appointment.userName,
            appointment.therapistName,
            aptStallHours
          );
        } catch (error) {
          logger.error(
            { checkId, appointmentId: appointment.id, error },
            'Failed to send auto-escalation Slack notification'
          );
        }
      });

      await Promise.all(notificationPromises);
      return batchResult.count;
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
  private async recoverMissedReplies(checkId: string): Promise<number> {
    try {
      // Recovery threshold: check appointments with no activity for 1+ hour.
      // This catches missed push notifications much faster than the 48h stale flag.
      // The processedGmailMessage DB check in checkThreadForUnprocessedReplies
      // ensures we don't reprocess already-handled messages, so running this
      // more frequently is safe (at worst it makes a few extra Gmail API calls).
      const replyRecoveryThreshold = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1 hour

      // Find appointments awaiting replies that have a thread ID to check.
      // Includes both stale (48h+) and recently-inactive (1h+) appointments.
      const awaitingReply = await prisma.appointmentRequest.findMany({
        where: {
          status: { in: ['contacted', 'negotiating'] },
          therapistGmailThreadId: { not: null },
          humanControlEnabled: false, // Don't interfere with human-controlled appointments
          lastActivityAt: { lt: replyRecoveryThreshold }, // No activity for 1+ hour
        },
        select: {
          id: true,
          therapistGmailThreadId: true,
          gmailThreadId: true,
          therapistName: true,
          userName: true,
        },
        take: 10, // Limit batch size to avoid Gmail rate limits
      });

      if (awaitingReply.length === 0) {
        return 0;
      }

      logger.info(
        { checkId, count: awaitingReply.length },
        'Checking threads for missed replies (1h+ inactive appointments)'
      );

      let totalRecovered = 0;

      for (const appointment of awaitingReply) {
        try {
          // Check the therapist thread for unprocessed messages
          if (appointment.therapistGmailThreadId) {
            const recovered = await emailProcessingService.checkThreadForUnprocessedReplies(
              appointment.therapistGmailThreadId,
              `${checkId}:stale-recovery:${appointment.id}`
            );
            if (recovered > 0) {
              logger.info(
                {
                  checkId,
                  appointmentId: appointment.id,
                  threadId: appointment.therapistGmailThreadId,
                  recoveredCount: recovered,
                  therapistName: appointment.therapistName,
                  userName: appointment.userName,
                },
                'Recovered missed therapist reply from stale thread'
              );
              totalRecovered += recovered;
            }
          }

          // Also check the client thread in case a client reply was missed
          if (appointment.gmailThreadId) {
            const recovered = await emailProcessingService.checkThreadForUnprocessedReplies(
              appointment.gmailThreadId,
              `${checkId}:stale-recovery:${appointment.id}`
            );
            if (recovered > 0) {
              logger.info(
                {
                  checkId,
                  appointmentId: appointment.id,
                  threadId: appointment.gmailThreadId,
                  recoveredCount: recovered,
                  userName: appointment.userName,
                },
                'Recovered missed client reply from stale thread'
              );
              totalRecovered += recovered;
            }
          }
        } catch (error) {
          logger.warn(
            { checkId, appointmentId: appointment.id, error },
            'Failed to check stale thread for missed replies - will retry next cycle'
          );
        }
      }

      return totalRecovered;
    } catch (error) {
      logger.error({ checkId, error }, 'Failed to run stale thread recovery');
      return 0;
    }
  }

  /**
   * Send chase follow-up emails to the non-responding party.
   *
   * When a conversation has been stale for a configurable period (default 72h),
   * and no chase has been sent yet, determine who hasn't responded and send
   * them a single follow-up email. The checkpoint stage tells us who we're
   * waiting for:
   *
   * - awaiting_therapist_availability / awaiting_therapist_confirmation / awaiting_meeting_link → chase therapist
   * - awaiting_user_slot_selection → chase user
   * - initial_contact / stalled / no checkpoint → infer from conversation state or thread existence
   *
   * Only one chase is ever sent per thread. If it goes unanswered, the system
   * will later recommend closure to the admin.
   *
   * Uses the same sentinel pattern as post-booking follow-ups to prevent
   * duplicate sends on process crash: null → epoch (sending) → actual timestamp.
   */
  private async sendChaseFollowUps(checkId: string): Promise<number> {
    try {
      const chaseAfterHours = await getSettingValue<number>('chase.afterStaleHours');
      const chaseThreshold = new Date(Date.now() - chaseAfterHours * 60 * 60 * 1000);

      // Clean up stuck sentinels from crashed processes (>2 min old)
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      const stuckReset = await prisma.appointmentRequest.updateMany({
        where: {
          chaseSentAt: new Date(0),
          updatedAt: { lt: twoMinutesAgo },
        },
        data: { chaseSentAt: null },
      });
      if (stuckReset.count > 0) {
        logger.warn({ checkId, resetCount: stuckReset.count }, 'Reset stuck chase sentinels');
      }

      // Find stale conversations that haven't been chased yet
      const candidates = await prisma.appointmentRequest.findMany({
        where: {
          status: { in: ['pending', 'contacted', 'negotiating'] },
          lastActivityAt: { lt: chaseThreshold },
          chaseSentAt: null, // Never chased (and not currently being sent)
          humanControlEnabled: false, // Don't chase while under human control
          closureRecommendedAt: null, // Not already recommended for closure
        },
        select: {
          id: true,
          userName: true,
          userEmail: true,
          therapistName: true,
          therapistEmail: true,
          checkpointStage: true,
          gmailThreadId: true,
          therapistGmailThreadId: true,
          lastActivityAt: true,
          conversationState: true,
        },
        take: CHASE_FOLLOWUP.MAX_CHASE_BATCH_SIZE,
      });

      if (candidates.length === 0) {
        return 0;
      }

      let chasedCount = 0;

      for (const appointment of candidates) {
        try {
          // Determine who to chase based on checkpoint stage
          const chaseTarget = this.determineChaseTarget(appointment);
          if (!chaseTarget) {
            logger.debug(
              { checkId, appointmentId: appointment.id },
              'Cannot determine chase target - skipping'
            );
            continue;
          }

          const { target, email, threadId } = chaseTarget;

          // OPTIMISTIC LOCKING: claim this appointment with a sentinel
          const lockResult = await prisma.appointmentRequest.updateMany({
            where: {
              id: appointment.id,
              chaseSentAt: null, // Only if still unclaimed
            },
            data: {
              chaseSentAt: new Date(0), // Sentinel: epoch = "sending"
            },
          });

          if (lockResult.count === 0) {
            // Another process claimed it
            continue;
          }

          try {
            const therapistFirstName = (appointment.therapistName || 'there').split(' ')[0];
            const clientFirstName = (appointment.userName || 'the client').split(' ')[0];

            // Build the chase email using templates
            let subject: string;
            let body: string;

            if (target === 'user') {
              subject = await getEmailSubject('chaseUser', {
                therapistName: appointment.therapistName,
              });
              body = await getEmailBody('chaseUser', {
                userName: appointment.userName || 'there',
                therapistName: appointment.therapistName,
              });
            } else {
              subject = await getEmailSubject('chaseTherapist', {
                clientFirstName,
              });
              body = await getEmailBody('chaseTherapist', {
                therapistFirstName,
                clientFirstName,
              });
            }

            // Send the chase email on the existing thread
            await emailProcessingService.sendEmail({
              to: email,
              subject,
              body,
              threadId: threadId || undefined,
            });

            const now = new Date();

            // Atomic update: verify sentinel still ours, then record chase
            const updateResult = await prisma.appointmentRequest.updateMany({
              where: {
                id: appointment.id,
                chaseSentAt: new Date(0), // Must still be our sentinel
              },
              data: {
                chaseSentAt: now,
                chaseSentTo: target,
                chaseTargetEmail: email,
                checkpointStage: 'chased',
                lastActivityAt: now,
                isStale: false,
              },
            });

            if (updateResult.count === 0) {
              logger.error(
                { checkId, appointmentId: appointment.id },
                'ALERT: Chase email sent but sentinel update failed - possible duplicate'
              );
            } else {
              // Send Slack notification
              await slackNotificationService.notifyChaseFollowUp(
                appointment.id,
                appointment.userName,
                appointment.therapistName,
                target,
                Math.round((Date.now() - appointment.lastActivityAt.getTime()) / (60 * 60 * 1000))
              );

              logger.info(
                {
                  checkId,
                  appointmentId: appointment.id,
                  target,
                  email,
                  userName: appointment.userName,
                  therapistName: appointment.therapistName,
                },
                `Sent chase follow-up email to ${target}`
              );

              chasedCount++;
            }
          } catch (error) {
            // On failure, reset sentinel to null so it can be retried
            await prisma.appointmentRequest.update({
              where: { id: appointment.id },
              data: { chaseSentAt: null },
              select: { id: true },
            });

            logger.error(
              { checkId, appointmentId: appointment.id, error },
              'Failed to send chase follow-up email - will retry next cycle'
            );
          }
        } catch (error) {
          logger.error(
            { checkId, appointmentId: appointment.id, error },
            'Failed to process chase follow-up for appointment'
          );
        }
      }

      return chasedCount;
    } catch (error) {
      logger.error({ checkId, error }, 'Failed to run chase follow-ups');
      return 0;
    }
  }

  /**
   * Determine who to chase based on the conversation's checkpoint stage.
   * Returns the target ('user' or 'therapist'), their email, and the thread ID
   * to reply on.
   */
  private determineChaseTarget(appointment: {
    checkpointStage: string | null;
    userEmail: string;
    therapistEmail: string;
    gmailThreadId: string | null;
    therapistGmailThreadId: string | null;
    conversationState: unknown;
  }): { target: 'user' | 'therapist'; email: string; threadId: string | null } | null {
    const stage = appointment.checkpointStage;

    // Stages where we're waiting on the therapist
    if (
      stage === 'awaiting_therapist_availability' ||
      stage === 'awaiting_therapist_confirmation' ||
      stage === 'awaiting_meeting_link' // Therapist needs to send the meeting link
    ) {
      return {
        target: 'therapist',
        email: appointment.therapistEmail,
        threadId: appointment.therapistGmailThreadId,
      };
    }

    // Stages where we're waiting on the user
    if (stage === 'awaiting_user_slot_selection') {
      return {
        target: 'user',
        email: appointment.userEmail,
        threadId: appointment.gmailThreadId,
      };
    }

    // For initial_contact, stalled, or no checkpoint, infer from context
    if (stage === 'initial_contact' || stage === 'stalled' || !stage) {
      // Check the conversation state for who was last emailed
      const state = appointment.conversationState as { checkpoint?: { context?: { lastEmailSentTo?: string } } } | null;
      const lastEmailTo = state?.checkpoint?.context?.lastEmailSentTo;

      if (lastEmailTo === 'therapist') {
        return {
          target: 'therapist',
          email: appointment.therapistEmail,
          threadId: appointment.therapistGmailThreadId,
        };
      }

      if (lastEmailTo === 'user') {
        return {
          target: 'user',
          email: appointment.userEmail,
          threadId: appointment.gmailThreadId,
        };
      }

      // Default: if therapist thread exists but conversation didn't progress, chase therapist
      if (appointment.therapistGmailThreadId) {
        return {
          target: 'therapist',
          email: appointment.therapistEmail,
          threadId: appointment.therapistGmailThreadId,
        };
      }

      // If only user thread, chase user
      if (appointment.gmailThreadId) {
        return {
          target: 'user',
          email: appointment.userEmail,
          threadId: appointment.gmailThreadId,
        };
      }
    }

    // Cannot determine target (e.g., rescheduling, confirmed, or no threads)
    return null;
  }

  /**
   * Recommend closure for threads where the chase follow-up went unanswered.
   *
   * After a configurable period (default 48h) following a chase email with no
   * response, the system flags the thread for admin review with a recommendation
   * to cancel/close. The admin can then action or dismiss the recommendation.
   *
   * This ensures every conversation has a path to conclusion rather than
   * lingering indefinitely in an active state.
   */
  private async recommendClosures(checkId: string): Promise<number> {
    try {
      const closureHours = await getSettingValue<number>('chase.closureRecommendationHours');
      const closureThreshold = new Date(Date.now() - closureHours * 60 * 60 * 1000);

      // Find conversations where chase was sent but no response received
      const candidates = await prisma.appointmentRequest.findMany({
        where: {
          status: { in: ['pending', 'contacted', 'negotiating'] },
          chaseSentAt: {
            gt: new Date(0), // Exclude null and sentinels (in-flight sends)
            lt: closureThreshold, // Chase sent > threshold ago
          },
          closureRecommendedAt: null, // Not already recommended
          // Ensure no activity since the chase was sent (no response received)
          lastActivityAt: { lt: closureThreshold },
        },
        select: {
          id: true,
          userName: true,
          userEmail: true,
          therapistName: true,
          chaseSentTo: true,
          chaseSentAt: true,
          lastActivityAt: true,
          status: true,
        },
        take: CHASE_FOLLOWUP.MAX_CLOSURE_BATCH_SIZE,
      });

      if (candidates.length === 0) {
        return 0;
      }

      let closureCount = 0;

      for (const appointment of candidates) {
        try {
          const inactiveHours = Math.round(
            (Date.now() - appointment.lastActivityAt.getTime()) / (60 * 60 * 1000)
          );
          const chasedParty = appointment.chaseSentTo === 'therapist'
            ? appointment.therapistName
            : (appointment.userName || appointment.userEmail);

          const reason = `No response from ${appointment.chaseSentTo} (${chasedParty}) after chase follow-up sent ${Math.round(
            (Date.now() - (appointment.chaseSentAt?.getTime() || 0)) / (60 * 60 * 1000)
          )}h ago. Total inactivity: ${inactiveHours}h.`;

          await prisma.appointmentRequest.update({
            where: { id: appointment.id },
            data: {
              closureRecommendedAt: new Date(),
              closureRecommendedReason: reason,
              closureRecommendationActioned: false,
              checkpointStage: 'closure_recommended',
            },
            select: { id: true },
          });

          // Send Slack notification recommending closure
          await slackNotificationService.notifyClosureRecommendation(
            appointment.id,
            appointment.userName,
            appointment.therapistName,
            appointment.chaseSentTo || 'unknown',
            inactiveHours,
            reason
          );

          logger.info(
            {
              checkId,
              appointmentId: appointment.id,
              chaseSentTo: appointment.chaseSentTo,
              inactiveHours,
              userName: appointment.userName,
              therapistName: appointment.therapistName,
            },
            'Recommended closure for unresponsive thread'
          );

          closureCount++;
        } catch (error) {
          logger.error(
            { checkId, appointmentId: appointment.id, error },
            'Failed to recommend closure for appointment'
          );
        }
      }

      return closureCount;
    } catch (error) {
      logger.error({ checkId, error }, 'Failed to run closure recommendations');
      return 0;
    }
  }

  /**
   * Auto-complete feedback_requested appointments where the feedback reminder
   * went unanswered.
   *
   * After the feedback reminder is sent and a configurable period passes with
   * no feedback submission, the appointment is automatically completed. This
   * prevents feedback_requested from being a dead-end state.
   */
  private async autoCompleteFeedbackDeadEnds(checkId: string): Promise<number> {
    try {
      // Use the same delay as the chase closure recommendation (default 48h after reminder)
      const closureHours = await getSettingValue<number>('chase.closureRecommendationHours');
      const threshold = new Date(Date.now() - closureHours * 60 * 60 * 1000);

      // Find feedback_requested appointments where reminder was sent but no feedback received
      // feedbackReminderSentAt must be: not null, not epoch sentinel, and older than threshold
      const candidates = await prisma.appointmentRequest.findMany({
        where: {
          status: 'feedback_requested',
          feedbackReminderSentAt: {
            gt: new Date(0), // Excludes both null and epoch sentinel
            lt: threshold, // Reminder sent > threshold ago
          },
        },
        select: {
          id: true,
          userName: true,
          therapistName: true,
        },
        take: CHASE_FOLLOWUP.MAX_CLOSURE_BATCH_SIZE,
      });

      if (candidates.length === 0) {
        return 0;
      }

      let completedCount = 0;

      for (const appointment of candidates) {
        try {
          const result = await appointmentLifecycleService.transitionToCompleted({
            appointmentId: appointment.id,
            source: 'system',
            note: 'Auto-completed: no feedback received after reminder',
          });

          if (result.success) {
            completedCount++;
            logger.info(
              { checkId, appointmentId: appointment.id, userName: appointment.userName },
              'Auto-completed feedback_requested appointment (no feedback after reminder)'
            );
          }
        } catch (error) {
          logger.error(
            { checkId, appointmentId: appointment.id, error },
            'Failed to auto-complete feedback_requested appointment'
          );
        }
      }

      return completedCount;
    } catch (error) {
      logger.error({ checkId, error }, 'Failed to run feedback dead-end auto-completion');
      return 0;
    }
  }

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

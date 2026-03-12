import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { slackNotificationService } from './slack-notification.service';
import { emailProcessingService } from './email-processing.service';
import { emailQueueService } from './email-queue.service';
import { STALE_THRESHOLDS, DATA_RETENTION, STALE_CHECK_LOCK, RETENTION_CLEANUP_LOCK } from '../constants';
import { getSettingValue } from './settings.service';
import { chaseEmailService } from './chase-email.service';
import { auditEventService } from './audit-event.service';

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

        // Log stale_flagged audit events for each newly stale appointment
        const newlyStale = await prisma.appointmentRequest.findMany({
          where: {
            lastActivityAt: { lt: staleThreshold },
            status: { in: ['pending', 'contacted', 'negotiating'] },
            isStale: true,
          },
          select: { id: true },
        });
        for (const apt of newlyStale) {
          auditEventService.log(apt.id, 'stale_flagged', 'system', {
            reason: 'No activity for configured threshold',
          });
        }
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

          // Log stale_flagged audit event for stalled conversation
          auditEventService.log(apt.id, 'stale_flagged', 'system', {
            reason: `Conversation stalled - activity but no tool execution for ${stallHours}h`,
          });
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

      // Log human_control audit events for auto-escalated appointments
      for (const appointment of candidates) {
        auditEventService.log(appointment.id, 'human_control', 'system', {
          enabled: true,
          reason: 'Auto-escalated: stalled conversation with no tool execution progress',
        });
      }

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

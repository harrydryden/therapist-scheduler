/**
 * Appointment Lifecycle Service
 *
 * THE SINGLE SOURCE OF TRUTH for all appointment status transitions.
 *
 * This service centralizes:
 * - Status transitions (pending → contacted → negotiating → confirmed → completed/cancelled)
 * - Email notifications (client + therapist)
 * - Slack notifications
 * - Audit trail (conversation state updates)
 * - Therapist status updates
 * - User sync to Notion
 *
 * All code paths that change appointment status MUST go through this service.
 * This ensures consistent behavior regardless of trigger source (AI agent, admin, system).
 */

import { prisma } from '../utils/database';
import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import { slackNotificationService } from './slack-notification.service';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { notionSyncManager } from './notion-sync-manager.service';
import { notionService } from './notion.service';
import { emailProcessingService } from './email-processing.service';
import { APPOINTMENT_STATUS, AppointmentStatus } from '../constants';
import { getSettingValue, getSettingValues } from './settings.service';
import { getEmailSubject, getEmailBody } from '../utils/email-templates';
import { runBackgroundTask } from '../utils/background-task';

// ============================================
// Custom Errors for Lifecycle Transitions
// ============================================

export class AppointmentNotFoundError extends Error {
  constructor(appointmentId: string) {
    super(`Appointment ${appointmentId} not found`);
    this.name = 'AppointmentNotFoundError';
  }
}

export class InvalidTransitionError extends Error {
  constructor(fromStatus: string, toStatus: string) {
    super(`Invalid status transition: ${fromStatus} → ${toStatus}`);
    this.name = 'InvalidTransitionError';
  }
}

export class ConcurrentModificationError extends Error {
  constructor(appointmentId: string) {
    super(`Appointment ${appointmentId} is being modified by another process`);
    this.name = 'ConcurrentModificationError';
  }
}

// ============================================
// Types
// ============================================

export type TransitionSource = 'agent' | 'admin' | 'system' | 'feedback_sync';

export interface BaseTransitionParams {
  appointmentId: string;
  /** Source of the transition for audit logging */
  source: TransitionSource;
  /** Admin ID if source is 'admin' */
  adminId?: string;
  /** Optional reason for the transition */
  reason?: string;
}

export interface TransitionToContactedParams extends BaseTransitionParams {
  /** Whether therapist availability is known */
  hasAvailability: boolean;
}

export interface TransitionToNegotiatingParams extends BaseTransitionParams {
  /** Optional notes about the negotiation */
  notes?: string;
}

export interface TransitionToConfirmedParams extends BaseTransitionParams {
  confirmedDateTime: string;
  confirmedDateTimeParsed?: Date | null;
  /** Optional notes to append */
  notes?: string;
  /** Whether to send emails (defaults to true) */
  sendEmails?: boolean;
  /**
   * Atomic confirmation options for preventing race conditions.
   * When provided, uses updateMany with status precondition to ensure
   * only one concurrent confirmation succeeds.
   */
  atomic?: {
    /** Required statuses - update only succeeds if current status matches */
    requireStatuses: AppointmentStatus[];
    /** Also require humanControlEnabled to be false */
    requireHumanControlDisabled?: boolean;
  };
  /**
   * Reschedule options - extra fields to update when rescheduling
   */
  reschedule?: {
    /** Previous confirmed datetime to store */
    previousConfirmedDateTime?: string;
    /** Reset follow-up flags when rescheduling */
    resetFollowUpFlags?: boolean;
  };
}

export interface TransitionToCompletedParams extends BaseTransitionParams {
  /** Optional note to prepend to existing notes */
  note?: string;
  /** Optional feedback submission ID - used to include a link in Slack notification */
  feedbackSubmissionId?: string;
  /** Optional formatted feedback responses - displayed in Slack notification */
  feedbackData?: Record<string, string>;
}

export interface TransitionToCancelledParams extends BaseTransitionParams {
  reason: string;
  cancelledBy: 'client' | 'therapist' | 'admin' | 'system';
  /**
   * Atomic cancellation options for preventing race conditions.
   * When provided, uses updateMany with status precondition.
   */
  atomic?: {
    /** Required statuses - update only succeeds if current status matches */
    requireStatusNotIn?: AppointmentStatus[];
    /** Also require humanControlEnabled to be false */
    requireHumanControlDisabled?: boolean;
  };
}

export interface TransitionToSessionHeldParams extends BaseTransitionParams {
  // No additional params needed
}

export interface TransitionToFeedbackRequestedParams extends BaseTransitionParams {
  // No additional params needed
}

export interface TransitionResult {
  success: boolean;
  previousStatus: AppointmentStatus;
  newStatus: AppointmentStatus;
  skipped?: boolean; // True if transition was skipped (idempotent)
  atomicSkipped?: boolean; // True if atomic update failed (another process won)
  warning?: string;
}

// Notification settings type
export interface NotificationSettings {
  slack: {
    requested: boolean;
    confirmed: boolean;
    completed: boolean;
    cancelled: boolean;
    escalation: boolean;
  };
  email: {
    clientConfirmation: boolean;
    therapistConfirmation: boolean;
    sessionReminder: boolean;
    feedbackForm: boolean;
    clientCancellation: boolean;
    therapistCancellation: boolean;
  };
}

// Default notification settings
const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  slack: {
    requested: true,
    confirmed: true,
    completed: true,
    cancelled: true,
    escalation: true,
  },
  email: {
    clientConfirmation: true,
    therapistConfirmation: true,
    sessionReminder: true,
    feedbackForm: true,
    clientCancellation: true,
    therapistCancellation: true,
  },
};

// ============================================
// Service Implementation
// ============================================

class AppointmentLifecycleService {
  /**
   * Get notification settings from admin settings
   * OPTIMIZATION: Fetch all settings in parallel instead of sequentially
   */
  private async getNotificationSettings(): Promise<NotificationSettings> {
    try {
      // Single batch DB query instead of 11 individual calls
      const keys = [
        'notifications.slack.requested',
        'notifications.slack.confirmed',
        'notifications.slack.completed',
        'notifications.slack.cancelled',
        'notifications.slack.escalation',
        'notifications.email.clientConfirmation',
        'notifications.email.therapistConfirmation',
        'notifications.email.sessionReminder',
        'notifications.email.feedbackForm',
        'notifications.email.clientCancellation',
        'notifications.email.therapistCancellation',
      ] as const;

      const settingsMap = await getSettingValues<boolean>([...keys]);
      const get = (key: typeof keys[number], fallback: boolean) =>
        settingsMap.get(key) ?? fallback;

      return {
        slack: {
          requested: get('notifications.slack.requested', DEFAULT_NOTIFICATION_SETTINGS.slack.requested),
          confirmed: get('notifications.slack.confirmed', DEFAULT_NOTIFICATION_SETTINGS.slack.confirmed),
          completed: get('notifications.slack.completed', DEFAULT_NOTIFICATION_SETTINGS.slack.completed),
          cancelled: get('notifications.slack.cancelled', DEFAULT_NOTIFICATION_SETTINGS.slack.cancelled),
          escalation: get('notifications.slack.escalation', DEFAULT_NOTIFICATION_SETTINGS.slack.escalation),
        },
        email: {
          clientConfirmation: get('notifications.email.clientConfirmation', DEFAULT_NOTIFICATION_SETTINGS.email.clientConfirmation),
          therapistConfirmation: get('notifications.email.therapistConfirmation', DEFAULT_NOTIFICATION_SETTINGS.email.therapistConfirmation),
          sessionReminder: get('notifications.email.sessionReminder', DEFAULT_NOTIFICATION_SETTINGS.email.sessionReminder),
          feedbackForm: get('notifications.email.feedbackForm', DEFAULT_NOTIFICATION_SETTINGS.email.feedbackForm),
          clientCancellation: get('notifications.email.clientCancellation', DEFAULT_NOTIFICATION_SETTINGS.email.clientCancellation),
          therapistCancellation: get('notifications.email.therapistCancellation', DEFAULT_NOTIFICATION_SETTINGS.email.therapistCancellation),
        },
      };
    } catch {
      return DEFAULT_NOTIFICATION_SETTINGS;
    }
  }

  /**
   * Add an audit message to the conversation state using SQL-level JSON append.
   * This avoids reading/parsing/serializing the full blob (up to 500KB) for each status transition.
   */
  private async addAuditMessage(
    appointmentId: string,
    source: TransitionSource,
    message: string,
    adminId?: string
  ): Promise<void> {
    try {
      const auditContent = source === 'admin' && adminId
        ? `[Admin: ${adminId}] ${message}`
        : `[System: ${source}] ${message}`;

      const newMessage = JSON.stringify({
        role: source === 'admin' ? 'admin' : 'assistant',
        content: auditContent,
      });

      // Use SQL-level JSON append to avoid full blob round-trip.
      // If conversation_state is NULL, initialize it with a new messages array.
      // If it exists, append to the existing messages array using jsonb_set + ||.
      await prisma.$executeRaw`
        UPDATE "appointment_requests"
        SET "conversation_state" = CASE
          WHEN "conversation_state" IS NULL THEN
            jsonb_build_object('messages', jsonb_build_array(${newMessage}::jsonb))
          ELSE
            jsonb_set(
              "conversation_state",
              '{messages}',
              COALESCE("conversation_state"->'messages', '[]'::jsonb) || ${newMessage}::jsonb
            )
          END,
          "updated_at" = NOW()
        WHERE "id" = ${appointmentId}
      `;
    } catch (err) {
      logger.error({ err, appointmentId }, 'Failed to add audit message (non-fatal)');
    }
  }

  // ============================================
  // Status Transitions
  // ============================================

  /**
   * Transition: pending → contacted
   *
   * Called when the AI agent makes first contact with the user.
   */
  async transitionToContacted(params: TransitionToContactedParams): Promise<TransitionResult> {
    const { appointmentId, source, adminId, hasAvailability } = params;
    const logContext = { appointmentId, source, adminId };

    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: { id: true, status: true },
    });

    if (!appointment) {
      logger.error(logContext, 'Cannot transition to contacted - appointment not found');
      throw new AppointmentNotFoundError(appointmentId);
    }

    const previousStatus = appointment.status as AppointmentStatus;

    // Idempotent check
    if (previousStatus === APPOINTMENT_STATUS.CONTACTED) {
      logger.debug(logContext, 'Appointment already contacted - skipping');
      return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.CONTACTED, skipped: true };
    }

    // Atomic update with status precondition to prevent race conditions
    const result = await prisma.appointmentRequest.updateMany({
      where: {
        id: appointmentId,
        status: APPOINTMENT_STATUS.PENDING, // Only pending → contacted is valid
      },
      data: {
        status: APPOINTMENT_STATUS.CONTACTED,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      logger.warn(
        { ...logContext, currentStatus: previousStatus },
        `Invalid transition: ${previousStatus} → contacted (only pending allowed)`
      );
      throw new InvalidTransitionError(previousStatus, 'contacted');
    }

    // Add audit trail
    await this.addAuditMessage(
      appointmentId,
      source,
      `Status changed: ${previousStatus} → contacted (availability ${hasAvailability ? 'known' : 'unknown'})`,
      adminId
    );

    logger.info({ ...logContext, previousStatus, hasAvailability }, 'Appointment transitioned to contacted');

    return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.CONTACTED };
  }

  /**
   * Transition: contacted → negotiating
   *
   * Called when the user responds and negotiation begins.
   */
  async transitionToNegotiating(params: TransitionToNegotiatingParams): Promise<TransitionResult> {
    const { appointmentId, source, adminId, notes } = params;
    const logContext = { appointmentId, source, adminId };

    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: { id: true, status: true },
    });

    if (!appointment) {
      logger.error(logContext, 'Cannot transition to negotiating - appointment not found');
      throw new AppointmentNotFoundError(appointmentId);
    }

    const previousStatus = appointment.status as AppointmentStatus;

    // Idempotent check
    if (previousStatus === APPOINTMENT_STATUS.NEGOTIATING) {
      logger.debug(logContext, 'Appointment already negotiating - skipping');
      return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.NEGOTIATING, skipped: true };
    }

    // Atomic update with status precondition
    const validFromStatuses = [APPOINTMENT_STATUS.CONTACTED, APPOINTMENT_STATUS.PENDING];
    const result = await prisma.appointmentRequest.updateMany({
      where: {
        id: appointmentId,
        status: { in: validFromStatuses },
      },
      data: {
        status: APPOINTMENT_STATUS.NEGOTIATING,
        notes: notes || undefined,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      logger.warn(
        { ...logContext, currentStatus: previousStatus },
        `Invalid transition: ${previousStatus} → negotiating`
      );
      throw new InvalidTransitionError(previousStatus, 'negotiating');
    }

    // Add audit trail
    await this.addAuditMessage(
      appointmentId,
      source,
      `Status changed: ${previousStatus} → negotiating`,
      adminId
    );

    logger.info({ ...logContext, previousStatus }, 'Appointment transitioned to negotiating');

    return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.NEGOTIATING };
  }

  /**
   * Transition: * → confirmed
   *
   * Handles all side effects:
   * - Updates appointment record
   * - Marks therapist as confirmed (freezes for other bookings)
   * - Syncs therapist freeze status to Notion
   * - Syncs user to Notion
   * - Sends confirmation emails to client and therapist
   * - Sends Slack notification
   */
  async transitionToConfirmed(params: TransitionToConfirmedParams): Promise<TransitionResult> {
    const {
      appointmentId,
      confirmedDateTime,
      confirmedDateTimeParsed,
      notes,
      source,
      adminId,
      sendEmails = true,
      atomic,
    } = params;

    const logContext = { appointmentId, source, adminId };

    // Get current appointment state with all needed fields
    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
        userName: true,
        userEmail: true,
        therapistName: true,
        therapistEmail: true,
        therapistNotionId: true,
        confirmedDateTime: true,
        humanControlEnabled: true,
      },
    });

    if (!appointment) {
      logger.error(logContext, 'Cannot transition to confirmed - appointment not found');
      throw new AppointmentNotFoundError(appointmentId);
    }

    const previousStatus = appointment.status as AppointmentStatus;

    // Check if already confirmed with same datetime (idempotent)
    if (
      appointment.status === APPOINTMENT_STATUS.CONFIRMED &&
      appointment.confirmedDateTime === confirmedDateTime
    ) {
      logger.debug(logContext, 'Appointment already confirmed with same datetime - skipping');
      return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.CONFIRMED, skipped: true };
    }

    const wasConfirmed = appointment.status === APPOINTMENT_STATUS.CONFIRMED;
    const isReschedule = wasConfirmed && appointment.confirmedDateTime !== confirmedDateTime;
    const reschedule = params.reschedule;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {
      status: APPOINTMENT_STATUS.CONFIRMED,
      confirmedDateTime,
      confirmedDateTimeParsed: confirmedDateTimeParsed || null,
      // For reschedules, reset confirmedAt so timing calculations use new time
      confirmedAt: isReschedule ? new Date() : (wasConfirmed ? undefined : new Date()),
      notes: notes || undefined,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      // Always clear rescheduling flags when confirming
      reschedulingInProgress: false,
      reschedulingInitiatedBy: null,
    };

    // Handle reschedule-specific fields
    if (reschedule) {
      if (reschedule.previousConfirmedDateTime) {
        updateData.previousConfirmedDateTime = reschedule.previousConfirmedDateTime;
      }
      if (reschedule.resetFollowUpFlags) {
        updateData.meetingLinkCheckSentAt = null;
        updateData.feedbackFormSentAt = null;
      }
    }

    // Use atomic update (updateMany) when atomic options provided
    // This prevents race conditions where two processes try to confirm simultaneously
    if (atomic) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const whereClause: any = {
        id: appointmentId,
        status: { in: atomic.requireStatuses },
      };

      if (atomic.requireHumanControlDisabled) {
        whereClause.humanControlEnabled = false;
      }

      const updateResult = await prisma.appointmentRequest.updateMany({
        where: whereClause,
        data: updateData,
      });

      // If no rows updated, another process already confirmed or conditions not met
      if (updateResult.count === 0) {
        // Re-fetch to determine why it failed
        const current = await prisma.appointmentRequest.findUnique({
          where: { id: appointmentId },
          select: { status: true, humanControlEnabled: true, confirmedDateTime: true },
        });

        if (current?.humanControlEnabled && atomic.requireHumanControlDisabled) {
          logger.info(
            { ...logContext },
            'Human control enabled between check and update - atomic confirmation skipped'
          );
          return { success: false, previousStatus, newStatus: previousStatus, atomicSkipped: true };
        }

        if (current?.status === APPOINTMENT_STATUS.CONFIRMED) {
          logger.info(
            { ...logContext, existingDateTime: current.confirmedDateTime, attemptedDateTime: confirmedDateTime },
            'Appointment already confirmed by another process (concurrent confirmation prevented)'
          );
          return { success: false, previousStatus, newStatus: APPOINTMENT_STATUS.CONFIRMED, atomicSkipped: true };
        }

        logger.warn(
          { ...logContext, currentStatus: current?.status },
          'Atomic confirmation failed - status changed unexpectedly'
        );
        return { success: false, previousStatus, newStatus: previousStatus, atomicSkipped: true };
      }

      logger.info({ ...logContext }, 'Appointment confirmed atomically');
    } else {
      // Standard non-atomic update
      await prisma.appointmentRequest.update({
        where: { id: appointmentId },
        data: updateData,
      });
    }

    // Add audit trail
    await this.addAuditMessage(
      appointmentId,
      source,
      isReschedule
        ? `Appointment rescheduled: ${appointment.confirmedDateTime} → ${confirmedDateTime}`
        : `Status changed: ${previousStatus} → confirmed for ${confirmedDateTime}`,
      adminId
    );

    logger.info(
      { ...logContext, isReschedule, confirmedDateTime },
      isReschedule ? 'Appointment rescheduled' : 'Appointment confirmed'
    );

    // Mark therapist as confirmed (freezes for other bookings)
    if (appointment.therapistNotionId) {
      try {
        await therapistBookingStatusService.markConfirmed(
          appointment.therapistNotionId,
          appointment.therapistName
        );
        await notionSyncManager.syncSingleTherapist(appointment.therapistNotionId);
      } catch (err) {
        logger.error(
          { ...logContext, err },
          'Failed to mark therapist as confirmed (non-critical)'
        );
      }
    }

    // Sync user to Notion (non-blocking, tracked)
    runBackgroundTask(
      () => notionSyncManager.syncSingleUser(appointment.userEmail),
      {
        name: 'user-sync-notion',
        context: { ...logContext, userEmail: appointment.userEmail },
        retry: true,
        maxRetries: 2,
      }
    );

    // Get notification settings
    const settings = await this.getNotificationSettings();

    // Send Slack notification (non-blocking, tracked)
    if (settings.slack.confirmed) {
      runBackgroundTask(
        () => slackNotificationService.notifyAppointmentConfirmed(
          appointmentId,
          appointment.userName,
          appointment.therapistName,
          confirmedDateTime
        ),
        {
          name: 'slack-notify-confirmed',
          context: logContext,
          retry: true,
          maxRetries: 2,
        }
      );
    }

    // Send confirmation emails (non-blocking, tracked)
    if (sendEmails) {
      const therapistFirstName = (appointment.therapistName || 'there').split(' ')[0];
      const clientFirstName = (appointment.userName || 'the client').split(' ')[0];

      // Send client confirmation email
      if (settings.email.clientConfirmation) {
        runBackgroundTask(
          async () => {
            // Use allSettled to handle partial failures gracefully
            const results = await Promise.allSettled([
              getEmailSubject('clientConfirmation', {
                therapistName: appointment.therapistName || 'your therapist',
                confirmedDateTime,
              }),
              getEmailBody('clientConfirmation', {
                userName: appointment.userName || 'there',
                therapistName: appointment.therapistName || 'your therapist',
                confirmedDateTime,
              }),
            ]);

            // Check for failures in template loading
            const subjectResult = results[0];
            const bodyResult = results[1];

            if (subjectResult.status === 'rejected' || bodyResult.status === 'rejected') {
              const failures = results
                .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
                .map(r => r.reason);
              throw new Error(`Template loading failed: ${failures.join(', ')}`);
            }

            await emailProcessingService.sendEmail({
              to: appointment.userEmail,
              subject: subjectResult.value,
              body: bodyResult.value,
            });
            logger.info(
              { ...logContext, userEmail: appointment.userEmail },
              'Sent confirmation email to client'
            );
          },
          {
            name: 'email-client-confirmation',
            context: { ...logContext, userEmail: appointment.userEmail },
            retry: true,
            maxRetries: 2,
          }
        );
      }

      // Send therapist confirmation email
      if (settings.email.therapistConfirmation && appointment.therapistEmail) {
        runBackgroundTask(
          async () => {
            const results = await Promise.allSettled([
              getEmailSubject('therapistConfirmation', { confirmedDateTime }),
              getEmailBody('therapistConfirmation', {
                therapistFirstName,
                clientFirstName,
                userEmail: appointment.userEmail,
                confirmedDateTime,
              }),
            ]);

            const subjectResult = results[0];
            const bodyResult = results[1];

            if (subjectResult.status === 'rejected' || bodyResult.status === 'rejected') {
              const failures = results
                .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
                .map(r => r.reason);
              throw new Error(`Template loading failed: ${failures.join(', ')}`);
            }

            await emailProcessingService.sendEmail({
              to: appointment.therapistEmail!,
              subject: subjectResult.value,
              body: bodyResult.value,
            });
            logger.info(
              { ...logContext, therapistEmail: appointment.therapistEmail },
              'Sent confirmation email to therapist'
            );
          },
          {
            name: 'email-therapist-confirmation',
            context: { ...logContext, therapistEmail: appointment.therapistEmail },
            retry: true,
            maxRetries: 2,
          }
        );
      }
    }

    return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.CONFIRMED };
  }

  /**
   * Transition: confirmed → session_held
   *
   * Called automatically when the session datetime passes.
   */
  async transitionToSessionHeld(params: TransitionToSessionHeldParams): Promise<TransitionResult> {
    const { appointmentId, source, adminId } = params;
    const logContext = { appointmentId, source, adminId };

    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
        userEmail: true,
      },
    });

    if (!appointment) {
      logger.error(logContext, 'Cannot transition to session_held - appointment not found');
      throw new AppointmentNotFoundError(appointmentId);
    }

    const previousStatus = appointment.status as AppointmentStatus;

    // Idempotent check
    if (appointment.status === APPOINTMENT_STATUS.SESSION_HELD) {
      logger.debug(logContext, 'Appointment already session_held - skipping');
      return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.SESSION_HELD, skipped: true };
    }

    // Update appointment
    await prisma.appointmentRequest.update({
      where: { id: appointmentId },
      data: {
        status: APPOINTMENT_STATUS.SESSION_HELD,
        updatedAt: new Date(),
      },
    });

    // Sync user to Notion - moves therapist from "Upcoming" to "Previous" (tracked)
    runBackgroundTask(
      () => notionSyncManager.syncSingleUser(appointment.userEmail),
      {
        name: 'user-sync-session-held',
        context: { ...logContext, userEmail: appointment.userEmail },
        retry: true,
        maxRetries: 2,
      }
    );

    // Add audit trail
    await this.addAuditMessage(
      appointmentId,
      source,
      `Status changed: ${previousStatus} → session_held`,
      adminId
    );

    logger.info({ ...logContext, previousStatus }, 'Appointment transitioned to session_held');

    return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.SESSION_HELD };
  }

  /**
   * Transition: session_held → feedback_requested
   *
   * Called when the feedback form email is sent.
   */
  async transitionToFeedbackRequested(params: TransitionToFeedbackRequestedParams): Promise<TransitionResult> {
    const { appointmentId, source, adminId } = params;
    const logContext = { appointmentId, source, adminId };

    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
      },
    });

    if (!appointment) {
      logger.error(logContext, 'Cannot transition to feedback_requested - appointment not found');
      throw new AppointmentNotFoundError(appointmentId);
    }

    const previousStatus = appointment.status as AppointmentStatus;

    // Idempotent check
    if (appointment.status === APPOINTMENT_STATUS.FEEDBACK_REQUESTED) {
      logger.debug(logContext, 'Appointment already feedback_requested - skipping');
      return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.FEEDBACK_REQUESTED, skipped: true };
    }

    // Update appointment
    await prisma.appointmentRequest.update({
      where: { id: appointmentId },
      data: {
        status: APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
        feedbackFormSentAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Add audit trail
    await this.addAuditMessage(
      appointmentId,
      source,
      `Status changed: ${previousStatus} → feedback_requested`,
      adminId
    );

    logger.info({ ...logContext, previousStatus }, 'Appointment transitioned to feedback_requested');

    return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.FEEDBACK_REQUESTED };
  }

  /**
   * Transition: * → completed
   *
   * Handles all side effects:
   * - Updates appointment record (with row-level lock to prevent race conditions)
   * - Marks therapist as inactive in Notion
   * - Clears therapist booking status
   * - Syncs user to Notion
   * - Sends Slack notification
   */
  async transitionToCompleted(params: TransitionToCompletedParams): Promise<TransitionResult> {
    const { appointmentId, source, note, adminId, feedbackSubmissionId, feedbackData } = params;
    const logContext = { appointmentId, source, adminId };

    // Valid transitions to completed
    const validFromStatuses = [
      APPOINTMENT_STATUS.SESSION_HELD,
      APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
      APPOINTMENT_STATUS.CONFIRMED, // Edge case: complete without feedback
    ];

    // Use serializable transaction with row-level lock for atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Lock the row with FOR UPDATE to prevent concurrent modifications
      // NOWAIT throws immediately if row is locked (fast fail)
      type AppointmentRow = {
        id: string;
        status: string;
        user_name: string | null;
        user_email: string;
        therapist_name: string;
        therapist_notion_id: string;
        notes: string | null;
      };

      let appointment: AppointmentRow | null;
      try {
        const rows = await tx.$queryRaw<AppointmentRow[]>`
          SELECT id, status, user_name, user_email, therapist_name, therapist_notion_id, notes
          FROM "appointment_requests"
          WHERE id = ${appointmentId}
          FOR UPDATE NOWAIT
        `;
        appointment = rows[0] || null;
      } catch (lockError) {
        // NOWAIT throws if row is locked by another transaction
        throw new ConcurrentModificationError(appointmentId);
      }

      if (!appointment) {
        throw new AppointmentNotFoundError(appointmentId);
      }

      const previousStatus = appointment.status as AppointmentStatus;

      // Check if already completed (idempotent)
      if (appointment.status === APPOINTMENT_STATUS.COMPLETED) {
        return {
          success: true,
          previousStatus,
          newStatus: APPOINTMENT_STATUS.COMPLETED,
          skipped: true,
          appointment: {
            id: appointment.id,
            userName: appointment.user_name,
            userEmail: appointment.user_email,
            therapistName: appointment.therapist_name,
            therapistNotionId: appointment.therapist_notion_id,
          }
        };
      }

      // Validate state machine transition (soft validation - log warning but proceed)
      const validStatuses: string[] = validFromStatuses;
      if (!validStatuses.includes(appointment.status)) {
        logger.warn(
          { ...logContext, currentStatus: appointment.status },
          'Unusual transition to completed - proceeding anyway'
        );
      }

      // Build updated notes
      const updatedNotes = note
        ? appointment.notes
          ? `${note}\n\n${appointment.notes}`
          : note
        : appointment.notes;

      // Update appointment record within transaction
      await tx.appointmentRequest.update({
        where: { id: appointmentId },
        data: {
          status: APPOINTMENT_STATUS.COMPLETED,
          notes: updatedNotes,
          updatedAt: new Date(),
        },
      });

      // Create audit log within transaction for atomicity
      await tx.appointmentAuditEvent.create({
        data: {
          appointmentRequestId: appointmentId,
          eventType: 'status_change',
          actor: source === 'admin' ? `admin:${adminId || 'unknown'}` : source,
          payload: {
            fromStatus: previousStatus,
            toStatus: APPOINTMENT_STATUS.COMPLETED,
            note,
          },
        },
      });

      return {
        success: true,
        previousStatus,
        newStatus: APPOINTMENT_STATUS.COMPLETED,
        skipped: false,
        appointment: {
          id: appointment.id,
          userName: appointment.user_name,
          userEmail: appointment.user_email,
          therapistName: appointment.therapist_name,
          therapistNotionId: appointment.therapist_notion_id,
        }
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 10000, // 10 second timeout
    });

    // If skipped (already completed), return early
    if (result.skipped) {
      logger.debug(logContext, 'Appointment already completed - skipping');
      return { success: true, previousStatus: result.previousStatus, newStatus: result.newStatus, skipped: true };
    }

    const { appointment, previousStatus } = result;

    // Add audit trail (conversation state update - non-blocking)
    this.addAuditMessage(
      appointmentId,
      source,
      `Status changed: ${previousStatus} → completed${note ? ` (${note})` : ''}`,
      adminId
    ).catch(err => logger.error({ err, appointmentId }, 'Failed to add audit message'));

    logger.info(
      { ...logContext, previousStatus },
      'Appointment transitioned to completed'
    );

    // Update therapist booking status and conditionally deactivate in Notion
    if (appointment.therapistNotionId) {
      try {
        // Clear confirmed flag and recalculate request count in parallel (independent operations)
        await Promise.all([
          therapistBookingStatusService.unmarkConfirmed(appointment.therapistNotionId),
          therapistBookingStatusService.recalculateUniqueRequestCount(appointment.therapistNotionId),
        ]);

        // FIX #6: Only deactivate therapist if they have NO other active appointments.
        // Previously, completing one appointment would hide the therapist even if they
        // had other clients in negotiating/confirmed state.
        const otherActiveAppointments = await prisma.appointmentRequest.count({
          where: {
            therapistNotionId: appointment.therapistNotionId,
            id: { not: appointmentId },
            status: {
              in: [
                APPOINTMENT_STATUS.PENDING,
                APPOINTMENT_STATUS.CONTACTED,
                APPOINTMENT_STATUS.NEGOTIATING,
                APPOINTMENT_STATUS.CONFIRMED,
                APPOINTMENT_STATUS.SESSION_HELD,
                APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
              ],
            },
          },
        });

        if (otherActiveAppointments === 0) {
          // No other active appointments - safe to deactivate
          await notionService.updateTherapistActive(appointment.therapistNotionId, false);
          logger.info(
            { ...logContext, therapistNotionId: appointment.therapistNotionId },
            'Marked therapist as inactive after last appointment completed'
          );
        } else {
          logger.info(
            { ...logContext, therapistNotionId: appointment.therapistNotionId, otherActiveAppointments },
            'Therapist still has active appointments - keeping active'
          );
        }

        // Sync frozen status to Notion (will unfreeze since no active requests)
        await notionSyncManager.syncSingleTherapist(appointment.therapistNotionId);
      } catch (err) {
        // Log but don't fail the completion - therapist status is secondary
        logger.error(
          { ...logContext, therapistNotionId: appointment.therapistNotionId, err },
          'Failed to update therapist status after completion (non-fatal)'
        );
      }
    }

    // Sync user to Notion (non-blocking, tracked)
    runBackgroundTask(
      () => notionSyncManager.syncSingleUser(appointment.userEmail),
      {
        name: 'user-sync-completion',
        context: { ...logContext, userEmail: appointment.userEmail },
        retry: true,
        maxRetries: 2,
      }
    );

    // Get notification settings and send Slack notification (non-blocking, tracked)
    const settings = await this.getNotificationSettings();
    if (settings.slack.completed) {
      runBackgroundTask(
        () => slackNotificationService.notifyAppointmentCompleted(
          appointmentId,
          appointment.userName,
          appointment.therapistName,
          feedbackSubmissionId,
          feedbackData
        ),
        {
          name: 'slack-notify-completed',
          context: logContext,
          retry: true,
          maxRetries: 2,
        }
      );
    }

    return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.COMPLETED };
  }

  /**
   * Transition: * → cancelled
   *
   * Handles all side effects:
   * - Updates appointment record (with row-level lock to prevent race conditions)
   * - Unmarks therapist as confirmed (if was confirmed)
   * - Recalculates therapist booking status
   * - Syncs therapist freeze status to Notion
   * - Sends Slack notification (if enabled)
   * - Sends cancellation emails to both client and therapist (if enabled)
   */
  async transitionToCancelled(params: TransitionToCancelledParams): Promise<TransitionResult> {
    const { appointmentId, reason, cancelledBy, source, adminId, atomic } = params;
    const logContext = { appointmentId, source, adminId, cancelledBy };

    // Invalid statuses to cancel from
    const invalidFromStatuses = [
      APPOINTMENT_STATUS.COMPLETED,
      APPOINTMENT_STATUS.CANCELLED,
    ];

    // Use serializable transaction with row-level lock for atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Lock the row with FOR UPDATE to prevent concurrent modifications
      type AppointmentRow = {
        id: string;
        status: string;
        user_name: string | null;
        user_email: string;
        therapist_name: string;
        therapist_email: string;
        therapist_notion_id: string;
        human_control_enabled: boolean;
        notes: string | null;
        confirmed_date_time: string | null;
        gmail_thread_id: string | null;
        therapist_gmail_thread_id: string | null;
      };

      let appointment: AppointmentRow | null;
      try {
        const rows = await tx.$queryRaw<AppointmentRow[]>`
          SELECT id, status, user_name, user_email, therapist_name, therapist_email,
                 therapist_notion_id, human_control_enabled, notes,
                 confirmed_date_time, gmail_thread_id, therapist_gmail_thread_id
          FROM "appointment_requests"
          WHERE id = ${appointmentId}
          FOR UPDATE NOWAIT
        `;
        appointment = rows[0] || null;
      } catch (lockError) {
        throw new ConcurrentModificationError(appointmentId);
      }

      if (!appointment) {
        throw new AppointmentNotFoundError(appointmentId);
      }

      const previousStatus = appointment.status as AppointmentStatus;

      // Check if already cancelled (idempotent)
      if (appointment.status === APPOINTMENT_STATUS.CANCELLED) {
        return {
          success: true,
          previousStatus,
          newStatus: APPOINTMENT_STATUS.CANCELLED,
          skipped: true,
          wasConfirmed: false,
          appointment: {
            id: appointment.id,
            userName: appointment.user_name,
            userEmail: appointment.user_email,
            therapistName: appointment.therapist_name,
            therapistEmail: appointment.therapist_email,
            therapistNotionId: appointment.therapist_notion_id,
            confirmedDateTime: appointment.confirmed_date_time,
            gmailThreadId: appointment.gmail_thread_id,
            therapistGmailThreadId: appointment.therapist_gmail_thread_id,
          }
        };
      }

      // Check atomic conditions if provided
      if (atomic) {
        if (atomic.requireStatusNotIn && atomic.requireStatusNotIn.includes(appointment.status as AppointmentStatus)) {
          return {
            success: false,
            previousStatus,
            newStatus: previousStatus,
            atomicSkipped: true,
            wasConfirmed: false,
            appointment: {
              id: appointment.id,
              userName: appointment.user_name,
              therapistName: appointment.therapist_name,
              therapistNotionId: appointment.therapist_notion_id,
            }
          };
        }

        if (atomic.requireHumanControlDisabled && appointment.human_control_enabled) {
          return {
            success: false,
            previousStatus,
            newStatus: previousStatus,
            atomicSkipped: true,
            wasConfirmed: false,
            appointment: {
              id: appointment.id,
              userName: appointment.user_name,
              therapistName: appointment.therapist_name,
              therapistNotionId: appointment.therapist_notion_id,
            }
          };
        }
      }

      // Validate state machine - can't cancel completed appointments
      if (appointment.status === APPOINTMENT_STATUS.COMPLETED) {
        throw new InvalidTransitionError(appointment.status, 'cancelled');
      }

      const wasConfirmed = appointment.status === APPOINTMENT_STATUS.CONFIRMED;

      // Build updated notes - prepend cancellation info while preserving history
      const cancellationNote = `[CANCELLED ${new Date().toISOString()}] Reason: ${reason}. Cancelled by: ${cancelledBy}`;
      const updatedNotes = appointment.notes
        ? `${cancellationNote}\n\n${appointment.notes}`
        : cancellationNote;

      // Update appointment record within transaction
      await tx.appointmentRequest.update({
        where: { id: appointmentId },
        data: {
          status: APPOINTMENT_STATUS.CANCELLED,
          notes: updatedNotes,
          updatedAt: new Date(),
        },
      });

      // Create audit log within transaction for atomicity
      await tx.appointmentAuditEvent.create({
        data: {
          appointmentRequestId: appointmentId,
          eventType: 'status_change',
          actor: source === 'admin' ? `admin:${adminId || 'unknown'}` : source,
          payload: {
            fromStatus: previousStatus,
            toStatus: APPOINTMENT_STATUS.CANCELLED,
            reason,
            cancelledBy,
          },
        },
      });

      return {
        success: true,
        previousStatus,
        newStatus: APPOINTMENT_STATUS.CANCELLED,
        skipped: false,
        wasConfirmed,
        appointment: {
          id: appointment.id,
          userName: appointment.user_name,
          therapistName: appointment.therapist_name,
          therapistNotionId: appointment.therapist_notion_id,
        }
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 10000,
    });

    // Handle atomic skip
    if (result.atomicSkipped) {
      logger.warn(
        { ...logContext, currentStatus: result.previousStatus },
        'Atomic cancellation skipped - conditions not met'
      );
      return { success: false, previousStatus: result.previousStatus, newStatus: result.previousStatus, atomicSkipped: true };
    }

    // Handle idempotent skip
    if (result.skipped) {
      logger.debug(logContext, 'Appointment already cancelled - skipping');
      return { success: true, previousStatus: result.previousStatus, newStatus: result.newStatus, skipped: true };
    }

    const { appointment, previousStatus, wasConfirmed } = result;

    // Add audit trail to conversation state (non-blocking)
    this.addAuditMessage(
      appointmentId,
      source,
      `Status changed: ${previousStatus} → cancelled. Reason: ${reason}. Cancelled by: ${cancelledBy}`,
      adminId
    ).catch(err => logger.error({ err, appointmentId }, 'Failed to add audit message'));

    logger.info(
      { ...logContext, wasConfirmed, reason },
      'Appointment cancelled'
    );

    // Update therapist status
    if (appointment.therapistNotionId) {
      try {
        // If was confirmed, unmark therapist
        if (wasConfirmed) {
          await therapistBookingStatusService.unmarkConfirmed(appointment.therapistNotionId);
        }

        // Recalculate unique request count
        await therapistBookingStatusService.recalculateUniqueRequestCount(
          appointment.therapistNotionId
        );

        // Sync frozen status to Notion
        await notionSyncManager.syncSingleTherapist(appointment.therapistNotionId);
      } catch (err) {
        logger.error(
          { ...logContext, therapistNotionId: appointment.therapistNotionId, err },
          'Failed to update therapist status after cancellation (non-fatal)'
        );
      }
    }

    // Get notification settings and send Slack notification (non-blocking, tracked)
    const settings = await this.getNotificationSettings();
    if (settings.slack.cancelled) {
      runBackgroundTask(
        () => slackNotificationService.sendAlert({
          title: 'Appointment Cancelled',
          severity: 'medium',
          appointmentId,
          therapistName: appointment.therapistName,
          details: `Cancelled by ${cancelledBy}. Reason: ${reason}`,
        }),
        {
          name: 'slack-notify-cancelled',
          context: logContext,
          retry: true,
          maxRetries: 2,
        }
      );
    }

    // Send cancellation emails (non-blocking, tracked)
    const therapistFirstName = (appointment.therapistName || 'your therapist').split(' ')[0];
    const clientFirstName = (appointment.userName || 'the client').split(' ')[0];
    // Only include reason in the email to the *other* party (empty string hides the line)
    const cancellationReasonForClient = cancelledBy === 'therapist' ? `\nReason: ${reason}` : '';
    const cancellationReasonForTherapist = cancelledBy === 'client' ? `\nReason: ${reason}` : '';

    // Send client cancellation email
    if (settings.email.clientCancellation && appointment.userEmail) {
      runBackgroundTask(
        async () => {
          const results = await Promise.allSettled([
            getEmailSubject('clientCancellation', {
              therapistName: therapistFirstName,
            }),
            getEmailBody('clientCancellation', {
              userName: appointment.userName || 'there',
              therapistName: therapistFirstName,
              confirmedDateTime: appointment.confirmedDateTime || 'your scheduled time',
              cancellationReason: cancellationReasonForClient,
            }),
          ]);

          const subjectResult = results[0];
          const bodyResult = results[1];

          if (subjectResult.status === 'rejected' || bodyResult.status === 'rejected') {
            const failures = results
              .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
              .map(r => r.reason);
            throw new Error(`Template loading failed: ${failures.join(', ')}`);
          }

          await emailProcessingService.sendEmail({
            to: appointment.userEmail,
            subject: subjectResult.value,
            body: bodyResult.value,
            threadId: appointment.gmailThreadId || undefined,
          });
          logger.info(
            { ...logContext, userEmail: appointment.userEmail },
            'Sent cancellation email to client'
          );
        },
        {
          name: 'email-client-cancellation',
          context: { ...logContext, userEmail: appointment.userEmail },
          retry: true,
          maxRetries: 2,
        }
      );
    }

    // Send therapist cancellation email
    if (settings.email.therapistCancellation && appointment.therapistEmail) {
      runBackgroundTask(
        async () => {
          const results = await Promise.allSettled([
            getEmailSubject('therapistCancellation', {
              clientFirstName,
            }),
            getEmailBody('therapistCancellation', {
              therapistFirstName,
              clientFirstName,
              confirmedDateTime: appointment.confirmedDateTime || 'your scheduled time',
              cancellationReason: cancellationReasonForTherapist,
            }),
          ]);

          const subjectResult = results[0];
          const bodyResult = results[1];

          if (subjectResult.status === 'rejected' || bodyResult.status === 'rejected') {
            const failures = results
              .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
              .map(r => r.reason);
            throw new Error(`Template loading failed: ${failures.join(', ')}`);
          }

          await emailProcessingService.sendEmail({
            to: appointment.therapistEmail,
            subject: subjectResult.value,
            body: bodyResult.value,
            threadId: appointment.therapistGmailThreadId || undefined,
          });
          logger.info(
            { ...logContext, therapistEmail: appointment.therapistEmail },
            'Sent cancellation email to therapist'
          );
        },
        {
          name: 'email-therapist-cancellation',
          context: { ...logContext, therapistEmail: appointment.therapistEmail },
          retry: true,
          maxRetries: 2,
        }
      );
    }

    return { success: true, previousStatus: result.previousStatus, newStatus: APPOINTMENT_STATUS.CANCELLED };
  }

  // ============================================
  // Generic Status Update (for admin dashboard)
  // ============================================

  /**
   * Generic status update method for admin dashboard
   * Routes to appropriate transition method based on new status
   */
  async updateStatus(
    appointmentId: string,
    newStatus: AppointmentStatus,
    options: {
      source: TransitionSource;
      adminId?: string;
      reason?: string;
      confirmedDateTime?: string;
      confirmedDateTimeParsed?: Date | null;
      sendEmails?: boolean;
    }
  ): Promise<TransitionResult> {
    const { source, adminId, reason, confirmedDateTime, confirmedDateTimeParsed, sendEmails } = options;

    switch (newStatus) {
      case APPOINTMENT_STATUS.CONTACTED:
        return this.transitionToContacted({
          appointmentId,
          source,
          adminId,
          hasAvailability: false,
        });

      case APPOINTMENT_STATUS.NEGOTIATING:
        return this.transitionToNegotiating({
          appointmentId,
          source,
          adminId,
        });

      case APPOINTMENT_STATUS.CONFIRMED:
        if (!confirmedDateTime) {
          throw new Error('confirmedDateTime is required for confirmed status');
        }
        return this.transitionToConfirmed({
          appointmentId,
          confirmedDateTime,
          confirmedDateTimeParsed,
          source,
          adminId,
          sendEmails,
        });

      case APPOINTMENT_STATUS.SESSION_HELD:
        return this.transitionToSessionHeld({
          appointmentId,
          source,
          adminId,
        });

      case APPOINTMENT_STATUS.FEEDBACK_REQUESTED:
        return this.transitionToFeedbackRequested({
          appointmentId,
          source,
          adminId,
        });

      case APPOINTMENT_STATUS.COMPLETED:
        return this.transitionToCompleted({
          appointmentId,
          source,
          adminId,
          note: reason,
        });

      case APPOINTMENT_STATUS.CANCELLED:
        return this.transitionToCancelled({
          appointmentId,
          reason: reason || 'No reason provided',
          cancelledBy: source === 'admin' ? 'admin' : 'system',
          source,
          adminId,
        });

      default:
        throw new Error(`Unknown status: ${newStatus}`);
    }
  }
}

export const appointmentLifecycleService = new AppointmentLifecycleService();

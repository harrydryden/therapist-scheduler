/**
 * Appointment Lifecycle Service
 *
 * THE SINGLE SOURCE OF TRUTH for all appointment status transitions.
 *
 * State machine (every transition is enforced atomically via status preconditions):
 *
 *   pending → contacted → negotiating → confirmed → session_held → feedback_requested → completed
 *                 ↑              ↑           ↑ (reschedule)
 *                 └──────────────┘           │
 *                       ↑                    │
 *                       └────────────────────┘ (confirmed also accepts feedback_requested via admin)
 *
 *   Any active status → cancelled  (all except completed and cancelled)
 *
 * This service is focused on:
 * - Status transition validation (state machine enforcement)
 * - Atomic database updates with preconditions (prevents TOCTOU races)
 * - Audit trail (conversation state updates)
 * - Orchestrating post-transition side effects via extracted services:
 *   - transition-side-effects.service.ts: Notion sync, therapist booking status, SSE
 *   - appointment-notifications.service.ts: Slack + email notifications
 *
 * All code paths that change appointment status MUST go through this service.
 * This ensures consistent behavior regardless of trigger source (AI agent, admin, system).
 */

import { prisma } from '../utils/database';
import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import { APPOINTMENT_STATUS, AppointmentStatus } from '../constants';
import { appointmentNotificationsService } from './appointment-notifications.service';
import { transitionSideEffectsService } from './transition-side-effects.service';
import { recordAppointmentEvent } from './appointment-event.service';
import { auditEventService, type AuditActor } from './audit-event.service';
import { aiConversationService } from './ai-conversation.service';
import { stageFromAction, ConversationStage, ConversationCheckpoint } from '../services/conversation-checkpoint.service';

// ============================================
// Lifecycle status ordering (for detecting backwards transitions)
// ============================================

const LIFECYCLE_STATUS_ORDER: readonly AppointmentStatus[] = [
  APPOINTMENT_STATUS.PENDING,
  APPOINTMENT_STATUS.CONTACTED,
  APPOINTMENT_STATUS.NEGOTIATING,
  APPOINTMENT_STATUS.CONFIRMED,
  APPOINTMENT_STATUS.SESSION_HELD,
  APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
  APPOINTMENT_STATUS.COMPLETED,
] as const;

const CONFIRMED_IDX = LIFECYCLE_STATUS_ORDER.indexOf(APPOINTMENT_STATUS.CONFIRMED);
const FEEDBACK_IDX = LIFECYCLE_STATUS_ORDER.indexOf(APPOINTMENT_STATUS.FEEDBACK_REQUESTED);

// ============================================
// Custom Errors for Lifecycle Transitions
// ============================================

// Re-export domain errors from centralized error hierarchy for backward compatibility
export {
  AppointmentNotFoundError,
  InvalidTransitionError,
  ConcurrentModificationError,
} from '../errors';

// Import for local use (re-export above does not create local bindings)
import {
  AppointmentNotFoundError,
  InvalidTransitionError,
  ConcurrentModificationError,
} from '../errors';

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
   * Skip the standard cancellation notifications (Slack + cancellation emails to
   * client/therapist). Use when the caller is firing its own specialized notification
   * (e.g. email-bounce service which sends a more detailed bounce-specific Slack alert
   * and where emailing the bounced user is futile).
   *
   * Data-consistency side effects (therapist unfreeze, Notion sync, audit trail) still
   * run regardless — this only suppresses the user-visible notifications.
   */
  skipNotifications?: boolean;
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


// ============================================
// Service Implementation
// ============================================

class AppointmentLifecycleService {
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

  /**
   * Notify SSE clients of a successful status transition.
   * Called from each transition method so both updateStatus() and direct callers are covered.
   */
  private notifyTransition(result: TransitionResult, appointmentId: string, source: TransitionSource): void {
    transitionSideEffectsService.notifyTransition(result, appointmentId, source);
  }

  /**
   * Emit a status_change row in `appointment_audit_events` so every transition
   * produces a queryable timeline entry.
   *
   * Used by the lighter transitions (contacted, negotiating, confirmed,
   * session_held, feedback_requested) which update status via `updateMany`
   * without a wrapping transaction. The terminal transitions (completed,
   * cancelled) write the audit row INSIDE their transaction for stricter
   * atomicity, so they don't go through this helper.
   *
   * Failures are swallowed (auditEventService.log already does this) — a missing
   * audit row should never roll back a successful transition. The call is fired
   * synchronously (awaited) so the caller can `await` the full transition and
   * be confident the audit row is committed before the status-change event is
   * propagated to listeners.
   */
  private async recordStatusChangeEvent(
    appointmentId: string,
    source: TransitionSource,
    adminId: string | undefined,
    previousStatus: AppointmentStatus,
    newStatus: AppointmentStatus,
    reason?: string,
  ): Promise<void> {
    const actor: AuditActor =
      source === 'admin' || source === 'agent' || source === 'system' ? source : 'system';
    await auditEventService.log(appointmentId, 'status_change', actor, {
      previousStatus,
      newStatus,
      ...(reason ? { reason } : {}),
      ...(adminId ? { adminId } : {}),
    });
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

    // Add audit trail (conversation-state JSON message + status_change audit event row).
    // Independent writes — run in parallel to save a round-trip.
    await Promise.all([
      this.addAuditMessage(
        appointmentId,
        source,
        `Status changed: ${previousStatus} → contacted (availability ${hasAvailability ? 'known' : 'unknown'})`,
        adminId,
      ),
      this.recordStatusChangeEvent(
        appointmentId,
        source,
        adminId,
        previousStatus,
        APPOINTMENT_STATUS.CONTACTED,
        `availability ${hasAvailability ? 'known' : 'unknown'}`,
      ),
    ]);

    logger.info({ ...logContext, previousStatus, hasAvailability }, 'Appointment transitioned to contacted');

    const transition: TransitionResult = { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.CONTACTED };
    this.notifyTransition(transition, appointmentId, source);
    return transition;
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

    // Add audit trail (conversation-state JSON message + status_change audit event row).
    // Independent writes — run in parallel.
    await Promise.all([
      this.addAuditMessage(
        appointmentId,
        source,
        `Status changed: ${previousStatus} → negotiating`,
        adminId,
      ),
      this.recordStatusChangeEvent(
        appointmentId,
        source,
        adminId,
        previousStatus,
        APPOINTMENT_STATUS.NEGOTIATING,
        notes,
      ),
    ]);

    logger.info({ ...logContext, previousStatus }, 'Appointment transitioned to negotiating');

    const transition: TransitionResult = { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.NEGOTIATING };
    this.notifyTransition(transition, appointmentId, source);
    return transition;
  }

  /**
   * Transition: pending | contacted | negotiating | confirmed (reschedule) → confirmed
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

    // Valid source statuses for confirmation (forward progress + reschedule)
    const validFromStatuses = [
      APPOINTMENT_STATUS.PENDING,
      APPOINTMENT_STATUS.CONTACTED,
      APPOINTMENT_STATUS.NEGOTIATING,
      APPOINTMENT_STATUS.CONFIRMED, // Reschedule
    ];

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

    // Validate source status — reject transitions from terminal/post-session states
    if (!validFromStatuses.includes(previousStatus)) {
      logger.warn(
        { ...logContext, currentStatus: previousStatus },
        `Invalid transition: ${previousStatus} → confirmed`
      );
      throw new InvalidTransitionError(previousStatus, 'confirmed');
    }

    const wasConfirmed = appointment.status === APPOINTMENT_STATUS.CONFIRMED;
    const isReschedule = wasConfirmed && appointment.confirmedDateTime !== confirmedDateTime;
    const reschedule = params.reschedule;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {
      status: APPOINTMENT_STATUS.CONFIRMED,
      confirmedDateTime,
      confirmedDateTimeParsed: confirmedDateTimeParsed || null,
      // Set confirmedAt: new Date() for first confirmation, reset for reschedules.
      // (The wasConfirmed && !isReschedule case is unreachable — caught by the
      // idempotent same-datetime check above.)
      confirmedAt: new Date(),
      notes: notes || undefined,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      // Always clear rescheduling flags when confirming
      reschedulingInProgress: false,
      reschedulingInitiatedBy: null,
      // Clear stale flag — stale only applies to pre-confirmation statuses
      isStale: false,
    };

    // Handle reschedule-specific fields
    if (reschedule) {
      if (reschedule.previousConfirmedDateTime) {
        updateData.previousConfirmedDateTime = reschedule.previousConfirmedDateTime;
      }
      if (reschedule.resetFollowUpFlags) {
        updateData.meetingLinkCheckSentAt = null;
        updateData.reminderSentAt = null;
        updateData.feedbackFormSentAt = null;
        updateData.feedbackReminderSentAt = null;
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
      // Non-atomic update with status precondition for consistency
      const updateResult = await prisma.appointmentRequest.updateMany({
        where: {
          id: appointmentId,
          status: { in: validFromStatuses },
        },
        data: updateData,
      });

      if (updateResult.count === 0) {
        // Status changed between our read and write — re-read to provide accurate error
        const current = await prisma.appointmentRequest.findUnique({
          where: { id: appointmentId },
          select: { status: true },
        });
        logger.warn(
          { ...logContext, currentStatus: current?.status, readStatus: previousStatus },
          'Confirmation failed - status changed between read and write'
        );
        throw new InvalidTransitionError(current?.status || previousStatus, 'confirmed');
      }
    }

    // Add audit trail (conversation-state JSON message + status_change audit event row).
    // Independent writes — run in parallel.
    await Promise.all([
      this.addAuditMessage(
        appointmentId,
        source,
        isReschedule
          ? `Appointment rescheduled: ${appointment.confirmedDateTime} → ${confirmedDateTime}`
          : `Status changed: ${previousStatus} → confirmed for ${confirmedDateTime}`,
        adminId,
      ),
      this.recordStatusChangeEvent(
        appointmentId,
        source,
        adminId,
        previousStatus,
        APPOINTMENT_STATUS.CONFIRMED,
        isReschedule
          ? `Rescheduled to ${confirmedDateTime}`
          : `Confirmed for ${confirmedDateTime}`,
      ),
    ]);

    logger.info(
      { ...logContext, isReschedule, confirmedDateTime },
      isReschedule ? 'Appointment rescheduled' : 'Appointment confirmed'
    );

    // Log invalid date alert if the confirmed datetime could not be parsed
    if (!confirmedDateTimeParsed && confirmedDateTime) {
      logger.warn(
        { ...logContext, confirmedDateTime },
        'Invalid date alert raised - confirmed datetime could not be parsed'
      );
    }

    // Post-transition side effects (therapist booking status, Notion sync)
    transitionSideEffectsService.onConfirmed({
      appointmentId,
      source,
      adminId,
      therapistNotionId: appointment.therapistNotionId,
      therapistName: appointment.therapistName,
      userEmail: appointment.userEmail,
    });

    // Send Slack + email notifications (delegated to notifications service)
    appointmentNotificationsService.notifyConfirmed({
      appointmentId,
      source,
      adminId,
      userName: appointment.userName,
      userEmail: appointment.userEmail,
      therapistName: appointment.therapistName,
      therapistEmail: appointment.therapistEmail,
      confirmedDateTime,
      confirmedDateTimeParsed,
      sendEmails,
    });

    const transition: TransitionResult = { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.CONFIRMED };
    this.notifyTransition(transition, appointmentId, source);
    return transition;
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

    // Atomic update with status precondition — only confirmed → session_held is valid
    const result = await prisma.appointmentRequest.updateMany({
      where: {
        id: appointmentId,
        status: APPOINTMENT_STATUS.CONFIRMED,
      },
      data: {
        status: APPOINTMENT_STATUS.SESSION_HELD,
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      logger.warn(
        { ...logContext, currentStatus: previousStatus },
        `Invalid transition: ${previousStatus} → session_held (only confirmed allowed)`
      );
      throw new InvalidTransitionError(previousStatus, 'session_held');
    }

    // Post-transition side effects (Notion user sync)
    transitionSideEffectsService.onSessionHeld({
      appointmentId,
      source,
      adminId,
      userEmail: appointment.userEmail,
    });

    // Add audit trail (conversation-state JSON message + status_change audit event row).
    // Independent writes — run in parallel.
    await Promise.all([
      this.addAuditMessage(
        appointmentId,
        source,
        `Status changed: ${previousStatus} → session_held`,
        adminId,
      ),
      this.recordStatusChangeEvent(
        appointmentId,
        source,
        adminId,
        previousStatus,
        APPOINTMENT_STATUS.SESSION_HELD,
      ),
    ]);

    logger.info({ ...logContext, previousStatus }, 'Appointment transitioned to session_held');

    const transition: TransitionResult = { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.SESSION_HELD };
    this.notifyTransition(transition, appointmentId, source);
    return transition;
  }

  /**
   * Transition: session_held | confirmed → feedback_requested
   *
   * Called when the feedback form email is sent.
   * Accepts confirmed as a source status for admin-created appointments
   * that skip directly to the feedback stage.
   */
  async transitionToFeedbackRequested(params: TransitionToFeedbackRequestedParams): Promise<TransitionResult> {
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
      logger.error(logContext, 'Cannot transition to feedback_requested - appointment not found');
      throw new AppointmentNotFoundError(appointmentId);
    }

    const previousStatus = appointment.status as AppointmentStatus;

    // Idempotent check
    if (appointment.status === APPOINTMENT_STATUS.FEEDBACK_REQUESTED) {
      logger.debug(logContext, 'Appointment already feedback_requested - skipping');
      return { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.FEEDBACK_REQUESTED, skipped: true };
    }

    // Atomic update with status precondition — session_held or confirmed → feedback_requested
    const validFromStatuses = [APPOINTMENT_STATUS.SESSION_HELD, APPOINTMENT_STATUS.CONFIRMED];
    const result = await prisma.appointmentRequest.updateMany({
      where: {
        id: appointmentId,
        status: { in: validFromStatuses },
      },
      data: {
        status: APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
        feedbackFormSentAt: new Date(),
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      logger.warn(
        { ...logContext, currentStatus: previousStatus },
        `Invalid transition: ${previousStatus} → feedback_requested (only session_held or confirmed allowed)`
      );
      throw new InvalidTransitionError(previousStatus, 'feedback_requested');
    }

    // If transitioning from confirmed (skipping session_held), fire the
    // onSessionHeld side effects so the user's Notion record is synced
    if (previousStatus === APPOINTMENT_STATUS.CONFIRMED) {
      await transitionSideEffectsService.onSessionHeld({
        appointmentId,
        source,
        adminId,
        userEmail: appointment.userEmail,
      });
    }

    // Add audit trail (conversation-state JSON message + status_change audit event row).
    // Independent writes — run in parallel.
    await Promise.all([
      this.addAuditMessage(
        appointmentId,
        source,
        `Status changed: ${previousStatus} → feedback_requested`,
        adminId,
      ),
      this.recordStatusChangeEvent(
        appointmentId,
        source,
        adminId,
        previousStatus,
        APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
      ),
    ]);

    logger.info({ ...logContext, previousStatus }, 'Appointment transitioned to feedback_requested');

    const transition: TransitionResult = { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.FEEDBACK_REQUESTED };
    this.notifyTransition(transition, appointmentId, source);
    return transition;
  }

  /**
   * Transition: confirmed | session_held | feedback_requested → completed
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

      // Validate state machine transition
      const validStatuses: string[] = validFromStatuses;
      if (!validStatuses.includes(appointment.status)) {
        throw new InvalidTransitionError(appointment.status, 'completed');
      }

      // Build updated notes
      const updatedNotes = note
        ? appointment.notes
          ? `${note}\n\n${appointment.notes}`
          : note
        : appointment.notes;

      // Update appointment record within transaction.
      // Clear rescheduling state — completion is terminal, no reschedule should remain active.
      await tx.appointmentRequest.update({
        where: { id: appointmentId },
        data: {
          status: APPOINTMENT_STATUS.COMPLETED,
          notes: updatedNotes,
          updatedAt: new Date(),
          reschedulingInProgress: false,
          reschedulingInitiatedBy: null,
        },
        select: { id: true },
      });

      // Create audit log within transaction for atomicity
      await tx.appointmentAuditEvent.create({
        data: {
          appointmentRequestId: appointmentId,
          eventType: 'status_change',
          actor: source === 'admin' ? `admin:${adminId || 'unknown'}` : source,
          payload: {
            previousStatus,
            newStatus: APPOINTMENT_STATUS.COMPLETED,
            reason: note,
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

    // If completing from confirmed (skipping session_held), fire the
    // onSessionHeld side effects so the user's Notion record is synced
    if (previousStatus === APPOINTMENT_STATUS.CONFIRMED) {
      await transitionSideEffectsService.onSessionHeld({
        appointmentId,
        source,
        adminId,
        userEmail: appointment.userEmail,
      });
    }

    // Post-transition side effects (therapist booking status, Notion sync, deactivation)
    transitionSideEffectsService.onCompleted({
      appointmentId,
      source,
      adminId,
      therapistNotionId: appointment.therapistNotionId,
      therapistName: appointment.therapistName,
      userEmail: appointment.userEmail,
      userName: appointment.userName,
      previousStatus,
    });

    // Send Slack notification (delegated to notifications service)
    appointmentNotificationsService.notifyCompleted({
      appointmentId,
      source,
      adminId,
      userName: appointment.userName,
      therapistName: appointment.therapistName,
      feedbackSubmissionId,
      feedbackData,
    });

    const transition: TransitionResult = { success: true, previousStatus, newStatus: APPOINTMENT_STATUS.COMPLETED };
    this.notifyTransition(transition, appointmentId, source);
    return transition;
  }

  /**
   * Transition: pending | contacted | negotiating | confirmed | session_held | feedback_requested → cancelled
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
    const { appointmentId, reason, cancelledBy, source, adminId, atomic, skipNotifications } = params;
    const logContext = { appointmentId, source, adminId, cancelledBy };

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
        confirmed_date_time_parsed: Date | null;
        gmail_thread_id: string | null;
        therapist_gmail_thread_id: string | null;
      };

      let appointment: AppointmentRow | null;
      try {
        const rows = await tx.$queryRaw<AppointmentRow[]>`
          SELECT id, status, user_name, user_email, therapist_name, therapist_email,
                 therapist_notion_id, human_control_enabled, notes,
                 confirmed_date_time, confirmed_date_time_parsed,
                 gmail_thread_id, therapist_gmail_thread_id
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
            confirmedDateTimeParsed: appointment.confirmed_date_time_parsed,
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

      // Update appointment record within transaction.
      // Clear rescheduling state and follow-up sentinels — cancellation is terminal,
      // so no rescheduling or follow-up should remain active.
      await tx.appointmentRequest.update({
        where: { id: appointmentId },
        data: {
          status: APPOINTMENT_STATUS.CANCELLED,
          notes: updatedNotes,
          updatedAt: new Date(),
          // Clear rescheduling state — cancellation supersedes any in-progress reschedule
          reschedulingInProgress: false,
          reschedulingInitiatedBy: null,
        },
        select: { id: true },
      });

      // Create audit log within transaction for atomicity
      await tx.appointmentAuditEvent.create({
        data: {
          appointmentRequestId: appointmentId,
          eventType: 'status_change',
          actor: source === 'admin' ? `admin:${adminId || 'unknown'}` : source,
          payload: {
            previousStatus,
            newStatus: APPOINTMENT_STATUS.CANCELLED,
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
          userEmail: appointment.user_email,
          therapistName: appointment.therapist_name,
          therapistEmail: appointment.therapist_email,
          therapistNotionId: appointment.therapist_notion_id,
          confirmedDateTime: appointment.confirmed_date_time,
          confirmedDateTimeParsed: appointment.confirmed_date_time_parsed,
          gmailThreadId: appointment.gmail_thread_id,
          therapistGmailThreadId: appointment.therapist_gmail_thread_id,
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

    // Post-transition side effects (therapist booking status, Notion sync, deactivation)
    transitionSideEffectsService.onCancelled({
      appointmentId,
      source,
      adminId,
      therapistNotionId: appointment.therapistNotionId,
      wasConfirmed,
      userEmail: appointment.userEmail,
    });

    // Send Slack + email notifications (delegated to notifications service).
    // Skipped when the caller wants to fire its own specialized notification
    // (e.g. bounce handler) — data-consistency side effects above still run.
    if (!skipNotifications) {
      appointmentNotificationsService.notifyCancelled({
        appointmentId,
        source,
        adminId,
        cancelledBy,
        reason,
        userName: appointment.userName,
        userEmail: appointment.userEmail,
        therapistName: appointment.therapistName,
        therapistEmail: appointment.therapistEmail,
        confirmedDateTime: appointment.confirmedDateTime,
        confirmedDateTimeParsed: appointment.confirmedDateTimeParsed,
        gmailThreadId: appointment.gmailThreadId,
        therapistGmailThreadId: appointment.therapistGmailThreadId,
      });
    }

    const transitionResult: TransitionResult = { success: true, previousStatus: result.previousStatus, newStatus: APPOINTMENT_STATUS.CANCELLED };
    this.notifyTransition(transitionResult, appointmentId, source);
    return transitionResult;
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

    let result: TransitionResult;

    switch (newStatus) {
      case APPOINTMENT_STATUS.CONTACTED:
        result = await this.transitionToContacted({
          appointmentId,
          source,
          adminId,
          hasAvailability: false,
        });
        break;

      case APPOINTMENT_STATUS.NEGOTIATING:
        result = await this.transitionToNegotiating({
          appointmentId,
          source,
          adminId,
        });
        break;

      case APPOINTMENT_STATUS.CONFIRMED:
        if (!confirmedDateTime) {
          throw new Error('confirmedDateTime is required for confirmed status');
        }
        result = await this.transitionToConfirmed({
          appointmentId,
          confirmedDateTime,
          confirmedDateTimeParsed,
          source,
          adminId,
          sendEmails,
        });
        break;

      case APPOINTMENT_STATUS.SESSION_HELD:
        result = await this.transitionToSessionHeld({
          appointmentId,
          source,
          adminId,
        });
        break;

      case APPOINTMENT_STATUS.FEEDBACK_REQUESTED:
        result = await this.transitionToFeedbackRequested({
          appointmentId,
          source,
          adminId,
        });
        break;

      case APPOINTMENT_STATUS.COMPLETED:
        result = await this.transitionToCompleted({
          appointmentId,
          source,
          adminId,
          note: reason,
        });
        break;

      case APPOINTMENT_STATUS.CANCELLED:
        result = await this.transitionToCancelled({
          appointmentId,
          reason: reason || 'No reason provided',
          cancelledBy: source === 'admin' ? 'admin' : 'system',
          source,
          adminId,
        });
        break;

      default:
        throw new Error(`Unknown status: ${newStatus}`);
    }

    return result;
  }

  /**
   * Force-update an appointment's status and/or confirmedDateTime, bypassing state machine
   * validation. Used by the admin appointments page where admins need unrestricted control.
   *
   * GUARDRAILS:
   * - `bypassStateMachine: true` is REQUIRED on every call. The flag exists
   *   to make accidental new callers impossible — the type system rejects
   *   omitting it, and routine updates should go through updateStatus()
   *   instead.
   * - `reason` is REQUIRED when bypassStateMachine is set. The reason is
   *   logged loudly, persisted to the audit trail, and (for status changes)
   *   sent as a high-severity Slack alert so any non-routine bypass is
   *   visible to the team.
   *
   * Always performs: audit trail, SSE notification, confirmedAt timestamp management,
   * therapist booking status updates, Notion sync (data consistency).
   * Optionally performs: emails, Slack (controlled by skipNotifications, default true).
   */
  async adminForceUpdate(
    appointmentId: string,
    options: {
      newStatus?: AppointmentStatus;
      confirmedDateTime?: string | null;
      confirmedDateTimeParsed?: Date | null;
      adminId: string;
      /** Required acknowledgement that this call bypasses state machine validation. */
      bypassStateMachine: true;
      /** Required justification — logged + audited + (for status changes) Slack-alerted. */
      reason: string;
      skipNotifications?: boolean;
    }
  ): Promise<TransitionResult> {
    const { newStatus, confirmedDateTime, confirmedDateTimeParsed, adminId, reason, bypassStateMachine } = options;
    const skipNotifications = options.skipNotifications ?? true;
    const logContext = { appointmentId, adminId };

    // Runtime checks defend against the route layer constructing this
    // options object from a request body (where TypeScript can't enforce
    // the literal-true type) or any caller using `as any`.
    if (bypassStateMachine !== true) {
      throw new Error('adminForceUpdate requires bypassStateMachine: true');
    }
    if (!reason || reason.trim().length === 0) {
      throw new Error('adminForceUpdate requires a non-empty reason');
    }

    // Loud warning so any bypass shows up in logs at WARN level (not just info).
    logger.warn(
      { ...logContext, reason, newStatus, confirmedDateTime },
      'STATE MACHINE BYPASS: adminForceUpdate called'
    );

    // Use transaction with FOR UPDATE NOWAIT row lock to prevent TOCTOU races.
    // Without this, another process could change the status between our read and write,
    // causing side effects to fire based on a stale previousStatus.
    type AdminForceUpdateRow = {
      id: string;
      status: string;
      confirmed_date_time: string | null;
      confirmed_at: Date | null;
      user_name: string | null;
      user_email: string;
      therapist_name: string;
      therapist_email: string | null;
      therapist_notion_id: string;
    };

    let appointment!: {
      id: string;
      status: string;
      confirmedDateTime: string | null;
      confirmedAt: Date | null;
      userName: string | null;
      userEmail: string;
      therapistName: string;
      therapistEmail: string | null;
      therapistNotionId: string;
    };
    // Track whether sentinel fields were reset inside the transaction for audit trail
    let sentinelFieldsReset = false;

    await prisma.$transaction(async (tx) => {
      // Lock the row with FOR UPDATE NOWAIT to prevent concurrent modifications
      let row: AdminForceUpdateRow | null;
      try {
        const rows = await tx.$queryRaw<AdminForceUpdateRow[]>`
          SELECT id, status, confirmed_date_time, confirmed_at, user_name, user_email,
                 therapist_name, therapist_email, therapist_notion_id
          FROM "appointment_requests"
          WHERE id = ${appointmentId}
          FOR UPDATE NOWAIT
        `;
        row = rows[0] || null;
      } catch (lockError) {
        throw new ConcurrentModificationError(appointmentId);
      }

      if (!row) {
        throw new AppointmentNotFoundError(appointmentId);
      }

      // Map snake_case DB columns to camelCase
      appointment = {
        id: row.id,
        status: row.status,
        confirmedDateTime: row.confirmed_date_time,
        confirmedAt: row.confirmed_at,
        userName: row.user_name,
        userEmail: row.user_email,
        therapistName: row.therapist_name,
        therapistEmail: row.therapist_email,
        therapistNotionId: row.therapist_notion_id,
      };

      const previousStatus = appointment.status as AppointmentStatus;
      const statusChanging = newStatus && newStatus !== previousStatus;
      const dateChanging = confirmedDateTime !== undefined && confirmedDateTime !== appointment.confirmedDateTime;

      if (!statusChanging && !dateChanging) {
        return; // Will handle the early return after the transaction
      }

      // Build typed update data
      const updateData: Parameters<typeof prisma.appointmentRequest.update>[0]['data'] = {
        updatedAt: new Date(),
        lastActivityAt: new Date(),
      };

      if (statusChanging) {
        updateData.status = newStatus;
        if (newStatus === APPOINTMENT_STATUS.CONFIRMED && !appointment.confirmedAt) {
          updateData.confirmedAt = new Date();
        }

        // Reset follow-up sentinel fields when moving backwards past the stage they guard.
        // Without this, automated services (post-booking follow-up) would skip re-sending
        // emails because the sentinel is already set from the first pass through the lifecycle.
        const prevIdx = LIFECYCLE_STATUS_ORDER.indexOf(previousStatus);
        const newIdx = LIFECYCLE_STATUS_ORDER.indexOf(newStatus);
        const movingBackwards = newIdx >= 0 && prevIdx >= 0 && newIdx < prevIdx;

        if (movingBackwards) {
          // Moving back to confirmed or earlier, from past confirmed → reset post-confirmation emails
          if (newIdx <= CONFIRMED_IDX && prevIdx > CONFIRMED_IDX) {
            updateData.meetingLinkCheckSentAt = null;
            updateData.reminderSentAt = null;
            sentinelFieldsReset = true;
          }

          // Moving back before feedback_requested, from at-or-past it → reset feedback emails
          if (newIdx < FEEDBACK_IDX && prevIdx >= FEEDBACK_IDX) {
            updateData.feedbackFormSentAt = null;
            updateData.feedbackReminderSentAt = null;
            sentinelFieldsReset = true;
          }
        }

        // Terminal statuses (completed/cancelled) supersede any in-progress reschedule.
        // Clear rescheduling state so the record is clean. Note: cancelled is not in
        // LIFECYCLE_STATUS_ORDER so the movingBackwards logic above doesn't cover it.
        if (newStatus === APPOINTMENT_STATUS.COMPLETED || newStatus === APPOINTMENT_STATUS.CANCELLED) {
          updateData.reschedulingInProgress = false;
          updateData.reschedulingInitiatedBy = null;
        }

        // Clear stale flag on any transition to confirmed or beyond —
        // stale only applies to pre-confirmation statuses
        const confirmedIdx = LIFECYCLE_STATUS_ORDER.indexOf(APPOINTMENT_STATUS.CONFIRMED);
        const targetIdx = LIFECYCLE_STATUS_ORDER.indexOf(newStatus);
        if (targetIdx >= confirmedIdx || newStatus === APPOINTMENT_STATUS.CANCELLED) {
          updateData.isStale = false;
        }
      }

      if (dateChanging) {
        updateData.confirmedDateTime = confirmedDateTime;
        updateData.confirmedDateTimeParsed = confirmedDateTimeParsed ?? null;

        // When clearing the date on an active appointment, mark as rescheduling
        const effectiveStatus = newStatus || previousStatus;
        const isActiveStatus = effectiveStatus !== APPOINTMENT_STATUS.COMPLETED && effectiveStatus !== APPOINTMENT_STATUS.CANCELLED;
        if (!confirmedDateTime && isActiveStatus && appointment.confirmedDateTime) {
          updateData.reschedulingInProgress = true;
          updateData.previousConfirmedDateTime = appointment.confirmedDateTime;
          updateData.reschedulingInitiatedBy = `admin:${adminId}`;
          updateData.checkpointStage = 'rescheduling';
        }

        // When setting a new date, clear the rescheduling flag
        if (confirmedDateTime) {
          updateData.reschedulingInProgress = false;
          updateData.reschedulingInitiatedBy = null;
        }
      }

      await tx.appointmentRequest.update({
        where: { id: appointmentId },
        data: updateData,
        select: { id: true }, // Minimal select to avoid RETURNING columns that may not exist in DB yet
      });
    }, {
      maxWait: 5000,
      timeout: 10000,
    });

    if (!appointment) {
      throw new AppointmentNotFoundError(appointmentId);
    }

    const previousStatus = appointment.status as AppointmentStatus;
    const statusChanging = newStatus && newStatus !== previousStatus;
    const dateChanging = confirmedDateTime !== undefined && confirmedDateTime !== appointment.confirmedDateTime;

    if (!statusChanging && !dateChanging) {
      return { success: true, previousStatus, newStatus: previousStatus, skipped: true };
    }

    // Audit trail
    const effectiveNewStatus = newStatus || previousStatus;
    const auditParts: string[] = [];
    if (statusChanging) {
      auditParts.push(`Status changed: ${previousStatus} → ${newStatus}`);
      if (sentinelFieldsReset) {
        auditParts.push('Follow-up email flags reset (moved backwards in lifecycle)');
      }
    }
    if (dateChanging) {
      auditParts.push(`Date/time updated: ${appointment.confirmedDateTime || 'none'} → ${confirmedDateTime || 'none'}`);
    }
    if (reason) {
      auditParts.push(`Reason: ${reason}`);
    }
    await this.addAuditMessage(appointmentId, 'admin', auditParts.join('. '), adminId);

    // Emit a status_change row when status actually changes, so a query for
    // "all status transitions for this appointment" picks up admin overrides
    // alongside the normal lifecycle transitions. The dedicated
    // `admin_force_update` checkpoint event below carries the bypass-specific
    // metadata (Slack alert, bypassed-state-machine flag) — both are needed
    // because they answer different questions.
    if (statusChanging) {
      await this.recordStatusChangeEvent(
        appointmentId,
        'admin',
        adminId,
        previousStatus,
        effectiveNewStatus as AppointmentStatus,
        reason,
      );
    }

    // SSE notification
    if (statusChanging) {
      transitionSideEffectsService.notifyTransition(
        { success: true, previousStatus, newStatus: effectiveNewStatus as AppointmentStatus },
        appointmentId,
        'admin'
      );
    }

    // --- Data-consistency side effects (always run when status changes) ---
    if (statusChanging) {
      transitionSideEffectsService.onAdminForceUpdate({
        appointmentId,
        source: 'admin',
        adminId,
        appointment,
        previousStatus,
        newStatus: effectiveNewStatus as AppointmentStatus,
        skipNotifications,
        confirmedDateTime: confirmedDateTime ?? appointment.confirmedDateTime,
      });
    }

    logger.info(
      { ...logContext, previousStatus, newStatus: effectiveNewStatus, confirmedDateTime, reason, skipNotifications },
      'Appointment force-updated by admin (state machine bypassed)'
    );

    // Audit + Slack alert for visibility. Only the status-change case sends
    // a Slack alert (severity=high) — date-only edits are routine and would
    // be alert spam. Audit log fires for both so the bypass is always traceable.
    const isStatusChange = !!(newStatus && newStatus !== previousStatus);
    await recordAppointmentEvent({
      appointmentId,
      type: 'admin_force_update',
      actor: 'admin',
      reason,
      payload: {
        adminId,
        previousStatus,
        newStatus: effectiveNewStatus,
        confirmedDateTime,
        bypassedStateMachine: true,
      },
      ...(isStatusChange && {
        slack: {
          title: 'Admin force-updated appointment status (state machine bypassed)',
          severity: 'high',
          details:
            `An admin used the force-update path to change status from ` +
            `*${previousStatus}* to *${effectiveNewStatus}*, bypassing state machine ` +
            `validation. This path skips the normal lifecycle guards — ensure the ` +
            `outcome is correct.\n\nReason: ${reason}`,
          additionalFields: {
            'Admin': adminId,
            'Appointment': appointmentId,
          },
        },
      }),
    });

    return { success: true, previousStatus, newStatus: effectiveNewStatus as AppointmentStatus };
  }

  /**
   * Dismiss a pending closure recommendation and reset chase state so the
   * conversation can resume. Used by both the admin "Dismiss" action and the
   * automated path that fires when an incoming reply arrives on a closure-
   * recommended thread (the recommendation is stale by definition once the
   * other party responds).
   *
   * This is NOT a state-machine status transition — closure flags live alongside
   * `status` rather than within it, so we don't go through transitionSideEffectsService.
   *
   * Two paths can set closure_recommended, and they handle the JSON checkpoint
   * differently — both must be reconciled here:
   *
   * 1. **Chase-recommended** (chase-email.service.ts): writes only the
   *    denormalized DB column `checkpointStage = 'closure_recommended'`. The
   *    JSON `conversationState.checkpoint.stage` is left unchanged.
   * 2. **Agent-recommended** (recommend_cancel_match tool → agent-tool-loop):
   *    routes through `updateCheckpoint`, which writes BOTH the JSON and
   *    (via storeConversationState's extractConversationMeta) the DB column.
   *
   * In path #2, leaving the JSON wedged at `closure_recommended` would cause the
   * system prompt to tell the agent "wait for admin action" forever — even after
   * we clear the DB column, the next agent save would re-derive the column from
   * the JSON and undo our dismissal. So we reconcile the JSON checkpoint via
   * aiConversationService (with optimistic locking) when it's stuck in the
   * closure stage, restoring it to whatever stage `lastSuccessfulAction` maps
   * to (or a sensible default).
   *
   * Reporting fidelity: we DO NOT null `closureRecommendedAt` / `closureRecommendedReason`.
   * Those are historical records used by work-report and the daily Slack summary.
   * Instead we set `closureRecommendationActioned = true` (mirroring the admin
   * "cancel" path) and rely on chase-email's filter to use that flag for gating.
   *
   * Idempotent: returns { dismissed: false } when there's nothing to dismiss.
   */
  async dismissClosureRecommendation(
    params: BaseTransitionParams
  ): Promise<{ dismissed: boolean; previousStage?: string; restoredStage?: string | null }> {
    const { appointmentId, source, adminId, reason } = params;

    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: {
        closureRecommendedAt: true,
        closureRecommendationActioned: true,
        checkpointStage: true,
        chaseSentTo: true,
        humanControlTakenBy: true,
      },
    });

    if (!appointment || !appointment.closureRecommendedAt || appointment.closureRecommendationActioned) {
      return { dismissed: false };
    }

    const previousStage = appointment.checkpointStage || 'closure_recommended';

    // Atomic: reconcile JSON checkpoint + derive column + clear closure/chase fields.
    // The JSON checkpoint is the source of truth — we mutate it in the callback
    // and the helper derives the column from the result. We preserve
    // closureRecommendedAt and closureRecommendedReason for historical reporting
    // (work-report counts per period); the actionable signal is
    // closureRecommendationActioned.
    const result = await aiConversationService.applyCheckpointUpdate(
      appointmentId,
      (current) => {
        // Only rewrite the JSON checkpoint if it was actually at closure_recommended
        // (the chase-recommended path leaves the JSON at the underlying stage).
        // For everything else, keep the checkpoint as-is and let the helper
        // derive the column from it.
        if (current?.stage === 'closure_recommended') {
          const restoredStage = inferRestoredStage(current, appointment.chaseSentTo);
          return {
            ...current,
            stage: restoredStage,
            pendingAction: null,
            checkpoint_at: new Date().toISOString(),
          };
        }
        return current ?? {
          stage: inferRestoredStage(null, appointment.chaseSentTo),
          lastSuccessfulAction: null,
          pendingAction: null,
          checkpoint_at: new Date().toISOString(),
        };
      },
      {
        extraUpdates: {
          closureRecommendationActioned: true,
          chaseSentAt: null,
          chaseSentTo: null,
          chaseTargetEmail: null,
          // Release agent-flagged human control so the agent can resume processing.
          // Admin-set human control is left alone — the admin opted in explicitly.
          ...(appointment.humanControlTakenBy === 'agent-flagged' && {
            humanControlEnabled: false,
          }),
        },
      },
    );

    if (!result.applied) {
      logger.warn(
        { appointmentId, source, reason },
        'Closure dismissal lost optimistic lock after retries'
      );
      return { dismissed: false };
    }

    logger.info(
      { appointmentId, source, reason, restoredStage: result.stage },
      'Closure recommendation dismissed'
    );

    // Audit event + Slack notification are emitted by the caller via
    // recordAppointmentEvent (the auto-dismiss path uses
    // 'closure_dismissed_auto', the admin manual path uses 'closure_dismissed').
    // Returning previousStage so the caller has it for the audit payload.
    return { dismissed: true, previousStage, restoredStage: result.stage };
  }
}

/**
 * Choose the stage to fall back to when dismissing a closure recommendation
 * whose JSON checkpoint is wedged at `closure_recommended`. Prefers the stage
 * implied by the previous successful action; otherwise infers from which party
 * was being chased; otherwise gives up and returns 'awaiting_therapist_availability'
 * as a safe default that the chase pipeline can re-evaluate.
 */
function inferRestoredStage(
  checkpoint: ConversationCheckpoint | undefined,
  chaseSentTo: string | null,
): ConversationStage {
  if (checkpoint?.lastSuccessfulAction) {
    const inferred = stageFromAction(checkpoint.lastSuccessfulAction);
    if (inferred !== 'closure_recommended' && inferred !== 'chased') {
      return inferred;
    }
  }
  if (chaseSentTo === 'user') return 'awaiting_user_slot_selection';
  return 'awaiting_therapist_availability';
}

export const appointmentLifecycleService = new AppointmentLifecycleService();

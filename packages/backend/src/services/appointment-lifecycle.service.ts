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
import { aiConversationService, inferRestoredStage } from './ai-conversation.service';

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
// Shared update fragments
// ============================================

/**
 * Standard "clear any in-progress reschedule" partial. Spread into update
 * data on every transition that supersedes an active reschedule:
 * confirmed (with new datetime), completed, cancelled, and adminForceUpdate
 * when moving to a terminal state or setting a new datetime.
 */
const CLEAR_RESCHEDULING_STATE = {
  reschedulingInProgress: false,
  reschedulingInitiatedBy: null,
} as const;

/**
 * Reset all four post-booking follow-up sentinels. Used by transitionToConfirmed
 * when rescheduling (the new session needs its own meeting-link check, reminder,
 * feedback form, feedback reminder).
 */
const RESET_ALL_FOLLOWUP_SENTINELS = {
  meetingLinkCheckSentAt: null,
  reminderSentAt: null,
  feedbackFormSentAt: null,
  feedbackReminderSentAt: null,
} as const;

/**
 * Compute the follow-up sentinel resets needed when an admin force-update
 * moves an appointment BACKWARDS in the lifecycle. Without these, the
 * automated post-booking services would skip re-sending emails because the
 * sentinel is already set from the first pass through.
 *
 * Called only by adminForceUpdate; the normal forward-progress transitions
 * never need to reset post-stage sentinels.
 */
function computeBackwardSentinelResets(
  fromStatus: AppointmentStatus,
  toStatus: AppointmentStatus,
): { updates: Prisma.AppointmentRequestUpdateInput; reset: boolean } {
  const fromIdx = LIFECYCLE_STATUS_ORDER.indexOf(fromStatus);
  const toIdx = LIFECYCLE_STATUS_ORDER.indexOf(toStatus);
  const movingBackwards = toIdx >= 0 && fromIdx >= 0 && toIdx < fromIdx;
  if (!movingBackwards) return { updates: {}, reset: false };

  const updates: Prisma.AppointmentRequestUpdateInput = {};
  let reset = false;

  // Moving back to confirmed-or-earlier from past-confirmed → reset
  // post-confirmation follow-ups (meeting-link check, session reminder).
  if (toIdx <= CONFIRMED_IDX && fromIdx > CONFIRMED_IDX) {
    updates.meetingLinkCheckSentAt = null;
    updates.reminderSentAt = null;
    reset = true;
  }

  // Moving back to before feedback_requested from at-or-past it → reset
  // feedback sentinels.
  if (toIdx < FEEDBACK_IDX && fromIdx >= FEEDBACK_IDX) {
    updates.feedbackFormSentAt = null;
    updates.feedbackReminderSentAt = null;
    reset = true;
  }

  return { updates, reset };
}

// ============================================
// updateStatus dispatch table
// ============================================

interface UpdateStatusOptions {
  source: TransitionSource;
  adminId?: string;
  reason?: string;
  confirmedDateTime?: string;
  confirmedDateTimeParsed?: Date | null;
  sendEmails?: boolean;
}

type UpdateStatusDispatcher = (
  service: AppointmentLifecycleService,
  appointmentId: string,
  options: UpdateStatusOptions,
) => Promise<TransitionResult>;

/**
 * Routes a generic admin/system "set the status to X" request to the matching
 * specialised transition method, with the param translation each transition
 * needs (e.g. cancellation needs `cancelledBy` derived from `source`,
 * confirmation needs the datetime, completion uses `reason` as a note).
 *
 * Defined as a const map at module scope so adding a new status forces the
 * map to be updated — TypeScript flags missing keys when AppointmentStatus
 * is extended. A switch had two pitfalls this fixes:
 *   - the cancelled branch silently defaulted `cancelledBy='system'` when
 *     `source` wasn't 'admin', which conflated agent + system cancellations;
 *   - the missing 'pending' case fell through to the default, which threw
 *     "Unknown status" instead of being explicitly rejected as a target.
 */
const UPDATE_STATUS_DISPATCH: Partial<Record<AppointmentStatus, UpdateStatusDispatcher>> = {
  [APPOINTMENT_STATUS.CONTACTED]: (service, appointmentId, opts) =>
    service.transitionToContacted({
      appointmentId,
      source: opts.source,
      adminId: opts.adminId,
      hasAvailability: false,
    }),

  [APPOINTMENT_STATUS.NEGOTIATING]: (service, appointmentId, opts) =>
    service.transitionToNegotiating({
      appointmentId,
      source: opts.source,
      adminId: opts.adminId,
    }),

  [APPOINTMENT_STATUS.CONFIRMED]: (service, appointmentId, opts) => {
    if (!opts.confirmedDateTime) {
      throw new Error('confirmedDateTime is required for confirmed status');
    }
    return service.transitionToConfirmed({
      appointmentId,
      confirmedDateTime: opts.confirmedDateTime,
      confirmedDateTimeParsed: opts.confirmedDateTimeParsed,
      source: opts.source,
      adminId: opts.adminId,
      sendEmails: opts.sendEmails,
    });
  },

  [APPOINTMENT_STATUS.SESSION_HELD]: (service, appointmentId, opts) =>
    service.transitionToSessionHeld({
      appointmentId,
      source: opts.source,
      adminId: opts.adminId,
    }),

  [APPOINTMENT_STATUS.FEEDBACK_REQUESTED]: (service, appointmentId, opts) =>
    service.transitionToFeedbackRequested({
      appointmentId,
      source: opts.source,
      adminId: opts.adminId,
    }),

  [APPOINTMENT_STATUS.COMPLETED]: (service, appointmentId, opts) =>
    service.transitionToCompleted({
      appointmentId,
      source: opts.source,
      adminId: opts.adminId,
      note: opts.reason,
    }),

  [APPOINTMENT_STATUS.CANCELLED]: (service, appointmentId, opts) =>
    service.transitionToCancelled({
      appointmentId,
      reason: opts.reason || 'No reason provided',
      // updateStatus() is currently only called from admin routes, so source
      // is always 'admin' in practice. Preserve the original mapping for any
      // hypothetical 'system' caller; agent-path cancellations call
      // transitionToCancelled directly with an explicit cancelledBy.
      cancelledBy: opts.source === 'admin' ? 'admin' : 'system',
      source: opts.source,
      adminId: opts.adminId,
    }),
};

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
   * Fire an async side-effect/notification dispatch that the caller doesn't
   * want to await. The returned promise has its rejection logged so a future
   * change that introduces an uncaught throw doesn't surface as an
   * unhandledRejection — every lifecycle dispatch goes through here.
   *
   * The dispatchers themselves (transition-side-effects, appointment-notifications)
   * have their own internal try/catches around their work and use
   * runBackgroundTask / runTrackedSideEffect for tracking individual outbound
   * calls; this is a belt-and-braces wrapper at the lifecycle boundary.
   */
  private fireAndForget(
    promise: Promise<unknown>,
    appointmentId: string,
    label: string,
  ): void {
    promise.catch((err) => {
      logger.error({ err, appointmentId, label }, 'Lifecycle fire-and-forget dispatch failed');
    });
  }

  /**
   * Shared shape for the lighter transitions (contacted, negotiating,
   * session_held, feedback_requested). These all follow the same skeleton:
   *
   *   read current → idempotent skip → atomic updateMany with precondition
   *   → optional post-update hook (for paths that re-fire side effects when
   *     skipping a stage, e.g. confirmed → feedback_requested needs the
   *     onSessionHeld effects) → audit message + status_change event in
   *     parallel → notifyTransition (SSE).
   *
   * The complex transitions (confirmed, completed, cancelled, adminForceUpdate)
   * have transactional row locks, reschedule logic, atomic options, or
   * skipNotifications and intentionally do NOT use this helper — collapsing
   * them in would force awkward branching.
   *
   * The read pulls `userEmail` alongside `id`/`status` so callers that need
   * to dispatch user-sync side effects in their `onAfterUpdate` hook don't
   * have to do a second round-trip. Methods that don't need it just ignore
   * the field.
   *
   * @param onAfterUpdate Runs after the update succeeds and before the audit
   *   writes. Use this for additional side effects that need to fire BEFORE
   *   the audit/SSE event.
   */
  private async applyLightTransition(args: {
    appointmentId: string;
    source: TransitionSource;
    adminId?: string;
    targetStatus: AppointmentStatus;
    validFromStatuses: readonly AppointmentStatus[];
    /** Extra fields to write alongside status. */
    extraData?: Prisma.AppointmentRequestUpdateInput;
    buildAuditMessage: (previousStatus: AppointmentStatus) => string;
    /** Optional reason to embed in the status_change audit event payload. */
    auditReason?: string;
    /** Runs after the atomic update succeeds, before the audit writes. */
    onAfterUpdate?: (
      previousStatus: AppointmentStatus,
      appointment: { id: string; status: string; userEmail: string },
    ) => Promise<void> | void;
  }): Promise<TransitionResult> {
    const {
      appointmentId,
      source,
      adminId,
      targetStatus,
      validFromStatuses,
      extraData,
      buildAuditMessage,
      auditReason,
      onAfterUpdate,
    } = args;
    const logContext = { appointmentId, source, adminId };

    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: { id: true, status: true, userEmail: true },
    });

    if (!appointment) {
      logger.error(logContext, `Cannot transition to ${targetStatus} - appointment not found`);
      throw new AppointmentNotFoundError(appointmentId);
    }

    const previousStatus = appointment.status as AppointmentStatus;

    if (previousStatus === targetStatus) {
      logger.debug(logContext, `Appointment already ${targetStatus} - skipping`);
      return { success: true, previousStatus, newStatus: targetStatus, skipped: true };
    }

    const updateResult = await prisma.appointmentRequest.updateMany({
      where: {
        id: appointmentId,
        status: { in: [...validFromStatuses] },
      },
      data: {
        status: targetStatus,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
        ...extraData,
      },
    });

    if (updateResult.count === 0) {
      logger.warn(
        { ...logContext, currentStatus: previousStatus },
        `Invalid transition: ${previousStatus} → ${targetStatus}`,
      );
      throw new InvalidTransitionError(previousStatus, targetStatus);
    }

    if (onAfterUpdate) {
      await onAfterUpdate(previousStatus, appointment);
    }

    // Audit writes — independent, run in parallel.
    await Promise.all([
      this.addAuditMessage(appointmentId, source, buildAuditMessage(previousStatus), adminId),
      this.recordStatusChangeEvent(appointmentId, source, adminId, previousStatus, targetStatus, auditReason),
    ]);

    logger.info({ ...logContext, previousStatus }, `Appointment transitioned to ${targetStatus}`);

    const transition: TransitionResult = { success: true, previousStatus, newStatus: targetStatus };
    this.notifyTransition(transition, appointmentId, source);
    return transition;
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
   *
   * Audit narrative accuracy note: `previousStatus` is captured from a read
   * BEFORE the atomic updateMany. For transitions with multiple valid from-
   * statuses (negotiating, confirmed, feedback_requested), a concurrent process
   * could change the actual at-write from-status — the data is still consistent
   * (the atomic guard ensures only valid-from rows are updated) but the audit
   * narrative may report the read-time previous status instead of the actual
   * at-update one. Eliminating this would require a CTE-based RETURNING update
   * or a transactional row lock on every transition. Accepted as a known minor
   * inaccuracy for forensic queries; the queryable status timeline still tells
   * the right story up to a single jump-vs-skip discrepancy in the rare race.
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
    return this.applyLightTransition({
      appointmentId,
      source,
      adminId,
      targetStatus: APPOINTMENT_STATUS.CONTACTED,
      validFromStatuses: [APPOINTMENT_STATUS.PENDING],
      buildAuditMessage: (prev) =>
        `Status changed: ${prev} → contacted (availability ${hasAvailability ? 'known' : 'unknown'})`,
      auditReason: `availability ${hasAvailability ? 'known' : 'unknown'}`,
    });
  }

  /**
   * Transition: contacted → negotiating
   *
   * Called when the user responds and negotiation begins.
   */
  async transitionToNegotiating(params: TransitionToNegotiatingParams): Promise<TransitionResult> {
    const { appointmentId, source, adminId, notes } = params;
    return this.applyLightTransition({
      appointmentId,
      source,
      adminId,
      targetStatus: APPOINTMENT_STATUS.NEGOTIATING,
      validFromStatuses: [APPOINTMENT_STATUS.CONTACTED, APPOINTMENT_STATUS.PENDING],
      extraData: notes ? { notes } : undefined,
      buildAuditMessage: (prev) => `Status changed: ${prev} → negotiating`,
      auditReason: notes,
    });
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
      // Always clear rescheduling flags when confirming.
      ...CLEAR_RESCHEDULING_STATE,
      // Clear stale flag — stale only applies to pre-confirmation statuses
      isStale: false,
    };

    // Handle reschedule-specific fields
    if (reschedule) {
      if (reschedule.previousConfirmedDateTime) {
        updateData.previousConfirmedDateTime = reschedule.previousConfirmedDateTime;
      }
      if (reschedule.resetFollowUpFlags) {
        Object.assign(updateData, RESET_ALL_FOLLOWUP_SENTINELS);
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
    this.fireAndForget(
      transitionSideEffectsService.onConfirmed({
        appointmentId,
        source,
        adminId,
        therapistNotionId: appointment.therapistNotionId,
        therapistName: appointment.therapistName,
        userEmail: appointment.userEmail,
      }),
      appointmentId,
      'onConfirmed',
    );

    // Send Slack + email notifications (delegated to notifications service)
    this.fireAndForget(
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
      }),
      appointmentId,
      'notifyConfirmed',
    );

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
    return this.applyLightTransition({
      appointmentId,
      source,
      adminId,
      targetStatus: APPOINTMENT_STATUS.SESSION_HELD,
      validFromStatuses: [APPOINTMENT_STATUS.CONFIRMED],
      buildAuditMessage: (prev) => `Status changed: ${prev} → session_held`,
      onAfterUpdate: (_prev, apt) => {
        // Post-transition side effects (Notion user sync) — moves therapist
        // from "Upcoming" to "Previous" on the user's Notion page.
        this.fireAndForget(
          transitionSideEffectsService.onSessionHeld({
            appointmentId,
            source,
            adminId,
            userEmail: apt.userEmail,
          }),
          appointmentId,
          'onSessionHeld',
        );
      },
    });
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
    return this.applyLightTransition({
      appointmentId,
      source,
      adminId,
      targetStatus: APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
      validFromStatuses: [APPOINTMENT_STATUS.SESSION_HELD, APPOINTMENT_STATUS.CONFIRMED],
      extraData: { feedbackFormSentAt: new Date() },
      buildAuditMessage: (prev) => `Status changed: ${prev} → feedback_requested`,
      onAfterUpdate: async (prev, apt) => {
        // If transitioning from confirmed (skipping session_held), fire the
        // onSessionHeld side effects so the user's Notion record is synced.
        // We await this rather than fire-and-forget so the user-sync row in
        // the side-effect tracker is registered before audit/SSE fire.
        if (prev === APPOINTMENT_STATUS.CONFIRMED) {
          await transitionSideEffectsService.onSessionHeld({
            appointmentId,
            source,
            adminId,
            userEmail: apt.userEmail,
          });
        }
      },
    });
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

    // Use serializable transaction with row-level lock for atomicity.
    // FOR UPDATE (no NOWAIT) — concurrent transitions on the same row
    // serialize naturally: the second waiter eventually sees the new status
    // and either idempotent-skips (already completed) or hits the
    // validFromStatuses guard. Brief unrelated writes (e.g. ai-conversation
    // saving conversation state) hold the row lock for tens of ms; bounded
    // by the transaction's 10s timeout below.
    const result = await prisma.$transaction(async (tx) => {
      type AppointmentRow = {
        id: string;
        status: string;
        user_name: string | null;
        user_email: string;
        therapist_name: string;
        therapist_notion_id: string;
        notes: string | null;
      };

      const rows = await tx.$queryRaw<AppointmentRow[]>`
        SELECT id, status, user_name, user_email, therapist_name, therapist_notion_id, notes
        FROM "appointment_requests"
        WHERE id = ${appointmentId}
        FOR UPDATE
      `;
      const appointment: AppointmentRow | null = rows[0] || null;

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
          ...CLEAR_RESCHEDULING_STATE,
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
    this.fireAndForget(
      transitionSideEffectsService.onCompleted({
        appointmentId,
        source,
        adminId,
        therapistNotionId: appointment.therapistNotionId,
        therapistName: appointment.therapistName,
        userEmail: appointment.userEmail,
        userName: appointment.userName,
        previousStatus,
      }),
      appointmentId,
      'onCompleted',
    );

    // Send Slack notification (delegated to notifications service)
    this.fireAndForget(
      appointmentNotificationsService.notifyCompleted({
        appointmentId,
        source,
        adminId,
        userName: appointment.userName,
        therapistName: appointment.therapistName,
        feedbackSubmissionId,
        feedbackData,
      }),
      appointmentId,
      'notifyCompleted',
    );

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

    // Cross-validate the cancelledBy ⇄ source pair so callers can't pass an
    // incoherent combination (e.g. source='agent' with cancelledBy='admin' —
    // the agent isn't an admin). Notifications and audit narrative both use
    // cancelledBy, so a mismatch here propagates a misleading record. Allowed
    // pairings reflect the actual call sites:
    //   - 'admin'  source: cancelledBy must be 'admin'
    //   - 'agent'  source: agent is acting on behalf of a party — cancelledBy
    //              must be 'client' or 'therapist'
    //   - 'system' source: cancelledBy is 'system' (cron / bounce / auto-flow)
    //              or 'client' (e.g. forwarded auto-reply that's effectively
    //              a client cancellation but wasn't admin-initiated)
    //   - 'feedback_sync' source: cancelledBy must be 'system'
    if (
      (source === 'admin' && cancelledBy !== 'admin') ||
      (source === 'agent' && cancelledBy !== 'client' && cancelledBy !== 'therapist') ||
      (source === 'feedback_sync' && cancelledBy !== 'system')
    ) {
      throw new Error(
        `Invalid cancelledBy '${cancelledBy}' for source '${source}'. ` +
          `See transitionToCancelled validation table for allowed pairings.`,
      );
    }

    // Use serializable transaction with row-level lock for atomicity.
    // FOR UPDATE (no NOWAIT) — see transitionToCompleted's comment.
    const result = await prisma.$transaction(async (tx) => {
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

      const rows = await tx.$queryRaw<AppointmentRow[]>`
        SELECT id, status, user_name, user_email, therapist_name, therapist_email,
               therapist_notion_id, human_control_enabled, notes,
               confirmed_date_time, confirmed_date_time_parsed,
               gmail_thread_id, therapist_gmail_thread_id
        FROM "appointment_requests"
        WHERE id = ${appointmentId}
        FOR UPDATE
      `;
      const appointment: AppointmentRow | null = rows[0] || null;

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

      // Check atomic conditions if provided. The post-transaction code returns
      // early on atomicSkipped without touching the appointment fields, so we
      // don't carry an `appointment` payload here — keeping it would force
      // every consumer of the success branch's appointment fields to defensively
      // narrow on a discriminator.
      if (atomic) {
        if (atomic.requireStatusNotIn && atomic.requireStatusNotIn.includes(appointment.status as AppointmentStatus)) {
          return { success: false, previousStatus, newStatus: previousStatus, atomicSkipped: true } as const;
        }

        if (atomic.requireHumanControlDisabled && appointment.human_control_enabled) {
          return { success: false, previousStatus, newStatus: previousStatus, atomicSkipped: true } as const;
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
          ...CLEAR_RESCHEDULING_STATE,
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
    this.fireAndForget(
      transitionSideEffectsService.onCancelled({
        appointmentId,
        source,
        adminId,
        therapistNotionId: appointment.therapistNotionId,
        wasConfirmed,
        userEmail: appointment.userEmail,
      }),
      appointmentId,
      'onCancelled',
    );

    // Send Slack + email notifications (delegated to notifications service).
    // Skipped when the caller wants to fire its own specialized notification
    // (e.g. bounce handler) — data-consistency side effects above still run.
    if (!skipNotifications) {
      this.fireAndForget(
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
        }),
        appointmentId,
        'notifyCancelled',
      );
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
    const dispatch = UPDATE_STATUS_DISPATCH[newStatus];
    if (!dispatch) {
      throw new Error(`Unknown status: ${newStatus}`);
    }
    return dispatch(this, appointmentId, options);
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
    // adminId carries through to the audit message ("[Admin: <id>]"), the
    // status_change event payload, and the Slack alert "additionalFields".
    // An empty string would render as "Admin: " — validate to keep the bypass
    // record traceable.
    if (!adminId || adminId.trim().length === 0) {
      throw new Error('adminForceUpdate requires a non-empty adminId');
    }

    // Loud warning so any bypass shows up in logs at WARN level (not just info).
    logger.warn(
      { ...logContext, reason, newStatus, confirmedDateTime },
      'STATE MACHINE BYPASS: adminForceUpdate called'
    );

    // Use transaction with FOR UPDATE row lock to prevent TOCTOU races.
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
      // Lock the row with FOR UPDATE (no NOWAIT — see transitionToCompleted
      // comment) to prevent concurrent modifications.
      const rows = await tx.$queryRaw<AdminForceUpdateRow[]>`
        SELECT id, status, confirmed_date_time, confirmed_at, user_name, user_email,
               therapist_name, therapist_email, therapist_notion_id
        FROM "appointment_requests"
        WHERE id = ${appointmentId}
        FOR UPDATE
      `;
      const row: AdminForceUpdateRow | null = rows[0] || null;

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

        // Reset follow-up sentinel fields when moving backwards past the stage
        // they guard. Without this, automated services (post-booking follow-up)
        // would skip re-sending emails because the sentinel is already set
        // from the first pass through the lifecycle.
        const backwardResets = computeBackwardSentinelResets(previousStatus, newStatus);
        Object.assign(updateData, backwardResets.updates);
        if (backwardResets.reset) {
          sentinelFieldsReset = true;
        }

        // Terminal statuses (completed/cancelled) supersede any in-progress reschedule.
        // Clear rescheduling state so the record is clean.
        if (newStatus === APPOINTMENT_STATUS.COMPLETED || newStatus === APPOINTMENT_STATUS.CANCELLED) {
          Object.assign(updateData, CLEAR_RESCHEDULING_STATE);
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
          Object.assign(updateData, CLEAR_RESCHEDULING_STATE);
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

    // Side effects + SSE in the same order other transitions use:
    // queue side effects first, then emit SSE last so listeners see the
    // status-change event after the data-consistency work has been kicked off.
    if (statusChanging) {
      this.fireAndForget(
        transitionSideEffectsService.onAdminForceUpdate({
          appointmentId,
          source: 'admin',
          adminId,
          appointment,
          previousStatus,
          newStatus: effectiveNewStatus as AppointmentStatus,
          skipNotifications,
          confirmedDateTime: confirmedDateTime ?? appointment.confirmedDateTime,
        }),
        appointmentId,
        'onAdminForceUpdate',
      );

      transitionSideEffectsService.notifyTransition(
        { success: true, previousStatus, newStatus: effectiveNewStatus as AppointmentStatus },
        appointmentId,
        'admin'
      );
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

export const appointmentLifecycleService = new AppointmentLifecycleService();

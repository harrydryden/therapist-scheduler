/**
 * Public types for the appointment lifecycle.
 *
 * Defines the source-of-transition discriminant, the parameter shapes
 * for each transition method, and the result shape returned by every
 * transition (whether successful, idempotently skipped, or atomically
 * skipped due to a concurrent writer winning the race).
 */

import type { AppointmentStatus } from '../../../constants';

/**
 * What triggered the transition. Drives audit-event actor, log messages,
 * and (for cancel) the cancelledBy validation table.
 *
 *   - 'agent'         — the AI booking/availability agent acting on behalf of a party
 *   - 'admin'         — an admin via the dashboard
 *   - 'system'        — automated path (cron, scanner, bounce, post-booking follow-up)
 *   - 'feedback_sync' — narrow case: feedback-submission auto-completion path
 */
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
   * Data-consistency side effects (therapist unfreeze, audit trail) still
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
  /** True if transition was skipped (idempotent — caller observed already-target state) */
  skipped?: boolean;
  /** True if atomic update failed (another process won) */
  atomicSkipped?: boolean;
  warning?: string;
}

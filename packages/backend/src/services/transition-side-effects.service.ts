/**
 * Transition Side Effects Service
 *
 * Extracted from AppointmentLifecycleService to separate post-transition
 * side effects from state machine logic.
 *
 * This service handles non-transactional operations that run AFTER a status
 * transition has been committed:
 * - Therapist booking status updates (freeze/unfreeze)
 * - SSE broadcast of status changes
 *
 * Notifications (Slack/email) are handled by appointment-notifications.service.ts.
 *
 * All operations here are non-fatal: failures are logged but never cause
 * the transition to be rolled back.
 *
 * Note: a therapist's `active` flag (their visibility on the public booking
 * page) is deliberately NOT touched here. It is an admin-only toggle,
 * decoupled from the appointment lifecycle — terminating a therapist's last
 * appointment (cancel/complete) must not hide them from the finder.
 */

import { logger } from '../utils/logger';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { APPOINTMENT_STATUS, AppointmentStatus } from '../constants';
import { sseService } from './sse.service';
import { appointmentNotificationsService } from './appointment-notifications.service';
import { runTrackedSideEffect } from './side-effect-harness';
import type { TransitionSource, TransitionResult } from '../domain/scheduling/lifecycle';

// ============================================
// Parameter Types
// ============================================

export interface SideEffectContext {
  appointmentId: string;
  source: TransitionSource;
  adminId?: string;
}

export interface OnConfirmedParams extends SideEffectContext {
  therapistHandle: string | null;
  therapistName: string | null;
  userEmail: string;
}

export interface OnSessionHeldParams extends SideEffectContext {
  userEmail: string;
}

export interface OnCompletedParams extends SideEffectContext {
  therapistHandle: string | null;
  therapistName: string;
  userEmail: string;
  userName: string | null;
  previousStatus: AppointmentStatus;
}

export interface OnCancelledParams extends SideEffectContext {
  therapistHandle: string | null;
  wasConfirmed: boolean;
  userEmail: string;
}

export interface OnAdminForceUpdateParams extends SideEffectContext {
  appointment: {
    therapistHandle: string | null;
    therapistName: string | null;
    userName: string | null;
    userEmail: string;
    therapistEmail: string | null;
  };
  previousStatus: AppointmentStatus;
  newStatus: AppointmentStatus;
  skipNotifications: boolean;
  confirmedDateTime: string | null | undefined;
}

// ============================================
// Service Implementation
// ============================================

class TransitionSideEffectsService {
  /**
   * Emit an SSE event for a successful status transition.
   */
  notifyTransition(result: TransitionResult, appointmentId: string, source: TransitionSource): void {
    if (result.success && !result.skipped && !result.atomicSkipped) {
      sseService.emitStatusChange(appointmentId, result.previousStatus, result.newStatus, source);
    }
  }

  /**
   * Side effects after a successful confirmation.
   *
   * NOTE (target-availability model): markConfirmed is now a NO-OP. A
   * confirmed appointment is an ACTIVE status, so the availability rule
   * already treats the therapist as unavailable (serial guard) with no
   * flag to set — see therapist-booking-status.service.ts and
   * docs/THERAPIST_TARGET_AVAILABILITY.md. The tracked side-effect and its
   * retry row are retained only so existing call sites/idempotency keys stay
   * stable; they can be removed in a later cleanup.
   */
  async onConfirmed(params: OnConfirmedParams): Promise<void> {
    const { appointmentId, therapistHandle, therapistName, userEmail } = params;

    if (therapistHandle) {
      runTrackedSideEffect(
        appointmentId,
        'confirmed',
        'therapist_freeze_sync',
        () => therapistBookingStatusService.markConfirmed(
          therapistHandle,
          therapistName ?? 'unknown therapist',
        ),
        {
          name: 'therapist-freeze-sync',
          context: { appointmentId, therapistHandle },
        },
      );
    }
    // userEmail intentionally unused — the Notion user sync that consumed it
    // was retired with the Notion deprecation.
    void userEmail;
  }

  /**
   * Side effects after a successful session_held transition.
   *
   * Previously synced the user record to Notion (moving the therapist
   * from "Upcoming" to "Previous" on their Notion page). With Notion
   * retired, this transition has no Postgres-side action — the
   * appointment status itself is the canonical signal.
   */
  async onSessionHeld(params: OnSessionHeldParams): Promise<void> {
    const { appointmentId, source, adminId, userEmail } = params;
    const logContext = { appointmentId, source, adminId, userEmail };
    logger.debug(logContext, 'session_held: no remaining side effects');
  }

  /**
   * Side effects after a successful completion:
   * - Clear therapist confirmed status (unfreeze for other bookings)
   * - Recalculate therapist request count
   *
   * Note: does NOT change the therapist's `active` flag. Completing a
   * therapist's last appointment must not remove them from the public
   * booking page — visibility is an admin-only toggle.
   */
  async onCompleted(params: OnCompletedParams): Promise<void> {
    const { appointmentId, therapistHandle, userEmail } = params;

    if (therapistHandle) {
      // Routed through the side-effect tracker so a Postgres flap during
      // these writes doesn't strand the therapist as confirmed-or-frozen
      // for a closed appointment. The retry runner re-runs failed rows.
      // The two steps share a single tracked task (one retry unit) so
      // partial-progress on retry doesn't fork into two separate retry
      // schedules. Both inner ops are idempotent.
      runTrackedSideEffect(
        appointmentId,
        'completed',
        'therapist_unfreeze_sync',
        async () => {
          await therapistBookingStatusService.unmarkConfirmed(therapistHandle);
          await therapistBookingStatusService.recalculateUniqueRequestCount(therapistHandle);
        },
        {
          name: 'therapist-unfreeze-completion',
          context: { appointmentId, therapistHandle },
        },
      );
    }

    // userEmail intentionally unused — the Notion user sync that consumed it
    // was retired with the Notion deprecation.
    void userEmail;
  }

  /**
   * Side effects after a successful cancellation:
   * - Unmark therapist as confirmed (unconditionally — see below)
   * - Recalculate therapist booking status
   *
   * Note: does NOT change the therapist's `active` flag. Cancelling a
   * therapist's last appointment must not remove them from the public
   * booking page — visibility is an admin-only toggle.
   *
   * NOTE (target-availability model): unmarkConfirmed and
   * recalculateUniqueRequestCount are now NO-OPS — availability re-derives
   * from appointment status + the completed-client target, so terminating a
   * booking automatically frees the therapist without a flag to clear (see
   * therapist-booking-status.service.ts). The tracked side-effect rows are
   * retained only for call-site/idempotency stability and can be removed in a
   * later cleanup. `active` flag visibility remains an admin-only toggle.
   *
   * Same retry semantics as onCompleted — failed writes are re-driven
   * by the side-effect retry runner.
   */
  async onCancelled(params: OnCancelledParams): Promise<void> {
    const { appointmentId, therapistHandle, wasConfirmed, userEmail } = params;

    if (therapistHandle) {
      runTrackedSideEffect(
        appointmentId,
        'cancelled',
        'therapist_unfreeze_sync',
        async () => {
          await therapistBookingStatusService.unmarkConfirmed(therapistHandle);
          await therapistBookingStatusService.recalculateUniqueRequestCount(therapistHandle);
        },
        {
          name: 'therapist-unfreeze-cancellation',
          context: { appointmentId, therapistHandle, wasConfirmed },
        },
      );
    }
    // userEmail intentionally unused — the Notion user sync that consumed it
    // was retired with the Notion deprecation.
    void userEmail;
  }

  /**
   * Side effects for admin force updates.
   * Ensures therapist booking status and Notion stay in sync regardless of
   * whether the status change went through the normal state machine.
   */
  async onAdminForceUpdate(params: OnAdminForceUpdateParams): Promise<void> {
    const {
      appointmentId,
      source,
      adminId,
      appointment,
      previousStatus,
      newStatus,
      skipNotifications,
      confirmedDateTime,
    } = params;
    const logContext = { appointmentId, source, adminId };

    const wasConfirmed = previousStatus === APPOINTMENT_STATUS.CONFIRMED;
    const nowConfirmed = newStatus === APPOINTMENT_STATUS.CONFIRMED;
    const nowCompleted = newStatus === APPOINTMENT_STATUS.COMPLETED;
    const nowCancelled = newStatus === APPOINTMENT_STATUS.CANCELLED;

    // --- Therapist booking status ---
    // Updates freeze/unfreeze flags only. The therapist's `active` flag
    // (public booking-page visibility) is deliberately left untouched —
    // it is an admin-only toggle, decoupled from the appointment lifecycle.
    if (appointment.therapistHandle) {
      try {
        if (nowConfirmed && !wasConfirmed) {
          await therapistBookingStatusService.markConfirmed(
            appointment.therapistHandle,
            appointment.therapistName ?? 'unknown therapist'
          );
        } else if (nowCompleted || nowCancelled) {
          // Unconditional on terminal moves (not gated on previousStatus ===
          // confirmed): force-terminating from session_held/feedback_requested
          // otherwise strands hasConfirmedBooking=true, hiding the therapist
          // from the public finder. unmarkConfirmed is self-guarding.
          await therapistBookingStatusService.unmarkConfirmed(appointment.therapistHandle);
        }

        if (nowCompleted || nowCancelled) {
          await therapistBookingStatusService.recalculateUniqueRequestCount(
            appointment.therapistHandle
          );
        }
      } catch (err) {
        logger.error(
          { ...logContext, therapistHandle: appointment.therapistHandle, err },
          'Failed to update therapist booking status after admin force update (non-fatal)'
        );
      }
    }

    // --- Optional notifications (Slack only — delegated to notifications service) ---
    if (!skipNotifications) {
      appointmentNotificationsService.notifyAdminForceUpdate({
        appointmentId,
        adminId: logContext.adminId as string | undefined,
        userName: appointment.userName,
        therapistName: appointment.therapistName,
        newStatus,
        confirmedDateTime,
      });
    }
  }
}

export const transitionSideEffectsService = new TransitionSideEffectsService();

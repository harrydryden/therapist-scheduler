/**
 * Transition Side Effects Service
 *
 * Extracted from AppointmentLifecycleService to separate post-transition
 * side effects from state machine logic.
 *
 * This service handles non-transactional operations that run AFTER a status
 * transition has been committed:
 * - Therapist booking status updates (freeze/unfreeze)
 * - Therapist deactivation when no active appointments remain
 * - SSE broadcast of status changes
 *
 * Notifications (Slack/email) are handled by appointment-notifications.service.ts.
 *
 * All operations here are non-fatal: failures are logged but never cause
 * the transition to be rolled back.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { APPOINTMENT_STATUS, AppointmentStatus, ACTIVE_STATUSES } from '../constants';
import { sseService } from './sse.service';
import { appointmentNotificationsService } from './appointment-notifications.service';
import { runTrackedSideEffect } from './side-effect-tracker.service';
import type { TransitionSource, TransitionResult } from './appointment-lifecycle.service';

/**
 * Count this therapist's OTHER active appointments and, if there are none,
 * mark the therapist inactive in Postgres.
 *
 * Used by completion / cancellation / admin-force paths so the same "last
 * appointment closed → take therapist off the booking page" semantics apply
 * regardless of how the appointment terminated.
 *
 * Failures are logged but never thrown — matches the existing "non-fatal
 * side effect" contract.
 */
async function deactivateTherapistIfLastAppointment(args: {
  appointmentId: string;
  therapistHandle: string;
  taskName: string;
  logContext: Record<string, unknown>;
  successLogMessage: string;
}): Promise<void> {
  const { appointmentId, therapistHandle, taskName, logContext, successLogMessage } = args;

  try {
    const otherActiveAppointments = await prisma.appointmentRequest.count({
      where: {
        therapistHandle,
        id: { not: appointmentId },
        status: { in: [...ACTIVE_STATUSES] },
      },
    });

    if (otherActiveAppointments === 0) {
      // therapistHandle is the public handle: legacy notionId or
      // post-Notion Postgres uuid. Match by either — updateMany returns
      // count=0 if no row matches, which is fine for missing therapists.
      const result = await prisma.therapist.updateMany({
        where: { OR: [{ notionId: therapistHandle }, { id: therapistHandle }] },
        data: { active: false },
      });
      logger.info(
        { ...logContext, therapistHandle, taskName, updated: result.count },
        successLogMessage,
      );
    } else {
      logger.info(
        { ...logContext, therapistHandle, otherActiveAppointments },
        'Therapist still has active appointments - keeping active',
      );
    }
  } catch (err) {
    logger.error(
      { ...logContext, therapistHandle, err },
      `Failed to deactivate therapist (${taskName}) — non-fatal`,
    );
  }
}

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
   * Side effects after a successful confirmation:
   * - Mark therapist as confirmed (freeze for other bookings)
   *
   * Routed through `runTrackedSideEffect` so a transient Postgres flap
   * during therapist-status update doesn't silently drop the freeze —
   * the side-effect-retry runner picks up failed rows and re-runs them
   * (idempotent: markConfirmed sets a flag).
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
   * - Clear therapist confirmed status
   * - Recalculate therapist request count
   * - Conditionally deactivate therapist in Notion
   * - Sync therapist freeze status to Notion
   * - Sync user to Notion
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
          await deactivateTherapistIfLastAppointment({
            appointmentId,
            therapistHandle,
            taskName: 'therapist-deactivate-completion',
            logContext: { appointmentId },
            successLogMessage: 'Marked therapist as inactive after last appointment completed',
          });
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
   * - Unmark therapist as confirmed (if was confirmed)
   * - Recalculate therapist booking status
   * - Conditionally deactivate therapist if no other active appointments
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
          if (wasConfirmed) {
            await therapistBookingStatusService.unmarkConfirmed(therapistHandle);
          }
          await therapistBookingStatusService.recalculateUniqueRequestCount(therapistHandle);
          await deactivateTherapistIfLastAppointment({
            appointmentId,
            therapistHandle,
            taskName: 'therapist-deactivate-cancellation',
            logContext: { appointmentId },
            successLogMessage: 'Marked therapist as inactive after last appointment cancelled',
          });
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
    // Each operation has its own try/catch so a failure in one does not block the others.
    if (appointment.therapistHandle) {
      // Step 1: Update booking status flags
      try {
        if (nowConfirmed && !wasConfirmed) {
          await therapistBookingStatusService.markConfirmed(
            appointment.therapistHandle,
            appointment.therapistName ?? 'unknown therapist'
          );
        } else if ((nowCompleted || nowCancelled) && wasConfirmed) {
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
          'Failed to update therapist booking status after admin force update (non-fatal, continuing to deactivation)'
        );
      }

      // Step 2: Conditionally deactivate therapist (independent of Step 1).
      if (nowCompleted || nowCancelled) {
        await deactivateTherapistIfLastAppointment({
          appointmentId,
          therapistHandle: appointment.therapistHandle,
          taskName: 'therapist-deactivate-admin-force',
          logContext,
          successLogMessage: `Marked therapist as inactive after admin force-${nowCompleted ? 'completed' : 'cancelled'} last appointment`,
        });
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

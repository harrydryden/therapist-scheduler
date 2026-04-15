/**
 * Transition Side Effects Service
 *
 * Extracted from AppointmentLifecycleService to separate post-transition
 * side effects from state machine logic.
 *
 * This service handles non-transactional operations that run AFTER a status
 * transition has been committed:
 * - Therapist booking status updates (freeze/unfreeze)
 * - Notion sync for therapists and users
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
import { notionSyncManager } from './notion-sync-manager.service';
import { notionService } from './notion.service';
import { APPOINTMENT_STATUS, AppointmentStatus } from '../constants';
import { runBackgroundTask } from '../utils/background-task';
import { sseService } from './sse.service';
import { appointmentNotificationsService } from './appointment-notifications.service';
import type { TransitionSource, TransitionResult } from './appointment-lifecycle.service';

// ============================================
// Parameter Types
// ============================================

export interface SideEffectContext {
  appointmentId: string;
  source: TransitionSource;
  adminId?: string;
}

export interface OnConfirmedParams extends SideEffectContext {
  therapistNotionId: string | null;
  therapistName: string | null;
  userEmail: string;
}

export interface OnSessionHeldParams extends SideEffectContext {
  userEmail: string;
}

export interface OnCompletedParams extends SideEffectContext {
  therapistNotionId: string | null;
  therapistName: string;
  userEmail: string;
  userName: string | null;
  previousStatus: AppointmentStatus;
}

export interface OnCancelledParams extends SideEffectContext {
  therapistNotionId: string | null;
  wasConfirmed: boolean;
  userEmail: string;
}

export interface OnAdminForceUpdateParams extends SideEffectContext {
  appointment: {
    therapistNotionId: string | null;
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
   * - Sync therapist freeze status to Notion
   * - Sync user to Notion
   */
  async onConfirmed(params: OnConfirmedParams): Promise<void> {
    const { appointmentId, source, adminId, therapistNotionId, therapistName, userEmail } = params;
    const logContext = { appointmentId, source, adminId };

    // Mark therapist as confirmed (freezes for other bookings)
    if (therapistNotionId) {
      try {
        await therapistBookingStatusService.markConfirmed(
          therapistNotionId,
          therapistName
        );
        await notionSyncManager.syncSingleTherapist(therapistNotionId);
      } catch (err) {
        logger.error(
          { ...logContext, err },
          'Failed to mark therapist as confirmed (non-critical)'
        );
      }
    }

    // Sync user to Notion (non-blocking, tracked)
    runBackgroundTask(
      () => notionSyncManager.syncSingleUser(userEmail),
      {
        name: 'user-sync-notion',
        context: { ...logContext, userEmail },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  /**
   * Side effects after a successful session_held transition:
   * - Sync user to Notion (moves therapist from "Upcoming" to "Previous")
   */
  async onSessionHeld(params: OnSessionHeldParams): Promise<void> {
    const { appointmentId, source, adminId, userEmail } = params;
    const logContext = { appointmentId, source, adminId };

    // Sync user to Notion - moves therapist from "Upcoming" to "Previous" (tracked)
    runBackgroundTask(
      () => notionSyncManager.syncSingleUser(userEmail),
      {
        name: 'user-sync-session-held',
        context: { ...logContext, userEmail },
        retry: true,
        maxRetries: 2,
      }
    );
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
    const { appointmentId, source, adminId, therapistNotionId, userEmail } = params;
    const logContext = { appointmentId, source, adminId };

    // Update therapist booking status and conditionally deactivate in Notion
    // Each operation has its own try/catch so a failure in one does not block the others.
    // Previously, a single try/catch meant a failure in unmarkConfirmed or
    // recalculateUniqueRequestCount would skip deactivation entirely.
    if (therapistNotionId) {
      // Step 1: Clear confirmed flag and recalculate request count (independent, non-blocking)
      try {
        await Promise.all([
          therapistBookingStatusService.unmarkConfirmed(therapistNotionId),
          therapistBookingStatusService.recalculateUniqueRequestCount(therapistNotionId),
        ]);
      } catch (err) {
        logger.error(
          { ...logContext, therapistNotionId, err },
          'Failed to update therapist booking status after completion (non-fatal, continuing to deactivation)'
        );
      }

      // Step 2: Conditionally deactivate therapist in Notion (independent of Step 1)
      // FIX #6: Only deactivate therapist if they have NO other active appointments.
      // Uses runBackgroundTask with retry so a transient Notion API failure doesn't
      // leave the therapist permanently visible on the booking page.
      try {
        const otherActiveAppointments = await prisma.appointmentRequest.count({
          where: {
            therapistNotionId,
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
          // No other active appointments - deactivate with retry
          runBackgroundTask(
            () => notionService.updateTherapistActive(therapistNotionId, false),
            {
              name: 'therapist-deactivate-completion',
              context: { ...logContext, therapistNotionId },
              retry: true,
              maxRetries: 2,
            }
          );
          logger.info(
            { ...logContext, therapistNotionId },
            'Marked therapist as inactive after last appointment completed'
          );
        } else {
          logger.info(
            { ...logContext, therapistNotionId, otherActiveAppointments },
            'Therapist still has active appointments - keeping active'
          );
        }
      } catch (err) {
        logger.error(
          { ...logContext, therapistNotionId, err },
          'Failed to deactivate therapist after completion (non-fatal)'
        );
      }

      // Step 3: Sync frozen status to Notion (independent of Steps 1-2)
      runBackgroundTask(
        () => notionSyncManager.syncSingleTherapist(therapistNotionId),
        {
          name: 'therapist-freeze-sync-completion',
          context: { ...logContext, therapistNotionId },
          retry: true,
          maxRetries: 2,
        }
      );
    }

    // Sync user to Notion (non-blocking, tracked)
    runBackgroundTask(
      () => notionSyncManager.syncSingleUser(userEmail),
      {
        name: 'user-sync-completion',
        context: { ...logContext, userEmail },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  /**
   * Side effects after a successful cancellation:
   * - Unmark therapist as confirmed (if was confirmed)
   * - Recalculate therapist booking status
   * - Conditionally deactivate therapist in Notion
   * - Sync therapist freeze status to Notion
   */
  async onCancelled(params: OnCancelledParams): Promise<void> {
    const { appointmentId, source, adminId, therapistNotionId, wasConfirmed, userEmail } = params;
    const logContext = { appointmentId, source, adminId };

    // Update therapist status
    // Each operation has its own try/catch so a failure in one does not block the others.
    if (therapistNotionId) {
      // Step 1: Update booking status (non-blocking for deactivation)
      try {
        if (wasConfirmed) {
          await therapistBookingStatusService.unmarkConfirmed(therapistNotionId);
        }

        await therapistBookingStatusService.recalculateUniqueRequestCount(
          therapistNotionId
        );
      } catch (err) {
        logger.error(
          { ...logContext, therapistNotionId, err },
          'Failed to update therapist booking status after cancellation (non-fatal, continuing to deactivation)'
        );
      }

      // Step 2: Conditionally deactivate therapist in Notion (independent of Step 1)
      try {
        const otherActiveAppointments = await prisma.appointmentRequest.count({
          where: {
            therapistNotionId,
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
          runBackgroundTask(
            () => notionService.updateTherapistActive(therapistNotionId, false),
            {
              name: 'therapist-deactivate-cancellation',
              context: { ...logContext, therapistNotionId },
              retry: true,
              maxRetries: 2,
            }
          );
          logger.info(
            { ...logContext, therapistNotionId },
            'Marked therapist as inactive after last appointment cancelled'
          );
        } else {
          logger.info(
            { ...logContext, therapistNotionId, otherActiveAppointments },
            'Therapist still has active appointments after cancellation - keeping active'
          );
        }
      } catch (err) {
        logger.error(
          { ...logContext, therapistNotionId, err },
          'Failed to deactivate therapist after cancellation (non-fatal)'
        );
      }

      // Step 3: Sync frozen status to Notion (independent of Steps 1-2)
      runBackgroundTask(
        () => notionSyncManager.syncSingleTherapist(therapistNotionId),
        {
          name: 'therapist-freeze-sync-cancellation',
          context: { ...logContext, therapistNotionId },
          retry: true,
          maxRetries: 2,
        }
      );
    }

    // Sync user to Notion (non-blocking, tracked).
    // Previously missing from the cancellation path — every other transition
    // (confirmed, session_held, completed) synced the user.
    if (userEmail) {
      runBackgroundTask(
        () => notionSyncManager.syncSingleUser(userEmail),
        {
          name: 'user-sync-cancellation',
          context: { ...logContext, userEmail },
          retry: true,
          maxRetries: 2,
        }
      );
    }
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
    if (appointment.therapistNotionId) {
      // Step 1: Update booking status flags
      try {
        if (nowConfirmed && !wasConfirmed) {
          await therapistBookingStatusService.markConfirmed(
            appointment.therapistNotionId,
            appointment.therapistName
          );
        } else if ((nowCompleted || nowCancelled) && wasConfirmed) {
          await therapistBookingStatusService.unmarkConfirmed(appointment.therapistNotionId);
        }

        if (nowCompleted || nowCancelled) {
          await therapistBookingStatusService.recalculateUniqueRequestCount(
            appointment.therapistNotionId
          );
        }
      } catch (err) {
        logger.error(
          { ...logContext, therapistNotionId: appointment.therapistNotionId, err },
          'Failed to update therapist booking status after admin force update (non-fatal, continuing to deactivation)'
        );
      }

      // Step 2: Conditionally deactivate therapist (independent of Step 1)
      if (nowCompleted || nowCancelled) {
        try {
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
            runBackgroundTask(
              () => notionService.updateTherapistActive(appointment.therapistNotionId!, false),
              {
                name: 'therapist-deactivate-admin-force',
                context: { ...logContext, therapistNotionId: appointment.therapistNotionId },
                retry: true,
                maxRetries: 2,
              }
            );
            logger.info(
              { ...logContext, therapistNotionId: appointment.therapistNotionId },
              `Marked therapist as inactive after admin force-${nowCompleted ? 'completed' : 'cancelled'} last appointment`
            );
          }
        } catch (err) {
          logger.error(
            { ...logContext, therapistNotionId: appointment.therapistNotionId, err },
            'Failed to deactivate therapist after admin force update (non-fatal)'
          );
        }
      }

      // Step 3: Sync therapist freeze status to Notion (independent of Steps 1-2)
      runBackgroundTask(
        () => notionSyncManager.syncSingleTherapist(appointment.therapistNotionId!),
        {
          name: 'therapist-freeze-sync-admin-force',
          context: { ...logContext, therapistNotionId: appointment.therapistNotionId },
          retry: true,
          maxRetries: 2,
        }
      );
    }

    // --- Notion user sync (non-blocking) ---
    runBackgroundTask(
      () => notionSyncManager.syncSingleUser(appointment.userEmail),
      {
        name: 'user-sync-admin-force-update',
        context: { ...logContext, userEmail: appointment.userEmail },
        retry: true,
        maxRetries: 2,
      }
    );

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

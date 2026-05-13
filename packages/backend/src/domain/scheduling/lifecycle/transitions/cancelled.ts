/**
 * Transition: pending | contacted | negotiating | confirmed | session_held | feedback_requested → cancelled
 *
 * Terminal transition. Runs inside `runTerminalTransitionTx` (serializable
 * + FOR UPDATE row lock + atomic audit event commit).
 *
 * Special features:
 *   - Cross-validates `cancelledBy ⇄ source` so callers can't pass
 *     incoherent combinations (e.g. source='agent' with cancelledBy='admin').
 *   - `skipNotifications` lets specialised callers (notably email-bounce)
 *     skip user-visible notifications while still running data-consistency
 *     side effects (therapist unfreeze, audit).
 *   - `atomic.requireStatusNotIn` / `requireHumanControlDisabled` for
 *     race-free agent cancellations.
 */

import { logger } from '../../../../utils/logger';
import { APPOINTMENT_STATUS, type AppointmentStatus } from '../../../../constants';
import { InvalidTransitionError } from '../../../../errors';
import { appointmentNotificationsService } from '../../../../services/appointment-notifications.service';
import { transitionSideEffectsService } from '../../../../services/transition-side-effects.service';
import { addAuditMessage } from '../audit';
import { CLEAR_RESCHEDULING_STATE } from '../update-fragments';
import { progressionResetsFor } from '../status-order';
import { fireAndForget, notifyTransition } from '../dispatch-helpers';
import { runTerminalTransitionTx } from '../terminal-tx';
import type { TransitionResult, TransitionToCancelledParams } from '../types';

export async function transitionToCancelled(
  params: TransitionToCancelledParams,
): Promise<TransitionResult> {
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

  type CancelledRow = {
    id: string;
    status: string;
    user_name: string | null;
    user_email: string;
    therapist_name: string;
    therapist_email: string;
    therapist_handle: string;
    human_control_enabled: boolean;
    notes: string | null;
    confirmed_date_time: string | null;
    confirmed_date_time_parsed: Date | null;
    gmail_thread_id: string | null;
    therapist_gmail_thread_id: string | null;
    transition_generation: number;
  };

  const outcome = await runTerminalTransitionTx<CancelledRow>({
    appointmentId,
    source,
    adminId,
    fetchAndLock: async (tx) => {
      const rows = await tx.$queryRaw<CancelledRow[]>`
        SELECT id, status, user_name, user_email, therapist_name, therapist_email,
               therapist_handle, human_control_enabled, notes,
               confirmed_date_time, confirmed_date_time_parsed,
               gmail_thread_id, therapist_gmail_thread_id, transition_generation
        FROM "appointment_requests"
        WHERE id = ${appointmentId}
        FOR UPDATE
      `;
      return rows[0] || null;
    },
    classify: (row) => {
      if (row.status === APPOINTMENT_STATUS.CANCELLED) return 'idempotent';
      // Atomic preconditions (caller-supplied). Mismatches mean the row's
      // current state has drifted from what the caller assumed, so we bail
      // without writing — the caller will return atomicSkipped.
      if (atomic) {
        if (
          atomic.requireStatusNotIn &&
          atomic.requireStatusNotIn.includes(row.status as AppointmentStatus)
        ) {
          return 'atomicSkipped';
        }
        if (atomic.requireHumanControlDisabled && row.human_control_enabled) {
          return 'atomicSkipped';
        }
      }
      // State-machine guard — completed is the only forbidden source.
      if (row.status === APPOINTMENT_STATUS.COMPLETED) {
        throw new InvalidTransitionError(row.status, 'cancelled');
      }
      return 'proceed';
    },
    buildUpdateData: (row) => {
      // Prepend cancellation info to existing notes — preserves history.
      const cancellationNote = `[CANCELLED ${new Date().toISOString()}] Reason: ${reason}. Cancelled by: ${cancelledBy}`;
      const updatedNotes = row.notes
        ? `${cancellationNote}\n\n${row.notes}`
        : cancellationNote;
      return {
        status: APPOINTMENT_STATUS.CANCELLED,
        notes: updatedNotes,
        updatedAt: new Date(),
        // Bump generation atomically with the status flip so side-effect
        // idempotency keys for this transition don't collide with prior
        // generations' completed rows.
        transitionGeneration: { increment: 1 },
        // Cancellation supersedes any in-progress reschedule.
        ...CLEAR_RESCHEDULING_STATE,
        // Centralised progression-based field resets (clears isStale).
        ...progressionResetsFor(APPOINTMENT_STATUS.CANCELLED),
      };
    },
    buildAuditPayload: (row) => ({
      previousStatus: row.status,
      newStatus: APPOINTMENT_STATUS.CANCELLED,
      reason,
      cancelledBy,
    }),
  });

  if (outcome.kind === 'atomicSkipped') {
    logger.warn(
      { ...logContext, currentStatus: outcome.previousStatus },
      'Atomic cancellation skipped - conditions not met',
    );
    return {
      success: false,
      previousStatus: outcome.previousStatus,
      newStatus: outcome.previousStatus,
      atomicSkipped: true,
    };
  }

  if (outcome.kind === 'idempotent') {
    logger.debug(logContext, 'Appointment already cancelled - skipping');
    return {
      success: true,
      previousStatus: outcome.previousStatus,
      newStatus: APPOINTMENT_STATUS.CANCELLED,
      skipped: true,
    };
  }

  const previousStatus = outcome.previousStatus;
  const wasConfirmed = previousStatus === APPOINTMENT_STATUS.CONFIRMED;
  const appointment = {
    id: outcome.row.id,
    userName: outcome.row.user_name,
    userEmail: outcome.row.user_email,
    therapistName: outcome.row.therapist_name,
    therapistEmail: outcome.row.therapist_email,
    therapistHandle: outcome.row.therapist_handle,
    confirmedDateTime: outcome.row.confirmed_date_time,
    confirmedDateTimeParsed: outcome.row.confirmed_date_time_parsed,
    gmailThreadId: outcome.row.gmail_thread_id,
    therapistGmailThreadId: outcome.row.therapist_gmail_thread_id,
  };

  // Audit narrative (conversation_state JSON). Awaited so the message lands
  // before the SSE event downstream — see transitionToCompleted note.
  await addAuditMessage(
    appointmentId,
    source,
    `Status changed: ${previousStatus} → cancelled. Reason: ${reason}. Cancelled by: ${cancelledBy}`,
    adminId,
  );

  logger.info(
    { ...logContext, wasConfirmed, reason },
    'Appointment cancelled',
  );

  // Post-transition side effects (therapist booking status, deactivation)
  fireAndForget(
    transitionSideEffectsService.onCancelled({
      appointmentId,
      source,
      adminId,
      therapistHandle: appointment.therapistHandle,
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
    // outcome.row is pre-update; the atomic update incremented the
    // generation column by 1.
    const newGeneration = outcome.row.transition_generation + 1;
    fireAndForget(
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
        transitionGeneration: newGeneration,
      }),
      appointmentId,
      'notifyCancelled',
    );
  }

  const transitionResult: TransitionResult = {
    success: true,
    previousStatus,
    newStatus: APPOINTMENT_STATUS.CANCELLED,
  };
  notifyTransition(transitionResult, appointmentId, source);
  return transitionResult;
}

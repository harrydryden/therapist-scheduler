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
import { sideEffectTrackerService } from '../../../../services/side-effect-tracker.service';
import { addAuditMessage } from '../audit';
import { CLEAR_RESCHEDULING_STATE, CLEAR_HUMAN_CONTROL_STATE } from '../update-fragments';
import { progressionResetsFor } from '../status-order';
import { fireAndForget, notifyTransition } from '../dispatch-helpers';
import { runTerminalTransitionTx } from '../terminal-tx';
import type { TransitionResult, TransitionToCancelledParams } from '../types';

/**
 * Cross-validate the cancelledBy ⇄ source pair so callers can't
 * pass an incoherent combination. Notifications and audit narrative
 * both use cancelledBy, so a mismatch here propagates a misleading
 * record.
 *
 * Allowed pairings (reflect the actual call sites):
 *   - source='admin':  cancelledBy ∈ {'admin', 'client', 'therapist'}
 *                       The 'client' / 'therapist' values drive
 *                       different email copy in notifyCancelled
 *                       (apology + voucher to user vs. apology +
 *                       reassurance to therapist). 'admin' = neutral.
 *   - source='agent':  cancelledBy ∈ {'client', 'therapist'}
 *                       (agent is acting on behalf of a party).
 *   - source='system': cancelledBy ∈ {'system', 'client'}
 *                       ('system' for cron/bounce/auto-flow;
 *                       'client' for forwarded auto-replies).
 *   - source='feedback_sync': cancelledBy must be 'system'.
 *
 * Exported for unit tests so the table can be pinned independently
 * of the full transition flow.
 */
export function validateCancellationInitiator(
  source: TransitionToCancelledParams['source'],
  cancelledBy: TransitionToCancelledParams['cancelledBy'],
): void {
  const valid =
    (source === 'admin' && (cancelledBy === 'admin' || cancelledBy === 'client' || cancelledBy === 'therapist')) ||
    (source === 'agent' && (cancelledBy === 'client' || cancelledBy === 'therapist')) ||
    (source === 'system' && (cancelledBy === 'system' || cancelledBy === 'client')) ||
    (source === 'feedback_sync' && cancelledBy === 'system');
  if (!valid) {
    throw new Error(
      `Invalid cancelledBy '${cancelledBy}' for source '${source}'. ` +
        `See transitionToCancelled validation table for allowed pairings.`,
    );
  }
}

export async function transitionToCancelled(
  params: TransitionToCancelledParams,
): Promise<TransitionResult> {
  const { appointmentId, reason, cancelledBy, source, adminId, atomic, skipNotifications } = params;
  const logContext = { appointmentId, source, adminId, cancelledBy };

  validateCancellationInitiator(source, cancelledBy);

  // Fetched before the transaction so the intent-registration hook below
  // knows which effect rows to pre-register. A settings toggle flipped in
  // the narrow window between this fetch and the post-commit dispatch is
  // an accepted, bounded edge case — see
  // docs/agent-harness-review/register-in-tx-design.md §6.
  const notificationSettings = skipNotifications
    ? null
    : await appointmentNotificationsService.getNotificationSettings();

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
        // Auto-release human control on cancellation. The admin
        // typically had to take control to perform the cancel
        // (the patch-dashboard route enforces it as a guard), and
        // leaving it on post-cancel inflates the Human Control
        // dashboard tile with permanently-cancelled rows. See the
        // fragment docstring for the full rationale.
        ...CLEAR_HUMAN_CONTROL_STATE,
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
    // Pre-register durable intent rows atomically with the status update —
    // closes the crash window between commit and the post-commit
    // fireAndForget dispatch below (finding #10). The post-commit dispatch
    // code's own registerSideEffects call will find these rows by
    // idempotency key and no-op instead of creating duplicates, so it
    // needs no changes — see register-in-tx-design.md §3.
    //
    // therapist_unfreeze_sync mirrors onCancelled: it runs regardless of
    // skipNotifications/settings, keyed WITHOUT a transitionGeneration
    // (matches transitionSideEffectsService.onCancelled's call, which
    // doesn't pass one either). The Slack/email rows below only exist
    // when skipNotifications is false, matching notifyCancelled's guard
    // in this same file; slack_notify_cancelled is keyed WITHOUT a
    // generation (matches notifyCancelled's call), while both email
    // types ARE keyed with the post-update generation (also matching).
    registerEffects: async (tx, row, postUpdateGeneration) => {
      if (row.therapist_handle) {
        await sideEffectTrackerService.registerInTransaction(tx, appointmentId, 'cancelled', {
          effectType: 'therapist_unfreeze_sync',
        });
      }
      if (!notificationSettings) return;
      if (notificationSettings.slack.cancelled) {
        await sideEffectTrackerService.registerInTransaction(tx, appointmentId, 'cancelled', {
          effectType: 'slack_notify_cancelled',
        });
      }
      if (notificationSettings.email.clientCancellation && row.user_email) {
        await sideEffectTrackerService.registerInTransaction(
          tx,
          appointmentId,
          'cancelled',
          { effectType: 'email_client_cancellation', payload: { cancelledBy, reason } },
          postUpdateGeneration,
        );
      }
      if (
        notificationSettings.email.therapistCancellation &&
        row.therapist_email &&
        row.therapist_gmail_thread_id
      ) {
        await sideEffectTrackerService.registerInTransaction(
          tx,
          appointmentId,
          'cancelled',
          { effectType: 'email_therapist_cancellation', payload: { cancelledBy, reason } },
          postUpdateGeneration,
        );
      }
    },
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

  // Post-transition side effects (therapist booking status)
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

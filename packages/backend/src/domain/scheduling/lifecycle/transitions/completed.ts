/**
 * Transition: confirmed | session_held | feedback_requested → completed
 *
 * Terminal transition. Runs inside `runTerminalTransitionTx` (serializable
 * + FOR UPDATE row lock + atomic audit event commit). Side effects fire
 * AFTER the transaction commits.
 */

import { logger } from '../../../../utils/logger';
import { APPOINTMENT_STATUS } from '../../../../constants';
import { InvalidTransitionError } from '../../../../errors';
import { appointmentNotificationsService } from '../../../../services/appointment-notifications.service';
import { transitionSideEffectsService } from '../../../../services/transition-side-effects.service';
import { addAuditMessage } from '../audit';
import { CLEAR_RESCHEDULING_STATE } from '../update-fragments';
import { progressionResetsFor } from '../status-order';
import {
  catchUpSessionHeldEffects,
  fireAndForget,
  notifyTransition,
} from '../dispatch-helpers';
import { runTerminalTransitionTx } from '../terminal-tx';
import type { TransitionResult, TransitionToCompletedParams } from '../types';

export async function transitionToCompleted(
  params: TransitionToCompletedParams,
): Promise<TransitionResult> {
  const { appointmentId, source, note, adminId, feedbackSubmissionId, feedbackData } = params;
  const logContext = { appointmentId, source, adminId };

  // Valid transitions to completed
  const validFromStatuses = [
    APPOINTMENT_STATUS.SESSION_HELD,
    APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
    APPOINTMENT_STATUS.CONFIRMED, // Edge case: complete without feedback
  ];

  type CompletedRow = {
    id: string;
    status: string;
    user_name: string | null;
    user_email: string;
    therapist_name: string;
    therapist_handle: string;
    notes: string | null;
    transition_generation: number;
  };

  const outcome = await runTerminalTransitionTx<CompletedRow>({
    appointmentId,
    source,
    adminId,
    fetchAndLock: async (tx) => {
      const rows = await tx.$queryRaw<CompletedRow[]>`
        SELECT id, status, user_name, user_email, therapist_name, therapist_handle, notes, transition_generation
        FROM "appointment_requests"
        WHERE id = ${appointmentId}
        FOR UPDATE
      `;
      return rows[0] || null;
    },
    classify: (row) => {
      if (row.status === APPOINTMENT_STATUS.COMPLETED) return 'idempotent';
      if (!(validFromStatuses as string[]).includes(row.status)) {
        throw new InvalidTransitionError(row.status, 'completed');
      }
      return 'proceed';
    },
    buildUpdateData: (row) => ({
      status: APPOINTMENT_STATUS.COMPLETED,
      notes: note ? (row.notes ? `${note}\n\n${row.notes}` : note) : row.notes,
      updatedAt: new Date(),
      // Bump generation atomically with the status flip so side-effect
      // idempotency keys for this transition don't collide with prior
      // generations' completed rows.
      transitionGeneration: { increment: 1 },
      // Completion is terminal — no reschedule should remain active.
      ...CLEAR_RESCHEDULING_STATE,
      // Centralised progression-based field resets (clears isStale).
      ...progressionResetsFor(APPOINTMENT_STATUS.COMPLETED),
    }),
    buildAuditPayload: (row) => ({
      previousStatus: row.status,
      newStatus: APPOINTMENT_STATUS.COMPLETED,
      reason: note,
    }),
  });

  if (outcome.kind === 'idempotent') {
    logger.debug(logContext, 'Appointment already completed - skipping');
    return {
      success: true,
      previousStatus: outcome.previousStatus,
      newStatus: APPOINTMENT_STATUS.COMPLETED,
      skipped: true,
    };
  }

  const previousStatus = outcome.previousStatus;
  const appointment = {
    id: outcome.row.id,
    userName: outcome.row.user_name,
    userEmail: outcome.row.user_email,
    therapistName: outcome.row.therapist_name,
    therapistHandle: outcome.row.therapist_handle,
  };

  // Audit narrative (conversation_state JSON). Awaited so the message lands
  // before the SSE event downstream — a UI subscriber tailing both channels
  // sees the narrative entry no later than the status-change notification.
  // Failures are swallowed by addAuditMessage itself.
  await addAuditMessage(
    appointmentId,
    source,
    `Status changed: ${previousStatus} → completed${note ? ` (${note})` : ''}`,
    adminId,
  );

  logger.info(
    { ...logContext, previousStatus },
    'Appointment transitioned to completed',
  );

  await catchUpSessionHeldEffects(previousStatus, {
    appointmentId,
    source,
    adminId,
    userEmail: appointment.userEmail,
  });

  // Post-transition side effects (therapist booking status)
  fireAndForget(
    transitionSideEffectsService.onCompleted({
      appointmentId,
      source,
      adminId,
      therapistHandle: appointment.therapistHandle,
      therapistName: appointment.therapistName,
      userEmail: appointment.userEmail,
      userName: appointment.userName,
      previousStatus,
    }),
    appointmentId,
    'onCompleted',
  );

  // Send Slack notification (delegated to notifications service).
  // outcome.row is pre-update; the atomic update incremented the column
  // by 1, so the post-update generation is +1.
  const newGeneration = outcome.row.transition_generation + 1;
  fireAndForget(
    appointmentNotificationsService.notifyCompleted({
      appointmentId,
      source,
      adminId,
      userName: appointment.userName,
      therapistName: appointment.therapistName,
      feedbackSubmissionId,
      feedbackData,
      transitionGeneration: newGeneration,
    }),
    appointmentId,
    'notifyCompleted',
  );

  const transition: TransitionResult = {
    success: true,
    previousStatus,
    newStatus: APPOINTMENT_STATUS.COMPLETED,
  };
  notifyTransition(transition, appointmentId, source);
  return transition;
}

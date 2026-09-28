/**
 * `cancel_appointment` — agent-initiated cancellation.
 *
 * Delegates to `appointmentLifecycleService.transitionToCancelled`
 * for the atomic cancellation + therapist freeze release + Slack +
 * cancellation emails to both parties.
 *
 * Defence in depth: re-reads `humanControlEnabled` before calling
 * the lifecycle service. The lifecycle service has its own atomic
 * gate via `atomic.requireHumanControlDisabled`, so this is belt-
 * and-braces.
 */

import { logger } from '../../../../utils/logger';
import { prisma } from '../../../../utils/database';
import { appointmentLifecycleService } from '../../../../domain/scheduling/lifecycle';
import { APPOINTMENT_STATUS } from '../../../../constants';
import { cancelAppointmentInputSchema } from '../../../../schemas/tool-inputs';
import type { ConversationAction } from '../../../../services/conversation-checkpoint.service';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

export interface CancelAppointmentOutcome {
  result: ToolExecutionResult;
  checkpointAction?: ConversationAction;
}

export async function handleCancelAppointment(
  rawInput: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<CancelAppointmentOutcome> {
  const parsed = cancelAppointmentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const errorMsg = `Invalid cancel_appointment input: ${parsed.error.message}`;
    logger.error({ traceId, errors: parsed.error.errors }, 'Invalid cancel_appointment input');
    return { result: { success: false, toolName: 'cancel_appointment', error: errorMsg } };
  }

  const outcome = await cancelAppointment(context, {
    reason: parsed.data.reason,
    cancelled_by: parsed.data.cancelled_by,
  }, traceId);

  // A cancellation that did NOT happen must not be reported as success:
  // on success dispatch records the idempotency key and bumps the
  // per-appointment counter, the loop advances the checkpoint to
  // `cancelled`, and the model tells both parties the session is off.
  if (outcome.kind === 'not_cancelled') {
    return {
      result: { success: false, toolName: 'cancel_appointment', error: outcome.error },
    };
  }

  return {
    result: { success: true, toolName: 'cancel_appointment' },
    checkpointAction: 'processed_cancellation',
  };
}

/**
 * `cancelled` — the transition cancelled the appointment, or it was
 *   already cancelled (idempotent).
 * `not_cancelled` — nothing was written (appointment missing, human
 *   control on, or the atomic transition lost its precondition). `error`
 *   is the message the agent sees.
 */
type CancelOutcome =
  | { kind: 'cancelled' }
  | { kind: 'not_cancelled'; error: string };

const NOT_CANCELLED_SUFFIX =
  'The appointment was NOT cancelled and no cancellation emails were sent. ' +
  'Do not tell either party it has been cancelled.';

async function cancelAppointment(
  context: SchedulingContext,
  params: { reason: string; cancelled_by: 'client' | 'therapist' },
  traceId: string,
): Promise<CancelOutcome> {
  logger.info(
    {
      traceId,
      appointmentRequestId: context.appointmentRequestId,
      reason: params.reason,
      cancelledBy: params.cancelled_by,
    },
    'Cancelling appointment via lifecycle service',
  );

  const appointment = await prisma.appointmentRequest.findUnique({
    where: { id: context.appointmentRequestId },
    select: {
      status: true,
      humanControlEnabled: true,
    },
  });

  if (!appointment) {
    logger.error(
      { traceId, appointmentRequestId: context.appointmentRequestId },
      'Appointment not found for cancellation',
    );
    return { kind: 'not_cancelled', error: `Appointment not found. ${NOT_CANCELLED_SUFFIX}` };
  }

  if (appointment.humanControlEnabled) {
    logger.info(
      { traceId, appointmentRequestId: context.appointmentRequestId },
      'Human control enabled - skipping cancelAppointment',
    );
    return {
      kind: 'not_cancelled',
      error: `An admin has taken control of this conversation. ${NOT_CANCELLED_SUFFIX} Stop and leave it to the admin.`,
    };
  }

  const result = await appointmentLifecycleService.transitionToCancelled({
    appointmentId: context.appointmentRequestId,
    reason: params.reason,
    cancelledBy: params.cancelled_by,
    source: 'agent',
    atomic: {
      requireStatusNotIn: [APPOINTMENT_STATUS.CANCELLED],
      requireHumanControlDisabled: true,
    },
  });

  // `success === false` too, defensively: a failed result means no
  // cancellation was written, whatever flag the transition set.
  if (result.atomicSkipped || result.success === false) {
    // The atomic precondition failed inside the locked transaction —
    // in practice human control was switched on between the check above
    // and the write (an already-cancelled row comes back as `skipped`).
    logger.warn(
      {
        traceId,
        appointmentRequestId: context.appointmentRequestId,
        previousStatus: result.previousStatus,
      },
      'Cancellation skipped atomically (human control or already cancelled)',
    );
    return {
      kind: 'not_cancelled',
      error:
        `The appointment changed while cancelling (status is "${result.newStatus}"; an admin may have taken control). ` +
        `${NOT_CANCELLED_SUFFIX} Stop, or call flag_for_human_review if it is unclear.`,
    };
  }

  if (result.skipped) {
    logger.info(
      { traceId, appointmentRequestId: context.appointmentRequestId },
      'Appointment already cancelled - skipping (idempotent)',
    );
    return { kind: 'cancelled' };
  }

  // (status_change audit event is written by transitionToCancelled inside its transaction)
  logger.info(
    {
      traceId,
      appointmentRequestId: context.appointmentRequestId,
      wasConfirmed: result.previousStatus === APPOINTMENT_STATUS.CONFIRMED,
    },
    'Appointment cancelled via lifecycle service',
  );
  return { kind: 'cancelled' };
}

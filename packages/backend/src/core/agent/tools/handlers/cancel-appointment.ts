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

  await cancelAppointment(context, {
    reason: parsed.data.reason,
    cancelled_by: parsed.data.cancelled_by,
  }, traceId);

  return {
    result: { success: true, toolName: 'cancel_appointment' },
    checkpointAction: 'processed_cancellation',
  };
}

async function cancelAppointment(
  context: SchedulingContext,
  params: { reason: string; cancelled_by: 'client' | 'therapist' },
  traceId: string,
): Promise<void> {
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
    return;
  }

  if (appointment.humanControlEnabled) {
    logger.info(
      { traceId, appointmentRequestId: context.appointmentRequestId },
      'Human control enabled - skipping cancelAppointment',
    );
    return;
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

  if (result.atomicSkipped) {
    logger.warn(
      {
        traceId,
        appointmentRequestId: context.appointmentRequestId,
        previousStatus: result.previousStatus,
      },
      'Cancellation skipped atomically (human control or already cancelled)',
    );
    return;
  }

  if (result.skipped) {
    logger.info(
      { traceId, appointmentRequestId: context.appointmentRequestId },
      'Appointment already cancelled - skipping (idempotent)',
    );
    return;
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
}

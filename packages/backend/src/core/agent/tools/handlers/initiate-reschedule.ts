/**
 * `initiate_reschedule` — flag a confirmed appointment as
 * actively rescheduling and clear the existing confirmed datetime.
 *
 * The agent uses this when the user/therapist signals they want
 * to change the booked time. The atomic updateMany requires
 * `status: 'confirmed'` AND `humanControlEnabled: false` — any
 * other state returns an error.
 *
 * Follow-up sentinels (meetingLinkCheckSentAt, reminderSentAt) are
 * cleared so the post-booking services re-send the appropriate
 * emails for the new datetime.
 *
 * `checkpointStage` column is NOT set here — the agent tool loop
 * returns `checkpointAction: 'initiated_reschedule'` which advances
 * the JSON checkpoint, and the subsequent storeConversationState
 * syncs the denormalized column. Writing it here would be a
 * redundant direct write that splits the source of truth.
 */

import { logger } from '../../../../utils/logger';
import { prisma } from '../../../../utils/database';
import { initiateRescheduleInputSchema } from '../../../../schemas/tool-inputs';
import type { ConversationAction } from '../../../../services/conversation-checkpoint.service';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

export interface InitiateRescheduleOutcome {
  result: ToolExecutionResult;
  checkpointAction?: ConversationAction;
}

export async function handleInitiateReschedule(
  rawInput: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<InitiateRescheduleOutcome> {
  const parsed = initiateRescheduleInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const errorMsg = `Invalid initiate_reschedule input: ${parsed.error.message}`;
    logger.error({ traceId, errors: parsed.error.errors }, 'Invalid initiate_reschedule input');
    return { result: { success: false, toolName: 'initiate_reschedule', error: errorMsg } };
  }

  // Fetch current appointment to capture the existing confirmedDateTime
  // before we clear it. Stored on previousConfirmedDateTime so the
  // reschedule can be audited / undone.
  const rescheduleAppointment = await prisma.appointmentRequest.findUnique({
    where: { id: context.appointmentRequestId },
    select: { confirmedDateTime: true },
  });

  if (!rescheduleAppointment) {
    return {
      result: { success: false, toolName: 'initiate_reschedule', error: 'Appointment not found' },
    };
  }

  const rescheduleResult = await prisma.appointmentRequest.updateMany({
    where: {
      id: context.appointmentRequestId,
      status: 'confirmed',
      humanControlEnabled: false,
    },
    data: {
      reschedulingInProgress: true,
      reschedulingInitiatedBy: 'agent',
      previousConfirmedDateTime: rescheduleAppointment.confirmedDateTime,
      confirmedDateTime: null,
      meetingLinkCheckSentAt: null,
      reminderSentAt: null,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    },
  });

  if (rescheduleResult.count === 0) {
    return {
      result: {
        success: false,
        toolName: 'initiate_reschedule',
        error: 'Cannot initiate reschedule - appointment is not in confirmed status or human control is enabled',
      },
    };
  }

  logger.info(
    {
      traceId,
      appointmentRequestId: context.appointmentRequestId,
      reason: parsed.data.reason,
    },
    'Initiated reschedule for confirmed appointment',
  );

  return {
    result: { success: true, toolName: 'initiate_reschedule' },
    checkpointAction: 'initiated_reschedule',
  };
}

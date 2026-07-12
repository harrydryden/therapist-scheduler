/**
 * `initiate_reschedule` — flag a confirmed appointment as
 * actively rescheduling and clear the existing confirmed datetime.
 *
 * The agent uses this when the user/therapist signals they want
 * to change the booked time. The atomic updateMany requires
 * `status: 'confirmed'` AND `humanControlEnabled: false` — any
 * other state returns an error.
 *
 * Past-session guard: a reschedule is only meaningful for a session
 * that hasn't happened yet. Once the confirmed time is more than
 * SESSION_END_BUFFER_MS in the past — the same boundary at which the
 * lifecycle tick treats the session as held — the tool refuses.
 * Without this, a post-session email misread as a reschedule request
 * wipes the confirmed datetime, which removes the appointment from
 * the tick's query and permanently strands it in `confirmed`: no
 * session_held, no feedback form, no completion. Within the buffer
 * (session start → start + 1h) rescheduling is still allowed, so a
 * genuine "I missed our session just now" no-show flow keeps working.
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
import { SESSION_END_BUFFER_MS } from '../../../../constants';
import { startReschedulingState } from '../../../../domain/scheduling/lifecycle/update-fragments';
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
    select: { confirmedDateTime: true, confirmedDateTimeParsed: true },
  });

  if (!rescheduleAppointment) {
    return {
      result: { success: false, toolName: 'initiate_reschedule', error: 'Appointment not found' },
    };
  }

  // Past-session guard (see module doc). Compared against the parsed
  // datetime — the same field the lifecycle tick queries — so the guard
  // and the tick agree on when a session stops being reschedulable.
  const sessionStart = rescheduleAppointment.confirmedDateTimeParsed;
  if (sessionStart && Date.now() - sessionStart.getTime() > SESSION_END_BUFFER_MS) {
    logger.warn(
      {
        traceId,
        appointmentRequestId: context.appointmentRequestId,
        confirmedDateTimeParsed: sessionStart,
        reason: parsed.data.reason,
      },
      'Blocked initiate_reschedule - confirmed session time has already passed',
    );
    return {
      result: {
        success: false,
        toolName: 'initiate_reschedule',
        error:
          'Cannot initiate reschedule - the confirmed session time has already passed, so the session is presumed to have taken place and this booking must not be cleared. ' +
          'If the client or therapist is asking for another session, that is a NEW booking: use flag_for_human_review so an admin can arrange it. ' +
          'If they are saying the session never actually happened, also use flag_for_human_review and explain that.',
      },
    };
  }

  const rescheduleResult = await prisma.appointmentRequest.updateMany({
    where: {
      id: context.appointmentRequestId,
      status: 'confirmed',
      humanControlEnabled: false,
    },
    data: {
      ...startReschedulingState({
        initiatedBy: 'agent',
        previousConfirmedDateTime: rescheduleAppointment.confirmedDateTime,
      }),
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

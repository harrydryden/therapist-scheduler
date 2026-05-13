/**
 * Transition: pending | contacted | negotiating | confirmed (reschedule) → confirmed
 *
 * The most complex non-terminal transition. Distinct features:
 *
 *   - Semantic datetime equality. Two renderings of the same time
 *     ("Mon 3 Feb 10am" vs "Monday 3rd February at 10:00am") should be
 *     treated as idempotent, NOT as a reschedule.
 *   - Reschedule branch. When the row is already confirmed at a
 *     different time, we treat it as a reschedule: stamp the previous
 *     time, optionally reset post-booking follow-up sentinels, narrate
 *     the audit differently.
 *   - Atomic options. Callers (notably the agent's mark_scheduling_complete
 *     tool) pass `atomic.requireStatuses` and
 *     `atomic.requireHumanControlDisabled` to guard against concurrent
 *     human takeover. Mismatches return `atomicSkipped` instead of
 *     throwing.
 *   - Capture post-update generation atomically. We use Prisma 5's
 *     `update` (which accepts non-unique filters in `where`) so the
 *     UPDATE … RETURNING returns the post-update transitionGeneration —
 *     critical for side-effect-tracker idempotency keys. The previous
 *     read-side `+1` had a race where a concurrent confirmation could
 *     bump generation between our read and our notification dispatch,
 *     causing keys to collide with the concurrent transition's
 *     already-completed rows and silently drop our notifications.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../../../utils/database';
import { logger } from '../../../../utils/logger';
import { areDatetimesEqual } from '../../../../utils/date';
import { APPOINTMENT_STATUS, type AppointmentStatus } from '../../../../constants';
import {
  AppointmentNotFoundError,
  InvalidTransitionError,
} from '../../../../errors';
import { appointmentNotificationsService } from '../../../../services/appointment-notifications.service';
import { transitionSideEffectsService } from '../../../../services/transition-side-effects.service';
import { addAuditMessage, recordStatusChangeEvent } from '../audit';
import {
  CLEAR_RESCHEDULING_STATE,
  RESET_ALL_FOLLOWUP_SENTINELS,
} from '../update-fragments';
import { progressionResetsFor } from '../status-order';
import { fireAndForget, notifyTransition } from '../dispatch-helpers';
import type { TransitionResult, TransitionToConfirmedParams } from '../types';

export async function transitionToConfirmed(
  params: TransitionToConfirmedParams,
): Promise<TransitionResult> {
  const {
    appointmentId,
    confirmedDateTime,
    confirmedDateTimeParsed,
    notes,
    source,
    adminId,
    sendEmails = true,
    atomic,
  } = params;

  const logContext = { appointmentId, source, adminId };

  // Valid source statuses for confirmation (forward progress + reschedule)
  const validFromStatuses = [
    APPOINTMENT_STATUS.PENDING,
    APPOINTMENT_STATUS.CONTACTED,
    APPOINTMENT_STATUS.NEGOTIATING,
    APPOINTMENT_STATUS.CONFIRMED, // Reschedule
  ];

  // Get current appointment state with all needed fields
  const appointment = await prisma.appointmentRequest.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      status: true,
      userName: true,
      userEmail: true,
      therapistName: true,
      therapistEmail: true,
      therapistHandle: true,
      confirmedDateTime: true,
      humanControlEnabled: true,
      transitionGeneration: true,
    },
  });

  if (!appointment) {
    logger.error(logContext, 'Cannot transition to confirmed - appointment not found');
    throw new AppointmentNotFoundError(appointmentId);
  }

  const previousStatus = appointment.status as AppointmentStatus;

  // Check if already confirmed with same datetime (idempotent).
  // Use semantic comparison so a re-confirm with a slightly different
  // rendering ("Mon 3 Feb at 10:00 AM" vs "Monday 3rd February at
  // 10am") is correctly treated as a no-op rather than a reschedule.
  // Without this, a benign agent-emitted variant of the same datetime
  // would flip wasConfirmed/isReschedule, fire a reschedule audit
  // narrative, and reset follow-up sentinels.
  if (
    appointment.status === APPOINTMENT_STATUS.CONFIRMED &&
    areDatetimesEqual(appointment.confirmedDateTime, confirmedDateTime)
  ) {
    logger.debug(logContext, 'Appointment already confirmed with same datetime - skipping');
    return {
      success: true,
      previousStatus,
      newStatus: APPOINTMENT_STATUS.CONFIRMED,
      skipped: true,
    };
  }

  // Validate source status — reject transitions from terminal/post-session states
  if (!validFromStatuses.includes(previousStatus)) {
    logger.warn(
      { ...logContext, currentStatus: previousStatus },
      `Invalid transition: ${previousStatus} → confirmed`,
    );
    throw new InvalidTransitionError(previousStatus, 'confirmed');
  }

  const wasConfirmed = appointment.status === APPOINTMENT_STATUS.CONFIRMED;
  // Semantic compare so two different renderings of the same time
  // ("Mon 3rd Feb 10am" vs "Monday 3rd February at 10:00am") aren't
  // mistaken for a reschedule.
  const isReschedule = wasConfirmed && !areDatetimesEqual(appointment.confirmedDateTime, confirmedDateTime);
  const reschedule = params.reschedule;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: any = {
    status: APPOINTMENT_STATUS.CONFIRMED,
    confirmedDateTime,
    confirmedDateTimeParsed: confirmedDateTimeParsed || null,
    // Set confirmedAt: new Date() for first confirmation, reset for reschedules.
    // (The wasConfirmed && !isReschedule case is unreachable — caught by the
    // idempotent same-datetime check above.)
    confirmedAt: new Date(),
    notes: notes || undefined,
    lastActivityAt: new Date(),
    updatedAt: new Date(),
    // Bump generation atomically with the status flip. Critical for the
    // cancel → re-confirm path: without this, the second confirmation's
    // Slack/email side-effect rows would dedupe against the first
    // confirmation's already-completed entries and never fire.
    transitionGeneration: { increment: 1 },
    // Always clear rescheduling flags when confirming.
    ...CLEAR_RESCHEDULING_STATE,
    // Clear isStale + any other progression-based field resets.
    ...progressionResetsFor(APPOINTMENT_STATUS.CONFIRMED),
  };

  // Handle reschedule-specific fields
  if (reschedule) {
    if (reschedule.previousConfirmedDateTime) {
      updateData.previousConfirmedDateTime = reschedule.previousConfirmedDateTime;
    }
    if (reschedule.resetFollowUpFlags) {
      Object.assign(updateData, RESET_ALL_FOLLOWUP_SENTINELS);
    }
  }

  // The "already at the target state" precondition. Spread into both
  // updateMany where clauses below. Without it, two concurrent calls
  // that both read CONFIRMED@T0 and target T1 would both pass the
  // read-time idempotent skip (T0 ≠ T1) and both succeed at the
  // updateMany — double-firing audit + side effects. The NOT clause
  // means only the first write lands; the second sees count=0 and
  // the post-write re-fetch detects "already at target" and returns
  // an idempotent skip instead of re-firing.
  const notAlreadyAtTarget = {
    NOT: {
      status: APPOINTMENT_STATUS.CONFIRMED,
      confirmedDateTime,
    },
  } as const;

  // Atomic update with preconditions — Prisma 5's `update` accepts
  // non-unique filters in `where`, so we can express the source-status
  // and "not already at target" guards in the same query that performs
  // the write. This lets us atomically capture the post-update
  // transitionGeneration in `updated.transitionGeneration`, which we
  // need below for side-effect-tracker idempotency keys.
  const allowedStatuses = atomic ? atomic.requireStatuses : validFromStatuses;
  const whereClause: Prisma.AppointmentRequestWhereUniqueInput = {
    id: appointmentId,
    status: { in: allowedStatuses },
    ...notAlreadyAtTarget,
    ...(atomic?.requireHumanControlDisabled ? { humanControlEnabled: false } : {}),
  };

  let postUpdateGeneration: number;
  try {
    const updated = await prisma.appointmentRequest.update({
      where: whereClause,
      data: updateData,
      select: { transitionGeneration: true },
    });
    postUpdateGeneration = updated.transitionGeneration;
    logger.info({ ...logContext, atomic: !!atomic }, 'Appointment confirmed atomically');
  } catch (err) {
    // Prisma throws P2025 (RecordNotFound) when the where preconditions
    // don't match — i.e. status drifted, human control flipped on, or
    // a concurrent caller already wrote our exact target datetime.
    // Re-fetch to attribute the failure precisely.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2025') {
      throw err;
    }

    const current = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: { status: true, humanControlEnabled: true, confirmedDateTime: true },
    });

    if (atomic?.requireHumanControlDisabled && current?.humanControlEnabled) {
      logger.info(
        { ...logContext },
        'Human control enabled between check and update - atomic confirmation skipped',
      );
      return { success: false, previousStatus, newStatus: previousStatus, atomicSkipped: true };
    }

    if (
      current?.status === APPOINTMENT_STATUS.CONFIRMED &&
      current?.confirmedDateTime === confirmedDateTime
    ) {
      logger.info(
        { ...logContext, confirmedDateTime },
        'Concurrent confirmation already wrote target datetime — treating as idempotent skip',
      );
      return {
        success: true,
        previousStatus,
        newStatus: APPOINTMENT_STATUS.CONFIRMED,
        skipped: true,
      };
    }

    if (atomic && current?.status === APPOINTMENT_STATUS.CONFIRMED) {
      logger.info(
        { ...logContext, existingDateTime: current?.confirmedDateTime, attemptedDateTime: confirmedDateTime },
        'Appointment already confirmed by another process (concurrent confirmation prevented)',
      );
      return { success: false, previousStatus, newStatus: APPOINTMENT_STATUS.CONFIRMED, atomicSkipped: true };
    }

    if (atomic) {
      logger.warn(
        { ...logContext, currentStatus: current?.status },
        'Atomic confirmation failed - status changed unexpectedly',
      );
      return { success: false, previousStatus, newStatus: previousStatus, atomicSkipped: true };
    }

    logger.warn(
      { ...logContext, currentStatus: current?.status, readStatus: previousStatus },
      'Confirmation failed - status changed between read and write',
    );
    throw new InvalidTransitionError(current?.status || previousStatus, 'confirmed');
  }

  // Add audit trail (conversation-state JSON message + status_change audit event row).
  // Independent writes — run in parallel.
  await Promise.all([
    addAuditMessage(
      appointmentId,
      source,
      isReschedule
        ? `Appointment rescheduled: ${appointment.confirmedDateTime} → ${confirmedDateTime}`
        : `Status changed: ${previousStatus} → confirmed for ${confirmedDateTime}`,
      adminId,
    ),
    recordStatusChangeEvent(
      appointmentId,
      source,
      adminId,
      previousStatus,
      APPOINTMENT_STATUS.CONFIRMED,
      isReschedule
        ? `Rescheduled to ${confirmedDateTime}`
        : `Confirmed for ${confirmedDateTime}`,
    ),
  ]);

  logger.info(
    { ...logContext, isReschedule, confirmedDateTime },
    isReschedule ? 'Appointment rescheduled' : 'Appointment confirmed',
  );

  // Log invalid date alert if the confirmed datetime could not be parsed
  if (!confirmedDateTimeParsed && confirmedDateTime) {
    logger.warn(
      { ...logContext, confirmedDateTime },
      'Invalid date alert raised - confirmed datetime could not be parsed',
    );
  }

  // Post-transition side effects (therapist booking status)
  fireAndForget(
    transitionSideEffectsService.onConfirmed({
      appointmentId,
      source,
      adminId,
      therapistHandle: appointment.therapistHandle,
      therapistName: appointment.therapistName,
      userEmail: appointment.userEmail,
    }),
    appointmentId,
    'onConfirmed',
  );

  // Send Slack + email notifications (delegated to notifications service).
  // We use the post-update generation captured atomically by the update
  // above. The previous read-time `+1` had a race where a concurrent
  // transition could bump generation between read and write, causing
  // our idempotency keys to collide with the other transition's
  // already-completed entries and silently dropping notifications.
  const newGeneration = postUpdateGeneration;
  fireAndForget(
    appointmentNotificationsService.notifyConfirmed({
      appointmentId,
      source,
      adminId,
      userName: appointment.userName,
      userEmail: appointment.userEmail,
      therapistName: appointment.therapistName,
      therapistEmail: appointment.therapistEmail,
      confirmedDateTime,
      confirmedDateTimeParsed,
      sendEmails,
      transitionGeneration: newGeneration,
    }),
    appointmentId,
    'notifyConfirmed',
  );

  const transition: TransitionResult = {
    success: true,
    previousStatus,
    newStatus: APPOINTMENT_STATUS.CONFIRMED,
  };
  notifyTransition(transition, appointmentId, source);
  return transition;
}

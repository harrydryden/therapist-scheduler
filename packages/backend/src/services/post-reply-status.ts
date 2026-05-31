/**
 * Post-reply appointment-status reconciliation.
 *
 * After the booking agent's tool loop finishes processing an inbound email,
 * the appointment status may need a nudge that the agent didn't perform
 * itself — most commonly `pending`/`contacted` → `negotiating` once a party
 * has actually replied. This logic was previously a private method on
 * JustinTimeService; it's its own module so it can be unit-tested without
 * dragging in the anthropic client + the rest of the orchestrator's graph
 * (same rationale as tool-loop-helpers.ts / tools-for-stage.ts).
 *
 * Important: the `appointmentRequest` snapshot is read BEFORE the tool loop
 * runs, so its `status` can be stale by the time we get here — the agent may
 * have driven the row to a terminal/forward state during the turn
 * (`mark_scheduling_complete` → confirmed, `cancel_appointment` → cancelled).
 * The lifecycle service's atomic preconditions are the source of truth; this
 * function treats a rejected transition as a benign no-op rather than letting
 * it bubble up as a processing failure.
 */

import { logger } from '../utils/logger';
import { prisma } from '../utils/database';
import { appointmentLifecycleService } from '../domain/scheduling/lifecycle';
import { InvalidTransitionError } from '../errors';

export interface PostReplyAppointmentSnapshot {
  id: string;
  status: string;
  confirmedDateTime?: string | null;
  reschedulingInProgress?: boolean | null;
}

export interface ReconcileStatusAfterReplyArgs {
  /** Snapshot taken BEFORE the tool loop — `status` may be stale. */
  appointmentRequest: PostReplyAppointmentSnapshot;
  appointmentRequestId: string;
  /** Sender of the inbound email — recorded as the reschedule initiator. */
  fromEmail: string;
  executedTools: Array<{ toolName: string; emailSentTo?: 'user' | 'therapist'; timestamp: string }>;
  traceId: string;
}

/**
 * Reconcile appointment status based on the executed tools and the
 * (pre-loop) status snapshot. Encapsulates the post-tool-loop transition
 * logic.
 *
 * Valid transitions:
 *   - pending | contacted -> negotiating (a party replied)
 *   - confirmed + initiate_reschedule -> clear confirmed datetime, flag reschedule
 *   - confirmed + mark_scheduling_complete -> no-op (reschedule already finalised)
 *   - confirmed (informational) -> no status change
 *   - cancelled -> no status change (terminal)
 */
export async function reconcileStatusAfterReply(
  args: ReconcileStatusAfterReplyArgs,
): Promise<void> {
  const { appointmentRequest, appointmentRequestId, fromEmail, executedTools, traceId } = args;

  // Use lifecycle service instead of a direct Prisma update for audit trail
  // & consistency.
  const validTransitionStates = ['pending', 'contacted'];
  if (validTransitionStates.includes(appointmentRequest.status)) {
    // The agent may have already driven the row to a terminal/forward state
    // during this turn (mark_scheduling_complete → confirmed,
    // cancel_appointment → cancelled), or a concurrent writer may have moved
    // it. In those cases the pending/contacted → negotiating transition is
    // moot and the lifecycle service throws InvalidTransitionError. Treat
    // that as a benign no-op — the same idiom startScheduling uses for its
    // pending → contacted call — rather than letting it propagate to
    // process.ts, where it would be counted as a processing failure
    // (spurious "Message Processing Failed" Slack alert) and leave the
    // message unmarked for a wasteful scanner re-process of an
    // already-terminal appointment.
    try {
      await appointmentLifecycleService.transitionToNegotiating({
        appointmentId: appointmentRequestId,
        source: 'agent',
      });
      logger.info(
        { traceId, appointmentRequestId, oldStatus: appointmentRequest.status },
        'Status transitioned to negotiating via lifecycle service',
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        logger.debug(
          { traceId, appointmentRequestId, oldStatus: appointmentRequest.status },
          'Skipping → negotiating: status already advanced during this turn (agent transition or concurrent writer)',
        );
      } else {
        throw err;
      }
    }
  } else if (appointmentRequest.status === 'confirmed') {
    // Confirmed appointment received an email - could be a rescheduling request
    // or just an informational reply (e.g. acknowledging a meeting link check).
    const completedReschedule = executedTools.some(
      (t) => t.toolName === 'mark_scheduling_complete',
    );
    const initiatedReschedule = executedTools.some(
      (t) => t.toolName === 'initiate_reschedule',
    );

    if (completedReschedule) {
      logger.info(
        { traceId, appointmentRequestId },
        'Skipping rescheduling flag update - mark_scheduling_complete already finalized the reschedule',
      );
    } else if (initiatedReschedule) {
      // Agent confirmed this is a reschedule. Clear the confirmed date/time.
      // checkpointStage is intentionally NOT set here — the agent tool loop
      // already advanced the JSON checkpoint via the `initiated_reschedule`
      // action, and the subsequent storeConversationState call will sync
      // the denormalized column from the JSON.
      //
      // Status-guarded (updateMany WHERE status='confirmed') so a concurrent
      // cancel/complete landing between the tool loop and here can't resurrect
      // reschedule fields (confirmedDateTime=null, reschedulingInProgress=true)
      // onto a terminal row. The normal path is unaffected — initiate_reschedule
      // leaves the row 'confirmed'.
      const rescheduleUpdate = await prisma.appointmentRequest.updateMany({
        where: { id: appointmentRequestId, status: 'confirmed' },
        data: {
          reschedulingInProgress: true,
          reschedulingInitiatedBy: fromEmail,
          previousConfirmedDateTime: appointmentRequest.confirmedDateTime,
          confirmedDateTime: null,
          confirmedDateTimeParsed: null,
        },
      });
      if (rescheduleUpdate.count === 0) {
        logger.warn(
          { traceId, appointmentRequestId },
          'Reschedule flag-update skipped — appointment no longer confirmed (concurrent cancel/complete)',
        );
      } else {
        logger.info(
          { traceId, appointmentRequestId, initiatedBy: fromEmail, previousDateTime: appointmentRequest.confirmedDateTime },
          'Agent initiated reschedule for confirmed appointment - cleared stale date/time',
        );
      }
    } else {
      // Informational reply — leave appointment state untouched.
      logger.info(
        { traceId, appointmentRequestId, executedToolNames: executedTools.map((t) => t.toolName) },
        'Email received for confirmed appointment - no reschedule initiated, treating as informational',
      );
    }
  } else if (appointmentRequest.status === 'cancelled') {
    logger.warn(
      { traceId, appointmentRequestId, status: appointmentRequest.status },
      'Received email for cancelled appointment - not updating status',
    );
  }
}

/**
 * Lifecycle status ordering + progression-based field-reset rules.
 *
 * The state machine has a strict forward order (pending → contacted →
 * negotiating → confirmed → session_held → feedback_requested →
 * completed) with cancellation reachable from any non-terminal state.
 * Two helpers in this module use that ordering:
 *
 *   - `progressionResetsFor(targetStatus)` returns the extra fields to
 *     clear when advancing FORWARD into the target (currently just
 *     `isStale`, which is pre-confirmation-only and must be cleared on
 *     any advance to confirmed-or-beyond OR to cancelled).
 *   - `computeBackwardSentinelResets(from, to)` is the admin-force-update
 *     companion: when an admin walks the row BACKWARDS, the post-stage
 *     follow-up sentinels must be cleared so the post-booking automated
 *     services don't skip the next pass.
 *
 * Pure module — no Prisma, no I/O. Safe to import from anywhere.
 */

import { Prisma } from '@prisma/client';
import { APPOINTMENT_STATUS, type AppointmentStatus } from '../../../constants';

export const LIFECYCLE_STATUS_ORDER: readonly AppointmentStatus[] = [
  APPOINTMENT_STATUS.PENDING,
  APPOINTMENT_STATUS.CONTACTED,
  APPOINTMENT_STATUS.NEGOTIATING,
  APPOINTMENT_STATUS.CONFIRMED,
  APPOINTMENT_STATUS.SESSION_HELD,
  APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
  APPOINTMENT_STATUS.COMPLETED,
] as const;

const CONFIRMED_IDX = LIFECYCLE_STATUS_ORDER.indexOf(APPOINTMENT_STATUS.CONFIRMED);
const FEEDBACK_IDX = LIFECYCLE_STATUS_ORDER.indexOf(APPOINTMENT_STATUS.FEEDBACK_REQUESTED);

/**
 * Fields written alongside `status` whenever the lifecycle advances TO
 * `targetStatus`. Currently this is just clearing the `isStale` flag on
 * any progression to confirmed-or-beyond (or to cancelled): stale only
 * applies to pre-confirmation statuses, so it must be cleared the moment
 * the appointment moves past that point.
 *
 * Returning a partial update lets callers spread it into their existing
 * update payloads without branching, and centralises the rule so any new
 * lifecycle field that needs auto-clearing on progression has exactly one
 * place to live.
 */
export function progressionResetsFor(
  targetStatus: AppointmentStatus,
): Partial<Prisma.AppointmentRequestUpdateInput> {
  const targetIdx = LIFECYCLE_STATUS_ORDER.indexOf(targetStatus);
  const advancesPastNegotiation =
    targetIdx >= CONFIRMED_IDX || targetStatus === APPOINTMENT_STATUS.CANCELLED;
  return advancesPastNegotiation ? { isStale: false } : {};
}

/**
 * Compute the follow-up sentinel resets needed when an admin force-update
 * moves an appointment BACKWARDS in the lifecycle. Without these, the
 * automated post-booking services would skip re-sending emails because the
 * sentinel is already set from the first pass through.
 *
 * Called only by adminForceUpdate; the normal forward-progress transitions
 * never need to reset post-stage sentinels.
 */
export function computeBackwardSentinelResets(
  fromStatus: AppointmentStatus,
  toStatus: AppointmentStatus,
): { updates: Prisma.AppointmentRequestUpdateInput; reset: boolean } {
  const fromIdx = LIFECYCLE_STATUS_ORDER.indexOf(fromStatus);
  const toIdx = LIFECYCLE_STATUS_ORDER.indexOf(toStatus);
  const movingBackwards = toIdx >= 0 && fromIdx >= 0 && toIdx < fromIdx;
  if (!movingBackwards) return { updates: {}, reset: false };

  const updates: Prisma.AppointmentRequestUpdateInput = {};
  let reset = false;

  // Moving back to confirmed-or-earlier from past-confirmed → reset
  // post-confirmation follow-ups (meeting-link check, session reminder).
  if (toIdx <= CONFIRMED_IDX && fromIdx > CONFIRMED_IDX) {
    updates.meetingLinkCheckSentAt = null;
    updates.reminderSentAt = null;
    reset = true;
  }

  // Moving back to before feedback_requested from at-or-past it → reset
  // feedback sentinels.
  if (toIdx < FEEDBACK_IDX && fromIdx >= FEEDBACK_IDX) {
    updates.feedbackFormSentAt = null;
    updates.feedbackReminderSentAt = null;
    reset = true;
  }

  return { updates, reset };
}

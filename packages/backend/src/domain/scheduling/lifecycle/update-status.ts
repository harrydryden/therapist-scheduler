/**
 * Generic admin "set the status to X" dispatch.
 *
 * Routes a target `AppointmentStatus` to the specialised transition
 * function with the param translation each transition needs (e.g.
 * cancellation derives `cancelledBy` from `source`, confirmation
 * needs the datetime, completion uses `reason` as a note).
 *
 * Defined as a const map keyed by `AppointmentStatus` so adding a new
 * status forces the map to be updated — TypeScript flags missing keys
 * when the union is extended. A switch had two pitfalls this fixes:
 *   - the cancelled branch silently defaulted `cancelledBy='system'`
 *     when `source` wasn't 'admin', conflating agent + system
 *     cancellations;
 *   - the missing 'pending' case fell through to the default, which
 *     threw "Unknown status" instead of being explicitly rejected as
 *     a target.
 */

import { APPOINTMENT_STATUS, type AppointmentStatus } from '../../../constants';
import { transitionToContacted, transitionToNegotiating, transitionToSessionHeld, transitionToFeedbackRequested } from './transitions/light';
import { transitionToConfirmed } from './transitions/confirmed';
import { transitionToCompleted } from './transitions/completed';
import { transitionToCancelled } from './transitions/cancelled';
import type { TransitionResult, TransitionSource } from './types';

export interface UpdateStatusOptions {
  source: TransitionSource;
  adminId?: string;
  reason?: string;
  confirmedDateTime?: string;
  confirmedDateTimeParsed?: Date | null;
  sendEmails?: boolean;
}

type UpdateStatusDispatcher = (
  appointmentId: string,
  options: UpdateStatusOptions,
) => Promise<TransitionResult>;

/**
 * Identity helper to force TypeScript to infer each arrow's parameter
 * types from the dispatcher type. Without this, `Partial<Record<K, F>>`
 * widens each value to `F | undefined` and parameters end up `any`.
 */
const dispatch = (fn: UpdateStatusDispatcher): UpdateStatusDispatcher => fn;

const UPDATE_STATUS_DISPATCH: Partial<Record<AppointmentStatus, UpdateStatusDispatcher>> = {
  [APPOINTMENT_STATUS.CONTACTED]: dispatch((appointmentId, opts) =>
    transitionToContacted({
      appointmentId,
      source: opts.source,
      adminId: opts.adminId,
      hasAvailability: false,
    })),

  [APPOINTMENT_STATUS.NEGOTIATING]: dispatch((appointmentId, opts) =>
    transitionToNegotiating({
      appointmentId,
      source: opts.source,
      adminId: opts.adminId,
    })),

  [APPOINTMENT_STATUS.CONFIRMED]: dispatch((appointmentId, opts) => {
    if (!opts.confirmedDateTime) {
      throw new Error('confirmedDateTime is required for confirmed status');
    }
    return transitionToConfirmed({
      appointmentId,
      confirmedDateTime: opts.confirmedDateTime,
      confirmedDateTimeParsed: opts.confirmedDateTimeParsed,
      source: opts.source,
      adminId: opts.adminId,
      sendEmails: opts.sendEmails,
    });
  }),

  [APPOINTMENT_STATUS.SESSION_HELD]: dispatch((appointmentId, opts) =>
    transitionToSessionHeld({
      appointmentId,
      source: opts.source,
      adminId: opts.adminId,
    })),

  [APPOINTMENT_STATUS.FEEDBACK_REQUESTED]: dispatch((appointmentId, opts) =>
    transitionToFeedbackRequested({
      appointmentId,
      source: opts.source,
      adminId: opts.adminId,
    })),

  [APPOINTMENT_STATUS.COMPLETED]: dispatch((appointmentId, opts) =>
    transitionToCompleted({
      appointmentId,
      source: opts.source,
      adminId: opts.adminId,
      note: opts.reason,
    })),

  [APPOINTMENT_STATUS.CANCELLED]: dispatch((appointmentId, opts) =>
    transitionToCancelled({
      appointmentId,
      reason: opts.reason || 'No reason provided',
      // updateStatus() is currently only called from admin routes, so source
      // is always 'admin' in practice. Preserve the original mapping for any
      // hypothetical 'system' caller; agent-path cancellations call
      // transitionToCancelled directly with an explicit cancelledBy.
      cancelledBy: opts.source === 'admin' ? 'admin' : 'system',
      source: opts.source,
      adminId: opts.adminId,
    })),
};

/**
 * Generic status update method for admin dashboard.
 * Routes to the appropriate transition function based on new status.
 */
export async function updateStatus(
  appointmentId: string,
  newStatus: AppointmentStatus,
  options: UpdateStatusOptions,
): Promise<TransitionResult> {
  const fn = UPDATE_STATUS_DISPATCH[newStatus];
  if (!fn) {
    throw new Error(`Unknown status: ${newStatus}`);
  }
  return fn(appointmentId, options);
}

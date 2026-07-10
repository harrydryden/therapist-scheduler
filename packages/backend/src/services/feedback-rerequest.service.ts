/**
 * Re-request feedback.
 *
 * Discards an appointment's existing feedback submission (if any) and sends a
 * fresh, properly-tokened feedback-form email — the recovery path for a form
 * that was sent too early or submitted in error.
 *
 * Why this needs to be a composed operation rather than "just resend":
 *   - The submit endpoint blocks a second submission while a FeedbackSubmission
 *     row exists for the appointment, so the stale row must be deleted first.
 *   - Once an appointment is `feedback_requested`/`completed`, the
 *     `transitionToFeedbackRequested` transition won't re-fire (it either skips
 *     or is invalid), so the appointment is walked back to `session_held` via
 *     the admin-force path (which also nulls the feedback sentinels) before the
 *     fresh request is sent.
 *   - The email itself is built through the shared helper so the link carries a
 *     valid `?fk=` token.
 *
 * Used by both the admin HTTP endpoint and the one-off recovery script, so the
 * behaviour is identical however it's invoked.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { APPOINTMENT_STATUS, type AppointmentStatus } from '../constants';
import { AppointmentNotFoundError, BadRequestError } from '../errors';
import { appointmentLifecycleService } from '../domain/scheduling/lifecycle';
import { emailProcessingService } from './email-processing.service';
import { buildFeedbackEmailPayload } from './feedback-email.helper';

/**
 * Statuses from which re-requesting feedback makes sense. These mirror the
 * statuses the feedback submit endpoint accepts — anything earlier means the
 * session hasn't happened, so there's nothing to gather feedback on.
 */
const ELIGIBLE_STATUSES: readonly AppointmentStatus[] = [
  APPOINTMENT_STATUS.CONFIRMED,
  APPOINTMENT_STATUS.SESSION_HELD,
  APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
  APPOINTMENT_STATUS.COMPLETED,
];

/** Statuses at or past `feedback_requested` need a walk-back before re-sending. */
const NEEDS_WALKBACK: readonly AppointmentStatus[] = [
  APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
  APPOINTMENT_STATUS.COMPLETED,
];

export interface ReRequestFeedbackResult {
  appointmentId: string;
  emailSentTo: string;
  deletedSubmissions: number;
  previousStatus: AppointmentStatus;
  newStatus: AppointmentStatus;
}

/**
 * Discard existing feedback for an appointment and send a fresh tokened
 * feedback-form email, leaving the appointment in `feedback_requested`.
 *
 * Throws `AppointmentNotFoundError` (404) or `BadRequestError` (400,
 * machine-readable `code`) for expected validation failures; unexpected
 * errors propagate for the caller to log and 500.
 */
export async function reRequestFeedback(params: {
  appointmentId: string;
  adminId: string;
}): Promise<ReRequestFeedbackResult> {
  const { appointmentId, adminId } = params;

  const appointment = await prisma.appointmentRequest.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      userName: true,
      userEmail: true,
      therapistName: true,
      trackingCode: true,
      gmailThreadId: true,
      status: true,
    },
  });

  if (!appointment) {
    throw new AppointmentNotFoundError(appointmentId);
  }

  const previousStatus = appointment.status as AppointmentStatus;

  // A valid feedback link is bound to the tracking code via the HMAC token;
  // without one we can't build a link that completes the appointment.
  if (!appointment.trackingCode) {
    throw new BadRequestError(
      'Appointment has no tracking code — cannot build a valid feedback link.',
      'FEEDBACK_NO_TRACKING_CODE',
    );
  }

  if (!ELIGIBLE_STATUSES.includes(previousStatus)) {
    throw new BadRequestError(
      `Cannot request feedback for an appointment in status "${previousStatus}". ` +
        `The session must have reached at least "confirmed".`,
      'FEEDBACK_INELIGIBLE_STATUS',
    );
  }

  // 1. Remove any existing submission so the submit endpoint's duplicate guard
  //    doesn't block the fresh form (scoped to this appointment only).
  const deleted = await prisma.feedbackSubmission.deleteMany({
    where: { appointmentRequestId: appointmentId },
  });

  // 2. If the appointment already reached/passed feedback_requested, walk it
  //    back to session_held so the forward transition can re-fire. The
  //    admin-force path also nulls feedbackFormSentAt/feedbackReminderSentAt.
  if (NEEDS_WALKBACK.includes(previousStatus)) {
    await appointmentLifecycleService.adminForceUpdate(appointmentId, {
      newStatus: APPOINTMENT_STATUS.SESSION_HELD,
      bypassStateMachine: true,
      adminId,
      reason:
        `Re-request feedback: reset ${previousStatus} → session_held to re-send the feedback form ` +
        `(discarded ${deleted.count} prior submission${deleted.count === 1 ? '' : 's'}).`,
      skipNotifications: true,
    });
  }

  // 3. Send the fresh, tokened feedback-form email.
  const emailPayload = await buildFeedbackEmailPayload(appointment);
  await emailProcessingService.sendEmail(emailPayload);

  // 4. Transition to feedback_requested — stamps a fresh feedbackFormSentAt and
  //    writes the audit trail. Admin source allows confirmed → feedback_requested.
  await appointmentLifecycleService.transitionToFeedbackRequested({
    appointmentId,
    source: 'admin',
    adminId,
  });

  logger.info(
    {
      appointmentId,
      adminId,
      previousStatus,
      deletedSubmissions: deleted.count,
      userEmail: appointment.userEmail,
    },
    'Re-requested feedback: discarded prior submission(s), re-sent tokened feedback form',
  );

  return {
    appointmentId,
    emailSentTo: appointment.userEmail,
    deletedSubmissions: deleted.count,
    previousStatus,
    newStatus: APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
  };
}

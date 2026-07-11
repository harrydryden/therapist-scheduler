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
 *     Anonymous rows sharing the tracking code (from historical tokenless
 *     links) are discarded too — they are the too-early submissions this flow
 *     exists to clean up.
 *   - Once an appointment is `feedback_requested`/`completed`, the
 *     `transitionToFeedbackRequested` transition won't re-fire (it either skips
 *     or is invalid), so the appointment is walked back to `session_held` via
 *     the admin-force path (which also nulls the feedback sentinels) before the
 *     fresh request is sent.
 *   - The walk-back leaves the row in exactly the state the post-booking
 *     feedback cron looks for (session_held + null sentinel + past session), so
 *     this flow immediately CAS-claims `feedbackFormSentAt` before sending.
 *     That makes it mutually exclusive with both the cron (which only claims a
 *     NULL sentinel) and a concurrent re-request. On a failed send the claim
 *     timestamp is deliberately left in place: the row stays invisible to the
 *     cron (whose harness dedupe would otherwise strand the sentinel at EPOCH —
 *     see side-effect-harness.ts), and a retry of this flow re-claims cleanly.
 *   - The email itself is built through the shared helper so the link carries a
 *     valid `?fk=` token.
 *
 * Used by both the admin HTTP endpoint and the one-off recovery script, so the
 * behaviour is identical however it's invoked.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import {
  APPOINTMENT_STATUS,
  POST_BOOKING_STATUSES,
  type AppointmentStatus,
} from '../constants';
import { AppointmentNotFoundError, BadRequestError, ConflictError } from '../errors';
import { appointmentLifecycleService } from '../domain/scheduling/lifecycle';
import { emailProcessingService } from './email-processing.service';
import { buildFeedbackEmailPayload } from './feedback-email.helper';

/**
 * Statuses from which re-requesting feedback makes sense: confirmed and
 * beyond, excluding cancelled. Mirrors the set the public feedback submit
 * endpoint accepts — anything earlier means the session hasn't happened.
 * (Shared constant so backend and frontend gating can't drift.)
 */
const ELIGIBLE_STATUSES = POST_BOOKING_STATUSES;

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
 * Throws `AppointmentNotFoundError` (404), `BadRequestError` (400) or
 * `ConflictError` (409) with machine-readable `code`s for expected
 * failures; unexpected errors propagate for the caller to log and 500.
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
      confirmedDateTimeParsed: true,
      feedbackFormSentAt: true,
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

  // `confirmed` is eligible only as a back-fill for sessions that already
  // happened but never auto-advanced. A confirmed appointment whose session
  // is still in the FUTURE must not get a feedback form — and transitioning
  // it to feedback_requested would silently pull it out of the session
  // reminder / meeting-link automations that key off `confirmed`.
  if (
    previousStatus === APPOINTMENT_STATUS.CONFIRMED &&
    appointment.confirmedDateTimeParsed &&
    appointment.confirmedDateTimeParsed > new Date()
  ) {
    throw new BadRequestError(
      'The session has not happened yet — feedback cannot be requested before ' +
        `the confirmed session time (${appointment.confirmedDateTimeParsed.toISOString()}).`,
      'FEEDBACK_SESSION_NOT_HELD',
    );
  }

  // 1. Remove existing submissions so the submit endpoint's duplicate guard
  //    doesn't block the fresh form. Two shapes are discarded:
  //    - rows linked to this appointment (normal tokened submissions)
  //    - anonymous rows carrying this tracking code with no appointment link
  //      (produced by historical tokenless links — the too-early submissions
  //      this flow exists to clean up). Scoped strictly to this appointment's
  //      tracking code.
  const deleted = await prisma.feedbackSubmission.deleteMany({
    where: {
      OR: [
        { appointmentRequestId: appointmentId },
        { trackingCode: appointment.trackingCode.toUpperCase(), appointmentRequestId: null },
      ],
    },
  });

  // 2. If the appointment already reached/passed feedback_requested, walk it
  //    back to session_held so the forward transition can re-fire. The
  //    admin-force path also nulls feedbackFormSentAt/feedbackReminderSentAt.
  const walkedBack = NEEDS_WALKBACK.includes(previousStatus);
  if (walkedBack) {
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

  // 3. Claim the send exclusively: CAS `feedbackFormSentAt` from its expected
  //    current value (null right after a walk-back, otherwise whatever we
  //    read) to a fresh claim timestamp. This excludes BOTH the 15-min
  //    feedback cron (which only claims a null sentinel and only selects
  //    null-sentinel candidates) and a concurrent re-request racing us.
  const claimStamp = new Date();
  const expectedSentinel = walkedBack ? null : appointment.feedbackFormSentAt;
  const claim = await prisma.appointmentRequest.updateMany({
    where: { id: appointmentId, feedbackFormSentAt: expectedSentinel },
    data: { feedbackFormSentAt: claimStamp },
  });
  if (claim.count === 0) {
    throw new ConflictError(
      'Another re-request or the feedback automation is already processing this appointment — try again in a moment.',
      'FEEDBACK_REREQUEST_IN_FLIGHT',
    );
  }

  // 4. Send the fresh, tokened feedback-form email. If this throws, the claim
  //    timestamp is intentionally left in place (see module doc): the row is
  //    stable and invisible to the cron, and a retry re-claims from the fresh
  //    read. Submissions were already discarded, which is idempotent.
  const emailPayload = await buildFeedbackEmailPayload(appointment);
  await emailProcessingService.sendEmail(emailPayload);

  // 5. Transition to feedback_requested — stamps the real feedbackFormSentAt
  //    (overwriting the claim) and writes the audit trail. Admin source allows
  //    confirmed → feedback_requested.
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

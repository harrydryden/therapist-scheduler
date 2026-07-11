/**
 * Feedback-form email helper.
 *
 * Single source of truth for building the user-facing feedback-form email:
 * the tracking-code URL, the HMAC token that authorises it, and the rendered
 * subject/body payload.
 *
 * Every path that sends a feedback form MUST go through here so the link
 * always carries a valid `?fk=` token. Without the token the submit endpoint
 * cannot link the submission back to its appointment (it stores the row
 * anonymously and never transitions the appointment to `completed`), so a
 * tokenless link is effectively a broken feedback request. Consumers:
 *   - the post-booking-followup cron (`processFeedbackForms`)
 *   - the admin re-request-feedback flow (manual resend, incl. resending
 *     for an already-completed appointment)
 */

import { getEmailSubject, getEmailBody } from '../utils/email-templates';
import { firstName } from '../utils/first-name';
import { getSettingValue } from './settings.service';
import { generateFeedbackToken } from '../utils/feedback-token';

/** Minimal appointment shape needed to address + render the feedback email. */
export interface FeedbackEmailAppointment {
  id: string;
  userName: string | null;
  userEmail: string;
  therapistName: string;
  trackingCode: string | null;
  gmailThreadId: string | null;
}

/**
 * Build the tracking-code feedback URL with an HMAC token bound to the
 * appointment ID. Throws when the appointment has no tracking code — a
 * tokened per-appointment URL can't be built without one, and a generic
 * fallback URL would produce anonymous, unlinkable submissions.
 */
export async function buildFeedbackFormUrl(appointment: {
  id: string;
  trackingCode: string | null;
}): Promise<string> {
  if (!appointment.trackingCode) {
    throw new Error('Appointment missing tracking code — cannot build feedback form URL');
  }
  const webAppUrl = await getSettingValue<string>('weeklyMailing.webAppUrl');
  const baseUrl = webAppUrl.replace(/\/$/, '');
  const feedbackToken = generateFeedbackToken(appointment.id);
  return `${baseUrl}/feedback/${appointment.trackingCode}?fk=${encodeURIComponent(feedbackToken)}`;
}

/**
 * Build the full feedback-form email payload (recipient, subject, body,
 * thread) with a properly-tokened link. Throws on missing tracking code —
 * callers handle that case (admin note + sentinel confirm to avoid re-runs).
 */
export async function buildFeedbackEmailPayload(
  appointment: FeedbackEmailAppointment,
): Promise<{ to: string; subject: string; body: string; threadId?: string }> {
  const userName = firstName(appointment.userName);
  const therapistFirstName = firstName(appointment.therapistName);

  const feedbackFormUrl = await buildFeedbackFormUrl(appointment);

  const subject = await getEmailSubject('feedbackForm', {
    therapistName: therapistFirstName,
  });
  const body = await getEmailBody('feedbackForm', {
    userName,
    therapistName: therapistFirstName,
    feedbackFormUrl,
  });

  return {
    to: appointment.userEmail,
    subject,
    body,
    threadId: appointment.gmailThreadId || undefined,
  };
}

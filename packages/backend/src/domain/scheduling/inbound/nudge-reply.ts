/**
 * Detection + handling for replies to therapist nudge emails
 * ("Spill update - still finding you a client").
 *
 * Two detection paths:
 *
 *   1. Thread-ID match (legacy fast path):
 *      `Therapist.lastNudgeThreadId === email.threadId` — strong
 *      signal that the inbound is a reply to the exact thread we
 *      sent the nudge on. Pre-phase-5 nudges with no
 *      TherapistConversation row land here.
 *
 *   2. Sender-based fallback:
 *      Gmail sometimes assigns the reply a different thread ID
 *      (replies arriving days/weeks later, clients that strip
 *      In-Reply-To/References, Gmail threading heuristics). The
 *      sender-based check matches the therapist by email +
 *      subject-line pattern + "no active appointments" — the same
 *      criteria that made them eligible for the nudge in the
 *      first place.
 *
 * Both paths emit a Slack alert (medium severity) routing the
 * therapist's availability to the admin for manual matching — there's
 * no active appointment thread to drop the reply into. Subject is
 * truncated to 100 chars for the Slack body; the sender's email
 * appears as a structured field.
 */

import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/database';
import { slackNotificationService } from '../../../services/slack-notification.service';
import { getSettingValue } from '../../../services/settings.service';
import { ACTIVE_STATUSES } from '../../../constants';
import type { EmailMessage } from '../../../utils/email-mime-parser';

interface NudgeTherapist {
  id: string;
  name: string;
  email: string;
}

/**
 * Thread-ID-based detection (legacy fast path). Returns the therapist
 * row if their `lastNudgeThreadId` matches this inbound's thread, or
 * null otherwise.
 */
export async function detectNudgeReplyByThreadId(threadId: string): Promise<NudgeTherapist | null> {
  if (!threadId) return null;
  const therapist = await prisma.therapist.findFirst({
    where: { lastNudgeThreadId: threadId },
    select: { id: true, name: true, email: true },
  });
  return therapist;
}

/**
 * Sender-based fallback (catches threadId mismatch). Returns the
 * therapist row if all four criteria match:
 *
 *   1. Sender matches a therapist's email address
 *   2. That therapist has been nudged (`lastNudgeAt` is set)
 *   3. Subject contains the configured nudge subject pattern
 *      (prevents false positives from unrelated therapist emails)
 *   4. That therapist has NO active appointments (the same criteria
 *      that made them eligible for the nudge)
 *
 * Non-fatal: if the check throws, returns null and lets the email
 * continue through the normal unmatched retry/abandon path.
 */
export async function detectNudgeReplyBySender(
  email: EmailMessage,
  traceId: string,
): Promise<NudgeTherapist | null> {
  try {
    // Step 1: Is the sender a nudged therapist?
    const therapist = await prisma.therapist.findFirst({
      where: {
        email: email.from.toLowerCase(),
        lastNudgeAt: { not: null },
      },
      select: { id: true, name: true, email: true, notionId: true },
    });

    if (!therapist) return null;

    // Step 2: Does the subject look like a reply to a nudge?
    const nudgeSubject = await getSettingValue<string>('email.therapistNudgeSubject')
      || 'Spill update - still finding you a client';

    const subjectLower = email.subject.toLowerCase().trim();
    const nudgeSubjectLower = nudgeSubject.toLowerCase().trim();
    if (!subjectLower.includes(nudgeSubjectLower)) {
      logger.debug(
        { traceId, from: email.from, subject: email.subject },
        'Sender is a nudged therapist but subject does not match nudge pattern — not a nudge reply',
      );
      return null;
    }

    // Step 3: Does this therapist have any active appointments?
    // `AppointmentRequest.therapistHandle` stores the public handle
    // (`notionId` for legacy rows, Postgres uuid for post-Notion
    // ingestions) — look up by either.
    const therapistHandle = therapist.notionId ?? therapist.id;
    const activeAppointment = await prisma.appointmentRequest.findFirst({
      where: {
        therapistHandle,
        status: { in: [...ACTIVE_STATUSES] },
      },
      select: { id: true },
    });

    if (activeAppointment) {
      logger.debug(
        { traceId, from: email.from, therapistId: therapist.id, appointmentId: activeAppointment.id },
        'Sender is a nudged therapist but has active appointment — not treating as nudge reply',
      );
      return null;
    }

    return { id: therapist.id, name: therapist.name, email: therapist.email };
  } catch (err) {
    logger.warn({ traceId, err, from: email.from }, 'Nudge reply sender fallback check failed');
    return null;
  }
}

/**
 * Send a Slack alert routing the nudge reply to an admin for manual
 * matching. Idempotent at the alert level — Slack may dedupe identical
 * recent alerts on its side, but we always fire here.
 */
export function alertAdminOfNudgeReply(args: {
  therapist: NudgeTherapist;
  subject: string;
  reason: 'thread-id-match' | 'sender-fallback';
  traceId: string;
}): void {
  const detailsByReason = {
    'thread-id-match':
      'Therapist replied to a nudge email with potential availability. ' +
      'No active appointment thread exists — manual review needed to match with a client.',
    'sender-fallback':
      'Therapist replied to a nudge email (detected via sender fallback — Gmail assigned a new thread ID). ' +
      'No active appointment thread exists — manual review needed to match with a client.',
  };

  slackNotificationService.sendAlert({
    title: 'Therapist Nudge Reply',
    severity: 'medium',
    therapistName: args.therapist.name,
    details: detailsByReason[args.reason],
    additionalFields: {
      'Therapist email': args.therapist.email,
      'Subject': args.subject.slice(0, 100),
    },
  }).catch((err) => {
    logger.warn({ traceId: args.traceId, err }, 'Failed to send Slack alert for therapist nudge reply');
  });
}

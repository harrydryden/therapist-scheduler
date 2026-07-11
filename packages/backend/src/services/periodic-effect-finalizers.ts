/**
 * Shared finalization logic for sentinel-gated periodic side effects
 * (chase emails, meeting-link check, feedback dispatch, feedback reminder,
 * session-reminder pair).
 *
 * Each of these effects is a multi-step unit: send email(s) -> confirm the
 * sentinel claim -> (feedback dispatch only) advance the lifecycle
 * transition. Before this module existed, that unit was implemented twice:
 * once inline in the first-run `execute` closure (post-booking-followup.
 * service.ts / chase-email.service.ts), and a second time — send only, no
 * finalization — in side-effect-retry.service.ts's hand-mirrored switch
 * branches. A crash or transient error between "email sent" and "sentinel
 * confirmed" meant retry resent the email but never confirmed the
 * sentinel or advanced the lifecycle, permanently stranding the
 * appointment (see docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md).
 *
 * Both the first-run closures and the retry executor now call the SAME
 * function from this module after sending — there is exactly one
 * implementation of "what happens after the email(s) go out."
 */

import { logger } from '../utils/logger';
import { prisma } from '../utils/database';
import { confirmSentinelClaim } from '../utils/atomic-sentinel-claim';
import { appointmentLifecycleService } from '../domain/scheduling/lifecycle';
import { aiConversationService } from './ai-conversation.service';
import { recordAppointmentEvent } from './appointment-event.service';
import { auditEventService } from './audit-event.service';
import { firstName } from '../utils/first-name';

export interface EmailEnvelope {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
}

/**
 * Stored/rendered payload for `email_session_reminder_pair`. `sentTo`
 * tracks which side(s) of the pair have already been sent — set
 * incrementally via the harness's `updateStoredPayload` helper as each
 * send lands, so a crash between the two sends leaves a durable record
 * of what already went out. Absent on rows registered before this field
 * existed; both sides are then treated as not-yet-sent (today's
 * behaviour, unchanged).
 */
export interface SessionReminderPairPayload {
  user: EmailEnvelope;
  therapist: EmailEnvelope;
  sentTo?: { user?: boolean; therapist?: boolean };
}

async function appendSystemAlertNote(appointmentId: string, notesSoFar: string | null | undefined, message: string): Promise<void> {
  try {
    await prisma.appointmentRequest.update({
      where: { id: appointmentId },
      data: {
        notes: `${notesSoFar || ''}\n[SYSTEM ALERT ${new Date().toISOString()}]: ${message}`,
      },
      select: { id: true },
    });
  } catch {
    // Ignore - the main issue is already logged by the caller.
  }
}

// ─── Chase (email_chase_user / email_chase_therapist) ──────────────────

export async function finalizeChase(args: {
  appointmentId: string;
  target: 'user' | 'therapist';
  targetEmail: string;
  now: Date;
  checkId?: string;
  userName?: string | null;
  therapistName?: string | null;
  inactiveHours: number;
}): Promise<void> {
  const { appointmentId, target, targetEmail, now, checkId, userName, therapistName, inactiveHours } = args;

  const checkpointResult = await aiConversationService.applyCheckpointAction(
    appointmentId,
    'sent_chase_followup',
    {
      extraWhere: { chaseSentAt: new Date(0) }, // sentinel guard
      extraUpdates: {
        chaseSentAt: now,
        chaseSentTo: target,
        chaseTargetEmail: targetEmail,
        lastActivityAt: now,
        isStale: false,
      },
    },
  );

  if (!checkpointResult.applied) {
    logger.error(
      { checkId, appointmentId },
      'ALERT: Chase email sent but sentinel update failed - possible duplicate',
    );
    return;
  }

  await recordAppointmentEvent({
    appointmentId,
    type: 'chase_sent',
    actor: 'system',
    reason: `Inactive ${inactiveHours}h, chasing ${target}`,
    payload: { target, chasedEmail: targetEmail, inactiveHours, userName, therapistName },
    slack: {
      // PII discipline: drop the chased email (PII for clients). Therapist's
      // full name is fine; client uses first name.
      title: 'Chase follow-up sent',
      severity: 'medium',
      details:
        `${target === 'therapist' ? 'Therapist' : 'Client'} hasn't responded for ` +
        `*${inactiveHours}h*. Sent a follow-up nudge.`,
      additionalFields: {
        'Client': firstName(userName, '(unknown)'),
        'Therapist': therapistName || '(unknown)',
      },
    },
  });

  logger.info(
    { checkId, appointmentId, target, email: targetEmail, userName, therapistName },
    `Sent chase follow-up email to ${target}`,
  );
}

// ─── Meeting-link check (email_meeting_link_check) ──────────────────────

export async function finalizeMeetingLinkCheck(args: {
  appointmentId: string;
  now: Date;
  checkId?: string;
  notesSoFar: string | null | undefined;
  userEmail?: string;
}): Promise<void> {
  const { appointmentId, now, checkId, notesSoFar, userEmail } = args;

  auditEventService.log(appointmentId, 'follow_up_sent', 'system', {
    followUpType: 'meeting_link_check',
  });

  const confirmed = await confirmSentinelClaim(appointmentId, 'meetingLinkCheckSentAt', now);

  if (!confirmed) {
    logger.error(
      { checkId, appointmentId },
      'ALERT: Meeting link check email sent but sentinel update failed - possible duplicate',
    );
    await appendSystemAlertNote(appointmentId, notesSoFar, 'meetingLinkCheck email sent but tracking update failed - review for duplicates');
    return;
  }

  logger.info({ checkId, appointmentId, userEmail }, 'Sent meeting link check email');
}

// ─── Feedback dispatch (email_feedback_dispatch) ────────────────────────

export async function finalizeFeedbackDispatch(args: {
  appointmentId: string;
  now: Date;
  checkId?: string;
  notesSoFar: string | null | undefined;
  userEmail?: string;
}): Promise<void> {
  const { appointmentId, now, checkId, notesSoFar, userEmail } = args;

  auditEventService.log(appointmentId, 'follow_up_sent', 'system', {
    followUpType: 'feedback_form',
  });

  const confirmed = await confirmSentinelClaim(appointmentId, 'feedbackFormSentAt', now);

  if (!confirmed) {
    logger.error(
      { checkId, appointmentId },
      'ALERT: Feedback form email sent but sentinel update failed - possible duplicate',
    );
    await appendSystemAlertNote(appointmentId, notesSoFar, 'feedbackForm email sent but tracking update failed - review for duplicates');
    return;
  }

  await appointmentLifecycleService.transitionToFeedbackRequested({
    appointmentId,
    source: 'system',
  });

  logger.info(
    { checkId, appointmentId, userEmail },
    'Sent feedback form dispatch and transitioned to feedback_requested',
  );
}

// ─── Feedback reminder (email_feedback_reminder) ────────────────────────

export async function finalizeFeedbackReminder(args: {
  appointmentId: string;
  now: Date;
  checkId?: string;
  userEmail?: string;
}): Promise<void> {
  const { appointmentId, now, checkId, userEmail } = args;

  auditEventService.log(appointmentId, 'follow_up_sent', 'system', {
    followUpType: 'feedback_reminder',
  });

  const confirmed = await confirmSentinelClaim(appointmentId, 'feedbackReminderSentAt', now);

  if (!confirmed) {
    logger.error(
      { checkId, appointmentId },
      'ALERT: Feedback reminder email sent but sentinel update failed - possible duplicate',
    );
    return;
  }

  logger.info({ checkId, appointmentId, userEmail }, 'Sent feedback reminder email');
}

// ─── Session-reminder pair (email_session_reminder_pair) ────────────────

export async function finalizeSessionReminderPair(args: {
  appointmentId: string;
  userSent: boolean;
  therapistSent: boolean;
  now: Date;
  checkId?: string;
  notesSoFar: string | null | undefined;
  userEmailForLog?: string;
  therapistEmailForLog?: string;
}): Promise<void> {
  const { appointmentId, userSent, therapistSent, now, checkId, notesSoFar, userEmailForLog, therapistEmailForLog } = args;

  if (!userSent && !therapistSent) {
    throw new Error('Session reminder failed for both user and therapist');
  }

  if (userSent && therapistSent) {
    const confirmed = await confirmSentinelClaim(appointmentId, 'reminderSentAt', now);

    if (!confirmed) {
      logger.error(
        { checkId, appointmentId },
        'ALERT: Session reminder emails sent but sentinel update failed - possible duplicate',
      );
      await appendSystemAlertNote(appointmentId, notesSoFar, 'sessionReminder emails sent but tracking update failed - review for duplicates');
      return;
    }

    logger.info(
      { checkId, appointmentId, userEmail: userEmailForLog, therapistEmail: therapistEmailForLog },
      'Sent session reminder emails to user and therapist',
    );
    return;
  }

  // Partial success — set sentinel + raise isStale + leave an admin note.
  const failedRecipient = !userSent ? 'user' : 'therapist';
  const succeededRecipient = userSent ? 'user' : 'therapist';

  const confirmed = await confirmSentinelClaim(appointmentId, 'reminderSentAt', now, {
    extraData: { isStale: true },
  });

  if (confirmed) {
    await appendSystemAlertNote(
      appointmentId,
      notesSoFar,
      `Session reminder sent to ${succeededRecipient} but FAILED for ${failedRecipient} - manual follow-up required`,
    );
  }
}

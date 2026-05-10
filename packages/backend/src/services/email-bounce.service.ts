/**
 * Email Bounce Handling Service
 *
 * Detects bounced emails and automatically unfreezes therapists when bounces occur.
 * This prevents therapists from being frozen indefinitely due to invalid email addresses.
 *
 * Bounce Detection Methods:
 * 1. Gmail API delivery status notifications
 * 2. Mailer-daemon / postmaster bounce messages
 * 3. Delivery failure subject patterns
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { slackNotificationService } from './slack-notification.service';
import { appointmentLifecycleService } from './appointment-lifecycle.service';
import { InvalidTransitionError } from '../errors';

/**
 * Subject-line markers for bounce notifications.
 */
const BOUNCE_SUBJECT_PATTERNS = [
  /delivery.*fail/i,
  /undeliverable/i,
  /mail.*delivery.*failed/i,
  /returned.*mail/i,
  /delivery.*status.*notification/i,
  /failure.*notice/i,
  /mail.*bounced/i,
  /address.*rejected/i,
  /user.*unknown/i,
  /mailbox.*not.*found/i,
  /recipient.*rejected/i,
  /message.*not.*delivered/i,
  /could.*not.*be.*delivered/i,
];

/**
 * Sender envelopes that signal a real delivery-status notification.
 *
 * Anchored to the local-part of the address (`mailer-daemon@…`,
 * `postmaster@…`, etc.) so unrelated senders that happen to contain
 * one of these substrings (e.g. mailing-list `bounces+abc@list.com`,
 * `do-not-reply-postmaster-news@somecorp.com`) don't false-positive
 * into the admin-review alert. Real bounces from major providers
 * (Google, Microsoft, AWS SES, SendGrid) all use one of these
 * canonical envelopes.
 *
 * The previous broad `/bounce/i` pattern matched any address with
 * "bounce" anywhere in it, which produced operational noise from
 * mailing-list bounce-handler addresses that are NOT actual NDRs.
 * After C1 the false positives are bounded — they hit the
 * "Bounce-shaped email — manual review" Slack alert rather than
 * cancelling appointments — but tightening here keeps that alert
 * volume meaningful.
 */
const BOUNCE_SENDER_PATTERNS = [
  /(?:^|<)mailer-daemon@/i,
  /(?:^|<)postmaster@/i,
  /(?:^|<)mail.*delivery.*subsystem@/i,
  /(?:^|<)noreply.*google.*@/i,
  // List-bounce envelope local-parts (`bounce@`, `bounces@`,
  // `bounces+xxx@`). This is narrower than the prior `/bounce/i`:
  // it requires the local-part to START with `bounce` rather than
  // contain it anywhere.
  /(?:^|<)bounces?(?:\+[^@]*)?@/i,
];

/**
 * SMTP-code regexes used to classify a bounce as hard / soft / unknown.
 * Hard = permanent failure (550-class, "user unknown", "no such user").
 * Soft = transient (552-class, mailbox full, try again).
 * The classification informs the cancellation note and the Slack alert
 * but does NOT drive any decision about whether to cancel — that's
 * handled by the threadId match in `handleBounce`.
 */
const HARD_BOUNCE_BODY = /550|553|554|invalid|unknown|not.*found|rejected|does.*not.*exist/i;
const SOFT_BOUNCE_BODY = /552|full|quota|temporarily|try.*again/i;

export interface BounceInfo {
  isBounce: boolean;
  bounceType: 'hard' | 'soft' | 'unknown' | null;
  detectionMethod: 'subject' | 'sender' | null;
}

/**
 * Analyze an email to determine if it's a bounce notification.
 *
 * Body-extracted recipient and SMTP-error-string fields used to be
 * surfaced too, but after the threadId-required hardening they're not
 * load-bearing for any decision (and were attacker-controllable). The
 * bounceType + detectionMethod is the triage signal we actually use.
 */
export function detectBounce(email: {
  from: string;
  subject: string;
  body: string;
}): BounceInfo {
  const result: BounceInfo = {
    isBounce: false,
    bounceType: null,
    detectionMethod: null,
  };

  // Sender patterns are the strongest signal — checked first.
  for (const pattern of BOUNCE_SENDER_PATTERNS) {
    if (pattern.test(email.from)) {
      result.isBounce = true;
      result.detectionMethod = 'sender';
      break;
    }
  }

  if (!result.isBounce) {
    for (const pattern of BOUNCE_SUBJECT_PATTERNS) {
      if (pattern.test(email.subject)) {
        result.isBounce = true;
        result.detectionMethod = 'subject';
        break;
      }
    }
  }

  if (result.isBounce) {
    if (HARD_BOUNCE_BODY.test(email.body)) {
      result.bounceType = 'hard';
    } else if (SOFT_BOUNCE_BODY.test(email.body)) {
      result.bounceType = 'soft';
    } else {
      result.bounceType = 'unknown';
    }
  }

  return result;
}

/**
 * Handle a detected email bounce
 *
 * Actions taken:
 * 1. Find the appointment request associated with the bounced email
 * 2. Mark the appointment as bounced
 * 3. Unfreeze the therapist
 * 4. Optionally notify admin
 */
export async function handleBounce(
  bounceInfo: BounceInfo,
  originalEmail?: { threadId?: string; messageId?: string }
): Promise<{
  handled: boolean;
  appointmentId?: string;
  therapistUnfrozen: boolean;
  error?: string;
}> {
  const traceId = `bounce-${Date.now().toString(36)}`;

  logger.info(
    { traceId, bounceType: bounceInfo.bounceType, detection: bounceInfo.detectionMethod },
    'Handling email bounce'
  );

  const result = {
    handled: false,
    appointmentId: undefined as string | undefined,
    therapistUnfrozen: false,
    error: undefined as string | undefined,
  };

  try {
    // SECURITY: Auto-cancellation requires the bounce to arrive in a Gmail
    // thread we own (gmailThreadId or therapistGmailThreadId). The threadId
    // proves that the bounce relates to one of our outbound messages —
    // without it, an attacker could craft a fake bounce email naming any
    // victim's address in the body and silently cancel their appointment.
    if (!originalEmail?.threadId) {
      logger.warn(
        { traceId },
        'Bounce detected but no threadId — refusing to auto-cancel (admin review required)'
      );
      result.error = 'No threadId on bounce — admin review required';
      return result;
    }

    const appointment = await prisma.appointmentRequest.findFirst({
      where: {
        OR: [
          { gmailThreadId: originalEmail.threadId },
          { therapistGmailThreadId: originalEmail.threadId },
        ],
        status: { notIn: ['cancelled', 'confirmed'] },
      },
      select: { id: true, therapistHandle: true, userName: true, userEmail: true, therapistName: true, therapistEmail: true, gmailThreadId: true, therapistGmailThreadId: true },
    });

    if (!appointment) {
      logger.warn(
        { traceId, threadId: originalEmail.threadId },
        'Bounce detected on unknown thread — refusing to auto-cancel'
      );
      result.error = 'No matching appointment found for bounce thread';
      return result;
    }

    result.appointmentId = appointment.id;

    // Cancel the appointment via the lifecycle service so all the standard
    // side effects fire (therapist unfreeze, audit trail, SSE).
    // We pass `skipNotifications=true` so the lifecycle's generic cancellation
    // Slack/emails are suppressed — the bounce path fires its own more detailed
    // bounce-specific Slack alert below, and emailing the user whose address
    // just bounced is futile.
    //
    // The atomic guard prevents racing with a concurrent confirmation: if the
    // appointment got confirmed between our read above and this write, the
    // lifecycle service throws InvalidTransitionError (terminal CONFIRMED is
    // valid for cancellation, but we explicitly want to short-circuit on
    // confirmed/cancelled to preserve the legacy "skip if already confirmed"
    // behaviour — admins should manually action a confirmed-then-bounced case).
    const bounceReason =
      `[BOUNCE] Email delivery failed (${bounceInfo.bounceType ?? 'unknown'} bounce, ` +
      `detected via ${bounceInfo.detectionMethod ?? 'unknown'}).`;

    try {
      const transitionResult = await appointmentLifecycleService.transitionToCancelled({
        appointmentId: appointment.id,
        reason: bounceReason,
        cancelledBy: 'system',
        source: 'system',
        skipNotifications: true,
        atomic: {
          requireStatusNotIn: ['cancelled', 'confirmed'],
        },
      });

      if (transitionResult.atomicSkipped || transitionResult.skipped) {
        logger.warn(
          { traceId, appointmentId: appointment.id, previousStatus: transitionResult.previousStatus },
          'Bounce detected but appointment already confirmed/cancelled - skipping cancellation'
        );
        result.error = 'Appointment status changed before bounce could be applied';
        return result;
      }
    } catch (transitionErr) {
      if (transitionErr instanceof InvalidTransitionError) {
        logger.warn(
          { traceId, appointmentId: appointment.id, err: transitionErr },
          'Bounce detected but appointment is in a state that cannot be cancelled - skipping'
        );
        result.error = 'Appointment cannot be cancelled in current state';
        return result;
      }
      throw transitionErr;
    }

    logger.info(
      { traceId, appointmentId: appointment.id },
      'Appointment marked as cancelled due to bounce (via lifecycle service)'
    );

    // The lifecycle service's onCancelled side effect handles therapist unfreeze.
    result.therapistUnfrozen = true;
    result.handled = true;

    // Log the bounce event for admin visibility. userEmail/userName are
    // retained in application logs (server-side, PII-redacted by pino
    // config) but kept out of Slack — see notifyEmailBounce.
    logger.warn(
      {
        traceId,
        event: 'EMAIL_BOUNCE',
        appointmentId: appointment.id,
        userName: appointment.userName,
        userEmail: appointment.userEmail,
        therapistName: appointment.therapistName,
        therapistHandle: appointment.therapistHandle,
        bounceType: bounceInfo.bounceType,
        detection: bounceInfo.detectionMethod,
      },
      'Appointment cancelled due to email bounce - therapist unfrozen'
    );

    // Send Slack notification for email bounce. Derive the bounced role
    // from which thread matched (therapistGmailThreadId vs gmailThreadId).
    const bouncedRole: 'client' | 'therapist' =
      appointment.therapistGmailThreadId === originalEmail.threadId
        ? 'therapist'
        : 'client';
    await slackNotificationService.notifyEmailBounce(
      appointment.id,
      appointment.userName,
      appointment.therapistName,
      bouncedRole,
      `${bounceInfo.bounceType ?? 'unknown'} bounce`,
    );

    return result;
  } catch (error) {
    logger.error(
      { traceId, error },
      'Failed to handle email bounce'
    );
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Process an incoming email to check if it's a bounce and handle accordingly
 * This should be called from the email processing service
 */
export async function processPotentialBounce(email: {
  from: string;
  subject: string;
  body: string;
  threadId?: string;
  messageId?: string;
}): Promise<boolean> {
  const bounceInfo = detectBounce(email);

  if (!bounceInfo.isBounce) {
    return false;
  }

  logger.info(
    {
      from: email.from,
      subject: email.subject.substring(0, 100),
      bounceType: bounceInfo.bounceType,
      detection: bounceInfo.detectionMethod,
    },
    'Detected bounce email'
  );

  const result = await handleBounce(bounceInfo, {
    threadId: email.threadId,
    messageId: email.messageId,
  });

  // If the bounce regex matched but we declined to auto-cancel (no threadId,
  // or threadId didn't map to a tracked appointment), surface it to admins
  // so a real bounce isn't silently dropped. Fire-and-forget — failure to
  // alert shouldn't block ingest. Returning false lets the caller continue
  // normal processing (e.g. the email may not actually be a bounce).
  if (!result.handled) {
    slackNotificationService.sendAlert({
      title: 'Bounce-shaped email — manual review',
      severity: 'medium',
      details:
        `An inbound email matched bounce-detection patterns but could not be ` +
        `auto-actioned (${result.error ?? 'unknown reason'}). ` +
        `If this is a real bounce, the appointment must be cancelled manually.`,
      additionalFields: {
        'Detection method': bounceInfo.detectionMethod ?? 'unknown',
        'Bounce type': bounceInfo.bounceType ?? 'unknown',
        'Subject': email.subject.slice(0, 100),
      },
    }).catch((err) => {
      logger.warn({ err }, 'Failed to send Slack alert for unactioned bounce');
    });
  }

  return result.handled;
}

// Export for use in email-processing.service.ts
export const emailBounceService = {
  detectBounce,
  handleBounce,
  processPotentialBounce,
};

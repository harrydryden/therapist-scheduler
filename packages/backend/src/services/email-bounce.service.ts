/**
 * Email Bounce Handling Service
 *
 * Detects bounced emails and automatically unfreezes therapists when bounces occur.
 * This prevents therapists from being frozen indefinitely due to invalid email addresses.
 *
 * Bounce Detection Methods (a message must look like a machine-generated
 * delivery-status notification — a subject line alone is never enough):
 * 1. DSN sender envelope (mailer-daemon@, postmaster@, ...)
 * 2. DSN MIME structure (multipart/report; report-type=delivery-status)
 * 3. Delivery-failure subject pattern AND an Auto-Submitted header
 *
 * Only HARD (permanent) failures on a thread we own, for an appointment
 * that is still pre-booking, auto-cancel. Delay notices ("still retrying")
 * are logged and ignored; soft / unclassifiable DSNs go to admin review.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { slackNotificationService } from './slack-notification.service';
import { appointmentLifecycleService } from '../domain/scheduling/lifecycle';
import { InvalidTransitionError } from '../errors';
import {
  PRE_BOOKING_STATUSES,
  POST_BOOKING_STATUSES,
  type AppointmentStatus,
} from '../constants';

/**
 * Statuses a bounce may auto-cancel. Only pre-booking negotiation: once a
 * session is confirmed / held / awaiting feedback / completed, a bounce
 * must never silently rewrite it to `cancelled` (E2) — admins action
 * those manually from the review alert.
 */
const BOUNCE_CANCELLABLE_STATUSES: readonly AppointmentStatus[] = PRE_BOOKING_STATUSES;
const BOUNCE_PROTECTED_STATUSES: AppointmentStatus[] = ['cancelled', ...POST_BOOKING_STATUSES];

/**
 * Subject-line markers for bounce notifications.
 *
 * These are deliberately loose ("message not delivered", "user … unknown")
 * so they are ONLY a corroborating signal: a subject match counts as a
 * bounce only together with an Auto-Submitted header (see detectBounce).
 * On their own they matched ordinary replies on our threads — e.g.
 * "Re: … my last message was not delivered?" or "… availability unknown"
 * (via /user.*unknown/) — and auto-cancelled live appointments (E2).
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
 * Classification of a detected DSN. Only `hard` (a permanent failure such
 * as an unknown address) is allowed to auto-cancel.
 *
 * - delay:   the sending MTA is STILL RETRYING (Gmail "Delivery Status
 *            Notification (Delay)", Exchange "Delivery delayed", Postfix
 *            "Delayed Mail (still being retried)"). Nothing has failed.
 * - soft:    transient condition (mailbox full, 4.x.x, try again later).
 * - hard:    permanent failure (5.x.x, user unknown, address not found).
 * - unknown: DSN with no recognisable failure detail.
 */
export type BounceType = 'hard' | 'soft' | 'delay' | 'unknown';

/**
 * Markers that a DSN reports a FINAL failure. Used to stop failure notices
 * that quote earlier transient errors from being misread as delays.
 */
const FAILURE_SUBJECT = /\bfail(?:ure|ed)?\b|undeliverable|returned mail|not delivered|could not be delivered/i;
const FAILURE_STATUS = /\baction:\s*failed\b/i;

const DELAY_SUBJECT = /\bdelay(?:ed)?\b|still being retried|\bwarning\b/i;
const DELAY_BODY =
  /\baction:\s*delayed\b|will (?:continue to )?retry|will be retried|still being retried|delivery (?:attempts )?will continue|has not yet been delivered|hasn't been delivered yet|not been delivered yet/i;

/** Unambiguous permanent address failures. */
const HARD_ADDRESS_BODY =
  /\b5\.1\.\d{1,3}\b|user unknown|unknown user|no such user|does not exist|doesn't exist|address not found|address couldn't be found|address could not be found|mailbox unavailable|mailbox not found|recipient (?:address )?rejected|invalid recipient|account (?:is |has been )?disabled/i;
/** Transient conditions (checked before the generic 5xx rule: 552 / 5.2.2 = mailbox full). */
const SOFT_BOUNCE_BODY =
  /\b4\.\d{1,3}\.\d{1,3}\b|\b(?:421|450|451|452|552)\b|\b5\.2\.2\b|mailbox (?:is )?full|over quota|quota exceeded|out of storage|storage space|insufficient storage|try again later|temporar(?:y|ily)/i;
/** Any other permanent failure. */
const HARD_GENERIC_BODY = /\b5\.\d{1,3}\.\d{1,3}\b|\b55[0-4]\b|permanent(?:ly)? (?:failed|failure|error)|rejected/i;

/** Only the head of a (sender-controlled) body is classified. */
const MAX_CLASSIFY_CHARS = 20_000;

export interface BounceInfo {
  isBounce: boolean;
  bounceType: BounceType | null;
  detectionMethod: 'subject' | 'sender' | 'dsn-report' | null;
}

export interface BounceCandidate {
  from: string;
  subject: string;
  body: string;
  /** RFC 3834 Auto-Submitted header value (lowercased), if present. */
  autoSubmitted?: string;
  /** Parser flag: multipart/report; report-type=delivery-status. */
  isDeliveryStatusReport?: boolean;
  /** Parser: text of the message/delivery-status part, if any. */
  deliveryStatus?: string;
}

function classifyBounce(email: BounceCandidate): BounceType {
  const subject = email.subject || '';
  const text = `${(email.deliveryStatus || '').slice(0, MAX_CLASSIFY_CHARS)}\n${(email.body || '').slice(0, MAX_CLASSIFY_CHARS)}`;

  const reportsFinalFailure = FAILURE_SUBJECT.test(subject) || FAILURE_STATUS.test(text);
  if (!reportsFinalFailure && (DELAY_SUBJECT.test(subject) || DELAY_BODY.test(text))) {
    return 'delay';
  }
  if (HARD_ADDRESS_BODY.test(text)) return 'hard';
  if (SOFT_BOUNCE_BODY.test(text)) return 'soft';
  if (HARD_GENERIC_BODY.test(text)) return 'hard';
  return 'unknown';
}

/**
 * Analyze an email to determine if it's a bounce notification.
 *
 * A message is a bounce only when it looks machine-generated:
 *   - DSN sender envelope (mailer-daemon@, postmaster@, …), or
 *   - DSN MIME structure (multipart/report delivery-status), or
 *   - a failure-shaped subject AND an Auto-Submitted header.
 * An ordinary correspondent whose subject happens to contain "not
 * delivered" / "unknown" is NOT a bounce (E2).
 */
export function detectBounce(email: BounceCandidate): BounceInfo {
  const result: BounceInfo = {
    isBounce: false,
    bounceType: null,
    detectionMethod: null,
  };

  const autoSubmitted = !!email.autoSubmitted && email.autoSubmitted.trim().toLowerCase() !== 'no';

  if (BOUNCE_SENDER_PATTERNS.some((pattern) => pattern.test(email.from))) {
    // Sender patterns are the strongest signal — checked first.
    result.isBounce = true;
    result.detectionMethod = 'sender';
  } else if (email.isDeliveryStatusReport === true) {
    result.isBounce = true;
    result.detectionMethod = 'dsn-report';
  } else if (autoSubmitted && BOUNCE_SUBJECT_PATTERNS.some((pattern) => pattern.test(email.subject))) {
    result.isBounce = true;
    result.detectionMethod = 'subject';
  }

  if (result.isBounce) {
    result.bounceType = classifyBounce(email);
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
    // Only permanent failures cancel. Delay notices mean the MTA is still
    // retrying; soft / unclassifiable DSNs are for a human to judge.
    if (bounceInfo.bounceType !== 'hard') {
      logger.info(
        { traceId, bounceType: bounceInfo.bounceType },
        'Bounce is not a hard failure — not auto-cancelling',
      );
      result.error = `Non-fatal bounce (${bounceInfo.bounceType ?? 'unknown'}) — not auto-cancelled`;
      return result;
    }

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
        // Pre-booking only: never auto-cancel confirmed / session_held /
        // feedback_requested / completed appointments on a bounce.
        status: { in: [...BOUNCE_CANCELLABLE_STATUSES] },
      },
      select: { id: true, therapistHandle: true, userName: true, userEmail: true, therapistName: true, therapistEmail: true, gmailThreadId: true, therapistGmailThreadId: true },
    });

    if (!appointment) {
      logger.warn(
        { traceId, threadId: originalEmail.threadId },
        'Bounce detected but no pre-booking appointment owns this thread — refusing to auto-cancel'
      );
      result.error = 'No bounce-cancellable (pre-booking) appointment found for bounce thread';
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
    // appointment moved to confirmed (or beyond) between our read above and
    // this write, the transition is skipped (atomicSkipped). Cancelling a
    // confirmed / session_held / feedback_requested / completed appointment
    // is technically valid, but a bounce must never do it silently — admins
    // action those cases manually from the review alert.
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
          requireStatusNotIn: [...BOUNCE_PROTECTED_STATUSES],
        },
      });

      if (transitionResult.atomicSkipped || transitionResult.skipped) {
        logger.warn(
          { traceId, appointmentId: appointment.id, previousStatus: transitionResult.previousStatus },
          'Bounce detected but appointment moved past pre-booking (or was cancelled) - skipping cancellation'
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
    await slackNotificationService.notifyEmailBounce({
      appointmentId: appointment.id,
      userName: appointment.userName,
      therapistName: appointment.therapistName,
      bouncedRole,
      bounceReason: `${bounceInfo.bounceType ?? 'unknown'} bounce`,
    });

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

export interface BounceProcessingResult {
  /**
   * True when the message is a delivery-status notification. The caller
   * must not route it to the scheduling agent: a DSN is not a reply from
   * the client or therapist, whatever thread it arrives on.
   */
  isBounce: boolean;
  /** True when a hard bounce auto-cancelled the owning appointment. */
  cancelled: boolean;
  bounceType: BounceType | null;
}

/**
 * Process an incoming email to check if it's a bounce and handle accordingly
 * This should be called from the email processing service
 */
export async function processPotentialBounce(
  email: BounceCandidate & { threadId?: string; messageId?: string },
): Promise<BounceProcessingResult> {
  const bounceInfo = detectBounce(email);

  if (!bounceInfo.isBounce) {
    return { isBounce: false, cancelled: false, bounceType: null };
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

  // Delay notices are informational: the sending server is still retrying
  // and will send a failure DSN if it gives up. Never cancel on them.
  if (bounceInfo.bounceType === 'delay') {
    logger.warn(
      {
        threadId: email.threadId,
        messageId: email.messageId,
        subject: email.subject.substring(0, 100),
      },
      'Delivery delay notice received — delivery still being retried, no action taken',
    );
    return { isBounce: true, cancelled: false, bounceType: 'delay' };
  }

  const result = await handleBounce(bounceInfo, {
    threadId: email.threadId,
    messageId: email.messageId,
  });

  // If the bounce was not auto-actioned (soft / unknown type, no threadId,
  // thread not ours, appointment past pre-booking), surface it to admins
  // so a real bounce isn't silently dropped. Fire-and-forget — failure to
  // alert shouldn't block ingest.
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

  return { isBounce: true, cancelled: result.handled, bounceType: bounceInfo.bounceType };
}

// Export for use in domain/scheduling/inbound/process.ts
export const emailBounceService = {
  detectBounce,
  handleBounce,
  processPotentialBounce,
};

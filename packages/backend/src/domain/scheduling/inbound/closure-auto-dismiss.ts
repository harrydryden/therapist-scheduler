/**
 * Auto-dismiss a pending closure recommendation when an incoming reply
 * arrives — the recommendation is stale by definition once the other
 * party has responded.
 *
 * Without this, the appointment stays excluded from chase cycles
 * forever and the admin keeps seeing the closure banner even though
 * the conversation has resumed.
 *
 * Gating: skip the auto-dismiss for auto-replies / out-of-office
 * responses. Those mean the recipient is unreachable, NOT that they've
 * actually re-engaged — closing the recommendation on an OOO would
 * silently undo a valid admin signal. Bounces and own-outbound emails
 * are short-circuited before reaching this branch in `processMessage`,
 * so the only false-positive risk left is auto-replies, gated by the
 * classification flag.
 */

import { logger } from '../../../utils/logger';
import { appointmentLifecycleService } from '../../../domain/scheduling/lifecycle';
import { recordAppointmentEvent } from '../../../services/appointment-event.service';
import type { EmailMessage } from '../../../utils/email-mime-parser';
import type { classifyEmail } from '../../../services/email-classifier.service';

export async function maybeDismissClosureRecommendation(args: {
  appointmentId: string;
  email: EmailMessage;
  classification: ReturnType<typeof classifyEmail>;
  messageId: string;
  traceId: string;
}): Promise<void> {
  const { appointmentId, email, classification, messageId, traceId } = args;

  if (classification.flags.isAutoReply) {
    logger.info(
      { traceId, messageId, appointmentId, from: email.from },
      'Skipping closure auto-dismiss: incoming email is an auto-reply / out-of-office',
    );
    return;
  }

  try {
    const result = await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId,
      source: 'system',
      reason: `Incoming reply from ${email.from}`,
    });

    if (!result.dismissed) return;

    await recordAppointmentEvent({
      appointmentId,
      type: 'closure_dismissed_auto',
      actor: 'system',
      reason: `Incoming reply from ${email.from}`,
      payload: {
        previousStage: result.previousStage,
        restoredStage: result.restoredStage,
        from: email.from,
        subject: email.subject.slice(0, 100),
      },
      slack: {
        // PII discipline: don't echo the sender's email address.
        // Subject is enough for admins to find the thread; the
        // appointmentId on the alert is the click-through.
        title: 'Closure Recommendation Auto-Dismissed',
        severity: 'medium',
        details:
          'An incoming reply arrived on a closure-recommended thread. The closure ' +
          'recommendation was auto-dismissed and the chase cycle reset so the agent ' +
          'can resume processing.',
        additionalFields: {
          'Subject': email.subject.slice(0, 100),
        },
      },
    });
  } catch (err) {
    // Don't block message processing if dismissal fails — log and continue
    logger.warn(
      { traceId, messageId, appointmentId, err },
      'Failed to auto-dismiss closure recommendation; continuing with message processing',
    );
  }
}

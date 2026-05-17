/**
 * Thread-divergence detection + retry/abandon for inbound emails.
 *
 * Divergence happens when an inbound's threading metadata (CC, in-
 * reply-to, references) doesn't line up with the expected appointment
 * thread — e.g. the user replied on the wrong thread, the agent's
 * outbound was BCC'd to a different appointment, the user replied
 * across two parallel threads. Some divergences are critical (block
 * processing); others are informational.
 *
 * Divergences can be transient (race in CC handling, in-flight email
 * ordering), so we give critical ones the same `MAX_PROCESSING_FAILURES`
 * retry budget as any other failure. The admin alert + appointment
 * notes fire on the FIRST occurrence so divergence is visible
 * immediately, but the message is only marked permanently processed
 * once the budget is exhausted.
 *
 * Returns:
 *   - `proceed`: caller continues processing.
 *   - `retry`:   blocking divergence below the retry budget — caller
 *                returns false to let the scanner retry on the next
 *                pass.
 *   - `abandoned`: budget exhausted — caller returns false and the
 *                  message has been marked processed by this module.
 */

import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/database';
import { slackNotificationService } from '../../../services/slack-notification.service';
import { markMessageProcessed } from '../../messaging/message-dedup';
import {
  detectThreadDivergence,
  getDivergenceSummary,
  logDivergence,
  recordDivergenceAlert,
  shouldBlockProcessing,
  type AppointmentContext,
  type EmailContext,
} from '../../../services/thread-divergence.service';
import { EMAIL_PROCESSING } from '../../../constants';
import {
  markFailureAbandoned,
  trackProcessingFailure,
} from './processing-failures';

const { MAX_PROCESSING_FAILURES } = EMAIL_PROCESSING;

export type DivergenceOutcome = 'proceed' | 'retry' | 'abandoned';

export async function checkAndHandleDivergence(args: {
  appointmentId: string;
  email: EmailContext;
  appointmentContext: AppointmentContext;
  allActiveAppointments: AppointmentContext[];
  messageId: string;
  traceId: string;
}): Promise<DivergenceOutcome> {
  const {
    appointmentId,
    email,
    appointmentContext,
    allActiveAppointments,
    messageId,
    traceId,
  } = args;

  const divergence = detectThreadDivergence(
    email,
    appointmentContext,
    allActiveAppointments,
  );

  logDivergence(divergence, { appointmentId, emailId: email.messageId, traceId });

  if (!shouldBlockProcessing(divergence)) {
    return 'proceed';
  }

  const divergenceError = `Thread divergence (${divergence.type}, ${divergence.severity}): ${divergence.description}`;
  const attempts = await trackProcessingFailure(messageId, divergenceError);

  logger.warn(
    {
      traceId,
      messageId,
      appointmentId,
      divergenceType: divergence.type,
      severity: divergence.severity,
      attempts,
      maxAttempts: MAX_PROCESSING_FAILURES,
    },
    `Thread divergence blocking processing (attempt ${attempts}/${MAX_PROCESSING_FAILURES}): ${divergence.description}`,
  );

  // Record alert + note only on the first failure so we don't spam the
  // admin dashboard / notes column on every retry cycle.
  if (attempts === 1) {
    await recordDivergenceAlert(appointmentId, divergence);

    const divergenceNote = `[DIVERGENCE ALERT - ${new Date().toISOString()}]\n${getDivergenceSummary(divergence)}\n\nEmail from: ${email.from}\nSubject: ${email.subject}\n---\n`;
    await prisma.$executeRaw`
      UPDATE "AppointmentRequest"
      SET "notes" = ${divergenceNote} || COALESCE("notes", '')
      WHERE "id" = ${appointmentId}
    `;
  }

  // After max attempts, abandon to break the scanner loop.
  if (attempts >= MAX_PROCESSING_FAILURES) {
    logger.error(
      { traceId, messageId, attempts, divergenceType: divergence.type },
      'Divergence-blocked message abandoned after max attempts',
    );
    await markMessageProcessed(messageId, 'divergence-blocked-abandoned');
    await markFailureAbandoned(messageId);

    // Surface the terminal state to admins. The attempt-1 alert only said
    // "divergence detected"; without this follow-up, the abandonment is
    // invisible until someone notices the message stayed unprocessed.
    // Caught + logged: alerting is best-effort, must not block the
    // abandonment write that breaks the scanner loop.
    slackNotificationService
      .notifyDivergenceAbandoned({
        appointmentId,
        therapistName: appointmentContext.therapistName,
        divergenceType: divergence.type,
        attempts,
        from: email.from,
        subject: email.subject,
      })
      .catch((err) => {
        logger.warn(
          { traceId, messageId, err },
          'Failed to send Slack alert for divergence abandonment',
        );
      });

    return 'abandoned';
  }

  return 'retry';
}

/**
 * Agent-side email send for appointment-scoped conversations.
 *
 * Wraps core/email's `sendEmail` with the per-appointment concerns:
 *
 *   - "Spill" prefix on subjects (brand consistency)
 *   - Body normalization (signature fixup, line-ending normalization)
 *   - Atomic human-control re-check via updateMany (TOCTOU defence
 *     between the executor-level check and the actual send)
 *   - Tracking-code embedding in the subject for deterministic
 *     thread matching
 *   - Thread-ID lookup + storage for Gmail conversation threading
 *     (separate threads for client and therapist)
 *   - Audit event emission on success
 *   - Fallback to the BullMQ pending-email queue on direct-send
 *     failure (with the final, tracking-coded subject; the queue worker
 *     repeats the human-control re-check and the thread-ID storage)
 *
 * This is distinct from `core/email/outbound/send.ts`. The outbound
 * module is the low-level Gmail API wrapper. This module is the
 * agent's per-appointment policy layer ON TOP of that wrapper.
 */

import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/database';
import { firstName } from '../../../utils/first-name';
import { sendEmail } from '../../../core/email';
import { emailQueueService } from '../../../services/email-queue.service';
import { auditEventService } from '../../../services/audit-event.service';
import { getSettingValue } from '../../../services/settings.service';
import { prependTrackingCodeToSubject } from '../../../services/tracking-code.service';
import { EMAIL, TERMINAL_STATUSES } from '../../../constants';
import { normalizeAgentOutboundEmail } from '../../../core/agent/tools/email-normalization';

/**
 * Send an email via core/email's Gmail wrapper, with all
 * per-appointment threading + tracking-code + human-control
 * defences applied. Falls through to the BullMQ pending-email
 * queue on direct-send failure.
 *
 * Never throws: failures are logged (and queued where possible) and
 * reported in the returned outcome, so the send_email handler can tell
 * the agent honestly whether the email went out.
 */
export type AppointmentEmailOutcome =
  /** Delivered to Gmail. */
  | { status: 'sent' }
  /** Direct send failed; queued for the retry worker (which re-checks human control). */
  | { status: 'queued' }
  /** Deliberately not sent: human control, a terminal status, or no such appointment. */
  | { status: 'not_sent'; reason: 'human_control' | 'terminal_status' | 'appointment_not_found' }
  /** Neither sent nor queued. */
  | { status: 'failed'; error: string };

export async function sendAppointmentEmail(
  params: {
    to: string;
    subject: string;
    body: string;
  },
  appointmentRequestId: string | undefined,
  traceId: string,
): Promise<AppointmentEmailOutcome> {
  const agentName = await getSettingValue<string>('agent.fromName');
  const agentFirstName = firstName(agentName);
  const { subject: normalizedSubject, body: normalizedBody } = normalizeAgentOutboundEmail(
    params.subject,
    params.body,
    agentFirstName,
  );

  if (normalizedSubject !== params.subject) {
    logger.info(
      { traceId, originalSubject: params.subject, normalizedSubject },
      'Added "Spill" prefix to email subject',
    );
  }

  logger.debug(
    {
      traceId,
      to: params.to,
      originalBodyLength: params.body.length,
      normalizedBodyLength: normalizedBody.length,
    },
    'Sending email — body normalization applied',
  );

  const emailParams = { ...params, subject: normalizedSubject, body: normalizedBody };
  // The subject actually sent — with the appointment's tracking code once
  // it is known. The queue fallback below must use this, not the bare
  // subject: a queued first email without the code started an untracked
  // thread whose reply matched nothing (E11). The code also marks the
  // email as an agent email for the queue worker's human-control /
  // terminal-status re-check (core/email/outbound/queue.ts).
  let finalSubject = emailParams.subject;

  try {
    let existingThreadId: string | null = null;
    let isTherapistEmail = false;
    let trackingCode: string | null = null;

    if (appointmentRequestId) {
      const existing = await prisma.appointmentRequest.findUnique({
        where: { id: appointmentRequestId },
        select: {
          gmailThreadId: true,
          therapistGmailThreadId: true,
          therapistEmail: true,
          initialMessageId: true,
          trackingCode: true,
        },
      });

      if (existing) {
        isTherapistEmail = params.to.toLowerCase() === existing.therapistEmail.toLowerCase();
        existingThreadId = isTherapistEmail
          ? existing.therapistGmailThreadId
          : existing.gmailThreadId;
        trackingCode = existing.trackingCode;

        logger.info(
          { traceId, to: params.to, isTherapistEmail, existingThreadId, trackingCode },
          'Determined recipient type, existing thread, and tracking code',
        );
      }
    }

    // ATOMIC TOCTOU defence: re-check human-control AND terminal-status via
    // updateMany with both as where predicates. If human control flipped, or
    // an admin cancelled the appointment, between the executor-level check
    // and this point, `count: 0` and we silently abort the send — closes the
    // window where an in-flight turn could still email a cancelled/completed
    // appointment.
    if (appointmentRequestId) {
      const canSend = await prisma.appointmentRequest.updateMany({
        where: {
          id: appointmentRequestId,
          humanControlEnabled: false,
          status: { notIn: [...TERMINAL_STATUSES] },
        },
        data: {
          lastActivityAt: new Date(),
        },
      });

      if (canSend.count === 0) {
        const current = await prisma.appointmentRequest.findUnique({
          where: { id: appointmentRequestId },
          select: { humanControlEnabled: true, status: true },
        });

        if (current?.humanControlEnabled) {
          logger.warn(
            { traceId, appointmentRequestId, to: params.to },
            'Human control enabled - aborting email send (atomic check)',
          );
          return { status: 'not_sent', reason: 'human_control' };
        }
        if (current && (TERMINAL_STATUSES as readonly string[]).includes(current.status)) {
          logger.warn(
            { traceId, appointmentRequestId, to: params.to, status: current.status },
            'Appointment reached a terminal status mid-turn - aborting email send (atomic check)',
          );
          return { status: 'not_sent', reason: 'terminal_status' };
        }
        if (!current) {
          logger.warn(
            { traceId, appointmentRequestId },
            'Appointment not found - aborting email send',
          );
          return { status: 'not_sent', reason: 'appointment_not_found' };
        }
      }
    }

    // Prepend tracking code to subject for deterministic matching.
    // Ensures emails can be matched to the correct appointment even
    // without thread IDs. Code goes at START for better visibility.
    const subjectWithTracking = trackingCode
      ? prependTrackingCodeToSubject(emailParams.subject, trackingCode)
      : emailParams.subject;
    finalSubject = subjectWithTracking;

    const result = await sendEmail({
      ...emailParams,
      subject: subjectWithTracking,
      threadId: existingThreadId || undefined,
    });

    logger.info(
      { traceId, to: params.to, threadId: result.threadId, isTherapistEmail },
      'Email sent successfully via Gmail',
    );

    if (appointmentRequestId) {
      auditEventService.logEmailSent(appointmentRequestId, {
        traceId,
        from: EMAIL.FROM_ADDRESS,
        to: emailParams.to,
        subject: emailParams.subject,
        bodyPreview: emailParams.body.slice(0, 200),
        gmailMessageId: result.messageId,
      });
    }

    // Store thread ID on first email for deterministic matching.
    // Atomic conditional update to prevent race conditions where two
    // concurrent first-emails would both store their (potentially
    // different) thread IDs.
    if (appointmentRequestId && result.threadId) {
      try {
        if (isTherapistEmail) {
          const updated = await prisma.appointmentRequest.updateMany({
            where: {
              id: appointmentRequestId,
              therapistGmailThreadId: null,
            },
            data: {
              therapistGmailThreadId: result.threadId,
            },
          });

          if (updated.count > 0) {
            logger.info(
              { traceId, appointmentRequestId, threadId: result.threadId },
              'Stored therapist Gmail thread ID for appointment',
            );
          } else {
            // CRITICAL: check if storage unexpectedly failed (no
            // thread ID set but update returned 0).
            const current = await prisma.appointmentRequest.findUnique({
              where: { id: appointmentRequestId },
              select: { therapistGmailThreadId: true },
            });
            if (!current?.therapistGmailThreadId) {
              logger.error(
                { traceId, appointmentRequestId, threadId: result.threadId },
                'CRITICAL: Failed to store therapist thread ID - email matching may be unreliable',
              );
            }
          }
        } else {
          const updated = await prisma.appointmentRequest.updateMany({
            where: {
              id: appointmentRequestId,
              gmailThreadId: null,
            },
            data: {
              gmailThreadId: result.threadId,
              initialMessageId: result.messageId,
            },
          });

          if (updated.count > 0) {
            logger.info(
              { traceId, appointmentRequestId, threadId: result.threadId },
              'Stored client Gmail thread ID for appointment',
            );
          } else {
            const current = await prisma.appointmentRequest.findUnique({
              where: { id: appointmentRequestId },
              select: { gmailThreadId: true },
            });
            if (!current?.gmailThreadId) {
              logger.error(
                { traceId, appointmentRequestId, threadId: result.threadId },
                'CRITICAL: Failed to store client thread ID - email matching may be unreliable',
              );
            }
          }
        }
      } catch (storeErr) {
        logger.error(
          { traceId, error: storeErr, appointmentRequestId },
          'CRITICAL: Failed to store thread ID - email routing may be unreliable',
        );
      }
    }
    return { status: 'sent' };
  } catch (sendError) {
    logger.warn(
      { traceId, error: sendError },
      'Could not send email directly, queuing for later',
    );

    // Fallback: queue via BullMQ for later processing (with DB audit trail).
    // The queue worker re-checks human control / terminal status
    // atomically before sending and stores the Gmail thread id on the
    // appointment, exactly like the direct path above.
    try {
      await emailQueueService.enqueue({
        to: emailParams.to,
        subject: finalSubject,
        body: emailParams.body,
        appointmentId: appointmentRequestId,
      });
      logger.info(
        { traceId, to: params.to },
        'Email queued successfully via BullMQ',
      );
      return { status: 'queued' };
    } catch (dbError) {
      logger.error(
        { traceId, error: dbError },
        'Failed to queue email',
      );
      const sendMsg = sendError instanceof Error ? sendError.message : String(sendError);
      const queueMsg = dbError instanceof Error ? dbError.message : String(dbError);
      return { status: 'failed', error: `send failed (${sendMsg}); queueing failed (${queueMsg})` };
    }
  }
}

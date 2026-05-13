/**
 * Agent-side email send for appointment-scoped conversations.
 *
 * Wraps `emailProcessingService.sendEmail` with the per-appointment
 * concerns:
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
 *     failure
 *
 * This is distinct from `core/email/outbound/send.ts`. The outbound
 * module is the low-level Gmail API wrapper. This module is the
 * agent's per-appointment policy layer ON TOP of that wrapper.
 */

import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/database';
import { firstName } from '../../../utils/first-name';
import { emailProcessingService } from '../../../services/email-processing.service';
import { emailQueueService } from '../../../services/email-queue.service';
import { auditEventService } from '../../../services/audit-event.service';
import { getSettingValue } from '../../../services/settings.service';
import { prependTrackingCodeToSubject } from '../../../services/tracking-code.service';
import { EMAIL } from '../../../constants';
import { normalizeEmailBody } from './email-normalization';

/**
 * Send an email via the email-processing service, with all
 * per-appointment threading + tracking-code + human-control
 * defences applied. Falls through to the BullMQ pending-email
 * queue on direct-send failure.
 *
 * Returns void — failures are logged and queued, never thrown,
 * because the tool dispatcher uses the absence of a return to
 * mean "no follow-up state to record" rather than treating it
 * as a tool failure.
 */
export async function sendAppointmentEmail(
  params: {
    to: string;
    subject: string;
    body: string;
  },
  appointmentRequestId: string | undefined,
  traceId: string,
): Promise<void> {
  // Ensure subject includes "Spill" for brand consistency.
  let normalizedSubject = params.subject;
  if (!params.subject.toLowerCase().includes('spill')) {
    normalizedSubject = `Spill - ${params.subject}`;
    logger.info(
      { traceId, originalSubject: params.subject, normalizedSubject },
      'Added "Spill" prefix to email subject',
    );
  }

  const agentName = await getSettingValue<string>('agent.fromName');
  const agentFirstName = firstName(agentName);
  const normalizedBody = normalizeEmailBody(params.body, agentFirstName);

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

    // ATOMIC TOCTOU defence: re-check human-control via updateMany
    // with `humanControlEnabled: false` as a where predicate. If
    // human control flipped between the executor-level check and
    // this point, `count: 0` and we silently abort the send.
    if (appointmentRequestId) {
      const canSend = await prisma.appointmentRequest.updateMany({
        where: {
          id: appointmentRequestId,
          humanControlEnabled: false,
        },
        data: {
          lastActivityAt: new Date(),
        },
      });

      if (canSend.count === 0) {
        const current = await prisma.appointmentRequest.findUnique({
          where: { id: appointmentRequestId },
          select: { humanControlEnabled: true },
        });

        if (current?.humanControlEnabled) {
          logger.warn(
            { traceId, appointmentRequestId, to: params.to },
            'Human control enabled - aborting email send (atomic check)',
          );
          return;
        }
        if (!current) {
          logger.warn(
            { traceId, appointmentRequestId },
            'Appointment not found - aborting email send',
          );
          return;
        }
      }
    }

    // Prepend tracking code to subject for deterministic matching.
    // Ensures emails can be matched to the correct appointment even
    // without thread IDs. Code goes at START for better visibility.
    const subjectWithTracking = trackingCode
      ? prependTrackingCodeToSubject(emailParams.subject, trackingCode)
      : emailParams.subject;

    const result = await emailProcessingService.sendEmail({
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
  } catch (sendError) {
    logger.warn(
      { traceId, error: sendError },
      'Could not send email directly, queuing for later',
    );

    // Fallback: queue via BullMQ for later processing (with DB audit trail).
    try {
      await emailQueueService.enqueue({
        to: emailParams.to,
        subject: emailParams.subject,
        body: emailParams.body,
        appointmentId: appointmentRequestId,
      });
      logger.info(
        { traceId, to: params.to },
        'Email queued successfully via BullMQ',
      );
    } catch (dbError) {
      logger.error(
        { traceId, error: dbError },
        'Failed to queue email',
      );
    }

    logger.info(
      { traceId, to: params.to, subject: params.subject },
      'Email queued for sending',
    );
  }
}

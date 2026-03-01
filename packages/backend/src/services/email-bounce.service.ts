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
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { notificationDispatcher } from './notification-dispatcher.service';

/**
 * Common bounce message patterns
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

const BOUNCE_SENDER_PATTERNS = [
  /mailer-daemon/i,
  /postmaster/i,
  /mail.*delivery.*subsystem/i,
  /bounce/i,
  /noreply.*google/i,
];

const BOUNCE_BODY_PATTERNS = [
  /550.*user.*unknown/i,
  /550.*no.*such.*user/i,
  /550.*mailbox.*not.*found/i,
  /550.*recipient.*rejected/i,
  /550.*invalid.*recipient/i,
  /553.*mailbox.*name.*not.*allowed/i,
  /554.*delivery.*error/i,
  /552.*mailbox.*full/i, // Soft bounce but still indicates issue
  /address.*does.*not.*exist/i,
  /no.*mailbox.*here/i,
  /account.*disabled/i,
  /account.*suspended/i,
  /this.*address.*no.*longer.*accepts.*mail/i,
];

export interface BounceInfo {
  isBounce: boolean;
  bounceType: 'hard' | 'soft' | 'unknown' | null;
  originalRecipient: string | null;
  reason: string | null;
  detectionMethod: 'subject' | 'sender' | 'body' | null;
}

/**
 * Analyze an email to determine if it's a bounce notification
 */
export function detectBounce(email: {
  from: string;
  subject: string;
  body: string;
}): BounceInfo {
  const result: BounceInfo = {
    isBounce: false,
    bounceType: null,
    originalRecipient: null,
    reason: null,
    detectionMethod: null,
  };

  // Check sender patterns (highest confidence)
  for (const pattern of BOUNCE_SENDER_PATTERNS) {
    if (pattern.test(email.from)) {
      result.isBounce = true;
      result.detectionMethod = 'sender';
      break;
    }
  }

  // Check subject patterns
  if (!result.isBounce) {
    for (const pattern of BOUNCE_SUBJECT_PATTERNS) {
      if (pattern.test(email.subject)) {
        result.isBounce = true;
        result.detectionMethod = 'subject';
        break;
      }
    }
  }

  // If we detected a bounce, analyze the body for more details
  if (result.isBounce) {
    // Determine bounce type
    if (/550|553|554|invalid|unknown|not.*found|rejected|does.*not.*exist/i.test(email.body)) {
      result.bounceType = 'hard'; // Permanent failure
    } else if (/552|full|quota|temporarily|try.*again/i.test(email.body)) {
      result.bounceType = 'soft'; // Temporary failure
    } else {
      result.bounceType = 'unknown';
    }

    // Try to extract the original recipient email
    const recipientMatch = email.body.match(
      /(?:original.*recipient|to:|recipient|address)[:\s]*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/i
    );
    if (recipientMatch) {
      result.originalRecipient = recipientMatch[1].toLowerCase();
    }

    // Extract reason
    for (const pattern of BOUNCE_BODY_PATTERNS) {
      const match = email.body.match(pattern);
      if (match) {
        result.reason = match[0];
        break;
      }
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
    {
      traceId,
      bounceType: bounceInfo.bounceType,
      recipient: bounceInfo.originalRecipient,
      reason: bounceInfo.reason,
    },
    'Handling email bounce'
  );

  const result = {
    handled: false,
    appointmentId: undefined as string | undefined,
    therapistUnfrozen: false,
    error: undefined as string | undefined,
  };

  try {
    // Find the appointment request by bounced email or thread ID
    let appointment = null;

    if (originalEmail?.threadId) {
      // Check both client and therapist thread IDs
      appointment = await prisma.appointmentRequest.findFirst({
        where: {
          OR: [
            { gmailThreadId: originalEmail.threadId },
            { therapistGmailThreadId: originalEmail.threadId },
          ],
          status: { notIn: ['cancelled', 'confirmed'] },
        },
        select: { id: true, therapistNotionId: true },
      });
    }

    if (!appointment && bounceInfo.originalRecipient) {
      appointment = await prisma.appointmentRequest.findFirst({
        where: {
          userEmail: bounceInfo.originalRecipient.toLowerCase(),
          status: { notIn: ['cancelled', 'confirmed'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, therapistNotionId: true },
      });
    }

    if (!appointment) {
      logger.warn(
        { traceId, recipient: bounceInfo.originalRecipient },
        'No matching appointment found for bounce'
      );
      result.error = 'No matching appointment found';
      return result;
    }

    result.appointmentId = appointment.id;

    // Update the appointment with bounce information
    await prisma.appointmentRequest.update({
      where: { id: appointment.id },
      data: {
        status: 'cancelled',
        notes: `[BOUNCE] Email delivery failed: ${bounceInfo.reason || bounceInfo.bounceType}. ` +
          `Original recipient: ${bounceInfo.originalRecipient || 'unknown'}. ` +
          `Auto-cancelled at ${new Date().toISOString()}.`,
        isStale: false, // Clear stale flag since we've handled it
      },
    });

    logger.info(
      { traceId, appointmentId: appointment.id },
      'Appointment marked as cancelled due to bounce'
    );

    // Unfreeze the therapist
    await therapistBookingStatusService.recalculateUniqueRequestCount(
      appointment.therapistNotionId
    );

    result.therapistUnfrozen = true;
    result.handled = true;

    logger.info(
      {
        traceId,
        appointmentId: appointment.id,
        therapistNotionId: appointment.therapistNotionId,
        userEmail: bounceInfo.originalRecipient,
      },
      'Therapist unfrozen after email bounce'
    );

    // Log the bounce event for admin visibility
    logger.warn(
      {
        traceId,
        event: 'EMAIL_BOUNCE',
        appointmentId: appointment.id,
        userName: appointment.userName,
        userEmail: appointment.userEmail,
        therapistName: appointment.therapistName,
        therapistNotionId: appointment.therapistNotionId,
        bounceType: bounceInfo.bounceType,
        bounceReason: bounceInfo.reason,
      },
      `Appointment cancelled due to email bounce - therapist unfrozen`
    );

    // Send Slack notification for email bounce
    await notificationDispatcher.emailBounce({
      appointmentId: appointment.id,
      therapistName: appointment.therapistName,
      bouncedEmail: bounceInfo.originalRecipient || appointment.userEmail,
      bounceReason: bounceInfo.reason || bounceInfo.bounceType || 'Unknown bounce reason',
    });

    return result;
  } catch (error) {
    logger.error(
      { traceId, error, recipient: bounceInfo.originalRecipient },
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
      recipient: bounceInfo.originalRecipient,
    },
    'Detected bounce email'
  );

  const result = await handleBounce(bounceInfo, {
    threadId: email.threadId,
    messageId: email.messageId,
  });

  return result.handled;
}

// Export for use in email-processing.service.ts
export const emailBounceService = {
  detectBounce,
  handleBounce,
  processPotentialBounce,
};

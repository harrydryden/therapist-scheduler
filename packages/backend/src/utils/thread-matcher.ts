/**
 * Thread Matcher
 *
 * Logic for matching incoming emails to appointment requests.
 * Uses a priority-based approach:
 *   1. Gmail thread ID (most deterministic)
 *   2. In-Reply-To / References headers (email chain tracking)
 *   3. Tracking code with sender verification
 *   4. Sender email + therapist name in subject (legacy fallback)
 */

import { prisma } from './database';
import { logger } from './logger';
import { extractTrackingCode } from '../services/tracking-code.service';
import { TERMINAL_STATUSES } from '../constants';

/**
 * Minimal email fields needed for appointment matching.
 */
export interface MatchableEmail {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  inReplyTo?: string;
  references?: string[];
}

/**
 * Result of a successful appointment match.
 */
export interface AppointmentMatch {
  id: string;
  userEmail: string;
  therapistEmail: string;
}

/**
 * Find an appointment request that matches the given email.
 *
 * Priority order:
 * 1. Gmail thread ID (deterministic - ensures correct routing for multi-therapist scenarios)
 * 2. In-Reply-To/References headers (email chain tracking)
 * 3. Tracking code with sender verification (deterministic match via subject-embedded code)
 * 4. Sender email + therapist name in subject (legacy fallback)
 *
 * FIX EMAIL-CONTEXT: Includes 'confirmed' status to handle post-booking emails
 * (e.g., reschedule requests, questions about the session).
 */
export async function findMatchingAppointmentRequest(
  email: MatchableEmail
): Promise<AppointmentMatch | null> {
  // PRIORITIES 1-3: Combined into a single query to reduce sequential DB round-trips.
  const trackingCode = extractTrackingCode(email.subject);
  const messageIds: string[] = [];
  if (email.references?.length || email.inReplyTo) {
    messageIds.push(...(email.references || []));
    if (email.inReplyTo && !messageIds.includes(email.inReplyTo)) {
      messageIds.push(email.inReplyTo);
    }
  }

  // Build OR conditions for all deterministic match types
  const deterministicConditions: Array<Record<string, unknown>> = [];
  if (email.threadId) {
    deterministicConditions.push({ gmailThreadId: email.threadId });
    deterministicConditions.push({ therapistGmailThreadId: email.threadId });
  }
  if (messageIds.length > 0) {
    deterministicConditions.push({ initialMessageId: { in: messageIds } });
  }
  if (trackingCode) {
    deterministicConditions.push({ trackingCode });
  }

  if (deterministicConditions.length > 0) {
    const candidates = await prisma.appointmentRequest.findMany({
      where: {
        OR: deterministicConditions,
      },
      select: {
        id: true,
        userEmail: true,
        therapistEmail: true,
        gmailThreadId: true,
        therapistGmailThreadId: true,
        initialMessageId: true,
        trackingCode: true,
      },
    });

    if (candidates.length > 0) {
      // Priority 1: Thread ID match
      if (email.threadId) {
        const threadMatch = candidates.find(
          (c) => c.gmailThreadId === email.threadId || c.therapistGmailThreadId === email.threadId
        );
        if (threadMatch) {
          logger.info(
            { appointmentId: threadMatch.id, threadId: email.threadId },
            'Matched appointment by Gmail thread ID'
          );
          return { id: threadMatch.id, userEmail: threadMatch.userEmail, therapistEmail: threadMatch.therapistEmail };
        }
      }

      // Priority 2: In-Reply-To/References match
      if (messageIds.length > 0) {
        const refMatch = candidates.find(
          (c) => c.initialMessageId && messageIds.includes(c.initialMessageId)
        );
        if (refMatch) {
          logger.info(
            { appointmentId: refMatch.id, inReplyTo: email.inReplyTo },
            'Matched appointment by In-Reply-To header'
          );
          return { id: refMatch.id, userEmail: refMatch.userEmail, therapistEmail: refMatch.therapistEmail };
        }
      }

      // Priority 3: Tracking code match (with sender verification)
      if (trackingCode) {
        const trackingMatch = candidates.find((c) => c.trackingCode === trackingCode);
        if (trackingMatch) {
          const senderIsUser = email.from.toLowerCase() === trackingMatch.userEmail.toLowerCase();
          const senderIsTherapist = email.from.toLowerCase() === trackingMatch.therapistEmail.toLowerCase();

          if (senderIsUser || senderIsTherapist) {
            logger.info(
              { appointmentId: trackingMatch.id, trackingCode, senderType: senderIsUser ? 'user' : 'therapist' },
              'Matched appointment by tracking code (deterministic match)'
            );
            return { id: trackingMatch.id, userEmail: trackingMatch.userEmail, therapistEmail: trackingMatch.therapistEmail };
          } else {
            logger.warn(
              { trackingCode, from: email.from, expectedUser: trackingMatch.userEmail, expectedTherapist: trackingMatch.therapistEmail },
              'Tracking code found but sender not recognized - possible forwarded email'
            );
            // Fall through to Priority 4
          }
        }
      }
    }
  }

  // PRIORITY 4: Fallback to sender + therapist name matching (for legacy appointments without tracking codes)
  return findByLegacyMatch(email);
}

/**
 * Sort comparator: most recently updated first, with ID as deterministic tiebreaker.
 */
function byMostRecent(
  a: { updatedAt: Date; id: string },
  b: { updatedAt: Date; id: string },
): number {
  const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  if (timeDiff !== 0) return timeDiff;
  return a.id.localeCompare(b.id);
}

/**
 * Legacy fallback matching: sender email + therapist name in subject.
 * Limited to 50 results to prevent memory issues with high-volume users.
 *
 * IMPORTANT: Excludes terminal statuses (cancelled, completed) to prevent
 * replies to unrelated emails (e.g. therapist nudge reminders) from being
 * matched to old, closed appointments. Deterministic matches (thread ID,
 * In-Reply-To, tracking code) are NOT filtered by status because those are
 * explicit thread replies.
 *
 * When multiple matches exist, uses deterministic selection:
 * - Prefer unique therapist-name match in subject
 * - Then prefer unique therapist-email match
 * - Otherwise reject as ambiguous
 */
async function findByLegacyMatch(
  email: MatchableEmail
): Promise<AppointmentMatch | null> {
  const matchingRequests = await prisma.appointmentRequest.findMany({
    where: {
      OR: [
        { userEmail: email.from },
        { therapistEmail: email.from },
      ],
      status: { notIn: [...TERMINAL_STATUSES] },
    },
    orderBy: {
      updatedAt: 'desc',
    },
    take: 50,
    select: {
      id: true,
      userEmail: true,
      therapistEmail: true,
      therapistName: true,
      updatedAt: true,
    },
  });

  if (matchingRequests.length === 0) {
    return null;
  }

  // If only one matching request, return it
  if (matchingRequests.length === 1) {
    return matchingRequests[0];
  }

  // Multiple matching requests - try to match by therapist name in subject
  // FIX E8: Collect ALL matches, then select deterministically (most recently updated)
  const subjectLower = email.subject.toLowerCase();
  const nameMatches: typeof matchingRequests = [];

  for (const request of matchingRequests) {
    if (!request.therapistName) {
      logger.warn(
        { appointmentId: request.id },
        'Appointment has null therapistName - skipping name-based matching'
      );
      continue;
    }

    const therapistNameLower = request.therapistName.toLowerCase();
    const firstName = therapistNameLower.split(' ')[0];

    if (subjectLower.includes(therapistNameLower) || subjectLower.includes(firstName)) {
      nameMatches.push(request);
    }
  }

  // FIX E8: If exactly one name match, use it
  if (nameMatches.length === 1) {
    logger.info(
      { appointmentId: nameMatches[0].id, therapistName: nameMatches[0].therapistName },
      'Matched appointment by therapist name in subject (unique match)'
    );
    return nameMatches[0];
  }

  // FIX E8 + H4: If multiple name matches, select deterministically
  if (nameMatches.length > 1) {
    nameMatches.sort(byMostRecent);
    logger.warn(
      {
        matchCount: nameMatches.length,
        selectedAppointmentId: nameMatches[0].id,
        therapistName: nameMatches[0].therapistName,
      },
      'Multiple appointments matched therapist name - selecting most recently updated'
    );
    return nameMatches[0];
  }

  // Fallback: if sender is a therapist, match by their email
  const therapistMatches = matchingRequests.filter(r => r.therapistEmail === email.from);
  if (therapistMatches.length === 1) {
    logger.info(
      { appointmentId: therapistMatches[0].id, therapistEmail: email.from },
      'Matched appointment by therapist email (unique match)'
    );
    return therapistMatches[0];
  } else if (therapistMatches.length > 1) {
    therapistMatches.sort(byMostRecent);
    logger.warn(
      {
        therapistEmail: email.from,
        matchCount: therapistMatches.length,
        selectedAppointmentId: therapistMatches[0].id,
      },
      'Multiple appointments for same therapist - selecting most recently updated'
    );
    return therapistMatches[0];
  }

  // SAFETY: Reject ambiguous emails rather than guessing wrong
  logger.error(
    { from: email.from, subject: email.subject, matchingRequestCount: matchingRequests.length },
    'AMBIGUOUS MATCH: Could not deterministically match email to appointment. ' +
    'Email will be skipped to prevent misdirected responses. Manual intervention required.'
  );
  return null;
}

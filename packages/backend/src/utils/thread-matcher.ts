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
 * Result of a successful TherapistConversation match.
 *
 * Distinct from AppointmentMatch because the dispatcher routes the two
 * kinds of matches to different agents (booking vs. availability) and
 * needs different downstream data:
 *
 *   - `status` drives the routing decision (active → run agent;
 *     superseded → maybe send ack; completed/abandoned → silent).
 *   - `supersededAckSent` gates the one-shot ack so the therapist
 *     gets at most one "we've moved this conversation" reply on a
 *     superseded thread.
 */
export interface TherapistConversationMatch {
  id: string;
  therapistId: string;
  therapistEmail: string;
  status: 'active' | 'completed' | 'superseded' | 'abandoned';
  supersededAckSent: boolean;
  kind: 'onboarding' | 'nudge_reply';
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
 * Find a TherapistConversation row that the inbound email belongs to.
 *
 * Matches deterministically by Gmail thread ID and, as a secondary,
 * by `initialMessageId` via the In-Reply-To / References headers — same
 * two priorities the appointment matcher uses, in the same order. We
 * skip the tracking-code and sender-legacy paths: TherapistConversation
 * doesn't have a tracking code, and the legacy sender-name fallback
 * would be unsafe here because a therapist may belong to many
 * conversations (active + superseded) where deterministic markers
 * matter more than ever.
 *
 * NO status filter — the caller decides what to do per status:
 *   - 'active'      → run the availability agent's processReply
 *   - 'superseded'  → send one-shot ack if `supersededAckSent === false`
 *   - 'completed'   → silent
 *   - 'abandoned'   → silent
 *
 * Routing-by-status is the dispatcher's job, not the matcher's. The
 * matcher's only contract is "does this email belong to a known
 * therapist-only conversation row".
 */
export async function findMatchingTherapistConversation(
  email: MatchableEmail,
): Promise<TherapistConversationMatch | null> {
  const messageIds: string[] = [];
  if (email.references?.length || email.inReplyTo) {
    messageIds.push(...(email.references || []));
    if (email.inReplyTo && !messageIds.includes(email.inReplyTo)) {
      messageIds.push(email.inReplyTo);
    }
  }

  const conditions: Array<Record<string, unknown>> = [];
  if (email.threadId) {
    conditions.push({ gmailThreadId: email.threadId });
  }
  if (messageIds.length > 0) {
    conditions.push({ initialMessageId: { in: messageIds } });
  }
  if (conditions.length === 0) {
    return null;
  }

  // Multiple rows could match (e.g. a therapist has both a superseded
  // onboarding and an active follow-up). Sort by most-recent-activity
  // and prefer active rows over terminal ones, so a stale superseded
  // row doesn't shadow a live conversation that happens to share an
  // initialMessageId.
  const candidates = await prisma.therapistConversation.findMany({
    where: { OR: conditions },
    select: {
      id: true,
      therapistId: true,
      status: true,
      supersededAckSent: true,
      kind: true,
      gmailThreadId: true,
      initialMessageId: true,
      lastActivityAt: true,
      therapist: { select: { email: true } },
    },
    orderBy: { lastActivityAt: 'desc' },
  });

  if (candidates.length === 0) return null;

  // Prefer active. Within active (or within non-active), the orderBy
  // above already broke ties by most-recent-activity.
  const active = candidates.find((c) => c.status === 'active');
  const chosen = active ?? candidates[0];

  logger.info(
    {
      conversationId: chosen.id,
      therapistId: chosen.therapistId,
      status: chosen.status,
      threadId: email.threadId,
      messageIdMatch: messageIds.includes(chosen.initialMessageId ?? ''),
    },
    'Matched therapist conversation by deterministic thread/message id',
  );

  return {
    id: chosen.id,
    therapistId: chosen.therapistId,
    therapistEmail: chosen.therapist.email,
    status: chosen.status as TherapistConversationMatch['status'],
    supersededAckSent: chosen.supersededAckSent,
    kind: chosen.kind as TherapistConversationMatch['kind'],
  };
}

/**
 * Lookback window for the cross-pollination guard. Within this many days,
 * a sender's terminal (completed/cancelled) appointment is "recent enough"
 * that an unstructured email from them is genuinely ambiguous between the
 * old closed thread and any new active one. Rather than guess, we surface
 * to admin review. 60 days covers the typical lag for therapists who
 * reply weeks after a session.
 */
const AMBIGUOUS_TERMINAL_LOOKBACK_DAYS = 60;
function byMostRecent(
  a: { updatedAt: Date; id: string },
  b: { updatedAt: Date; id: string },
): number {
  const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  if (timeDiff !== 0) return timeDiff;
  return a.id.localeCompare(b.id);
}

/** Distinct client emails (case-insensitive) across a set of candidate matches. */
function distinctClients(requests: Array<{ userEmail: string }>): string[] {
  return [...new Set(requests.map((r) => r.userEmail.toLowerCase()))];
}

function distinctClientCount(requests: Array<{ userEmail: string }>): number {
  return distinctClients(requests).length;
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

  // Cross-pollination guard: if the sender ALSO has a recent terminal
  // (completed/cancelled) appointment, an unstructured email from them is
  // genuinely ambiguous between the closed thread and any new active one.
  // Without this guard, a late therapist message about an old session was
  // silently attributed to a different client's new pending appointment
  // (the only non-terminal one for that therapist) — see PR fixing the
  // SPL-8449 / SPL-1185 misroute.
  //
  // The deterministic match priorities (thread ID, In-Reply-To, tracking
  // code) above don't filter by status, so well-formed replies still resolve
  // to the right appointment even if it's terminal. Only emails that fall
  // ALL the way through to legacy fallback hit this guard.
  const cutoff = new Date(Date.now() - AMBIGUOUS_TERMINAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const recentTerminal = await prisma.appointmentRequest.findFirst({
    where: {
      OR: [
        { userEmail: email.from },
        { therapistEmail: email.from },
      ],
      status: { in: [...TERMINAL_STATUSES] },
      updatedAt: { gte: cutoff },
    },
    select: { id: true },
  });

  if (recentTerminal) {
    logger.warn(
      {
        from: email.from,
        subject: email.subject,
        activeCount: matchingRequests.length,
        recentTerminalId: recentTerminal.id,
      },
      'AMBIGUOUS MATCH: sender has both active and recent terminal appointments. ' +
      'Skipping legacy match to prevent cross-pollination — manual review needed.'
    );
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

  // FIX E8 + H4: Multiple name matches. Active-vs-active guard: if the tied
  // candidates span more than one distinct client, an unstructured email is
  // genuinely ambiguous between those clients' threads — reject rather than
  // guess (see docs/THERAPIST_TARGET_AVAILABILITY.md §3). Only when every
  // tied candidate is the SAME client (e.g. a reschedule created a second
  // row) is most-recently-updated selection safe.
  if (nameMatches.length > 1) {
    if (distinctClientCount(nameMatches) > 1) {
      logger.error(
        {
          from: email.from,
          subject: email.subject,
          matchCount: nameMatches.length,
          clients: distinctClients(nameMatches),
        },
        'AMBIGUOUS MATCH (active-vs-active): therapist name in subject matched multiple ' +
        'clients with active appointments. Skipping legacy match to prevent cross-pollination — manual review needed.'
      );
      return null;
    }
    nameMatches.sort(byMostRecent);
    logger.warn(
      {
        matchCount: nameMatches.length,
        selectedAppointmentId: nameMatches[0].id,
        therapistName: nameMatches[0].therapistName,
      },
      'Multiple appointments matched therapist name (same client) - selecting most recently updated'
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
    // Same active-vs-active guard as the name branch: a therapist with more
    // than one active client and no deterministic marker on the email cannot
    // be attributed safely.
    if (distinctClientCount(therapistMatches) > 1) {
      logger.error(
        {
          therapistEmail: email.from,
          subject: email.subject,
          matchCount: therapistMatches.length,
          clients: distinctClients(therapistMatches),
        },
        'AMBIGUOUS MATCH (active-vs-active): therapist has multiple active clients and the ' +
        'email lacks a deterministic marker. Skipping legacy match to prevent cross-pollination — manual review needed.'
      );
      return null;
    }
    therapistMatches.sort(byMostRecent);
    logger.warn(
      {
        therapistEmail: email.from,
        matchCount: therapistMatches.length,
        selectedAppointmentId: therapistMatches[0].id,
      },
      'Multiple appointments for same therapist (same client) - selecting most recently updated'
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

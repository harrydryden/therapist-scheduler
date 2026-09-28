/**
 * Thread Divergence Detection & Handling
 *
 * Detects when email threads diverge from expected patterns:
 * - User replies to wrong thread
 * - CC/BCC creates parallel conversations
 * - Forwarded emails start new threads
 * - Cross-thread references detected
 *
 * Provides strategies for recovery and thread merging.
 */

import { logger } from '../utils/logger';
import { prisma } from '../utils/database';
import { slackNotificationService } from '../services/slack-notification.service';
import { EMAIL } from '../constants';

/**
 * Divergence types we can detect
 */
export type DivergenceType =
  | 'wrong_thread_reply'      // User replied to old/wrong thread
  | 'cc_parallel_thread'       // CC created parallel conversation
  | 'forward_new_thread'       // Email was forwarded, creating new thread
  | 'cross_thread_reference'   // Email references multiple threads
  | 'orphaned_reply'           // Reply to thread we don't have record of
  | 'therapist_direct_reply'   // Therapist replied directly instead of through system
  | 'therapist_name_mismatch'  // Email mentions different therapist than matched appointment
  | 'none';                    // No divergence detected

/**
 * Severity levels for divergence
 */
export type DivergenceSeverity =
  | 'low'       // Can be auto-handled
  | 'medium'    // May need confirmation
  | 'high'      // Likely needs manual intervention
  | 'critical'; // Risk of data going to wrong party

/**
 * Detection result
 */
export interface DivergenceDetection {
  detected: boolean;
  type: DivergenceType;
  severity: DivergenceSeverity;
  confidence: number; // 0-1
  description: string;
  suggestedAction: 'auto_merge' | 'confirm_with_user' | 'manual_review' | 'ignore' | 'none';
  relatedThreadIds?: string[];
  relatedAppointmentIds?: string[];
}

/**
 * Email context for divergence detection
 */
export interface EmailContext {
  threadId: string;
  messageId: string;
  from: string;
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
  date: Date;
}

/**
 * Appointment context for matching
 */
export interface AppointmentContext {
  id: string;
  userEmail: string;
  therapistEmail: string;
  therapistName: string;
  gmailThreadId: string | null;
  therapistGmailThreadId: string | null;
  initialMessageId: string | null;
  status: string;
  createdAt: Date;
  /**
   * Therapist identity keys, when known. Used to recognise that two
   * appointments are with the SAME therapist (e.g. a rebooking while the
   * earlier row is still feedback_requested) so the name-mismatch check
   * doesn't treat the therapist's own name as "another therapist".
   */
  therapistId?: string | null;
  therapistHandle?: string | null;
}

/**
 * Main divergence detection function
 */
export function detectThreadDivergence(
  email: EmailContext,
  matchedAppointment: AppointmentContext | null,
  allActiveAppointments: AppointmentContext[]
): DivergenceDetection {
  // No divergence if no appointment matched
  if (!matchedAppointment) {
    // Check if this looks like an orphaned reply
    if (email.inReplyTo || (email.references && email.references.length > 0)) {
      return {
        detected: true,
        type: 'orphaned_reply',
        severity: 'medium',
        confidence: 0.7,
        description: 'Email appears to be a reply but no matching appointment found',
        suggestedAction: 'manual_review',
      };
    }
    return createNoDetection();
  }

  // Check for CC creating parallel conversations
  const ccDivergence = detectCCDivergence(email, matchedAppointment, allActiveAppointments);
  if (ccDivergence.detected) {
    return ccDivergence;
  }

  // Check for wrong thread reply
  const wrongThreadDivergence = detectWrongThreadReply(email, matchedAppointment, allActiveAppointments);
  if (wrongThreadDivergence.detected) {
    return wrongThreadDivergence;
  }

  // Check for cross-thread references
  const crossThreadDivergence = detectCrossThreadReferences(email, allActiveAppointments);
  if (crossThreadDivergence.detected) {
    return crossThreadDivergence;
  }

  // Check for forwarded email creating new thread
  const forwardDivergence = detectForwardedEmail(email, matchedAppointment);
  if (forwardDivergence.detected) {
    return forwardDivergence;
  }

  // Check for therapist direct reply
  const directReplyDivergence = detectTherapistDirectReply(email, matchedAppointment);
  if (directReplyDivergence.detected) {
    return directReplyDivergence;
  }

  // Check for therapist name mismatch (email mentions different therapist)
  const nameMismatchDivergence = detectTherapistNameMismatch(email, matchedAppointment, allActiveAppointments);
  if (nameMismatchDivergence.detected) {
    return nameMismatchDivergence;
  }

  return createNoDetection();
}

/**
 * Detect CC creating parallel conversation threads
 */
function detectCCDivergence(
  email: EmailContext,
  matchedAppointment: AppointmentContext,
  allActiveAppointments: AppointmentContext[]
): DivergenceDetection {
  if (!email.cc || email.cc.length === 0) {
    return createNoDetection();
  }

  const ccEmails = email.cc.map(e => e.toLowerCase());
  // Our address: EMAIL.FROM_ADDRESS is the single source of truth. This
  // read an undocumented GMAIL_USER env var that was never set, so the
  // scheduler-CC check below was dead code.
  const schedulerEmail = EMAIL.FROM_ADDRESS.toLowerCase();

  // Check if our scheduler email was CC'd on a parallel conversation
  const schedulerCCd = ccEmails.includes(schedulerEmail);

  // Check if user or therapist is CC'd (may indicate parallel thread)
  const userCCd = ccEmails.includes(matchedAppointment.userEmail.toLowerCase());
  const therapistCCd = ccEmails.includes(matchedAppointment.therapistEmail.toLowerCase());

  // Check if CC recipients are involved in other appointments
  const ccInOtherAppointments = allActiveAppointments.filter(apt =>
    apt.id !== matchedAppointment.id &&
    (ccEmails.includes(apt.userEmail.toLowerCase()) ||
     ccEmails.includes(apt.therapistEmail.toLowerCase()))
  );

  if (ccInOtherAppointments.length > 0) {
    // High risk: CC includes parties from different appointments
    return {
      detected: true,
      type: 'cc_parallel_thread',
      severity: 'critical',
      confidence: 0.9,
      description: `Email CC includes parties from ${ccInOtherAppointments.length} other active appointment(s). Risk of crossed wires.`,
      suggestedAction: 'manual_review',
      relatedAppointmentIds: ccInOtherAppointments.map(a => a.id),
    };
  }

  if (schedulerCCd && email.from.toLowerCase() !== matchedAppointment.therapistEmail.toLowerCase()) {
    // User CC'd us - they may have replied directly to therapist
    return {
      detected: true,
      type: 'cc_parallel_thread',
      severity: 'medium',
      confidence: 0.75,
      description: 'Scheduler was CC\'d rather than direct recipient - possible parallel conversation',
      suggestedAction: 'confirm_with_user',
    };
  }

  if (userCCd || therapistCCd) {
    // Someone CC'd the other party - might be trying to bypass the scheduler
    return {
      detected: true,
      type: 'cc_parallel_thread',
      severity: 'low',
      confidence: 0.6,
      description: 'Email includes CC to user or therapist - conversation may be happening in parallel',
      suggestedAction: 'auto_merge',
    };
  }

  return createNoDetection();
}

/**
 * Detect when user replies to wrong/old thread
 */
function detectWrongThreadReply(
  email: EmailContext,
  matchedAppointment: AppointmentContext,
  allActiveAppointments: AppointmentContext[]
): DivergenceDetection {
  // If email's thread ID matches the appointment, no wrong thread issue
  if (email.threadId === matchedAppointment.gmailThreadId ||
      email.threadId === matchedAppointment.therapistGmailThreadId) {
    return createNoDetection();
  }

  // Check if this thread ID belongs to a different appointment
  const otherAppointmentWithThread = allActiveAppointments.find(apt =>
    apt.id !== matchedAppointment.id &&
    (apt.gmailThreadId === email.threadId || apt.therapistGmailThreadId === email.threadId)
  );

  if (otherAppointmentWithThread) {
    // Thread belongs to different appointment!
    return {
      detected: true,
      type: 'wrong_thread_reply',
      severity: 'high',
      confidence: 0.95,
      description: `Email thread belongs to appointment ${otherAppointmentWithThread.id} but matched to ${matchedAppointment.id}`,
      suggestedAction: 'manual_review',
      relatedThreadIds: [email.threadId],
      relatedAppointmentIds: [matchedAppointment.id, otherAppointmentWithThread.id],
    };
  }

  // Thread is new but appointment exists - could be forwarded/new chain
  if (!matchedAppointment.gmailThreadId && !matchedAppointment.therapistGmailThreadId) {
    // First thread for this appointment - not a divergence, just new
    return createNoDetection();
  }

  // Different thread but matched by email/name - possible new thread started
  return {
    detected: true,
    type: 'wrong_thread_reply',
    severity: 'medium',
    confidence: 0.7,
    description: 'Email is on a different thread than expected - user may have started new email chain',
    suggestedAction: 'auto_merge',
    relatedThreadIds: [email.threadId, matchedAppointment.gmailThreadId || matchedAppointment.therapistGmailThreadId || ''].filter(Boolean),
    relatedAppointmentIds: [matchedAppointment.id],
  };
}

/**
 * Detect emails that reference multiple threads
 */
function detectCrossThreadReferences(
  email: EmailContext,
  allActiveAppointments: AppointmentContext[]
): DivergenceDetection {
  if (!email.references || email.references.length <= 1) {
    return createNoDetection();
  }

  // Find all appointments that any of the references might belong to
  const referencedAppointments = new Set<string>();

  for (const ref of email.references) {
    for (const apt of allActiveAppointments) {
      if (apt.initialMessageId === ref) {
        referencedAppointments.add(apt.id);
      }
    }
  }

  if (referencedAppointments.size > 1) {
    return {
      detected: true,
      type: 'cross_thread_reference',
      severity: 'high',
      confidence: 0.85,
      description: `Email references ${referencedAppointments.size} different appointments`,
      suggestedAction: 'manual_review',
      relatedAppointmentIds: Array.from(referencedAppointments),
    };
  }

  return createNoDetection();
}

/**
 * Detect forwarded emails creating new threads
 */
function detectForwardedEmail(
  email: EmailContext,
  matchedAppointment: AppointmentContext
): DivergenceDetection {
  const forwardPatterns = [
    /^(fwd?|fw):\s*/i,          // Fwd:, FW:, Fw:
    /^------\s*forwarded/i,      // ------Forwarded message
    /^begin\s+forwarded/i,       // Begin forwarded message
    /^-+\s*original\s+message/i, // ---- Original message
  ];

  const subjectIsForward = forwardPatterns.some(p => p.test(email.subject));
  const bodyIsForward = forwardPatterns.some(p => p.test(email.body.slice(0, 500)));

  if (subjectIsForward || bodyIsForward) {
    return {
      detected: true,
      type: 'forward_new_thread',
      severity: 'medium',
      confidence: 0.8,
      description: 'Email appears to be forwarded - new thread may have been created',
      suggestedAction: 'auto_merge',
      relatedAppointmentIds: [matchedAppointment.id],
    };
  }

  return createNoDetection();
}

/**
 * Detect when therapist replies directly to user instead of through system
 */
function detectTherapistDirectReply(
  email: EmailContext,
  matchedAppointment: AppointmentContext
): DivergenceDetection {
  const schedulerEmail = EMAIL.FROM_ADDRESS.toLowerCase();

  // Check if email is from therapist to user, not going through scheduler
  const isFromTherapist = email.from.toLowerCase() === matchedAppointment.therapistEmail.toLowerCase();
  const isToUser = email.to.toLowerCase() === matchedAppointment.userEmail.toLowerCase();
  const schedulerNotInTo = email.to.toLowerCase() !== schedulerEmail;

  if (isFromTherapist && isToUser && schedulerNotInTo) {
    return {
      detected: true,
      type: 'therapist_direct_reply',
      severity: 'low',
      confidence: 0.85,
      description: 'Therapist appears to be communicating directly with user outside the booking system',
      suggestedAction: 'auto_merge',
      relatedAppointmentIds: [matchedAppointment.id],
    };
  }

  return createNoDetection();
}

/**
 * Honorifics / titles ignored when building name tokens. "Dr. Jones" used
 * to yield the "first name" `dr.`, which matched every email containing
 * "Dr." — so every client with two Dr-titled therapists was flagged.
 */
const NAME_HONORIFICS = new Set([
  'dr', 'doctor', 'mr', 'mrs', 'ms', 'miss', 'mx', 'prof', 'professor', 'rev', 'sir', 'dame',
]);

/**
 * Shortest name token we will match on its own. Two-letter first names
 * ("Al", "Jo") are too ambiguous as bare words to drive a blocking
 * decision; for those only the full name is matched.
 */
const MIN_NAME_TOKEN_LENGTH = 3;

/** Lowercased name tokens with honorifics and surrounding punctuation removed. */
function therapistNameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return name
    .normalize('NFKC')
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((token) => token.length > 0 && !NAME_HONORIFICS.has(token));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word patterns for a therapist name: the full name (tokens separated
 * by whitespace) and, when long enough, the first name on its own.
 * Boundaries are Unicode-aware, so "Ann" no longer matches "planning" and
 * "Al" no longer matches "also".
 */
function therapistNamePatterns(
  name: string | null | undefined,
  options: { skipFirstName?: boolean } = {},
): RegExp[] {
  const tokens = therapistNameTokens(name);
  if (tokens.length === 0) return [];
  const wholeWord = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
  const patterns: RegExp[] = [];
  const full = tokens.map(escapeRegExp).join('\\s+');
  if (tokens.length > 1 || tokens[0].length >= MIN_NAME_TOKEN_LENGTH) {
    patterns.push(wholeWord(full));
  }
  if (!options.skipFirstName && tokens.length > 1 && tokens[0].length >= MIN_NAME_TOKEN_LENGTH) {
    patterns.push(wholeWord(escapeRegExp(tokens[0])));
  }
  return patterns;
}

function mentionsName(content: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(content));
}

/**
 * True when two appointments are with the same therapist: same therapist
 * id, handle or email (Therapist.email is unique), or an identical name
 * (the name heuristic cannot tell identically-named rows apart anyway).
 */
function isSameTherapist(a: AppointmentContext, b: AppointmentContext): boolean {
  if (a.therapistId && b.therapistId && a.therapistId === b.therapistId) return true;
  if (a.therapistHandle && b.therapistHandle && a.therapistHandle === b.therapistHandle) return true;
  if (
    a.therapistEmail &&
    b.therapistEmail &&
    a.therapistEmail.trim().toLowerCase() === b.therapistEmail.trim().toLowerCase()
  ) {
    return true;
  }
  const aName = therapistNameTokens(a.therapistName).join(' ');
  const bName = therapistNameTokens(b.therapistName).join(' ');
  return aName.length > 0 && aName === bName;
}

/**
 * Detect when email body/subject mentions a different therapist than the matched appointment
 * This catches cases where emails get matched to the wrong appointment due to fallback logic
 *
 * E4: candidates are the sender's OTHER active appointments with a
 * DIFFERENT therapist. Previously the same therapist appearing on two
 * active rows (a client rebooking while the earlier appointment is still
 * feedback_requested, admin-created parallel bookings) made "mentions
 * other" identical to "mentions matched", so every signed reply scored
 * severity high / manual_review, was blocked, and was abandoned after
 * three attempts. Names are matched as whole words, ignoring honorifics.
 */
function detectTherapistNameMismatch(
  email: EmailContext,
  matchedAppointment: AppointmentContext,
  allActiveAppointments: AppointmentContext[]
): DivergenceDetection {
  // Skip if we don't have the therapist name
  if (!matchedAppointment.therapistName) {
    return createNoDetection();
  }

  // Unique OTHER therapists from the sender's active appointments.
  const matchedFirstName = therapistNameTokens(matchedAppointment.therapistName)[0];
  const seenNames = new Set<string>();
  const otherTherapists: Array<{ name: string; patterns: RegExp[]; appointmentId: string }> = [];
  let firstNameShared = false;
  for (const apt of allActiveAppointments) {
    if (apt.id === matchedAppointment.id || !apt.therapistName) continue;
    if (isSameTherapist(apt, matchedAppointment)) continue;
    const tokens = therapistNameTokens(apt.therapistName);
    const key = tokens.join(' ');
    if (!key || seenNames.has(key)) continue;
    // A first name shared with the matched therapist ("Thanks Sarah")
    // says nothing about which Sarah — match full names only, both ways.
    const sharesFirstName = tokens[0] === matchedFirstName;
    firstNameShared = firstNameShared || sharesFirstName;
    const patterns = therapistNamePatterns(apt.therapistName, { skipFirstName: sharesFirstName });
    if (patterns.length === 0) continue;
    seenNames.add(key);
    otherTherapists.push({ name: apt.therapistName, patterns, appointmentId: apt.id });
  }

  if (otherTherapists.length === 0) {
    // No different therapist among the sender's active appointments —
    // no risk of cross-contamination.
    return createNoDetection();
  }

  const contentToSearch = `${email.subject} ${email.body}`;

  // Check if email mentions the matched therapist (expected behavior)
  const mentionsMatchedTherapist = mentionsName(
    contentToSearch,
    therapistNamePatterns(matchedAppointment.therapistName, { skipFirstName: firstNameShared }),
  );

  // Check if email mentions a DIFFERENT therapist from user's other appointments
  for (const otherTherapist of otherTherapists) {
    const mentionsOther = mentionsName(contentToSearch, otherTherapist.patterns);

    if (mentionsOther && !mentionsMatchedTherapist) {
      // Email mentions another therapist but NOT the matched therapist - critical mismatch
      return {
        detected: true,
        type: 'therapist_name_mismatch',
        severity: 'critical',
        confidence: 0.9,
        description: `Email mentions therapist "${otherTherapist.name}" but matched to appointment with "${matchedAppointment.therapistName}". Possible cross-contamination.`,
        suggestedAction: 'manual_review',
        relatedAppointmentIds: [matchedAppointment.id, otherTherapist.appointmentId],
      };
    }

    if (mentionsOther && mentionsMatchedTherapist) {
      // Email mentions BOTH therapists - could be confusion or forwarded content
      return {
        detected: true,
        type: 'therapist_name_mismatch',
        severity: 'high',
        confidence: 0.75,
        description: `Email mentions multiple therapists: "${otherTherapist.name}" and "${matchedAppointment.therapistName}". May need clarification.`,
        suggestedAction: 'manual_review',
        relatedAppointmentIds: [matchedAppointment.id, otherTherapist.appointmentId],
      };
    }
  }

  return createNoDetection();
}

/**
 * Create a "no detection" result
 */
function createNoDetection(): DivergenceDetection {
  return {
    detected: false,
    type: 'none',
    severity: 'low',
    confidence: 1,
    description: 'No thread divergence detected',
    suggestedAction: 'none',
  };
}

/**
 * Determine if divergence should block processing
 */
export function shouldBlockProcessing(divergence: DivergenceDetection): boolean {
  if (!divergence.detected) return false;

  // Block on critical severity or manual review suggestions
  return divergence.severity === 'critical' ||
         divergence.suggestedAction === 'manual_review';
}

/**
 * Get human-readable summary for admin handoff
 */
export function getDivergenceSummary(divergence: DivergenceDetection): string {
  if (!divergence.detected) return '';

  const parts = [
    `**Thread Divergence Detected**`,
    `Type: ${divergence.type.replace(/_/g, ' ')}`,
    `Severity: ${divergence.severity.toUpperCase()}`,
    `Confidence: ${Math.round(divergence.confidence * 100)}%`,
    `Issue: ${divergence.description}`,
  ];

  if (divergence.relatedAppointmentIds?.length) {
    parts.push(`Related appointments: ${divergence.relatedAppointmentIds.join(', ')}`);
  }

  if (divergence.suggestedAction !== 'none') {
    parts.push(`Suggested action: ${divergence.suggestedAction.replace(/_/g, ' ')}`);
  }

  return parts.join('\n');
}

/**
 * Merge context from divergent thread into main appointment
 */
export function createMergeNotes(
  divergence: DivergenceDetection,
  email: EmailContext
): string {
  return `
[THREAD DIVERGENCE - ${new Date().toISOString()}]
Type: ${divergence.type}
Original thread ID: ${email.threadId}
Description: ${divergence.description}
Action taken: Email content merged into main appointment thread
---
`.trim();
}

/**
 * Extract email addresses from CC header
 * Handles various formats: "Name <email>", "email", etc.
 */
export function parseEmailAddresses(headerValue: string): string[] {
  if (!headerValue) return [];

  const emails: string[] = [];
  // Bounded quantifiers keep this linear on long '@'-free input.
  const regex = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,253}\.[a-zA-Z]{2,63}/g;
  const matches = headerValue.match(regex);

  if (matches) {
    for (const match of matches) {
      const normalized = match.toLowerCase();
      if (!emails.includes(normalized)) {
        emails.push(normalized);
      }
    }
  }

  return emails;
}

/**
 * Log divergence for metrics/debugging
 */
export function logDivergence(
  divergence: DivergenceDetection,
  context: { appointmentId?: string; emailId?: string; traceId?: string }
): void {
  if (!divergence.detected) return;

  const logLevel = divergence.severity === 'critical' ? 'error' :
                   divergence.severity === 'high' ? 'warn' : 'info';

  const logData = {
    ...context,
    divergenceType: divergence.type,
    severity: divergence.severity,
    confidence: divergence.confidence,
    suggestedAction: divergence.suggestedAction,
    relatedAppointmentIds: divergence.relatedAppointmentIds,
  };

  if (logLevel === 'error') {
    logger.error(logData, `Thread divergence: ${divergence.description}`);
  } else if (logLevel === 'warn') {
    logger.warn(logData, `Thread divergence: ${divergence.description}`);
  } else {
    logger.info(logData, `Thread divergence: ${divergence.description}`);
  }
}

/**
 * FIX R3: Record divergence alert in database for admin notification
 * This ensures that when thread divergence blocks processing, an admin is notified.
 * Previously, divergent emails were silently ignored.
 */
export async function recordDivergenceAlert(
  appointmentId: string,
  divergence: DivergenceDetection
): Promise<void> {
  try {
    // Fetch appointment details for Slack notification
    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: { userName: true, therapistName: true },
    });

    await prisma.appointmentRequest.update({
      where: { id: appointmentId },
      data: {
        threadDivergedAt: new Date(),
        threadDivergenceDetails: JSON.stringify({
          type: divergence.type,
          severity: divergence.severity,
          description: divergence.description,
          suggestedAction: divergence.suggestedAction,
          relatedAppointmentIds: divergence.relatedAppointmentIds,
          confidence: divergence.confidence,
        }),
        threadDivergenceAcknowledged: false,
      },
      select: { id: true },
    });

    logger.info(
      { appointmentId, divergenceType: divergence.type, severity: divergence.severity },
      'FIX R3: Thread divergence alert recorded for admin notification'
    );

    // Send Slack notification for thread divergence
    if (appointment) {
      await slackNotificationService.notifyThreadDivergence({
        appointmentId,
        therapistName: appointment.therapistName,
        divergenceType: divergence.type,
        description: divergence.description,
      });
    }
  } catch (error) {
    // Don't fail the main operation if alert recording fails
    logger.error(
      { error, appointmentId, divergenceType: divergence.type },
      'Failed to record thread divergence alert'
    );
  }
}

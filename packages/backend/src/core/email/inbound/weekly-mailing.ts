/**
 * Reply-handling branch for the weekly promotional mailing.
 *
 * Weekly emails go out under the subject
 * "Book your therapy session with Spill". Replies typically have
 * "Re:" prepended (variations supported); direct replies without
 * the prefix also exist for some clients.
 *
 * Matched replies are routed to a `WeeklyMailingInquiry` row + the
 * inquiry-handler agent (via the AgentProcessor DI) rather than the
 * normal appointment-matching path — there's no booking yet, just an
 * exploratory question.
 *
 * Returns true when the email is handled here (caller marks
 * processed and stops); false on agent-handler failure (caller
 * marks processed via the normal flow OR lets the retry budget catch
 * it).
 */

import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/database';
import { threadFetchingService } from '../../../services/thread-fetching.service';
import { extractNameFromEmail, type EmailMessage } from '../../../utils/email-mime-parser';
import { EMAIL } from '../../../constants';
import { getSettingValue } from '../../../services/settings.service';
import { getAgentProcessor } from './agent-processor';

/**
 * Strip leading reply/forward prefixes ("Re:", "Fwd:", "FW:"), possibly
 * stacked ("Re: Fwd: ..."), so the residual subject can be compared to the
 * subject we actually sent. Mirrors what mail clients prepend on reply.
 */
function stripReplyPrefixes(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(/^\s*(?:re|fwd|fw)\s*:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does this inbound look like a reply to the weekly promotional mailing?
 *
 * Derived from the SAME admin-editable subject the sender uses
 * (`email.weeklyMailingSubject`) so the two can't drift. A hardcoded phrase
 * here ("Book your therapy session with Spill") previously diverged from the
 * configured subject (default "Your weekly therapy update"), silently
 * breaking ALL reply handling — including reply-to-unsubscribe — whenever
 * the configured subject was anything other than that one literal.
 *
 * Matching (after stripping reply/forward prefixes, case-insensitive):
 *   - subject template has no `{var}`  → STRICT equality. Preserves the
 *     no-false-positive guarantee: "I want to <subject>" must NOT match.
 *   - subject template has a `{var}` (e.g. `{userName}`) → anchored pattern
 *     where each placeholder is a non-empty wildcard, so the recipient's
 *     name fills the gap but a mere substring still can't match.
 *
 * Reads a cached setting (settings-pubsub) — in-memory after first load. On a
 * settings-read failure we return false (let the email fall through to
 * appointment matching) rather than guess; the deterministic unsubscribe link
 * in every email is the safety net.
 */
export async function isWeeklyMailingReply(email: EmailMessage): Promise<boolean> {
  let configuredSubject: string;
  try {
    configuredSubject = await getSettingValue<string>('email.weeklyMailingSubject');
  } catch (err) {
    logger.warn(
      { err, subject: email.subject },
      'weekly-mailing: could not read subject setting for reply matching — not routing as a weekly reply',
    );
    return false;
  }

  const template = (configuredSubject ?? '').trim().toLowerCase();
  if (!template) return false;

  const core = stripReplyPrefixes(email.subject).toLowerCase();

  // No template variables → strict equality (the original bare-phrase contract).
  if (!/\{[^}]+\}/.test(template)) {
    return core === template;
  }

  // Template variables present → anchored match. Literal segments around each
  // `{placeholder}` must match exactly; placeholders become a non-empty
  // wildcard. Refuse a template that is only a placeholder (no literal text) —
  // its pattern would match every subject.
  const literalSegments = template.split(/\{[^}]+\}/).map(escapeRegExp);
  if (literalSegments.join('') === '') return false;
  const pattern = `^${literalSegments.join('.+?')}$`;
  try {
    return new RegExp(pattern).test(core);
  } catch {
    return false;
  }
}

export async function processWeeklyMailingReply(
  email: EmailMessage,
  messageId: string,
  traceId: string,
): Promise<boolean> {
  logger.info(
    { traceId, messageId, from: email.from, subject: email.subject },
    'Processing weekly mailing reply',
  );

  try {
    // Find or create the inquiry record. Match by threadId first, then
    // by sender email — covers the case where the inbound was assigned
    // a new threadId by Gmail.
    let inquiry = await prisma.weeklyMailingInquiry.findFirst({
      where: {
        OR: [
          { gmailThreadId: email.threadId },
          { userEmail: email.from.toLowerCase() },
        ],
        status: 'active',
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!inquiry) {
      inquiry = await prisma.weeklyMailingInquiry.create({
        data: {
          userEmail: email.from.toLowerCase(),
          userName: extractNameFromEmail(email.from),
          gmailThreadId: email.threadId,
          status: 'active',
        },
      });
      logger.info(
        { traceId, inquiryId: inquiry.id, userEmail: inquiry.userEmail },
        'Created new weekly mailing inquiry',
      );
    } else if (!inquiry.gmailThreadId && email.threadId) {
      // Update thread ID if not set
      await prisma.weeklyMailingInquiry.update({
        where: { id: inquiry.id },
        data: { gmailThreadId: email.threadId },
      });
    }

    if (inquiry.humanControlEnabled) {
      logger.info(
        { traceId, inquiryId: inquiry.id },
        'Human control enabled for inquiry - skipping agent processing',
      );
      return true; // Still mark as handled
    }

    let threadContext: string | undefined;
    if (email.threadId) {
      try {
        const thread = await threadFetchingService.fetchThreadById(email.threadId, traceId);
        if (thread && thread.messages.length > 0) {
          threadContext = threadFetchingService.formatThreadForAgent(
            thread,
            inquiry.userEmail,
            EMAIL.FROM_ADDRESS, // Agent's email
          );
        }
      } catch (threadError) {
        logger.warn(
          { traceId, threadId: email.threadId, error: threadError },
          'Failed to fetch thread for weekly mailing inquiry',
        );
      }
    }

    const agentProcessor = getAgentProcessor(traceId);
    await agentProcessor.processInquiryReply(
      inquiry.id,
      email.body,
      email.from,
      threadContext,
    );

    return true;
  } catch (error) {
    logger.error(
      { error, traceId, messageId, from: email.from },
      'Failed to process weekly mailing reply',
    );
    // Return false to allow retry
    return false;
  }
}

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
import { getAgentProcessor } from './agent-processor';

// "Re:"-prefixed patterns are matched via `includes()` so common
// variants ("Re: Re: Book ...", auto-prepended forwards, etc.) all
// route to the inquiry handler.
const WEEKLY_REPLY_PREFIX_PATTERNS = [
  're: book your therapy session with spill',
  're:book your therapy session with spill',
] as const;

// The bare phrase (some clients strip the "Re:" prefix on reply)
// requires STRICT equality. Without this constraint, a subject like
// "I want to book your therapy session with Spill" would misroute
// to the weekly-mailing inquiry handler — that's a real false-
// positive risk because clients sometimes write the phrase verbatim
// when starting a fresh booking conversation rather than replying.
const WEEKLY_REPLY_EXACT_PATTERN = 'book your therapy session with spill';

export function isWeeklyMailingReply(email: EmailMessage): boolean {
  const subjectLower = email.subject.toLowerCase().trim();
  if (subjectLower === WEEKLY_REPLY_EXACT_PATTERN) return true;
  return WEEKLY_REPLY_PREFIX_PATTERNS.some((p) => subjectLower.includes(p));
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

/**
 * Route an inbound email matched to a TherapistConversation row to
 * the appropriate downstream behaviour, based on the conversation's
 * lifecycle status.
 *
 * Returns true when the email is fully handled (caller should mark
 * processed and stop); false when the caller should fall through to
 * the next dispatch branch.
 *
 * Status semantics:
 *   - `active`: hand to availabilityAgent.processReply for the usual
 *     tool loop.
 *   - `superseded`: a booking has taken priority. If the one-shot
 *     ack hasn't been sent yet, fire it now (and only now); after
 *     that, every reply is captured silently.
 *   - `completed` / `abandoned`: silent — the conversation has
 *     reached its terminal lifecycle stage. We still mark the
 *     message processed so it doesn't churn the unmatched-retry
 *     loop.
 *
 * All branches return true (the inbound has been accounted for one
 * way or another), so the caller short-circuits to markProcessed.
 */

import { logger } from '../../../utils/logger';
import { markMessageProcessed } from '../../../core/messaging/message-dedup';
import { extendTraceContext } from '../../../utils/request-tracing';
import { threadFetchingService } from '../../../services/thread-fetching.service';
import { AvailabilityAgentService } from '../../../domain/scheduling/availability/agent/service';
import type { TherapistConversationMatch } from '../../../utils/thread-matcher';
import type { EmailMessage } from '../../../utils/email-mime-parser';

export async function routeToAvailabilityAgent(
  email: EmailMessage,
  convoMatch: TherapistConversationMatch,
  messageId: string,
  traceId: string,
): Promise<boolean> {
  extendTraceContext({ therapistConversationId: convoMatch.id });
  logger.info(
    {
      traceId,
      messageId,
      conversationId: convoMatch.id,
      therapistId: convoMatch.therapistId,
      status: convoMatch.status,
    },
    'Routing inbound to availability-collection agent',
  );

  const agent = new AvailabilityAgentService(traceId);

  if (convoMatch.status === 'active') {
    // Fetch the complete Gmail thread history so the availability
    // agent's processReply sees the full back-and-forth, not just
    // the latest inbound. Mirrors the booking-side pattern in
    // `process.ts`. For the availability agent the only counterparty
    // is the therapist, so we pass an empty userEmail to the
    // formatter — any other sender will surface as "Unknown" which
    // is the right visible signal if someone unexpected joined the
    // thread.
    let threadContext: string | undefined;
    if (email.threadId) {
      try {
        const thread = await threadFetchingService.fetchThreadById(email.threadId, traceId);
        if (thread && thread.messages.length > 0) {
          threadContext = threadFetchingService.formatThreadForAgent(
            thread,
            '', // no client counterpart on availability conversations
            convoMatch.therapistEmail,
          );
        }
      } catch (threadErr) {
        // Don't fail the route — process with the single inbound if
        // thread fetch fails. Same fallback as the booking dispatcher.
        logger.warn(
          { traceId, messageId, threadId: email.threadId, err: threadErr },
          'availability-agent: failed to fetch thread history — processing with single email only',
        );
      }
    }

    try {
      await agent.processReply({
        conversationId: convoMatch.id,
        emailContent: email.body,
        fromEmail: email.from,
        threadContext,
      });
      await markMessageProcessed(messageId, 'availability-agent-active');
      return true;
    } catch (err) {
      logger.error(
        { traceId, messageId, conversationId: convoMatch.id, err },
        'availability-agent processReply threw — leaving for retry',
      );
      return false;
    }
  }

  if (convoMatch.status === 'superseded') {
    if (!convoMatch.supersededAckSent) {
      const result = await agent.sendSupersessionAck(convoMatch.id);
      logger.info(
        {
          traceId,
          messageId,
          conversationId: convoMatch.id,
          alreadySent: result.alreadySent,
          emailSent: result.emailSent,
        },
        'availability-agent supersession ack outcome',
      );
    } else {
      logger.info(
        { traceId, messageId, conversationId: convoMatch.id },
        'availability-agent: reply on superseded thread ignored — ack already sent',
      );
    }
    await markMessageProcessed(messageId, 'availability-agent-superseded');
    return true;
  }

  // completed / abandoned — silent, but still mark processed so we
  // don't churn the unmatched-retry loop on stale terminal rows.
  await markMessageProcessed(
    messageId,
    convoMatch.status === 'completed'
      ? 'availability-agent-completed'
      : 'availability-agent-abandoned',
  );
  return true;
}

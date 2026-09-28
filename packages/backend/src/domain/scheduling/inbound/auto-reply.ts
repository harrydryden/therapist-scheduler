/**
 * Deterministic auto-reply gate for inbound mail.
 *
 * Out-of-office and other autoresponder mail used to get a full agent turn
 * (a paid Claude call) guarded only by a prompt hint. The invitation-reply
 * path already refuses RFC 3834 auto-submitted mail before calling Claude
 * (`invitation-reply.service.ts`); this applies the same rule to every
 * agent path in `process.ts`: the message is logged, marked processed as
 * `auto-reply`, and never reaches an agent.
 *
 * Only strong signals count — a human reply that merely mentions being
 * "on holiday" must still reach the agent:
 *   - an `Auto-Submitted` header with any value other than `no`
 *     (RFC 3834; Gmail's vacation responder and Exchange both set it), or
 *   - a subject that STARTS with an autoresponder prefix
 *     ("Automatic reply:", "Auto-Reply:", "Out of Office:" …), which is
 *     how Outlook/Exchange label OOO replies.
 */

import type { EmailMessage } from '../../../utils/email-mime-parser';

// Anchored, no nested quantifiers — linear on hostile subjects.
const AUTO_REPLY_SUBJECT =
  /^\s{0,10}(?:automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|out of (?:the )?office(?: reply)?)\s{0,10}:/i;

export type AutoReplySignal = 'auto-submitted-header' | 'auto-reply-subject';

export function detectAutoReply(email: Pick<EmailMessage, 'autoSubmitted' | 'subject'>): AutoReplySignal | null {
  const header = email.autoSubmitted?.trim().toLowerCase();
  if (header && header !== 'no') return 'auto-submitted-header';
  if (AUTO_REPLY_SUBJECT.test(email.subject ?? '')) return 'auto-reply-subject';
  return null;
}

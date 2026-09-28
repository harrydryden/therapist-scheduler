/**
 * Outbound Gmail send via the Gmail API.
 *
 * Maintains Gmail threading by passing `threadId` from the previous
 * messages in the same conversation. Gmail uses `threadId` to group
 * messages — without it each email would start a new thread, breaking
 * the scheduling conversation flow.
 *
 * If `replyTo` isn't supplied but `threadId` is, looks up the last
 * Message-ID from the thread and uses it for the In-Reply-To +
 * References headers. RFC-compliant threading is what some clients
 * use to nest the reply correctly even when Gmail's own threading
 * UI is bypassed.
 */

import { logger } from '../../../utils/logger';
import { emailOAuthService, executeGmailWithProtection } from '../../../services/email-oauth.service';
import { encodeEmailHeader } from '../../../utils/email-encoding';
import { convertPlainTextToHtml } from '../../../utils/email-html-body';

export async function sendEmail(params: {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  threadId?: string;
}): Promise<{ messageId: string; threadId: string }> {
  const gmail = await emailOAuthService.ensureGmailClient();

  // Header-injection guard. The raw RFC 2822 message below is assembled by
  // string concatenation, so a recipient containing CR/LF (or a comma-
  // separated list) could smuggle extra headers or recipients. Recipients
  // come from our own records, but several callers derive them from
  // model output or inbound mail, so refuse rather than trust.
  assertSingleAddressHeader('to', params.to);
  if (params.replyTo) assertSingleAddressHeader('replyTo', params.replyTo);

  // Encode subject if it contains non-ASCII characters (RFC 2047).
  const encodedSubject = encodeEmailHeader(params.subject);

  // Convert plain text body to simple HTML for proper text reflow on
  // mobile. This prevents awkward mid-sentence line breaks on narrow
  // screens.
  const htmlBody = convertPlainTextToHtml(params.body);

  // Determine In-Reply-To / References headers. If `replyTo` is
  // provided, use it directly. If `threadId` is provided but no
  // `replyTo`, fetch the last message ID from the thread.
  let inReplyTo = params.replyTo;
  if (!inReplyTo && params.threadId && gmail) {
    try {
      const threadResponse = await gmail.users.threads.get({
        userId: 'me',
        id: params.threadId,
        format: 'metadata',
        metadataHeaders: ['Message-ID'],
      });
      const messages = threadResponse.data.messages || [];
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        const headers = lastMessage.payload?.headers || [];
        const messageIdHeader = headers.find(
          (h) => h.name?.toLowerCase() === 'message-id',
        );
        if (messageIdHeader?.value) {
          inReplyTo = messageIdHeader.value;
          logger.debug(
            { threadId: params.threadId, inReplyTo },
            'Fetched In-Reply-To from thread for email threading',
          );
        }
      }
    } catch (err) {
      // Non-fatal: email will still be sent, just without optimal threading.
      logger.warn(
        { threadId: params.threadId, err },
        'Failed to fetch last message ID for In-Reply-To header',
      );
    }
  }

  // Build the email message with proper headers (using HTML for
  // proper mobile rendering).
  const emailLines = [
    `To: ${params.to}`,
    `Subject: ${encodedSubject}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    'MIME-Version: 1.0',
  ];

  if (inReplyTo) {
    emailLines.push(`In-Reply-To: ${inReplyTo}`);
    emailLines.push(`References: ${inReplyTo}`);
  }

  emailLines.push('', htmlBody);

  const rawMessage = emailLines.join('\r\n');
  const encodedMessage = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Build the request body, including threadId if provided to maintain
  // conversation. CRITICAL: without it, Gmail starts a new thread.
  const requestBody: { raw: string; threadId?: string } = {
    raw: encodedMessage,
  };

  if (params.threadId) {
    requestBody.threadId = params.threadId;
    logger.info(
      { to: params.to, existingThreadId: params.threadId },
      'Sending email with existing threadId to maintain conversation',
    );
  }

  const response = await executeGmailWithProtection(
    'send-email',
    () => gmail.users.messages.send({
      userId: 'me',
      requestBody,
    }),
  );

  // Fetch the sent message to get threadId for conversation tracking
  // (in case a new thread was created).
  let threadId = params.threadId || '';
  if (response.data.id) {
    try {
      const sentMessage = await gmail.users.messages.get({
        userId: 'me',
        id: response.data.id,
        format: 'minimal',
      });
      threadId = sentMessage.data.threadId || threadId;
    } catch (err) {
      logger.warn({ err, messageId: response.data.id }, 'Failed to fetch threadId for sent message');
    }
  }

  logger.info(
    { to: params.to, subject: params.subject, messageId: response.data.id, threadId, providedThreadId: params.threadId },
    'Email sent via Gmail',
  );

  return { messageId: response.data.id || '', threadId };
}

/**
 * Reject header values that could break out of a single address header.
 * Allows exactly one bare address or one `Name <addr>` form; rejects
 * control characters (CR/LF/NUL) and comma/semicolon-separated lists.
 */
function assertSingleAddressHeader(field: 'to' | 'replyTo', value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`sendEmail: ${field} must be a non-empty string`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00]/.test(value)) {
    throw new Error(`sendEmail: ${field} contains control characters`);
  }
  if (field === 'to' && /[,;]/.test(value)) {
    throw new Error('sendEmail: to must be a single recipient');
  }
}

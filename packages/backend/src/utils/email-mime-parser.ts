/**
 * Email MIME parsing utilities
 *
 * Pure helpers for extracting fields and bodies from Gmail API messages.
 * Extracted from email-message-processor.service.ts (where they duplicated
 * the implementations in thread-fetching.service.ts). Both services now
 * import from here so the logic lives in one place.
 */

import { gmail_v1 } from 'googleapis';
import { logger } from './logger';
import { decodeHtmlEntities, stripHtml } from './email-encoding';

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
  /**
   * Value of the RFC 3834 `Auto-Submitted` header when present (lowercased).
   * Out-of-office, mailer-daemon, and vacation responders set this to a
   * non-`no` value so receivers can avoid mail loops. Auto-replying
   * services (e.g. invitation-reply) MUST skip messages where this is
   * anything other than `no` or absent.
   */
  autoSubmitted?: string;
}

/**
 * Extract an email address from a "Name <email>" formatted header value.
 * Returns the raw value if the header isn't in angle-bracket form.
 */
export function extractEmail(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/);
  return match ? match[1] : headerValue.trim();
}

/**
 * Extract all email addresses from a header value (e.g. a CC list with
 * multiple recipients). Deduplicates and lowercases results.
 */
export function extractAllEmails(headerValue: string): string[] {
  if (!headerValue) return [];

  const emails: string[] = [];
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
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
 * Extract charset from a Content-Type header / MIME type string.
 * Returns a Node.js BufferEncoding, defaulting to utf-8.
 */
export function extractCharset(contentType: string): BufferEncoding {
  const match = contentType.match(/charset=["']?([^"';\s]+)/i);
  const charset = match ? match[1].toLowerCase() : 'utf-8';

  // Map common charset names to Node.js BufferEncoding
  const charsetMap: Record<string, BufferEncoding> = {
    'utf-8': 'utf-8',
    'utf8': 'utf-8',
    'iso-8859-1': 'latin1',
    'iso_8859-1': 'latin1',
    'latin1': 'latin1',
    'windows-1252': 'latin1', // Close enough for most cases
    'ascii': 'ascii',
    'us-ascii': 'ascii',
  };

  return charsetMap[charset] || 'utf-8';
}

/**
 * Decode a base64 email body with charset handling.
 *
 * IMPORTANT: Gmail returns body data in URL-safe Base64 format:
 *   - '-' instead of '+'
 *   - '_' instead of '/'
 *   - padding '=' may be omitted
 *
 * Node.js Buffer.from('base64') handles URL-safe Base64 since v15.14.0,
 * but we convert explicitly for maximum compatibility.
 */
export function decodeEmailBody(base64Data: string, contentType: string): string {
  const charset = extractCharset(contentType);
  try {
    const standardBase64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');
    const paddedBase64 =
      standardBase64 + '='.repeat((4 - (standardBase64.length % 4)) % 4);
    return Buffer.from(paddedBase64, 'base64').toString(charset);
  } catch {
    // Fall back to UTF-8 if charset decoding fails
    logger.debug({ contentType, charset }, 'Charset decoding failed, falling back to UTF-8');
    try {
      const standardBase64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');
      const paddedBase64 =
        standardBase64 + '='.repeat((4 - (standardBase64.length % 4)) % 4);
      return Buffer.from(paddedBase64, 'base64').toString('utf-8');
    } catch {
      // Last resort: try direct decoding
      return Buffer.from(base64Data, 'base64').toString('utf-8');
    }
  }
}

/**
 * Derive a display name from a From header. Prefers "Display Name <email>"
 * form, else converts the local-part of the email into Title Case.
 */
export function extractNameFromEmail(emailHeader: string): string | undefined {
  const match = emailHeader.match(/^([^<]+)\s*<[^>]+>$/);
  if (match) {
    return match[1].trim().replace(/^["']|["']$/g, '');
  }
  const emailMatch = emailHeader.match(/([^@]+)@/);
  if (emailMatch) {
    return emailMatch[1]
      .replace(/[._]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return undefined;
}

/**
 * Parse a Gmail API message into a normalized EmailMessage shape.
 * Returns null if the message is missing required fields or has no sender.
 */
export function parseEmailMessage(
  message: gmail_v1.Schema$Message
): EmailMessage | null {
  // Validate required fields exist
  if (!message || !message.id || !message.threadId) {
    logger.warn({ messageId: message?.id }, 'Message missing id or threadId');
    return null;
  }

  if (!message.payload) {
    logger.warn({ messageId: message.id }, 'Message has no payload');
    return null;
  }

  const headers = message.payload.headers || [];
  const getHeader = (name: string): string =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

  const from = extractEmail(getHeader('from'));
  const to = extractEmail(getHeader('to'));
  const ccHeader = getHeader('cc');
  const cc = ccHeader ? extractAllEmails(ccHeader) : undefined;
  const subject = getHeader('subject');
  const inReplyTo = getHeader('in-reply-to');
  const references = getHeader('references')?.split(/\s+/).filter(Boolean);
  const autoSubmittedRaw = getHeader('auto-submitted').trim().toLowerCase();
  const autoSubmitted = autoSubmittedRaw || undefined;

  // Parse date safely
  let date: Date;
  try {
    const dateHeader = getHeader('date');
    const dateValue = dateHeader || message.internalDate;
    date = dateValue ? new Date(dateValue) : new Date();
    if (isNaN(date.getTime())) {
      date = new Date();
    }
  } catch {
    date = new Date();
  }

  // Extract body — prefer plain text, fall back to HTML.
  // Handle charset detection for non-UTF-8 emails.
  let body = '';
  try {
    if (message.payload.body?.data) {
      // Simple message with body directly in payload
      const mimeType = message.payload.mimeType || '';
      const rawBody = decodeEmailBody(message.payload.body.data, mimeType);
      if (mimeType.includes('text/html')) {
        body = stripHtml(rawBody);
      } else {
        body = decodeHtmlEntities(rawBody);
      }
    } else if (message.payload.parts) {
      // Multipart message — try plain text first
      const textPart = message.payload.parts.find((p) => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        const contentType = textPart.mimeType || 'text/plain; charset=utf-8';
        const rawBody = decodeEmailBody(textPart.body.data, contentType);
        body = decodeHtmlEntities(rawBody);
      } else {
        // Fall back to HTML if no plain text available
        const htmlPart = message.payload.parts.find((p) => p.mimeType === 'text/html');
        if (htmlPart?.body?.data) {
          const contentType = htmlPart.mimeType || 'text/html; charset=utf-8';
          const rawBody = decodeEmailBody(htmlPart.body.data, contentType);
          body = stripHtml(rawBody);
          logger.debug(
            { messageId: message.id },
            'Extracted body from HTML part (no plain text available)'
          );
        }
      }
    }
  } catch (err) {
    logger.warn({ messageId: message.id, err }, 'Failed to decode email body');
    body = '';
  }

  if (!from) {
    logger.warn({ messageId: message.id }, 'Message has no from address');
    return null;
  }

  return {
    id: message.id,
    threadId: message.threadId,
    from,
    to,
    cc,
    subject,
    body,
    date,
    inReplyTo,
    references,
    autoSubmitted,
  };
}

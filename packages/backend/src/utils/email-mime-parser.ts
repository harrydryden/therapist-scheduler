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
  /**
   * True when the message is an RFC 3464 delivery-status notification:
   * a `multipart/report; report-type=delivery-status` container, or any
   * part of type `message/delivery-status`. Structural DSN signal used by
   * bounce detection — unlike the subject line, ordinary correspondents
   * don't produce it.
   */
  isDeliveryStatusReport?: boolean;
  /**
   * Decoded text of the `message/delivery-status` part (machine-readable
   * `Action:` / `Status:` fields), capped in size. Only present on DSNs.
   */
  deliveryStatus?: string;
}

/**
 * Remove RFC 5322 quoted-strings (`"..."`, honouring backslash escapes)
 * and parenthesised comments from an address header, leaving the
 * structural parts (angle-addrs, bare addr-specs, commas).
 */
function stripQuotedAndComments(headerValue: string): string {
  return headerValue
    .replace(/"(?:[^"\\]|\\.)*"?/g, ' ')
    .replace(/\((?:[^()\\]|\\.)*\)/g, ' ');
}

/**
 * Extract the (first) mailbox's address from an address header such as
 * `From`, returned trimmed and lowercased.
 *
 * SECURITY (S2): the display name is attacker-controlled and is not
 * covered by SPF/DKIM/DMARC — only the angle-addr is. The previous
 * implementation took the FIRST `<...>` in the raw header, so
 * `From: "Ann <client@corp.com>" <attacker@evil.com>` parsed as the
 * client, letting anyone inject messages into a client's conversation.
 * We now strip quoted display-name segments (and comments) first, split
 * off the first mailbox of a list (commas inside quotes no longer count),
 * and take the LAST `<...>` group within it — the real angle-addr always
 * comes after the display name.
 *
 * Returns the trimmed, lowercased raw value if no address form is found.
 */
export function extractEmail(headerValue: string): string {
  if (!headerValue) return '';
  const structural = stripQuotedAndComments(headerValue);

  // First mailbox of a list: split on commas that sit outside <...>.
  let depth = 0;
  let end = structural.length;
  for (let i = 0; i < structural.length; i++) {
    const ch = structural[i];
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      // Skip leading empty list elements (",, a@b.com").
      if (structural.slice(0, i).trim() === '') continue;
      end = i;
      break;
    }
  }
  const mailbox = structural.slice(0, end);

  const angleGroups = [...mailbox.matchAll(/<([^<>]*)>/g)];
  if (angleGroups.length > 0) {
    return angleGroups[angleGroups.length - 1][1].trim().toLowerCase();
  }
  // Bounded quantifiers keep this linear on long, '@'-free garbage.
  const bare = mailbox.match(/[^\s<>,;@]{1,64}@[^\s<>,;@]{1,255}/g);
  if (bare && bare.length > 0) {
    return bare[bare.length - 1].trim().toLowerCase();
  }
  return headerValue.trim().toLowerCase();
}

/**
 * Extract all email addresses from a header value (e.g. a CC list with
 * multiple recipients). Deduplicates and lowercases results.
 */
export function extractAllEmails(headerValue: string): string[] {
  if (!headerValue) return [];

  const emails: string[] = [];
  // Bounded quantifiers (RFC 5321 length limits) keep this linear on a
  // long sender-controlled header with no '@' — the unbounded version
  // backtracked quadratically.
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
 * Extract charset from a Content-Type header / MIME type string.
 * Returns a Node.js BufferEncoding, defaulting to utf-8.
 */
export function extractCharset(contentType: string): BufferEncoding {
  const charset = extractCharsetLabel(contentType);

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

/** Raw (lowercased) charset label from a Content-Type value; 'utf-8' if absent. */
function extractCharsetLabel(contentType: string): string {
  const match = contentType.match(/charset\s*=\s*["']?([^"';\s]+)/i);
  return match ? match[1].toLowerCase() : 'utf-8';
}

/** Decode Gmail's URL-safe, possibly unpadded Base64 into bytes. */
function decodeGmailBase64(base64Data: string): Buffer {
  const standardBase64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');
  const paddedBase64 = standardBase64 + '='.repeat((4 - (standardBase64.length % 4)) % 4);
  return Buffer.from(paddedBase64, 'base64');
}

/**
 * Decode a base64 email body with charset handling.
 *
 * `contentType` should be the part's full `Content-Type` header value
 * (e.g. `text/plain; charset="windows-1252"`) — Gmail's `mimeType` field
 * is the bare type and never carries the charset (see getPartContentType).
 *
 * IMPORTANT: Gmail returns body data in URL-safe Base64 format:
 *   - '-' instead of '+'
 *   - '_' instead of '/'
 *   - padding '=' may be omitted
 *
 * Non-UTF-8 charsets are decoded with WHATWG TextDecoder (full ICU in
 * Node), which handles windows-1252 smart quotes etc. correctly. Unknown
 * labels fall back to UTF-8.
 */
export function decodeEmailBody(base64Data: string, contentType: string): string {
  const bytes = decodeGmailBase64(base64Data);
  const label = extractCharsetLabel(contentType);
  if (label === 'utf-8' || label === 'utf8') {
    return bytes.toString('utf-8');
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // RangeError: unsupported charset label.
    logger.debug({ contentType, charset: label }, 'Unsupported charset, falling back to UTF-8');
    return bytes.toString('utf-8');
  }
}

type MessagePart = gmail_v1.Schema$MessagePart;

function getPartHeader(part: MessagePart, name: string): string {
  const lower = name.toLowerCase();
  return part.headers?.find((h) => h.name?.toLowerCase() === lower)?.value || '';
}

/**
 * The part's full Content-Type (including `charset=`). Gmail puts the bare
 * type in `mimeType` and the parameters only in the part's headers, so the
 * header is preferred; `mimeType` is the fallback.
 */
export function getPartContentType(part: MessagePart): string {
  return getPartHeader(part, 'content-type') || part.mimeType || '';
}

/** Bare, lowercased MIME type of a part (`text/plain`, `multipart/mixed`, ...). */
function getPartMimeType(part: MessagePart): string {
  const raw = part.mimeType || getPartHeader(part, 'content-type');
  return raw.split(';')[0].trim().toLowerCase();
}

/** Attachments (a filename, or Content-Disposition: attachment) are never the body. */
function isAttachmentPart(part: MessagePart): boolean {
  if (part.filename) return true;
  return /^\s*attachment\b/i.test(getPartHeader(part, 'content-disposition'));
}

/** Bounds on the MIME tree walk — real mail is a handful of levels deep. */
const MAX_MIME_DEPTH = 20;
const MAX_MIME_PARTS = 500;

/**
 * Depth-first, document-order walk of a Gmail part tree. Stops early when
 * `visit` returns true. Bounded in depth and part count so a hostile
 * message can't make us walk an enormous tree.
 */
function walkParts(root: MessagePart, visit: (part: MessagePart) => boolean | void): void {
  const stack: Array<{ part: MessagePart; depth: number }> = [{ part: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_MIME_PARTS) {
    const { part, depth } = stack.pop()!;
    visited++;
    if (visit(part) === true) return;
    if (part.parts && depth < MAX_MIME_DEPTH) {
      // Push in reverse so children are visited in document order.
      for (let i = part.parts.length - 1; i >= 0; i--) {
        stack.push({ part: part.parts[i], depth: depth + 1 });
      }
    }
  }
}

export interface ExtractedBody {
  body: string;
  /** Which kind of part the body came from ('none' when nothing was found). */
  source: 'text/plain' | 'text/html' | 'none';
}

/**
 * Extract the readable body from a Gmail message payload.
 *
 * Walks the WHOLE part tree (E3): replies with an attachment arrive as
 * `multipart/mixed` wrapping `multipart/alternative`, and signature logos
 * as `multipart/related` — the old top-level-only search returned '' for
 * both, so the agent saw an empty email. Prefers the first inline
 * `text/plain` part in document order, falling back to the first inline
 * `text/html` part (tags stripped). Attachment parts are skipped even if
 * they are text. Charset comes from each part's Content-Type header.
 *
 * Shared by parseEmailMessage and ThreadFetchingService so the inbound
 * message and the thread context always agree on what the body is.
 */
export function extractBodyFromPayload(
  payload: MessagePart | null | undefined,
): ExtractedBody {
  if (!payload) return { body: '', source: 'none' };

  // Single-part message: the body sits directly on the payload.
  if (payload.body?.data && !payload.parts?.length) {
    const contentType = getPartContentType(payload);
    const rawBody = decodeEmailBody(payload.body.data, contentType);
    if (getPartMimeType(payload).includes('text/html')) {
      return { body: stripHtml(rawBody), source: 'text/html' };
    }
    return { body: decodeHtmlEntities(rawBody), source: 'text/plain' };
  }

  let textPart: MessagePart | undefined;
  let htmlPart: MessagePart | undefined;
  walkParts(payload, (part) => {
    if (!part.body?.data || isAttachmentPart(part)) return false;
    const mimeType = getPartMimeType(part);
    if (mimeType === 'text/plain' && !textPart) {
      textPart = part;
      return true; // text/plain is preferred — nothing better to find.
    }
    if (mimeType === 'text/html' && !htmlPart) {
      htmlPart = part;
    }
    return false;
  });

  if (textPart?.body?.data) {
    const rawBody = decodeEmailBody(textPart.body.data, getPartContentType(textPart));
    return { body: decodeHtmlEntities(rawBody), source: 'text/plain' };
  }
  if (htmlPart?.body?.data) {
    const rawBody = decodeEmailBody(htmlPart.body.data, getPartContentType(htmlPart));
    return { body: stripHtml(rawBody), source: 'text/html' };
  }
  return { body: '', source: 'none' };
}

/** Upper bound on the delivery-status text we keep for bounce classification. */
const MAX_DELIVERY_STATUS_CHARS = 8 * 1024;

/**
 * Detect an RFC 3464 delivery-status notification from MIME structure.
 * Read receipts (`report-type=disposition-notification`) are NOT DSNs.
 */
export function extractDeliveryStatus(
  payload: MessagePart | null | undefined,
): { isDeliveryStatusReport: boolean; deliveryStatus?: string } {
  if (!payload) return { isDeliveryStatusReport: false };

  const rootMime = getPartMimeType(payload);
  const rootContentType = getPartContentType(payload);
  let isReport =
    rootMime === 'multipart/report' && /report-type\s*=\s*"?delivery-status/i.test(rootContentType);
  let deliveryStatus: string | undefined;

  walkParts(payload, (part) => {
    const mimeType = getPartMimeType(part);
    if (mimeType === 'message/delivery-status' || mimeType === 'message/global-delivery-status') {
      isReport = true;
      if (part.body?.data) {
        try {
          deliveryStatus = decodeEmailBody(part.body.data, getPartContentType(part)).slice(
            0,
            MAX_DELIVERY_STATUS_CHARS,
          );
        } catch {
          // Classification falls back to the human-readable body.
        }
      }
      return true;
    }
    return false;
  });

  return deliveryStatus !== undefined
    ? { isDeliveryStatusReport: isReport, deliveryStatus }
    : { isDeliveryStatusReport: isReport };
}

/**
 * Parse Gmail's `internalDate` (epoch milliseconds as a numeric STRING,
 * e.g. "1695897600000") into epoch ms. `new Date("1695897600000")` is an
 * Invalid Date, so the string must go through Number() first. Returns
 * null when missing or unparseable.
 */
export function parseGmailInternalDate(internalDate: string | number | null | undefined): number | null {
  if (internalDate === null || internalDate === undefined || internalDate === '') return null;
  const ms = Number(internalDate);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Message date: the `Date` header when it parses, else Gmail's
 * `internalDate`, else now.
 */
export function resolveMessageDate(
  dateHeader: string,
  internalDate: string | null | undefined,
): Date {
  if (dateHeader) {
    const fromHeader = new Date(dateHeader);
    if (!isNaN(fromHeader.getTime())) return fromHeader;
  }
  const internalMs = parseGmailInternalDate(internalDate);
  if (internalMs !== null) return new Date(internalMs);
  return new Date();
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

  // Date header, falling back to Gmail's internalDate (epoch-ms string).
  const date = resolveMessageDate(getHeader('date'), message.internalDate);

  // Extract body — walks the full MIME tree, prefers plain text, falls
  // back to HTML, and decodes each part with its own charset.
  let body = '';
  try {
    const extracted = extractBodyFromPayload(message.payload);
    body = extracted.body;
    if (extracted.source === 'text/html') {
      logger.debug(
        { messageId: message.id },
        'Extracted body from HTML part (no plain text available)'
      );
    } else if (extracted.source === 'none' && message.payload.parts?.length) {
      // Flag rather than silently hand the agent an empty email.
      logger.warn(
        { messageId: message.id, mimeType: message.payload.mimeType },
        'Multipart message has no inline text/plain or text/html part — body is empty'
      );
    }
  } catch (err) {
    logger.warn({ messageId: message.id, err }, 'Failed to decode email body');
    body = '';
  }

  const { isDeliveryStatusReport, deliveryStatus } = extractDeliveryStatus(message.payload);

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
    ...(isDeliveryStatusReport ? { isDeliveryStatusReport, deliveryStatus } : {}),
  };
}

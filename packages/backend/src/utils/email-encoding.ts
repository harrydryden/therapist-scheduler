/**
 * Shared email encoding/decoding utilities
 * Used by both core/email/outbound/send.ts and thread-fetching.service.ts
 */

/**
 * Decode common HTML entities to their character equivalents
 *
 * IMPORTANT: Order matters - specific entities first, then numeric
 * This prevents double-decoding of escaped numeric entities like &amp;#123;
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&ndash;/g, '\u2013')  // en-dash
    .replace(/&mdash;/g, '\u2014')  // em-dash
    .replace(/&hellip;/g, '\u2026') // horizontal ellipsis
    .replace(/&lsquo;/g, '\u2018')  // left single quote
    .replace(/&rsquo;/g, '\u2019')  // right single quote
    .replace(/&ldquo;/g, '\u201C')  // left double quote
    .replace(/&rdquo;/g, '\u201D')  // right double quote
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Maximum number of HTML characters `stripHtml` will process. Anything
 * beyond this is truncated (with a visible marker) before stripping.
 *
 * Inbound HTML is sender-controlled and is stripped on every poll, every
 * unmatched retry and every thread fetch, so the cost has to be bounded
 * even though the scanners below are linear. 300K chars comfortably holds
 * a long reply with a quoted HTML history (Gmail itself clips the display
 * of messages at ~102KB); the part that matters to the agent — the newest
 * reply — is at the top and survives truncation.
 */
export const MAX_STRIP_HTML_INPUT_CHARS = 300 * 1024;

/** Appended to the stripped text when the HTML input was truncated. */
export const HTML_TRUNCATION_MARKER = '[... HTML body truncated for processing ...]';

/**
 * Remove every `<tag ...>...</tag>` block (script/style) in a single
 * forward pass.
 *
 * Replaces `/<script[^>]*>[\s\S]*?<\/script>/gi`, which is quadratic on
 * unclosed tags: every `<script` without a matching close re-scanned the
 * whole remainder of the document (64KB → ~100ms, 128KB → ~400ms, 2MB →
 * minutes on the event loop). Here each character is scanned at most once:
 * the search position only ever moves forward, and once a block has no
 * closing tag we stop (no later block can have one either). An unclosed
 * block swallows the rest of the document, matching how browsers parse
 * raw-text elements — in raw HTML a literal `<script` is always a tag.
 */
function removeRawTextBlocks(html: string, tagName: 'script' | 'style'): string {
  const openRe = new RegExp(`<${tagName}\\b`, 'gi');
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    openRe.lastIndex = pos;
    const open = openRe.exec(html);
    if (!open) {
      out.push(html.slice(pos));
      break;
    }
    out.push(html.slice(pos, open.index));
    closeRe.lastIndex = open.index + open[0].length;
    const close = closeRe.exec(html);
    if (!close) {
      // Unclosed block: drop everything after the opening tag.
      break;
    }
    pos = close.index + close[0].length;
  }
  return out.join('');
}

/**
 * Remove all remaining `<...>` tags in a single forward pass.
 *
 * Equivalent to `.replace(/<[^>]+>/g, '')` — a `<` starts a tag that runs
 * to the next `>` provided at least one character sits between them — but
 * linear. The regex is quadratic when there is no closing `>`: each `<`
 * re-scans the remainder of the string (128KB of `<a` took ~4s).
 */
function removeTags(html: string): string {
  const out: string[] = [];
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) break;
    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) break; // No more tags can close — the rest is text.
    if (gt === lt + 1) {
      // "<>" is not a tag; keep the '<' and continue after it.
      out.push(html.slice(pos, lt + 1));
      pos = lt + 1;
      continue;
    }
    out.push(html.slice(pos, lt));
    pos = gt + 1;
  }
  out.push(html.slice(pos));
  return out.join('');
}

/**
 * Strip HTML tags from content and convert to plain text
 * Preserves paragraph structure by converting block elements to newlines
 *
 * Input is capped at MAX_STRIP_HTML_INPUT_CHARS and every step is linear,
 * so a hostile or malformed body cannot stall the event loop.
 */
export function stripHtml(html: string): string {
  let input = html;
  let truncated = false;
  if (input.length > MAX_STRIP_HTML_INPUT_CHARS) {
    input = input.slice(0, MAX_STRIP_HTML_INPUT_CHARS);
    // Don't leave half a tag at the cut point.
    const lastLt = input.lastIndexOf('<');
    if (lastLt > input.lastIndexOf('>')) {
      input = input.slice(0, lastLt);
    }
    truncated = true;
  }

  // Remove script and style blocks entirely
  const withoutBlocks = removeRawTextBlocks(removeRawTextBlocks(input, 'script'), 'style');

  const withBreaks = withoutBlocks
    // Convert block elements to newlines for structure
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n');

  const stripped = removeTags(withBreaks)
    // Normalize whitespace (preserve intentional line breaks)
    .replace(/[ \t]+/g, ' ')           // Collapse horizontal whitespace
    .replace(/ *\n */g, '\n')          // Trim spaces around newlines
    .replace(/\n{3,}/g, '\n\n')        // Collapse excessive newlines
    .trim();

  const text = decodeHtmlEntities(stripped);
  return truncated ? `${text}\n\n${HTML_TRUNCATION_MARKER}` : text;
}

/**
 * Encode email header value for non-ASCII characters using RFC 2047 (MIME encoded-word)
 * Uses Base64 encoding (B) which is more reliable than quoted-printable (Q)
 */
export function encodeEmailHeader(value: string): string {
  // Check if the value contains any non-ASCII characters
  if (!/[^\x20-\x7E]/.test(value)) {
    return value; // ASCII-only, no encoding needed
  }
  // Use RFC 2047 Base64 encoding for non-ASCII
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

/**
 * Truncate very long text to prevent context overflow
 * Keeps first and last portions for context
 */
export function truncateText(text: string, maxLength: number = 3000): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Calculate how much space the indicator will take
  const removedChars = text.length - maxLength;
  const indicator = `\n\n[... TRUNCATED - ${removedChars} characters removed ...]\n\n`;

  // Guard: if indicator alone exceeds maxLength, return truncated indicator
  if (indicator.length >= maxLength) {
    return indicator.substring(0, maxLength);
  }

  // Account for indicator length when calculating available space
  const availableLength = maxLength - indicator.length;
  const halfLength = Math.floor(availableLength / 2);

  const start = text.substring(0, halfLength);
  const end = text.substring(text.length - halfLength);

  return `${start}${indicator}${end}`;
}

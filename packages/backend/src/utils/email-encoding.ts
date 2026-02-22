/**
 * Shared email encoding/decoding utilities
 * Used by both email-processing.service.ts and thread-fetching.service.ts
 */

/**
 * Decode quoted-printable encoded text (RFC 2045)
 *
 * Quoted-printable encoding represents non-ASCII and special characters as =XX
 * where XX is the hexadecimal value. Soft line breaks are represented as =\r\n or =\n.
 *
 * This is important for email line break handling because:
 * - =0D represents CR (\r)
 * - =0A represents LF (\n)
 * - =3D represents the equals sign (=)
 * - Lines ending with = are soft breaks (continuation) and should be joined
 */
export function decodeQuotedPrintable(text: string): string {
  return text
    // First, join soft line breaks (lines ending with =)
    .replace(/=\r?\n/g, '')
    // Then decode =XX hex sequences
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

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
 * Strip HTML tags from content and convert to plain text
 * Preserves paragraph structure by converting block elements to newlines
 */
export function stripHtml(html: string): string {
  const stripped = html
    // Remove script and style blocks entirely
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Convert block elements to newlines for structure
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Normalize whitespace (preserve intentional line breaks)
    .replace(/[ \t]+/g, ' ')           // Collapse horizontal whitespace
    .replace(/ *\n */g, '\n')          // Trim spaces around newlines
    .replace(/\n{3,}/g, '\n\n')        // Collapse excessive newlines
    .trim();

  return decodeHtmlEntities(stripped);
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
 * Normalize line endings to CRLF as required by email RFC 5322
 */
export function normalizeLineEndings(text: string): string {
  return text
    .replace(/\r\n/g, '\n')  // First normalize all to LF
    .replace(/\r/g, '\n')    // Handle standalone CR
    .split('\n')
    .join('\r\n');           // Convert all to CRLF
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

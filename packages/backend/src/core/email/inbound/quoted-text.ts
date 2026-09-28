/**
 * Quoted-reply stripping for inbound email bodies (§4.3).
 *
 * Pure text utility shared by the thread-context builder
 * (services/thread-fetching.service.ts) and the inbound classifier call
 * (domain/scheduling/inbound/process.ts).
 */

// Cap per-line work in stripQuotedReply: a pathological single "line" of
// megabytes is kept verbatim rather than regex-scanned.
const MAX_ATTRIBUTION_LINE_LENGTH = 500;
const ATTRIBUTION_START = /^\s*On\s/;
const ATTRIBUTION_END = /\bwrote:\s*$/;
const ORIGINAL_MESSAGE_SEPARATOR = /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i;

/**
 * Remove quoted reply text from an email body, keeping only what the
 * sender actually wrote:
 *   - everything from a reply attribution line ("On Mon, 28 Sep 2026 at
 *     10:00, Jane <jane@x.com> wrote:" — also when the client wrapped it
 *     over two lines) or an Outlook "-----Original Message-----" separator
 *     onwards, and
 *   - every line that starts with `>` (quoted blocks, including inline
 *     quotes between the sender's answers).
 *
 * Quoted history is already present as its own message in the thread, so
 * keeping it made the thread context grow quadratically, and it made the
 * classifier react to OUR earlier wording ("cancel", "reschedule") rather
 * than the reply. If stripping would leave nothing (a pure forward, or a
 * reply written below the quote) the original text is returned.
 *
 * Linear: one pass over the lines, bounded regexes on short lines only.
 */
export function stripQuotedReply(text: string): string {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length <= MAX_ATTRIBUTION_LINE_LENGTH) {
      if (ORIGINAL_MESSAGE_SEPARATOR.test(line)) break;
      if (ATTRIBUTION_START.test(line)) {
        const next = lines[i + 1] ?? '';
        if (
          ATTRIBUTION_END.test(line) ||
          (next.length <= MAX_ATTRIBUTION_LINE_LENGTH && ATTRIBUTION_END.test(next))
        ) {
          break;
        }
      }
    }
    if (line.trimStart().startsWith('>')) continue;
    kept.push(line);
  }
  const stripped = kept.join('\n').trim();
  return stripped.length > 0 ? stripped : text;
}

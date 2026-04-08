/**
 * Plain-text → HTML email body formatter
 *
 * Extracted from email-message-processor.service.ts so sendEmail() stays
 * focused on Gmail API orchestration. Pure string manipulation — no I/O,
 * no dependencies on other services.
 */

/**
 * Detect if a paragraph looks like an email signature
 * (closing phrase followed by name on separate lines).
 * Used so signatures preserve line breaks even when templates use single
 * newlines instead of double newlines.
 */
function looksLikeSignature(lines: string[]): boolean {
  if (lines.length < 2 || lines.length > 3) return false;

  const closingPhrases = [
    'best wishes',
    'best',
    'thanks',
    'thank you',
    'regards',
    'cheers',
    'sincerely',
    'kind regards',
    'warm regards',
    'all the best',
    'many thanks',
    'with thanks',
  ];

  const firstLine = lines[0].toLowerCase().replace(/[,!]?\s*$/, '').trim();
  return closingPhrases.includes(firstLine);
}

/**
 * Convert a plain-text email body to simple HTML for proper mobile rendering.
 *
 * Prevents awkward mid-sentence line breaks on narrow screens by letting the
 * email client reflow text.
 *
 * - Escapes HTML special characters
 * - Converts paragraph breaks (\n\n) to <p> tags
 * - Converts list items (- or * prefixed) to <ul>/<li>
 * - Preserves line breaks in signatures (e.g. "Best wishes\nJustin")
 * - Joins other single line breaks with spaces for text reflow
 * - Supports limited markdown: [text](url) links and **bold**
 */
export function convertPlainTextToHtml(body: string): string {
  // Normalize line endings
  let text = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Extract markdown formatting before escaping HTML (preserve them as placeholders)
  const placeholders: { placeholder: string; html: string }[] = [];
  let placeholderIndex = 0;

  // Pattern: [link text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
    const placeholder = `__PLACEHOLDER_${placeholderIndex}__`;
    const escapedText = linkText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    placeholders.push({
      placeholder,
      html: `<a href="${url}" style="color: #0066cc; text-decoration: underline;">${escapedText}</a>`,
    });
    placeholderIndex++;
    return placeholder;
  });

  // Pattern: **bold text**
  text = text.replace(/\*\*([^*]+)\*\*/g, (_match, boldText) => {
    const placeholder = `__PLACEHOLDER_${placeholderIndex}__`;
    const escapedText = boldText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    placeholders.push({
      placeholder,
      html: `<strong>${escapedText}</strong>`,
    });
    placeholderIndex++;
    return placeholder;
  });

  // Escape HTML special characters
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Restore placeholders with actual HTML (links, bold, etc.)
  for (const { placeholder, html } of placeholders) {
    text = text.replace(placeholder, html);
  }

  // Split into paragraphs (double newlines)
  const paragraphs = text.split(/\n\n+/);

  const htmlParts: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Check if this paragraph is a list (lines starting with - or *)
    const lines = trimmed.split('\n');
    const isListParagraph = lines.every(
      (line) => /^\s*[-*•]\s/.test(line) || !line.trim()
    );

    if (isListParagraph && lines.some((l) => l.trim())) {
      // Convert to HTML list
      const listItems = lines
        .filter((line) => line.trim())
        .map((line) => {
          const content = line.replace(/^\s*[-*•]\s*/, '').trim();
          return `<li>${content}</li>`;
        })
        .join('');
      htmlParts.push(`<ul style="margin: 0 0 16px 0; padding-left: 20px;">${listItems}</ul>`);
    } else if (looksLikeSignature(lines)) {
      // Signature block - preserve line breaks with <br>
      const htmlLines = lines.map((l) => l.trim()).join('<br>');
      htmlParts.push(`<p style="margin: 0 0 16px 0;">${htmlLines}</p>`);
    } else {
      // Regular paragraph - join lines with spaces (remove single newlines within paragraph)
      const joined = lines.map((l) => l.trim()).join(' ');
      htmlParts.push(`<p style="margin: 0 0 16px 0;">${joined}</p>`);
    }
  }

  // Wrap in minimal HTML structure with responsive styling
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #333; margin: 0; padding: 0; }
p, ul { margin: 0 0 16px 0; }
p:last-child, ul:last-child { margin-bottom: 0; }
</style>
</head>
<body>
${htmlParts.join('\n')}
</body>
</html>`;
}

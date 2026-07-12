/**
 * Outbound email body normalization.
 *
 * Claude sometimes signs off with the full agent name ("Justin Time")
 * or puts the signature on the same line as the closing phrase
 * ("Best wishes Justin"). This module cleans both up to match the
 * platform's expected style, plus collapses excessive blank lines
 * and strips trailing whitespace.
 *
 * SIMPLIFIED: instead of complex paragraph-joining logic, we now
 * only:
 *   1. Normalize line endings
 *   2. Fix signature formatting (the main issue Claude gets wrong)
 *   3. Clean up excessive blank lines
 *
 * The system prompt instructs Claude on proper formatting. Any extra
 * line breaks Claude adds are cosmetic — email clients handle them
 * fine.
 */

/**
 * Shared outbound-email normalization for both agent loops (booking's
 * core/agent/tools/send.ts and the availability agent's
 * domain/scheduling/availability/agent/tool-executor.ts): the "Spill"
 * subject prefix plus normalizeEmailBody. Kept in one place so the two
 * agents' emails can't drift in formatting or brand-prefix policy.
 */
export function normalizeAgentOutboundEmail(
  subject: string,
  body: string,
  agentFirstName?: string,
): { subject: string; body: string } {
  const normalizedSubject = subject.toLowerCase().includes('spill') ? subject : `Spill - ${subject}`;
  const normalizedBody = normalizeEmailBody(body, agentFirstName);
  return { subject: normalizedSubject, body: normalizedBody };
}

export function normalizeEmailBody(body: string, agentFirstName?: string): string {
  let normalized = body
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  if (agentFirstName) {
    const escaped = agentFirstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Replace full agent name with first name only in sign-offs.
    // Handles "Justin Time" → "Justin" (or whatever the configured agent name is).
    const fullNamePattern = new RegExp(`${escaped}\\s+\\S+\\s*$`, 'gim');
    normalized = normalized.replace(fullNamePattern, agentFirstName);

    // Fix signature on same line: "Best wishes Justin" → "Best wishes\nJustin"
    const signaturePattern = new RegExp(
      `\\b(Best wishes|Best|Thanks|Regards|Cheers|Sincerely|Kind regards|Warm regards|All the best)[,]?\\s+(${escaped})\\s*$`,
      'gim',
    );
    normalized = normalized.replace(signaturePattern, '$1\n$2');
  }

  return normalized
    // Collapse excessive blank lines (3+ newlines → 2)
    .replace(/\n{3,}/g, '\n\n')
    // Clean up whitespace-only lines
    .replace(/\n[ \t]+\n/g, '\n\n')
    // Remove trailing whitespace from lines
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

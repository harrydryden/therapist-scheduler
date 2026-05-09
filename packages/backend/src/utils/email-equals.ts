/**
 * Email comparison helpers.
 *
 * Address comparison MUST be case-insensitive (RFC 5321 §2.4 — the local
 * part is technically case-sensitive but in practice every mail provider
 * compares case-insensitively, and our entire stack normalises addresses
 * to lowercase). Spreading raw `===` checks throughout the codebase is
 * how we ended up with mismatches between paths that lowercased one side
 * (e.g. bounce/freeze checks) and paths that didn't (e.g. agent inbound
 * sender classification), letting a mixed-case `From:` header bypass
 * sender-attribution.
 */

/**
 * Normalise an email for comparison or storage. Returns an empty string
 * for falsy input so callers can compare consistently without nullish
 * checks.
 */
export function normalizeEmail(email: string | null | undefined): string {
  return (email || '').toLowerCase().trim();
}

/**
 * Case-insensitive, whitespace-trimmed equality check for two email
 * addresses. Treats null/undefined on either side as a non-match.
 */
export function emailEquals(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return normalizeEmail(a) === normalizeEmail(b);
}

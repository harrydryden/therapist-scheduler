/**
 * First-name extractor for email salutations.
 *
 * Defined as the substring before the first whitespace character. Used
 * across every user-facing and therapist-facing email so we don't say
 * "Hi John Smith," — we say "Hi John,". Single source of truth so a
 * tweak (e.g. handling honorifics like "Dr. Smith" → "Dr." vs "Smith")
 * lands consistently.
 *
 * Returns the fallback when the input is null / undefined / blank /
 * whitespace-only. Default fallback `'there'` matches the existing
 * pattern used inline at several call sites (e.g. `userName || 'there'`).
 */
export function firstName(
  fullName: string | null | undefined,
  fallback = 'there',
): string {
  if (!fullName) return fallback;
  const trimmed = fullName.trim();
  if (!trimmed) return fallback;
  const beforeSpace = trimmed.split(/\s+/)[0];
  return beforeSpace || fallback;
}

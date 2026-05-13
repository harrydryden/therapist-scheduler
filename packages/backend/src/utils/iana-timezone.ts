/**
 * Validate that a string is a real IANA timezone identifier.
 *
 * `Intl.DateTimeFormat` throws when constructed with an unknown
 * timeZone, so we use that as the oracle. This is the same approach
 * `utils/timezone-resolver.ts` uses internally — extracted here as a
 * standalone helper for the agent tools that persist a user-supplied
 * (well, agent-supplied) timezone identifier.
 *
 * The Zod schema does a regex shape check first; this is the
 * semantic check that catches plausible-looking but non-existent
 * zones like "America/Atlantis".
 */
export function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

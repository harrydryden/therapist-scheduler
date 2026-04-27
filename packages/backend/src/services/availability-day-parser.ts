/**
 * Convert the agent's day-string availability shape into structured slots.
 *
 * Used by the `update_therapist_availability` tool — Claude returns
 * availability as { Monday: "09:00-12:00, 14:00-17:00" } and we persist it
 * as an array of { day, start, end } slots.
 *
 * Lives in its own module so the parser can be unit-tested without booting
 * the full AI tool executor (which transitively pulls in Redis/config/etc).
 */

import type { AvailabilitySlot } from '@therapist-scheduler/shared';

const VALID_DAYS = new Set([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]);

/**
 * Parse the day-keyed string map into structured slots. Unrecognised day
 * names and unparseable ranges are silently dropped — the agent occasionally
 * produces slightly malformed strings and we'd rather persist what's good
 * than reject the whole update.
 */
export function parseDayStringsToSlots(input: { [day: string]: string } | null | undefined): AvailabilitySlot[] {
  if (!input) return [];
  const slots: AvailabilitySlot[] = [];
  for (const [rawDay, raw] of Object.entries(input)) {
    const day = rawDay.charAt(0).toUpperCase() + rawDay.slice(1).toLowerCase();
    if (!VALID_DAYS.has(day)) continue;
    if (typeof raw !== 'string' || !raw.trim()) continue;

    for (const range of raw.split(',').map((s) => s.trim())) {
      const match = range.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (match) {
        slots.push({ day, start: match[1], end: match[2] });
      }
    }
  }
  return slots;
}

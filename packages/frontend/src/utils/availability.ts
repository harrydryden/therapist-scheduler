import type { TherapistAvailability, AvailabilitySlot } from '../types';

// Day order for sorting
export const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const DAY_ABBREVIATIONS: Record<string, string> = {
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
  Sunday: 'Sun',
};

/**
 * HH:MM time pattern, 24-hour clock. The strictness matters: this is the
 * only thing standing between malformed availability rows in the database
 * and "Mon: flexible-flexible" rendering on the public site.
 */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * True only when the slot has a recognised weekday + HH:MM-HH:MM times.
 * Anything else — "flexible", "Not specified", "null", capitalised
 * variants — gets dropped. Callers should treat the filtered array as
 * the authoritative slot list; an empty result means the therapist has
 * no display-quality availability and the UI should fall back to
 * "Available on request".
 */
export function isValidSlot(slot: AvailabilitySlot | null | undefined): slot is AvailabilitySlot {
  if (!slot || typeof slot !== 'object') return false;
  if (typeof slot.day !== 'string' || !DAY_ABBREVIATIONS[slot.day]) return false;
  if (typeof slot.start !== 'string' || !TIME_PATTERN.test(slot.start)) return false;
  if (typeof slot.end !== 'string' || !TIME_PATTERN.test(slot.end)) return false;
  return true;
}

/** Filter helper exposed for callers that need to count display-quality slots. */
export function getDisplayableSlots(availability: TherapistAvailability | null | undefined): AvailabilitySlot[] {
  if (!availability || !Array.isArray(availability.slots)) return [];
  return availability.slots.filter(isValidSlot);
}

export function formatAvailability(availability: TherapistAvailability): string[] {
  const slotsByDay: Record<string, string[]> = {};

  for (const slot of getDisplayableSlots(availability)) {
    const timeRange = `${slot.start}-${slot.end}`;
    if (!slotsByDay[slot.day]) {
      slotsByDay[slot.day] = [];
    }
    slotsByDay[slot.day].push(timeRange);
  }

  const sortedDays = Object.keys(slotsByDay).sort(
    (a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b)
  );

  return sortedDays.map((day) => {
    const abbrev = DAY_ABBREVIATIONS[day];
    const times = slotsByDay[day].join(', ');
    return `${abbrev}: ${times}`;
  });
}

/**
 * Short label for the zone a therapist's availability is written in, shown
 * next to the slots: "UK time", "New York time", "Dublin time". Null when
 * the zone is missing or not an IANA name.
 */
export function formatTimezoneLabel(timezone: string | null | undefined): string | null {
  const tz = timezone?.trim();
  if (!tz) return null;
  if (tz === 'Europe/London' || tz === 'GB') return 'UK time';
  if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
  if (!/^[A-Za-z]+\/[A-Za-z_\-/]+$/.test(tz)) return null;
  const city = tz.split('/').pop()!.replace(/_/g, ' ');
  return `${city} time`;
}

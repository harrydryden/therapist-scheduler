/**
 * Smart Availability Formatting Utility
 *
 * Formats therapist availability for user-friendly presentation:
 * - Excludes past slots
 * - Groups by week ("This week", "Next week", etc.)
 * - Highlights soonest available
 * - Limits options to reduce decision fatigue
 * - Handles timezone conversion
 */

import { logger } from '../utils/logger';
import {
  MIN_BOOKING_LEAD_HOURS,
  formatTime12Compact,
  formatDateLong,
  formatDateShort,
  getDateInTimezone,
  wallClockToUtc,
} from '../utils/date';
import type { AvailabilitySlot, TherapistAvailability } from '../types';

// Re-export for consumers
export type { AvailabilitySlot, TherapistAvailability };

export interface FormattedSlot {
  datetime: Date;
  display: string; // "Monday 10th February at 10:00am"
  shortDisplay: string; // "Mon 10th, 10am"
  isThisWeek: boolean;
  isNextWeek: boolean;
  isSoonest: boolean;
}

export interface FormattedAvailability {
  thisWeek: FormattedSlot[];
  nextWeek: FormattedSlot[];
  later: FormattedSlot[];
  soonestSlot: FormattedSlot | null;
  totalSlots: number;
  summary: string; // Human-readable summary for the agent
  userTimezone: string;
  therapistTimezone: string;
}

// Default configuration (can be overridden via SlotConfig parameter)
const DEFAULT_MAX_SLOTS_PER_GROUP = 6; // Limit to reduce decision fatigue
const DEFAULT_MAX_TOTAL_SLOTS = 12; // Maximum slots to show
const DEFAULT_SLOT_DURATION_MINUTES = 50; // Standard therapy session length
const DEFAULT_SLOT_INTERVAL_MINUTES = 60; // Generate slots every hour within availability window

/**
 * Configuration for slot generation and display, overridable via admin settings.
 */
export interface SlotConfig {
  maxSlotsPerGroup?: number;
  maxTotalSlots?: number;
  sessionDurationMinutes?: number;
  slotIntervalMinutes?: number;
}

/**
 * Day name to day-of-week index mapping
 */
const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

// formatDateLong / formatDateShort / formatTime12Compact are imported from
// utils/date and accept an explicit timezone — we always pass the therapist's
// availability timezone so slots are presented in the time the therapist
// actually works.

/**
 * Check if a date falls on an exception day, comparing the calendar date
 * in the therapist's timezone (so a slot starting at 23:00 Sydney time on
 * 2026-04-28 is matched against an exception entry for 2026-04-28, not for
 * the UTC date 2026-04-27).
 */
function isExceptionDay(
  date: Date,
  exceptions: Array<{ date: string; available: boolean }> | undefined,
  timezone: string,
): boolean | null {
  if (!exceptions || exceptions.length === 0) return null;

  const parts = getDateInTimezone(date, timezone);
  const dateStr = `${parts.year.toString().padStart(4, '0')}-${(parts.month + 1)
    .toString()
    .padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
  const exception = exceptions.find(e => e.date === dateStr);
  return exception ? exception.available : null;
}

/**
 * Generate concrete datetime slots from an availability pattern.
 *
 * The (day, start, end) triples in `availability.slots` are interpreted as
 * **wall-clock times in `availability.timezone`**, then converted to absolute
 * UTC instants. So a Sydney therapist with `Monday 09:00-17:00` produces UTC
 * Date objects representing 09:00 Sydney time on each upcoming Monday — not
 * 09:00 UTC, and not 09:00 in whatever timezone the Node process runs in.
 *
 * @param availability - Therapist's availability configuration
 * @param referenceDate - Starting point for slot generation (defaults to now)
 * @param weeksAhead - How many weeks ahead to generate (default 3)
 * @returns Array of concrete UTC datetime slots, sorted ascending
 */
function generateSlots(
  availability: TherapistAvailability,
  referenceDate: Date = new Date(),
  weeksAhead: number = 3,
  durationMinutes: number = DEFAULT_SLOT_DURATION_MINUTES,
  intervalMinutes: number = DEFAULT_SLOT_INTERVAL_MINUTES,
): Date[] {
  const slots: Date[] = [];
  const now = new Date();
  const timezone = availability.timezone || 'Europe/London';

  // Buffer: don't show slots starting within the minimum booking lead time
  const minStartTime = new Date(now.getTime() + MIN_BOOKING_LEAD_HOURS * 60 * 60 * 1000);

  // Anchor week iteration on the reference date as it appears in the
  // therapist's timezone — otherwise a referenceDate near UTC midnight could
  // skew which calendar week we start on.
  const refParts = getDateInTimezone(referenceDate, timezone);
  const refDayOfWeek = refParts.dayOfWeek; // 0=Sun..6=Sat in the therapist's tz
  const endTime = referenceDate.getTime() + weeksAhead * 7 * 24 * 60 * 60 * 1000;

  for (const slot of availability.slots) {
    const dayIndex = DAY_INDEX[slot.day.toLowerCase()];
    if (dayIndex === undefined) {
      logger.warn({ day: slot.day }, 'Unknown day name in availability');
      continue;
    }

    // Parse BOTH start and end times
    const [startHour, startMinute] = slot.start.split(':').map(Number);
    const [endHour, endMinute] = slot.end.split(':').map(Number);

    // Calculate the last valid slot start time (must allow full session before window closes)
    const windowEndMinutes = endHour * 60 + endMinute;
    const lastSlotStartMinutes = windowEndMinutes - durationMinutes;

    // Walk forward day-by-day from the reference date. Using a wall-clock
    // calendar (year, month, day in the therapist's tz) avoids any DST
    // arithmetic on plain Date objects.
    const daysUntilFirst = (dayIndex - refDayOfWeek + 7) % 7;
    let cursorYear = refParts.year;
    let cursorMonth = refParts.month;
    let cursorDay = refParts.day + daysUntilFirst;

    for (let week = 0; week < weeksAhead; week++) {
      // Generate hourly slots within the window for this calendar day
      let slotMinutes = startHour * 60 + startMinute;
      while (slotMinutes <= lastSlotStartMinutes) {
        const slotHour = Math.floor(slotMinutes / 60);
        const slotMin = slotMinutes % 60;
        const utcInstant = wallClockToUtc(cursorYear, cursorMonth, cursorDay, slotHour, slotMin, timezone);

        if (utcInstant.getTime() <= endTime) {
          // Honour the exceptions list (calendar date matched in tz)
          const exceptionStatus = isExceptionDay(utcInstant, availability.exceptions, timezone);
          // Honour minimum-booking-lead buffer
          if (exceptionStatus !== false && utcInstant > minStartTime) {
            slots.push(utcInstant);
          }
        }

        slotMinutes += intervalMinutes;
      }

      cursorDay += 7;
    }
  }

  // Sort by datetime
  slots.sort((a, b) => a.getTime() - b.getTime());

  return slots;
}

/**
 * Format therapist availability into a user-friendly grouped format.
 *
 * Slot display strings are rendered in the therapist's availability
 * timezone — that is the timezone the therapist actually works in, and the
 * slots' UTC instants represent wall-clock moments in that zone. The
 * `displayTimezone` parameter is recorded on the result so callers (and the
 * scheduling agent) know which zone the strings refer to; pass the
 * recipient's local timezone if you intend to format differently for them
 * (currently the agent does the cross-zone phrasing, so we always render
 * the slots in the therapist's local time).
 *
 * @param availability - Raw availability data from Notion/database
 * @param displayTimezone - IANA timezone the slots are RENDERED in
 *   (defaults to the availability's own timezone, then UK)
 * @param referenceDate - Anchor date for slot generation
 * @param slotConfig - Limits on how many slots to generate
 */
export function formatAvailabilityForUser(
  availability: TherapistAvailability | Record<string, unknown> | null,
  displayTimezone?: string,
  referenceDate: Date = new Date(),
  slotConfig: SlotConfig = {}
): FormattedAvailability {
  const maxSlotsPerGroup = slotConfig.maxSlotsPerGroup ?? DEFAULT_MAX_SLOTS_PER_GROUP;
  const maxTotalSlots = slotConfig.maxTotalSlots ?? DEFAULT_MAX_TOTAL_SLOTS;
  const sessionDurationMinutes = slotConfig.sessionDurationMinutes ?? DEFAULT_SLOT_DURATION_MINUTES;
  const slotIntervalMinutes = slotConfig.slotIntervalMinutes ?? DEFAULT_SLOT_INTERVAL_MINUTES;
  const result: FormattedAvailability = {
    thisWeek: [],
    nextWeek: [],
    later: [],
    soonestSlot: null,
    totalSlots: 0,
    summary: '',
    userTimezone: displayTimezone || 'Europe/London',
    therapistTimezone: 'Europe/London',
  };

  if (!availability) {
    result.summary = 'No availability on file. Therapist will need to provide available times.';
    return result;
  }

  // Type guard and normalization
  const normalizedAvailability = normalizeAvailability(availability);
  if (!normalizedAvailability || normalizedAvailability.slots.length === 0) {
    result.summary = 'No availability slots configured. Therapist will need to provide available times.';
    return result;
  }

  const therapistTz = normalizedAvailability.timezone || 'Europe/London';
  result.therapistTimezone = therapistTz;
  // Render slot strings in the therapist's timezone unless the caller wants
  // a specific display zone — keeps the wall-clock label consistent with how
  // the therapist sees their own week.
  const renderTz = displayTimezone || therapistTz;
  result.userTimezone = renderTz;

  // Generate concrete slots using provided reference date for consistency
  const slots = generateSlots(normalizedAvailability, referenceDate, 3, sessionDurationMinutes, slotIntervalMinutes);

  if (slots.length === 0) {
    result.summary = 'No available slots in the next 3 weeks. Consider asking the therapist for updated availability.';
    return result;
  }

  // Group slots by week — anchor the week boundary on the reference date as
  // it appears in the render timezone, so a Sunday-evening reference doesn't
  // accidentally roll a Monday-morning slot into "this week" (or vice versa).
  const refParts = getDateInTimezone(referenceDate, renderTz);
  const thisWeekStart = wallClockToUtc(
    refParts.year,
    refParts.month,
    refParts.day - refParts.dayOfWeek,
    0, 0,
    renderTz,
  );
  const nextWeekStart = new Date(thisWeekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const weekAfterStart = new Date(nextWeekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  let slotsAdded = 0;

  for (const slotDate of slots) {
    if (slotsAdded >= maxTotalSlots) break;

    const formatted: FormattedSlot = {
      datetime: slotDate,
      display: `${formatDateLong(slotDate, renderTz)} at ${formatTime12Compact(slotDate, renderTz)}`,
      shortDisplay: `${formatDateShort(slotDate, renderTz)}, ${formatTime12Compact(slotDate, renderTz)}`,
      isThisWeek: slotDate >= thisWeekStart && slotDate < nextWeekStart,
      isNextWeek: slotDate >= nextWeekStart && slotDate < weekAfterStart,
      isSoonest: slotsAdded === 0,
    };

    // Mark first slot as soonest
    if (slotsAdded === 0) {
      result.soonestSlot = formatted;
    }

    // Add to appropriate group (with limits)
    // Note: When a group is full, we still count the slot for accurate totalSlots
    // but skip adding to avoid array overflow
    if (formatted.isThisWeek) {
      if (result.thisWeek.length < maxSlotsPerGroup) {
        result.thisWeek.push(formatted);
      }
      slotsAdded++;
    } else if (formatted.isNextWeek) {
      if (result.nextWeek.length < maxSlotsPerGroup) {
        result.nextWeek.push(formatted);
      }
      slotsAdded++;
    } else {
      if (result.later.length < maxSlotsPerGroup) {
        result.later.push(formatted);
      }
      slotsAdded++;
    }
  }

  result.totalSlots = slotsAdded;

  // Generate human-readable summary
  result.summary = generateSummary(result);

  return result;
}

/**
 * Normalize various availability formats to our standard format
 */
function normalizeAvailability(
  raw: TherapistAvailability | Record<string, unknown>
): TherapistAvailability | null {
  // Already in correct format
  if (raw && 'slots' in raw && Array.isArray(raw.slots)) {
    return raw as TherapistAvailability;
  }

  // Handle legacy format: { Monday: "09:00-12:00, 14:00-17:00", ... }
  if (raw && typeof raw === 'object') {
    const slots: AvailabilitySlot[] = [];

    for (const [day, timeStr] of Object.entries(raw)) {
      if (typeof timeStr !== 'string') {
        if (day.toLowerCase() !== 'timezone') {
          logger.warn({ day, valueType: typeof timeStr }, 'Availability entry has non-string value, skipping');
        }
        continue;
      }

      // Skip non-day keys like 'timezone'
      if (day.toLowerCase() === 'timezone') continue;
      if (!DAY_INDEX[day.toLowerCase()]) {
        logger.warn({ day }, 'Unrecognized day name in availability, skipping');
        continue;
      }

      // Parse time ranges: "09:00-12:00, 14:00-17:00"
      const ranges = timeStr.split(',').map(r => r.trim());
      for (const range of ranges) {
        const [start, end] = range.split('-').map(t => t.trim());
        if (start && end) {
          slots.push({ day, start, end });
        } else {
          logger.warn({ day, range }, 'Invalid time range format in availability, skipping');
        }
      }
    }

    if (slots.length > 0) {
      return {
        timezone: (raw as any).timezone || 'Europe/London',
        slots,
      };
    }
  }

  return null;
}

/**
 * Collapse consecutive hourly times into ranges, formatted in `timezone`.
 */
function collapseToRanges(datetimes: Date[], timezone: string): string[] {
  if (datetimes.length === 0) return [];
  if (datetimes.length === 1) return [formatTime12Compact(datetimes[0], timezone)];

  const ranges: string[] = [];
  let rangeStart = datetimes[0];
  let rangePrev = datetimes[0];

  for (let i = 1; i <= datetimes.length; i++) {
    const current = datetimes[i];
    const gap = current ? (current.getTime() - rangePrev.getTime()) / (60 * 1000) : Infinity;

    // Consecutive if within ~65 minutes (allows for 60-min intervals with small drift)
    if (gap <= 65) {
      rangePrev = current;
    } else {
      // Close the current range
      if (rangeStart.getTime() === rangePrev.getTime()) {
        ranges.push(formatTime12Compact(rangeStart, timezone));
      } else {
        ranges.push(
          `${formatTime12Compact(rangeStart, timezone)} – ${formatTime12Compact(rangePrev, timezone)}`,
        );
      }
      if (current) {
        rangeStart = current;
        rangePrev = current;
      }
    }
  }

  return ranges;
}

/**
 * Group slots by calendar date (in `timezone`) and collapse consecutive times
 * into ranges. e.g. "Monday 30th March: 10am – 3pm".
 */
function formatSlotsByDate(slots: FormattedSlot[], timezone: string): string {
  // Group by calendar date in the display timezone — using a server-local
  // string would split or merge slots incorrectly across midnight UTC.
  const byDate = new Map<string, { dateLong: string; datetimes: Date[] }>();

  for (const slot of slots) {
    const parts = getDateInTimezone(slot.datetime, timezone);
    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    if (!byDate.has(dateKey)) {
      byDate.set(dateKey, {
        dateLong: formatDateLong(slot.datetime, timezone),
        datetimes: [],
      });
    }
    byDate.get(dateKey)!.datetimes.push(slot.datetime);
  }

  return Array.from(byDate.values())
    .map(({ dateLong, datetimes }) => {
      const ranges = collapseToRanges(datetimes, timezone);
      return `- ${dateLong}: ${ranges.join(', ')}`;
    })
    .join('\n');
}

/**
 * Generate a human-readable summary of availability
 * Groups times by date for clearer presentation
 */
function generateSummary(availability: FormattedAvailability): string {
  const parts: string[] = [];
  const tz = availability.userTimezone;

  if (availability.soonestSlot) {
    parts.push(`**Soonest available:** ${availability.soonestSlot.display}`);
  }

  if (availability.thisWeek.length > 0) {
    parts.push(`**This week:**\n${formatSlotsByDate(availability.thisWeek, tz)}`);
  }

  if (availability.nextWeek.length > 0) {
    parts.push(`**Next week:**\n${formatSlotsByDate(availability.nextWeek, tz)}`);
  }

  if (availability.later.length > 0) {
    const maxLaterSlots = 6;
    const slotsToShow = availability.later.slice(0, maxLaterSlots);
    const formatted = formatSlotsByDate(slotsToShow, tz);
    const remaining = availability.later.length - slotsToShow.length;
    const suffix = remaining > 0 ? `\n(+${remaining} more slots available)` : '';
    parts.push(`**Later:**\n${formatted}${suffix}`);
  }

  if (parts.length === 0) {
    return 'No available slots found in the next 3 weeks.';
  }

  return parts.join('\n\n');
}


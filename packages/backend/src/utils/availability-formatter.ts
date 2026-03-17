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

import { logger } from './logger';
import { MIN_BOOKING_LEAD_HOURS } from './date-parser';
import {
  DAYS_LONG,
  DAYS_SHORT,
  MONTHS,
  getOrdinalSuffix,
  formatTime12Compact,
} from './date-formatting';
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

/**
 * Format a date as "Monday 10th February"
 */
function formatDateLong(date: Date): string {
  const day = date.getDate();
  const suffix = getOrdinalSuffix(day);
  return `${DAYS_LONG[date.getDay()]} ${day}${suffix} ${MONTHS[date.getMonth()]}`;
}

/**
 * Format a date as "Mon 10th"
 */
function formatDateShort(date: Date): string {
  const day = date.getDate();
  const suffix = getOrdinalSuffix(day);
  return `${DAYS_SHORT[date.getDay()]} ${day}${suffix}`;
}

// Use shared formatTime12Compact for both formatTime and formatTimeShort
// (they were identical: "10am" or "10:30am")
const formatTime = formatTime12Compact;
const formatTimeShort = formatTime12Compact;

/**
 * Get the start of the current week (Sunday)
 */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Check if a date falls on an exception day
 */
function isExceptionDay(
  date: Date,
  exceptions: Array<{ date: string; available: boolean }> | undefined
): boolean | null {
  if (!exceptions || exceptions.length === 0) return null;

  const dateStr = date.toISOString().split('T')[0]; // "YYYY-MM-DD"
  const exception = exceptions.find(e => e.date === dateStr);
  return exception ? exception.available : null;
}

/**
 * Generate concrete datetime slots from availability pattern
 *
 * Generates multiple slots within each availability window at hourly intervals.
 * For example, availability "12:00-16:00" generates slots at 12pm, 1pm, 2pm, 3pm.
 *
 * @param availability - Therapist's availability configuration
 * @param referenceDate - Starting point for slot generation (defaults to now)
 * @param weeksAhead - How many weeks ahead to generate (default 3)
 * @returns Array of concrete datetime slots
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

  // Buffer: don't show slots starting within the minimum booking lead time
  const minStartTime = new Date(now.getTime() + MIN_BOOKING_LEAD_HOURS * 60 * 60 * 1000);

  // Generate slots for the next N weeks
  const endDate = new Date(referenceDate);
  endDate.setDate(endDate.getDate() + weeksAhead * 7);

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

    // Find first occurrence of this day
    let currentDay = new Date(referenceDate);
    currentDay.setHours(0, 0, 0, 0);
    const daysUntil = (dayIndex - currentDay.getDay() + 7) % 7;
    currentDay.setDate(currentDay.getDate() + daysUntil);

    // Generate slots for each week
    while (currentDay < endDate) {
      // Check exceptions
      const exceptionStatus = isExceptionDay(currentDay, availability.exceptions);

      if (exceptionStatus !== false) { // Not explicitly unavailable
        // Generate multiple slots within the availability window
        let slotTime = new Date(currentDay);
        slotTime.setHours(startHour, startMinute, 0, 0);

        // Loop through hourly slots within the window
        while (true) {
          const slotMinutes = slotTime.getHours() * 60 + slotTime.getMinutes();

          // Stop if we've passed the last valid slot start time
          if (slotMinutes > lastSlotStartMinutes) break;

          // Only add if after minimum buffer time
          if (slotTime > minStartTime) {
            slots.push(new Date(slotTime));
          }

          // Move to next hourly slot
          slotTime = new Date(slotTime.getTime() + intervalMinutes * 60 * 1000);
        }
      }

      // Move to next week
      currentDay.setDate(currentDay.getDate() + 7);
    }
  }

  // Sort by datetime
  slots.sort((a, b) => a.getTime() - b.getTime());

  return slots;
}

/**
 * Format therapist availability into user-friendly grouped format
 *
 * @param availability - Raw availability data from Notion/database
 * @param userTimezone - User's timezone (optional, for future timezone support)
 * @returns Formatted availability with groupings and summaries
 */
export function formatAvailabilityForUser(
  availability: TherapistAvailability | Record<string, unknown> | null,
  userTimezone: string = 'Europe/London',
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
    userTimezone,
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

  result.therapistTimezone = normalizedAvailability.timezone || 'Europe/London';

  // Generate concrete slots using provided reference date for consistency
  const slots = generateSlots(normalizedAvailability, referenceDate, 3, sessionDurationMinutes, slotIntervalMinutes);

  if (slots.length === 0) {
    result.summary = 'No available slots in the next 3 weeks. Consider asking the therapist for updated availability.';
    return result;
  }

  // Group slots by week - use referenceDate for consistent grouping
  const now = referenceDate;
  const thisWeekStart = getWeekStart(now);
  const nextWeekStart = new Date(thisWeekStart);
  nextWeekStart.setDate(nextWeekStart.getDate() + 7);
  const weekAfterStart = new Date(nextWeekStart);
  weekAfterStart.setDate(weekAfterStart.getDate() + 7);

  let slotsAdded = 0;

  for (const slotDate of slots) {
    if (slotsAdded >= maxTotalSlots) break;

    const formatted: FormattedSlot = {
      datetime: slotDate,
      display: `${formatDateLong(slotDate)} at ${formatTime(slotDate)}`,
      shortDisplay: `${formatDateShort(slotDate)}, ${formatTimeShort(slotDate)}`,
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
 * Generate a human-readable summary of availability
 */
function generateSummary(availability: FormattedAvailability): string {
  const parts: string[] = [];

  if (availability.soonestSlot) {
    parts.push(`**Soonest available:** ${availability.soonestSlot.display}`);
  }

  if (availability.thisWeek.length > 0) {
    const slots = availability.thisWeek.map(s => s.shortDisplay).join(', ');
    parts.push(`**This week:** ${slots}`);
  }

  if (availability.nextWeek.length > 0) {
    const slots = availability.nextWeek.map(s => s.shortDisplay).join(', ');
    parts.push(`**Next week:** ${slots}`);
  }

  if (availability.later.length > 0) {
    const slots = availability.later.slice(0, 3).map(s => s.shortDisplay).join(', ');
    const suffix = availability.later.length > 3 ? ` (+${availability.later.length - 3} more)` : '';
    parts.push(`**Later:** ${slots}${suffix}`);
  }

  if (parts.length === 0) {
    return 'No available slots found in the next 3 weeks.';
  }

  return parts.join('\n');
}


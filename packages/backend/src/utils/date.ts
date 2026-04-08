/**
 * Unified date utilities
 *
 * Consolidates what was previously three overlapping modules:
 *   - date-formatting.ts (primitive formatters + constants)
 *   - date-parser.ts     (parsing, timezone math, scheduling helpers)
 *   - email-date-formatter.ts (relative email-friendly formatting)
 *
 * Organised top-to-bottom as:
 *   1. Constants
 *   2. Primitive formatters (time-of-day, ordinals)
 *   3. Timezone helpers
 *   4. Parsing (natural language -> Date)
 *   5. Predicates (past / too soon / within N hours)
 *   6. Scheduling calculators
 *   7. Email-facing formatters
 */

import { parse as chronoParse } from 'chrono-node';
import { config } from '../config';
import { getSettingValue } from '../services/settings.service';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

export const DAYS_LONG = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
export const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Default minimum hours in the future an appointment must be to allow booking.
 * Can be overridden at runtime via the general.minBookingLeadHours admin setting.
 */
export const MIN_BOOKING_LEAD_HOURS = 4;

// ---------------------------------------------------------------------------
// 2. Primitive formatters
// ---------------------------------------------------------------------------

/**
 * Get ordinal suffix for a day number (1st, 2nd, 3rd, 4th...)
 */
export function getOrdinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * Format time in 12-hour format with minutes always shown: "9:30am", "1:00pm"
 */
export function formatTime12(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  const minuteStr = minutes.toString().padStart(2, '0');
  return `${hours}:${minuteStr}${ampm}`;
}

/**
 * Format time in 12-hour format, omitting :00 minutes: "10am", "2:30pm"
 */
export function formatTime12Compact(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  const minuteStr = minutes === 0 ? '' : `:${minutes.toString().padStart(2, '0')}`;
  return `${hours}${minuteStr}${ampm}`;
}

/**
 * Format time in 24-hour format: "09:30", "13:45"
 */
export function formatTime24(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

// ---------------------------------------------------------------------------
// 3. Timezone helpers
// ---------------------------------------------------------------------------

/**
 * Apply a timezone to a date that was parsed as if in local time.
 * Converts "this wall-clock time, in <timezone>" to the correct UTC instant.
 */
function applyTimezoneToDate(date: Date, timezone: string): Date {
  try {
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const tempDate = new Date(year, month, day, hours, minutes, seconds);
    const parts = formatter.formatToParts(tempDate);

    const getPart = (type: string): number => {
      const part = parts.find((p) => p.type === type);
      return part ? parseInt(part.value, 10) : 0;
    };

    const tzYear = getPart('year');
    const tzMonth = getPart('month') - 1;
    const tzDay = getPart('day');
    const tzHours = getPart('hour');
    const tzMinutes = getPart('minute');

    const localMs = new Date(year, month, day, hours, minutes, seconds).getTime();
    const tzMs = new Date(tzYear, tzMonth, tzDay, tzHours, tzMinutes, seconds).getTime();
    const offsetMs = localMs - tzMs;

    return new Date(tempDate.getTime() + offsetMs);
  } catch (error) {
    logger.warn({ timezone, error }, 'Failed to apply timezone - using local time');
    return date;
  }
}

/**
 * Get date components in a specific timezone.
 */
function getDateInTimezone(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
  hours: number;
  minutes: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string): string => parts.find(p => p.type === type)?.value || '0';

  const weekdayStr = getPart('weekday');
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    year: parseInt(getPart('year'), 10),
    month: parseInt(getPart('month'), 10) - 1,
    day: parseInt(getPart('day'), 10),
    dayOfWeek: weekdayMap[weekdayStr] ?? 0,
    hours: parseInt(getPart('hour'), 10),
    minutes: parseInt(getPart('minute'), 10),
  };
}

/**
 * Calendar-day difference between two dates in a given timezone.
 */
function daysDifference(now: Date, target: Date, timezone: string): number {
  const nowParts = getDateInTimezone(now, timezone);
  const targetParts = getDateInTimezone(target, timezone);
  const nowDate = new Date(nowParts.year, nowParts.month, nowParts.day);
  const targetDate = new Date(targetParts.year, targetParts.month, targetParts.day);
  return Math.round((targetDate.getTime() - nowDate.getTime()) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// 4. Parsing
// ---------------------------------------------------------------------------

/**
 * Options for date parsing behavior
 */
export interface DateParseOptions {
  /**
   * When true, ambiguous dates are interpreted as future dates.
   * When false, dates are parsed literally (may result in past dates).
   * Default: true (backward compatible)
   */
  forwardDate?: boolean;

  /**
   * IANA timezone identifier for parsing the datetime.
   * When provided, the parsed time is interpreted as being in this timezone
   * and converted to UTC for storage.
   * Default: config.timezone
   */
  timezone?: string;
}

/**
 * Parse human-readable datetime string to Date object.
 * Handles formats like "Monday 3rd February at 10:00am"
 *
 * Strategy:
 *   1. Try chrono-node first (handles most natural language)
 *   2. Fall back to regex extraction for edge cases
 *   3. By default, assume current/next occurrence of the date (forwardDate: true)
 */
export function parseConfirmedDateTime(
  dateTimeString: string,
  referenceDate: Date = new Date(),
  options: DateParseOptions = {}
): Date | null {
  const { forwardDate = true, timezone = config.timezone } = options;

  if (!dateTimeString || typeof dateTimeString !== 'string') {
    return null;
  }

  try {
    const normalized = dateTimeString
      .toLowerCase()
      .replace(/(\d+)(st|nd|rd|th)/g, '$1')
      .replace(/\s+at\s+/gi, ' ')
      .trim();

    const chronoOptions: { forwardDate: boolean; timezone?: string } = { forwardDate };
    if (timezone) {
      chronoOptions.timezone = timezone;
    }

    const results = chronoParse(normalized, referenceDate, chronoOptions);

    if (results.length > 0 && results[0].date()) {
      let parsedDate = results[0].date();

      if (timezone && !results[0].start.get('timezoneOffset')) {
        parsedDate = applyTimezoneToDate(parsedDate, timezone);
      }

      logger.debug(
        { input: dateTimeString, parsed: parsedDate.toISOString(), forwardDate, timezone },
        'Successfully parsed datetime with chrono-node'
      );
      return parsedDate;
    }

    const fallbackResult = parseWithRegex(dateTimeString, referenceDate, forwardDate, timezone);
    if (fallbackResult) {
      logger.debug(
        { input: dateTimeString, parsed: fallbackResult.toISOString(), forwardDate, timezone },
        'Successfully parsed datetime with regex fallback'
      );
      return fallbackResult;
    }

    logger.warn({ dateTimeString, forwardDate, timezone }, 'Failed to parse confirmed datetime');
    return null;
  } catch (error) {
    logger.warn({ dateTimeString, error, forwardDate, timezone }, 'Error parsing confirmed datetime');
    return null;
  }
}

/**
 * Fallback regex parser for specific format
 * Pattern: "Monday 3rd February at 10:00am"
 */
function parseWithRegex(
  dateTimeString: string,
  referenceDate: Date,
  forwardDate: boolean = true,
  timezone?: string
): Date | null {
  const pattern = /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:at\s+)?(\d{1,2}):?(\d{2})?\s*(am|pm)?/i;

  const match = dateTimeString.match(pattern);
  if (!match) return null;

  const [, day, month, hours, minutes = '00', ampm = 'am'] = match;

  const monthMap: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };

  let hour = parseInt(hours, 10);
  const ampmLower = ampm.toLowerCase();

  if (ampmLower === 'pm' && hour !== 12) {
    hour += 12;
  } else if (ampmLower === 'am' && hour === 12) {
    hour = 0;
  }

  const year = referenceDate.getFullYear();
  const monthNum = monthMap[month.toLowerCase()];

  let result = new Date(year, monthNum, parseInt(day, 10), hour, parseInt(minutes, 10));

  if (forwardDate && result < referenceDate) {
    result.setFullYear(year + 1);
  }

  if (timezone) {
    result = applyTimezoneToDate(result, timezone);
  }

  return result;
}

/**
 * Semantically compare two datetime strings.
 * Returns true if both strings parse to the same date/time
 * (within a tolerance to handle minor formatting differences).
 */
export function areDatetimesEqual(
  datetime1: string | null | undefined,
  datetime2: string | null | undefined,
  toleranceMinutes: number = 1,
  options: DateParseOptions = {}
): boolean {
  if (!datetime1 && !datetime2) return true;
  if (!datetime1 || !datetime2) return false;
  if (datetime1 === datetime2) return true;

  const date1 = parseConfirmedDateTime(datetime1, undefined, options);
  const date2 = parseConfirmedDateTime(datetime2, undefined, options);

  if (!date1 || !date2) {
    return datetime1.toLowerCase().trim() === datetime2.toLowerCase().trim();
  }

  const diffMs = Math.abs(date1.getTime() - date2.getTime());
  const toleranceMs = toleranceMinutes * 60 * 1000;
  return diffMs <= toleranceMs;
}

// ---------------------------------------------------------------------------
// 5. Predicates
// ---------------------------------------------------------------------------

/**
 * Check if a datetime is in the past
 */
export function isInPast(date: Date): boolean {
  return date < new Date();
}

/**
 * Check if a datetime is too soon (or in the past) to book.
 * Appointments must be at least `leadHours` in the future.
 */
export function isTooSoonToBook(date: Date, leadHours: number = MIN_BOOKING_LEAD_HOURS): boolean {
  const minBookingTime = new Date(Date.now() + leadHours * 60 * 60 * 1000);
  return date < minBookingTime;
}

/**
 * Check if a datetime is within a certain number of hours from now
 */
export function isWithinHours(date: Date, hours: number): boolean {
  const now = new Date();
  const threshold = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return date <= threshold && date > now;
}

// ---------------------------------------------------------------------------
// 6. Scheduling calculators
// ---------------------------------------------------------------------------

/**
 * Calculate when to send the meeting-link check email.
 *
 * Rules:
 *   - 24 hours after confirmation
 *   - UNLESS that would be after appointment time
 *   - Then send at least 4 hours before appointment
 *   - If appointment is very soon (< 4 hours), return current time (send immediately)
 */
export function calculateMeetingLinkCheckTime(
  confirmedAt: Date,
  appointmentTime: Date
): Date {
  const twentyFourHoursAfterConfirmation = new Date(
    confirmedAt.getTime() + 24 * 60 * 60 * 1000
  );
  const fourHoursBeforeAppointment = new Date(
    appointmentTime.getTime() - 4 * 60 * 60 * 1000
  );

  if (twentyFourHoursAfterConfirmation <= fourHoursBeforeAppointment) {
    return twentyFourHoursAfterConfirmation;
  }

  const now = new Date();
  return fourHoursBeforeAppointment > now ? fourHoursBeforeAppointment : now;
}

/**
 * Calculate when to send feedback form.
 * Session is 50 minutes; send 1 hour after start (10 min buffer after session ends).
 */
export function calculateFeedbackFormTime(appointmentTime: Date): Date {
  return new Date(appointmentTime.getTime() + 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// 7. Email-facing formatters
// ---------------------------------------------------------------------------

/**
 * Get the relative day prefix for a date.
 *
 * Returns:
 *   - "today" for same day
 *   - "tomorrow" for next day
 *   - "this [Day]" for same week (2-6 days ahead, same Mon-Sun week)
 *   - "next [Day]" for next week
 *   - "" (empty) for further out
 */
function getRelativePrefix(now: Date, target: Date, timezone: string): string {
  const diff = daysDifference(now, target, timezone);
  const targetParts = getDateInTimezone(target, timezone);
  const nowParts = getDateInTimezone(now, timezone);
  const dayName = DAYS_LONG[targetParts.dayOfWeek];

  if (diff < 0) return '';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';

  // Week boundaries: Mon=0, Tue=1, ... Sun=6
  const nowDayFromMon = (nowParts.dayOfWeek + 6) % 7;
  const daysUntilEndOfWeek = 6 - nowDayFromMon;

  if (diff <= daysUntilEndOfWeek) return `this ${dayName}`;
  if (diff <= daysUntilEndOfWeek + 7) return `next ${dayName}`;
  return '';
}

/**
 * Format a Date object into a human-friendly email date string.
 *
 * @param date - The appointment Date object (in UTC)
 * @param timezone - IANA timezone for display (e.g. "Europe/London")
 * @param use24Hour - Whether to use 24-hour clock (default: true)
 * @param now - Current time for relative calculations (default: new Date())
 * @returns Formatted string like "tomorrow March 13th at 13:45"
 */
export function formatEmailDate(
  date: Date,
  timezone: string = 'Europe/London',
  use24Hour: boolean = true,
  now: Date = new Date(),
): string {
  const targetParts = getDateInTimezone(date, timezone);

  const dayName = DAYS_LONG[targetParts.dayOfWeek];
  const monthName = MONTHS[targetParts.month];
  const dayNum = targetParts.day;
  const ordinal = getOrdinalSuffix(dayNum);

  // Create a date in the target timezone for time formatting
  const tzDate = new Date(2000, 0, 1, targetParts.hours, targetParts.minutes);
  const timeStr = use24Hour ? formatTime24(tzDate) : formatTime12(tzDate);

  const prefix = getRelativePrefix(now, date, timezone);

  if (prefix === 'today' || prefix === 'tomorrow') {
    return `${prefix} ${monthName} ${dayNum}${ordinal} at ${timeStr}`;
  }

  if (prefix.startsWith('this ') || prefix.startsWith('next ')) {
    return `${prefix} ${monthName} ${dayNum}${ordinal} at ${timeStr}`;
  }

  return `${dayName} ${monthName} ${dayNum}${ordinal} at ${timeStr}`;
}

/**
 * Format an appointment date for use in emails, using admin-configured settings.
 *
 * Falls back to the raw confirmedDateTime string if:
 *   - The parsed date is not available
 *   - Formatting fails for any reason
 */
export async function formatEmailDateFromSettings(
  confirmedDateTimeParsed: Date | null | undefined,
  confirmedDateTime: string | null | undefined,
  now: Date = new Date(),
): Promise<string> {
  if (!confirmedDateTimeParsed) {
    return confirmedDateTime || 'your scheduled time';
  }

  try {
    const [timezone, use24Hour] = await Promise.all([
      getSettingValue<string>('general.timezone'),
      getSettingValue<boolean>('email.use24HourTime'),
    ]);

    return formatEmailDate(confirmedDateTimeParsed, timezone, use24Hour, now);
  } catch (error) {
    logger.warn({ error }, 'Failed to format email date from settings, using fallback');
    return confirmedDateTime || 'your scheduled time';
  }
}

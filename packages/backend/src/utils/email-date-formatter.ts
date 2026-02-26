/**
 * Email Date Formatter
 *
 * Formats appointment dates for emails in a human-friendly relative format:
 * - "tomorrow March 13th at 13:45"
 * - "next Thursday March 18th at 09:30"
 * - "this Friday March 14th at 16:00"
 * - "Monday March 24th at 10:00" (further out, no relative prefix)
 *
 * Uses 24-hour clock by default (configurable via admin settings).
 * Duration is always 50 minutes - no end time shown.
 */

import { getSettingValue } from '../services/settings.service';
import { logger } from './logger';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Get ordinal suffix for a day number (1st, 2nd, 3rd, 4th...)
 */
function getOrdinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * Format time in 24-hour format: "09:30", "13:45"
 */
function formatTime24(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Format time in 12-hour format: "9:30am", "1:45pm"
 */
function formatTime12(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  const minuteStr = minutes.toString().padStart(2, '0');
  return `${hours}:${minuteStr}${ampm}`;
}

/**
 * Get the start of a day (midnight) for a given date in the specified timezone
 */
function getStartOfDay(date: Date, timezone: string): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find(p => p.type === 'year')?.value;
  const month = parts.find(p => p.type === 'month')?.value;
  const day = parts.find(p => p.type === 'day')?.value;

  // Create a date at midnight in the timezone
  // We use the Intl API to find the right UTC time for midnight in this timezone
  const midnightStr = `${year}-${month}-${day}T00:00:00`;
  const tempDate = new Date(midnightStr);

  // Adjust for timezone offset
  const tzFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const tzParts = tzFormatter.formatToParts(tempDate);
  const tzHour = parseInt(tzParts.find(p => p.type === 'hour')?.value || '0', 10);
  const tzMinute = parseInt(tzParts.find(p => p.type === 'minute')?.value || '0', 10);

  // The difference tells us the offset
  const offsetMs = (tzHour * 60 + tzMinute) * 60 * 1000;
  return new Date(tempDate.getTime() - offsetMs);
}

/**
 * Get date components in a specific timezone
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
 * Calculate the difference in calendar days between two dates in a timezone
 */
function daysDifference(now: Date, target: Date, timezone: string): number {
  const nowParts = getDateInTimezone(now, timezone);
  const targetParts = getDateInTimezone(target, timezone);

  // Create pure dates (no time) for comparison
  const nowDate = new Date(nowParts.year, nowParts.month, nowParts.day);
  const targetDate = new Date(targetParts.year, targetParts.month, targetParts.day);

  return Math.round((targetDate.getTime() - nowDate.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Get the relative day prefix for a date
 *
 * Returns:
 * - "today" for same day
 * - "tomorrow" for next day
 * - "this [Day]" for same week (2-6 days ahead, same Mon-Sun week)
 * - "next [Day]" for next week
 * - "" (empty) for further out
 */
function getRelativePrefix(now: Date, target: Date, timezone: string): string {
  const diff = daysDifference(now, target, timezone);
  const targetParts = getDateInTimezone(target, timezone);
  const nowParts = getDateInTimezone(now, timezone);
  const dayName = DAYS[targetParts.dayOfWeek];

  if (diff < 0) {
    return ''; // Past date
  }

  if (diff === 0) {
    return 'today';
  }

  if (diff === 1) {
    return 'tomorrow';
  }

  // Calculate week boundaries (Monday = start of week)
  // Days from Monday: Mon=0, Tue=1, ... Sun=6
  const nowDayFromMon = (nowParts.dayOfWeek + 6) % 7;
  const daysUntilEndOfWeek = 6 - nowDayFromMon; // Days until Sunday

  if (diff <= daysUntilEndOfWeek) {
    return `this ${dayName}`;
  }

  if (diff <= daysUntilEndOfWeek + 7) {
    return `next ${dayName}`;
  }

  return ''; // More than ~2 weeks out, just use day name
}

/**
 * Format a Date object into a human-friendly email date string
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

  const dayName = DAYS[targetParts.dayOfWeek];
  const monthName = MONTHS[targetParts.month];
  const dayNum = targetParts.day;
  const ordinal = getOrdinalSuffix(dayNum);

  // Create a date in the target timezone for time formatting
  const tzDate = new Date(2000, 0, 1, targetParts.hours, targetParts.minutes);
  const timeStr = use24Hour ? formatTime24(tzDate) : formatTime12(tzDate);

  const prefix = getRelativePrefix(now, date, timezone);

  // Build the formatted date string
  // Examples:
  //   "tomorrow March 13th at 13:45"
  //   "next Thursday March 18th at 09:30"
  //   "this Friday March 14th at 16:00"
  //   "today March 12th at 11:00"
  //   "Monday March 24th at 10:00" (no prefix)
  if (prefix === 'today' || prefix === 'tomorrow') {
    return `${prefix} ${monthName} ${dayNum}${ordinal} at ${timeStr}`;
  }

  if (prefix.startsWith('this ') || prefix.startsWith('next ')) {
    return `${prefix} ${monthName} ${dayNum}${ordinal} at ${timeStr}`;
  }

  // No relative prefix - use day name
  return `${dayName} ${monthName} ${dayNum}${ordinal} at ${timeStr}`;
}

/**
 * Format an appointment date for use in emails, using admin-configured settings
 *
 * Falls back to the raw confirmedDateTime string if:
 * - The parsed date is not available
 * - Formatting fails for any reason
 *
 * @param confirmedDateTimeParsed - The parsed Date object (may be null)
 * @param confirmedDateTime - The raw string fallback
 * @param now - Current time for relative prefix (default: new Date())
 * @returns Formatted date string for email use
 */
export async function formatEmailDateFromSettings(
  confirmedDateTimeParsed: Date | null | undefined,
  confirmedDateTime: string | null | undefined,
  now: Date = new Date(),
): Promise<string> {
  // If no parsed date, fall back to raw string
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

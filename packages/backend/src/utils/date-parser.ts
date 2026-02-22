/**
 * Date parsing utilities for confirmed appointment datetimes
 * Handles human-readable strings like "Monday 3rd February at 10:00am"
 */

import * as chrono from 'chrono-node';
import { config } from '../config';
import { logger } from './logger';

/**
 * Options for date parsing behavior
 */
export interface DateParseOptions {
  /**
   * When true, ambiguous dates are interpreted as future dates.
   * When false, dates are parsed literally (may result in past dates).
   * Default: true (backward compatible)
   *
   * Example: Parsing "January 1st at 10am" on January 2nd:
   * - forwardDate: true -> Returns January 1st of NEXT year
   * - forwardDate: false -> Returns January 1st of CURRENT year (a past date)
   */
  forwardDate?: boolean;

  /**
   * FIX A7: IANA timezone identifier for parsing the datetime.
   * When provided, the parsed time is interpreted as being in this timezone
   * and converted to UTC for storage.
   *
   * Example: "Europe/London", "America/New_York", "Asia/Tokyo"
   * Default: undefined (uses system timezone - legacy behavior)
   *
   * This is critical for scheduling appointments where the therapist
   * and user may be in different timezones.
   */
  timezone?: string;
}

/**
 * Parse human-readable datetime string to Date object
 * Handles formats like "Monday 3rd February at 10:00am"
 *
 * Strategy:
 * 1. Try chrono-node first (handles most natural language)
 * 2. Fall back to regex extraction for edge cases
 * 3. By default, assume current/next occurrence of the date (forwardDate: true)
 *
 * @param dateTimeString - The human-readable datetime string
 * @param referenceDate - Reference date for relative parsing (defaults to now)
 * @param options - Optional parsing configuration
 * @returns Parsed Date object or null if parsing fails
 */
export function parseConfirmedDateTime(
  dateTimeString: string,
  referenceDate: Date = new Date(),
  options: DateParseOptions = {}
): Date | null {
  // Default forwardDate to true for backward compatibility
  // Use configured timezone as default so server timezone doesn't affect parsing
  const { forwardDate = true, timezone = config.timezone } = options;

  if (!dateTimeString || typeof dateTimeString !== 'string') {
    return null;
  }

  try {
    // Normalize the string for better parsing
    const normalized = dateTimeString
      .toLowerCase()
      .replace(/(\d+)(st|nd|rd|th)/g, '$1') // Remove ordinals: 3rd -> 3
      .replace(/\s+at\s+/gi, ' ')           // "at" -> space
      .trim();

    // Try chrono-node parsing with configurable forward date preference
    // FIX A7: Pass timezone to chrono if provided
    const chronoOptions: { forwardDate: boolean; timezone?: string } = { forwardDate };
    if (timezone) {
      chronoOptions.timezone = timezone;
    }

    const results = chrono.parse(normalized, referenceDate, chronoOptions);

    if (results.length > 0 && results[0].date()) {
      let parsedDate = results[0].date();

      // FIX A7: If timezone provided but chrono didn't handle it,
      // manually adjust for timezone offset
      if (timezone && !results[0].start.get('timezoneOffset')) {
        parsedDate = applyTimezoneToDate(parsedDate, timezone);
      }

      logger.debug(
        { input: dateTimeString, parsed: parsedDate.toISOString(), forwardDate, timezone },
        'Successfully parsed datetime with chrono-node'
      );
      return parsedDate;
    }

    // Fallback: Manual regex parsing for specific format
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
 * FIX A7: Apply timezone to a parsed date
 * Converts a date interpreted in the given timezone to UTC
 *
 * @param date - The date object (assumed to be in local time)
 * @param timezone - IANA timezone identifier (e.g., "Europe/London")
 * @returns Date adjusted for the specified timezone
 */
function applyTimezoneToDate(date: Date, timezone: string): Date {
  try {
    // Get the date components as they would be displayed
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();

    // Create a formatter for the target timezone
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

    // Get the current offset for this date in the target timezone
    // We do this by creating a date and finding the difference between
    // what we want and what we'd get in that timezone
    const tempDate = new Date(year, month, day, hours, minutes, seconds);
    const parts = formatter.formatToParts(tempDate);

    // Extract parts from the formatted output
    const getPart = (type: string): number => {
      const part = parts.find((p) => p.type === type);
      return part ? parseInt(part.value, 10) : 0;
    };

    const tzYear = getPart('year');
    const tzMonth = getPart('month') - 1; // JS months are 0-indexed
    const tzDay = getPart('day');
    const tzHours = getPart('hour');
    const tzMinutes = getPart('minute');

    // Calculate the offset between what we asked for and what the timezone gave us
    const localMs = new Date(year, month, day, hours, minutes, seconds).getTime();
    const tzMs = new Date(tzYear, tzMonth, tzDay, tzHours, tzMinutes, seconds).getTime();
    const offsetMs = localMs - tzMs;

    // Apply the offset to get the correct UTC time
    return new Date(tempDate.getTime() + offsetMs);
  } catch (error) {
    logger.warn({ timezone, error }, 'Failed to apply timezone - using local time');
    return date;
  }
}

/**
 * Fallback regex parser for specific format
 * Pattern: "Monday 3rd February at 10:00am"
 *
 * @param dateTimeString - The datetime string to parse
 * @param referenceDate - Reference date for year calculation
 * @param forwardDate - If true, assume future dates for ambiguous inputs
 * @param timezone - Optional IANA timezone identifier
 */
function parseWithRegex(
  dateTimeString: string,
  referenceDate: Date,
  forwardDate: boolean = true,
  timezone?: string
): Date | null {
  // Pattern matches: "[Day] [Date][Ordinal] [Month] [at] [Time][am/pm]"
  const pattern = /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:at\s+)?(\d{1,2}):?(\d{2})?\s*(am|pm)?/i;

  const match = dateTimeString.match(pattern);
  if (!match) return null;

  const [, day, month, hours, minutes = '00', ampm = 'am'] = match;

  const monthMap: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };

  let hour = parseInt(hours, 10);
  const ampmLower = ampm.toLowerCase();

  // Handle 12-hour to 24-hour conversion
  if (ampmLower === 'pm' && hour !== 12) {
    hour += 12;
  } else if (ampmLower === 'am' && hour === 12) {
    hour = 0;
  }

  const year = referenceDate.getFullYear();
  const monthNum = monthMap[month.toLowerCase()];

  let result = new Date(year, monthNum, parseInt(day, 10), hour, parseInt(minutes, 10));

  // Only assume next year if forwardDate is enabled AND date is in the past
  if (forwardDate && result < referenceDate) {
    result.setFullYear(year + 1);
  }

  // FIX A7: Apply timezone adjustment if provided
  if (timezone) {
    result = applyTimezoneToDate(result, timezone);
  }

  return result;
}

/**
 * Calculate when to send meeting link check email
 *
 * Rules:
 * - 24 hours after confirmation
 * - UNLESS that would be after appointment time
 * - Then send at least 4 hours before appointment
 * - If appointment is very soon (< 4 hours), return current time (send immediately)
 *
 * @param confirmedAt - When the appointment was confirmed
 * @param appointmentTime - The scheduled appointment datetime
 * @returns The datetime when meeting link check should be sent
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

  // If 24h after confirmation is before 4h before appointment, use 24h
  if (twentyFourHoursAfterConfirmation <= fourHoursBeforeAppointment) {
    return twentyFourHoursAfterConfirmation;
  }

  // Otherwise, use 4h before appointment (or now if that's already passed)
  const now = new Date();
  return fourHoursBeforeAppointment > now ? fourHoursBeforeAppointment : now;
}

/**
 * Calculate when to send feedback form
 *
 * Session is 50 minutes, send 1 hour after start (10 min buffer after session ends)
 *
 * @param appointmentTime - The scheduled appointment start time
 * @returns The datetime when feedback form should be sent
 */
export function calculateFeedbackFormTime(appointmentTime: Date): Date {
  // 1 hour after session start = 10 minutes after 50-minute session ends
  return new Date(appointmentTime.getTime() + 60 * 60 * 1000);
}

/**
 * Semantically compare two datetime strings
 * Returns true if both strings parse to the same date/time
 * (within a tolerance to handle minor formatting differences)
 *
 * @param datetime1 - First datetime string (e.g., "Monday 3rd February at 10:00am")
 * @param datetime2 - Second datetime string (e.g., "Monday 3 February at 10:00am")
 * @param toleranceMinutes - Maximum difference in minutes to consider equal (default 1)
 * @param options - Optional date parsing options (passed to parseConfirmedDateTime)
 * @returns True if the datetimes are semantically equal, false otherwise or on parse failure
 */
export function areDatetimesEqual(
  datetime1: string | null | undefined,
  datetime2: string | null | undefined,
  toleranceMinutes: number = 1,
  options: DateParseOptions = {}
): boolean {
  // Handle null/undefined cases
  if (!datetime1 && !datetime2) return true;
  if (!datetime1 || !datetime2) return false;

  // Quick check: exact string match
  if (datetime1 === datetime2) return true;

  // Semantic comparison: parse both and compare
  const date1 = parseConfirmedDateTime(datetime1, undefined, options);
  const date2 = parseConfirmedDateTime(datetime2, undefined, options);

  if (!date1 || !date2) {
    // If we can't parse one of them, fall back to string comparison
    return datetime1.toLowerCase().trim() === datetime2.toLowerCase().trim();
  }

  // Compare timestamps with tolerance
  const diffMs = Math.abs(date1.getTime() - date2.getTime());
  const toleranceMs = toleranceMinutes * 60 * 1000;

  return diffMs <= toleranceMs;
}

/**
 * Check if a datetime is in the past
 *
 * @param date - The date to check
 * @returns True if the date is in the past
 */
export function isInPast(date: Date): boolean {
  return date < new Date();
}

/**
 * Check if a datetime is within a certain number of hours from now
 *
 * @param date - The date to check
 * @param hours - Number of hours threshold
 * @returns True if the date is within the specified hours
 */
export function isWithinHours(date: Date, hours: number): boolean {
  const now = new Date();
  const threshold = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return date <= threshold && date > now;
}

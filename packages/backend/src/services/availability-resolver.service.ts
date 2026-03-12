/**
 * Availability Resolver Service
 *
 * Extracted from justin-time.service.ts — handles confirmation datetime
 * validation and availability-related checks used during tool execution.
 *
 * Responsibilities:
 *   - Validate confirmed_datetime strings before marking scheduling complete
 *   - Date/time parsing and semantic validation
 *   - Minimum booking lead-time enforcement
 *
 * The heavier availability formatting (slot rendering for emails) lives in
 * utils/availability-formatter.ts, and date parsing utilities live in
 * utils/date-parser.ts. This service composes those utilities into
 * business-rule validation used by the tool executor.
 */

import { logger } from '../utils/logger';
import { parseConfirmedDateTime, isTooSoonToBook, MIN_BOOKING_LEAD_HOURS } from '../utils/date-parser';

export class AvailabilityResolverService {
  /**
   * FIX RSA-2: Validate confirmed_datetime before marking complete
   *
   * Ensures the datetime string contains parseable date/time information.
   * Either the user or therapist can confirm (we don't require both),
   * but a valid datetime must be provided.
   *
   * @returns Error message if validation fails, null if valid
   */
  validateMarkComplete(confirmedDateTime: string): string | null {
    if (!confirmedDateTime || confirmedDateTime.trim().length === 0) {
      return 'confirmed_datetime is required';
    }

    // Check for minimum length (at least "Mon 10am" = 8 chars)
    if (confirmedDateTime.trim().length < 5) {
      return 'confirmed_datetime is too short to contain valid date/time information';
    }

    // Must contain at least a day reference or time reference
    const hasDayReference = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|tomorrow|today)\b/i.test(confirmedDateTime);
    const hasDateReference = /\b(\d{1,2}(?:st|nd|rd|th)?)\b/i.test(confirmedDateTime);
    const hasTimeReference = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.test(confirmedDateTime);
    const hasMonthReference = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(confirmedDateTime);

    // Must have EITHER (day or date or month) AND time
    const hasDateComponent = hasDayReference || hasDateReference || hasMonthReference;

    if (!hasDateComponent && !hasTimeReference) {
      return `confirmed_datetime "${confirmedDateTime}" does not contain recognizable date or time information. Expected format like "Monday 3rd February at 10:00am" or "Tuesday 2pm"`;
    }

    // If only has time but no date, that's a warning but we allow it
    // (agent might say "10am" when context makes the day clear)
    if (hasTimeReference && !hasDateComponent) {
      logger.warn(
        { confirmedDateTime },
        'confirmed_datetime has time but no date - relying on conversation context'
      );
    }

    // FIX: Reject appointments that are in the past or too soon (< 4 hours from now)
    const parsedDate = parseConfirmedDateTime(confirmedDateTime);
    if (parsedDate && isTooSoonToBook(parsedDate)) {
      logger.warn(
        { confirmedDateTime, parsed: parsedDate.toISOString() },
        'Rejected confirmed_datetime: appointment is in the past or less than 4 hours from now'
      );
      return `confirmed_datetime "${confirmedDateTime}" is in the past or less than ${MIN_BOOKING_LEAD_HOURS} hours from now. Please suggest a time that is at least ${MIN_BOOKING_LEAD_HOURS} hours in the future.`;
    }

    return null; // Valid
  }
}

export const availabilityResolver = new AvailabilityResolverService();

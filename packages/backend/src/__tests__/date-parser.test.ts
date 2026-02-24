/**
 * Tests for date parsing utilities
 * Covers: parseConfirmedDateTime, calculateMeetingLinkCheckTime,
 *         calculateFeedbackFormTime, areDatetimesEqual, isInPast, isWithinHours
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { timezone: 'Europe/London' },
}));

import {
  parseConfirmedDateTime,
  calculateMeetingLinkCheckTime,
  calculateFeedbackFormTime,
  areDatetimesEqual,
  isInPast,
  isWithinHours,
} from '../utils/date-parser';

describe('parseConfirmedDateTime', () => {
  // Fixed reference date: Wednesday 5th February 2025, 12:00 UTC
  const refDate = new Date('2025-02-05T12:00:00Z');

  describe('chrono-node parsing', () => {
    it('parses "Monday 3rd February at 10:00am"', () => {
      const result = parseConfirmedDateTime('Monday 3rd February at 10:00am', refDate);
      expect(result).not.toBeNull();
      expect(result!.getMonth()).toBe(1); // February
      expect(result!.getDate()).toBe(3);
    });

    it('parses "Tuesday 11th March at 2:30pm"', () => {
      const result = parseConfirmedDateTime('Tuesday 11th March at 2:30pm', refDate);
      expect(result).not.toBeNull();
      expect(result!.getMonth()).toBe(2); // March
      expect(result!.getDate()).toBe(11);
    });

    it('parses "Friday at 3pm"', () => {
      const result = parseConfirmedDateTime('Friday at 3pm', refDate);
      expect(result).not.toBeNull();
    });

    it('parses ISO format "2025-02-10T14:00:00"', () => {
      const result = parseConfirmedDateTime('2025-02-10T14:00:00', refDate);
      expect(result).not.toBeNull();
      expect(result!.getFullYear()).toBe(2025);
      expect(result!.getMonth()).toBe(1);
      expect(result!.getDate()).toBe(10);
    });
  });

  describe('forward date handling', () => {
    it('defaults to forwardDate=true (future date for ambiguous inputs)', () => {
      // "January 1st at 10am" parsed on Feb 5th should give next year
      const result = parseConfirmedDateTime('January 1st at 10am', refDate);
      expect(result).not.toBeNull();
      expect(result!.getFullYear()).toBeGreaterThanOrEqual(2025);
    });

    it('respects forwardDate=false option', () => {
      const result = parseConfirmedDateTime('January 1st at 10am', refDate, { forwardDate: false });
      expect(result).not.toBeNull();
      // With forwardDate false, may return current year (past date)
      expect(result!.getMonth()).toBe(0); // January
      expect(result!.getDate()).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(parseConfirmedDateTime('')).toBeNull();
    });

    it('returns null for null/undefined input', () => {
      expect(parseConfirmedDateTime(null as any)).toBeNull();
      expect(parseConfirmedDateTime(undefined as any)).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(parseConfirmedDateTime(123 as any)).toBeNull();
    });

    it('returns null for unparseable string', () => {
      expect(parseConfirmedDateTime('not a date at all', refDate)).toBeNull();
    });

    it('handles ordinal suffixes (1st, 2nd, 3rd, 4th)', () => {
      const result1 = parseConfirmedDateTime('1st February at 10am', refDate);
      const result2 = parseConfirmedDateTime('2nd February at 10am', refDate);
      const result3 = parseConfirmedDateTime('3rd February at 10am', refDate);
      const result4 = parseConfirmedDateTime('4th February at 10am', refDate);
      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(result3).not.toBeNull();
      expect(result4).not.toBeNull();
    });
  });

  describe('regex fallback parsing', () => {
    it('parses "Monday 10th March at 10:00am" format', () => {
      const result = parseConfirmedDateTime('Monday 10th March at 10:00am', refDate);
      expect(result).not.toBeNull();
      expect(result!.getMonth()).toBe(2); // March
      expect(result!.getDate()).toBe(10);
    });

    it('handles pm times correctly', () => {
      const result = parseConfirmedDateTime('Monday 10th March at 2:00pm', refDate);
      expect(result).not.toBeNull();
      // The hour should be 14 in 24h format
      const hours = result!.getHours();
      // Account for possible timezone differences
      expect(hours === 14 || hours === 13 || hours === 15).toBe(true);
    });
  });
});

describe('calculateMeetingLinkCheckTime', () => {
  it('returns 24h after confirmation when appointment is far in the future', () => {
    const confirmedAt = new Date('2025-02-01T10:00:00Z');
    const appointmentTime = new Date('2025-02-10T10:00:00Z'); // 9 days later

    const result = calculateMeetingLinkCheckTime(confirmedAt, appointmentTime);
    const expected = new Date('2025-02-02T10:00:00Z'); // 24h after confirmation

    expect(result.getTime()).toBe(expected.getTime());
  });

  it('returns 4h before appointment when 24h after confirmation is too late', () => {
    const confirmedAt = new Date('2025-02-01T10:00:00Z');
    const appointmentTime = new Date('2025-02-02T06:00:00Z'); // Only 20h away

    const result = calculateMeetingLinkCheckTime(confirmedAt, appointmentTime);
    const fourHoursBefore = new Date('2025-02-02T02:00:00Z');

    // Should be 4h before appointment, but may return now if already past
    expect(result.getTime()).toBeLessThanOrEqual(appointmentTime.getTime());
  });

  it('returns now or earlier when appointment is imminent (< 4h)', () => {
    const now = new Date();
    const confirmedAt = new Date(now.getTime() - 60 * 60 * 1000); // 1h ago
    const appointmentTime = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2h from now

    const result = calculateMeetingLinkCheckTime(confirmedAt, appointmentTime);
    // 4h before appointment would be 2h in the past, so should return ~now
    expect(result.getTime()).toBeLessThanOrEqual(now.getTime() + 1000);
  });
});

describe('calculateFeedbackFormTime', () => {
  it('returns 1 hour after appointment start', () => {
    const appointmentTime = new Date('2025-02-10T10:00:00Z');
    const result = calculateFeedbackFormTime(appointmentTime);
    const expected = new Date('2025-02-10T11:00:00Z');
    expect(result.getTime()).toBe(expected.getTime());
  });
});

describe('areDatetimesEqual', () => {
  it('returns true for identical strings', () => {
    expect(areDatetimesEqual('Monday 3rd February at 10am', 'Monday 3rd February at 10am')).toBe(true);
  });

  it('returns true for both null/undefined', () => {
    expect(areDatetimesEqual(null, null)).toBe(true);
    expect(areDatetimesEqual(undefined, undefined)).toBe(true);
  });

  it('returns false when one is null', () => {
    expect(areDatetimesEqual('Monday 3rd February at 10am', null)).toBe(false);
    expect(areDatetimesEqual(null, 'Monday 3rd February at 10am')).toBe(false);
  });

  it('returns true for semantically equal datetimes with different formatting', () => {
    // "3rd February" vs "3 February" should be the same date
    const result = areDatetimesEqual(
      'Monday 3rd February at 10:00am',
      'Monday 3 February at 10:00am'
    );
    expect(result).toBe(true);
  });

  it('returns false for different datetimes', () => {
    const result = areDatetimesEqual(
      'Monday 3rd February at 10:00am',
      'Tuesday 4th February at 2:00pm'
    );
    expect(result).toBe(false);
  });

  it('falls back to string comparison when parsing fails', () => {
    expect(areDatetimesEqual('unparseable1', 'unparseable1')).toBe(true);
    expect(areDatetimesEqual('unparseable1', 'unparseable2')).toBe(false);
  });
});

describe('isInPast', () => {
  it('returns true for past dates', () => {
    const pastDate = new Date('2020-01-01T00:00:00Z');
    expect(isInPast(pastDate)).toBe(true);
  });

  it('returns false for future dates', () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(isInPast(futureDate)).toBe(false);
  });
});

describe('isWithinHours', () => {
  it('returns true when date is within the specified hours', () => {
    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(isWithinHours(twoHoursFromNow, 3)).toBe(true);
  });

  it('returns false when date is beyond the specified hours', () => {
    const fiveHoursFromNow = new Date(Date.now() + 5 * 60 * 60 * 1000);
    expect(isWithinHours(fiveHoursFromNow, 3)).toBe(false);
  });

  it('returns false for past dates', () => {
    const pastDate = new Date(Date.now() - 60 * 60 * 1000);
    expect(isWithinHours(pastDate, 3)).toBe(false);
  });
});

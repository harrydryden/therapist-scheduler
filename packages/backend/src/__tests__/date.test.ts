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
  isTooSoonToBook,
  MIN_BOOKING_LEAD_HOURS,
} from '../utils/date';

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

  describe('timezone interpretation', () => {
    // The agent emits a wall-clock time without an explicit zone
    // ("Monday 10am"). The lifecycle service now passes the user's
    // timezone so the same string parses to different UTC instants
    // depending on where the user is. February → no DST in either zone.
    const refDate = new Date('2026-02-01T12:00:00Z');

    it('parses "10am" in America/New_York as 15:00 UTC (EST)', () => {
      const result = parseConfirmedDateTime(
        'Tuesday 3rd February at 10am',
        refDate,
        { timezone: 'America/New_York' },
      );
      expect(result).not.toBeNull();
      expect(result!.toISOString()).toBe('2026-02-03T15:00:00.000Z');
    });

    it('parses "10am" in Europe/London as 10:00 UTC (GMT)', () => {
      const result = parseConfirmedDateTime(
        'Tuesday 3rd February at 10am',
        refDate,
        { timezone: 'Europe/London' },
      );
      expect(result).not.toBeNull();
      expect(result!.toISOString()).toBe('2026-02-03T10:00:00.000Z');
    });

    it('parses "10am" in Asia/Singapore as 02:00 UTC (SGT)', () => {
      const result = parseConfirmedDateTime(
        'Tuesday 3rd February at 10am',
        refDate,
        { timezone: 'Asia/Singapore' },
      );
      expect(result).not.toBeNull();
      expect(result!.toISOString()).toBe('2026-02-03T02:00:00.000Z');
    });

    it('produces different UTC instants for different timezones with the same string', () => {
      // The whole point of the M9 fix: same wall-clock string, different
      // timezones, different absolute instants. If these collapse, we're
      // back to the previous bug where every appointment was assumed
      // Europe/London regardless of user country.
      const ny = parseConfirmedDateTime('Tuesday 3rd February at 10am', refDate, { timezone: 'America/New_York' });
      const london = parseConfirmedDateTime('Tuesday 3rd February at 10am', refDate, { timezone: 'Europe/London' });
      const singapore = parseConfirmedDateTime('Tuesday 3rd February at 10am', refDate, { timezone: 'Asia/Singapore' });
      expect(ny!.getTime()).not.toBe(london!.getTime());
      expect(ny!.getTime()).not.toBe(singapore!.getTime());
      expect(london!.getTime()).not.toBe(singapore!.getTime());
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
    // Use future dates so the "4h before appointment" path is taken
    // (not the "already past, return now" fallback)
    const now = new Date();
    const confirmedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
    const appointmentTime = new Date(now.getTime() + 10 * 60 * 60 * 1000); // 10h from now
    // 24h after confirmation = 22h from now, which is AFTER appointment
    // So it should use 4h before appointment = 6h from now

    const result = calculateMeetingLinkCheckTime(confirmedAt, appointmentTime);
    const fourHoursBefore = new Date(appointmentTime.getTime() - 4 * 60 * 60 * 1000);

    // Should be 4h before appointment (which is in the future)
    expect(result.getTime()).toBe(fourHoursBefore.getTime());
    expect(result.getTime()).toBeLessThan(appointmentTime.getTime());
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

describe('isTooSoonToBook', () => {
  it('returns true for past dates', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(isTooSoonToBook(yesterday)).toBe(true);
  });

  it('returns true for dates less than MIN_BOOKING_LEAD_HOURS from now', () => {
    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(isTooSoonToBook(twoHoursFromNow)).toBe(true);
  });

  it('returns true for dates exactly at the boundary', () => {
    // Exactly MIN_BOOKING_LEAD_HOURS from now (minus 1ms to be before the threshold)
    const justBefore = new Date(Date.now() + MIN_BOOKING_LEAD_HOURS * 60 * 60 * 1000 - 1);
    expect(isTooSoonToBook(justBefore)).toBe(true);
  });

  it('returns false for dates more than MIN_BOOKING_LEAD_HOURS from now', () => {
    const fiveHoursFromNow = new Date(Date.now() + 5 * 60 * 60 * 1000);
    expect(isTooSoonToBook(fiveHoursFromNow)).toBe(false);
  });

  it('returns false for dates far in the future', () => {
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect(isTooSoonToBook(nextWeek)).toBe(false);
  });

  it('has MIN_BOOKING_LEAD_HOURS set to 4', () => {
    expect(MIN_BOOKING_LEAD_HOURS).toBe(4);
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

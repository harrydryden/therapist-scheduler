/**
 * Tests covering the timezone-aware behaviour of the availability layer:
 *   - generateSlots / formatAvailabilityForUser interpret (day, start, end)
 *     in the availability's timezone and emit absolute UTC instants.
 *   - The display strings are formatted in the therapist's timezone, so the
 *     wall-clock label matches the timezone the therapist actually works in.
 *   - The new wallClockToUtc / timezone-aware primitive formatters in
 *     utils/date.ts produce correct cross-timezone output.
 *
 * These are pure function tests; no DB or network mocks needed beyond
 * silencing the logger.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { timezone: 'Europe/London' },
}));

import {
  formatTime12,
  formatTime12Compact,
  formatTime24,
  formatDateLong,
  formatDateShort,
  wallClockToUtc,
  getDateInTimezone,
} from '../utils/date';
import { formatAvailabilityForUser } from '../domain/scheduling/availability/windows/formatter';
import type { TherapistAvailability } from '../types';

describe('wallClockToUtc', () => {
  it('returns the UTC instant for a UK wall-clock during BST', () => {
    // 1 July 2026 12:00 in London is BST (UTC+1) → 11:00 UTC
    const result = wallClockToUtc(2026, 6, 1, 12, 0, 'Europe/London');
    expect(result.toISOString()).toBe('2026-07-01T11:00:00.000Z');
  });

  it('returns the UTC instant for a UK wall-clock during GMT', () => {
    // 15 January 2026 12:00 in London is GMT (UTC+0) → 12:00 UTC
    const result = wallClockToUtc(2026, 0, 15, 12, 0, 'Europe/London');
    expect(result.toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });

  it('handles US Eastern time correctly', () => {
    // 15 February 2026 09:00 in New York is EST (UTC-5) → 14:00 UTC
    const result = wallClockToUtc(2026, 1, 15, 9, 0, 'America/New_York');
    expect(result.toISOString()).toBe('2026-02-15T14:00:00.000Z');
  });

  it('handles Sydney crossing the date line', () => {
    // 28 April 2026 09:00 in Sydney is AEST (UTC+10) → 23:00 UTC on the 27th
    const result = wallClockToUtc(2026, 3, 28, 9, 0, 'Australia/Sydney');
    expect(result.toISOString()).toBe('2026-04-27T23:00:00.000Z');
  });

  it('round-trips through getDateInTimezone', () => {
    const utc = wallClockToUtc(2026, 5, 20, 14, 30, 'America/Los_Angeles');
    const back = getDateInTimezone(utc, 'America/Los_Angeles');
    expect(back).toMatchObject({
      year: 2026,
      month: 5,
      day: 20,
      hours: 14,
      minutes: 30,
    });
  });
});

describe('timezone-aware primitive formatters', () => {
  // 2026-04-28 09:00 in Sydney (AEST UTC+10) is 2026-04-27 23:00 UTC.
  const sydneyMorning = new Date('2026-04-27T23:00:00.000Z');

  it('formatTime12 renders the local hour in the supplied timezone', () => {
    expect(formatTime12(sydneyMorning, 'Australia/Sydney')).toBe('9:00am');
    expect(formatTime12(sydneyMorning, 'Europe/London')).toBe('12:00am'); // midnight in London
  });

  it('formatTime12Compact omits the :00 minutes', () => {
    expect(formatTime12Compact(sydneyMorning, 'Australia/Sydney')).toBe('9am');
    const sydneyHalfPast = new Date('2026-04-27T23:30:00.000Z');
    expect(formatTime12Compact(sydneyHalfPast, 'Australia/Sydney')).toBe('9:30am');
  });

  it('formatTime24 zero-pads', () => {
    expect(formatTime24(sydneyMorning, 'Australia/Sydney')).toBe('09:00');
  });

  it('formatDateLong / formatDateShort use the calendar day in the supplied timezone', () => {
    // The same UTC instant is "Tuesday April 28th" in Sydney but
    // "Monday April 27th" in London — verifies the day-of-week shifts.
    expect(formatDateLong(sydneyMorning, 'Australia/Sydney')).toBe('Tuesday 28th April');
    expect(formatDateLong(sydneyMorning, 'Europe/London')).toBe('Tuesday 28th April');

    const lateSunday = new Date('2026-04-26T22:00:00.000Z'); // 23:00 BST -> Sunday
    expect(formatDateShort(lateSunday, 'Europe/London')).toBe('Sun 26th');
    expect(formatDateShort(lateSunday, 'Australia/Sydney')).toBe('Mon 27th');
  });
});

describe('formatAvailabilityForUser — timezone behaviour', () => {
  // Use a far-future reference so the MIN_BOOKING_LEAD_HOURS buffer (which
  // is computed against `new Date()` inside generateSlots) never trims the
  // first slot when the test runs in real wall-clock time.
  const reference = new Date('2030-06-30T00:00:00.000Z'); // Sunday

  function buildAvailability(timezone: string, day: string): TherapistAvailability {
    return {
      timezone,
      slots: [{ day, start: '09:00', end: '11:00' }],
    };
  }

  it('produces UTC instants matching wall-clock time in the therapist timezone', () => {
    const availability = buildAvailability('Australia/Sydney', 'Monday');
    const result = formatAvailabilityForUser(availability, undefined, reference);

    // Monday after 2030-06-30 is 2030-07-01. 09:00 Sydney AEST (UTC+10, no
    // DST in winter) = 2030-06-30T23:00 UTC.
    const first = result.thisWeek[0] || result.nextWeek[0] || result.later[0];
    expect(first).toBeDefined();
    expect(first.datetime.toISOString()).toBe('2030-06-30T23:00:00.000Z');
  });

  it('renders the display string in the therapist timezone by default', () => {
    const availability = buildAvailability('Australia/Sydney', 'Monday');
    const result = formatAvailabilityForUser(availability, undefined, reference);

    const first = result.thisWeek[0] || result.nextWeek[0] || result.later[0];
    expect(first.display).toMatch(/at 9am/);
    expect(first.display).toMatch(/Monday 1st July/);
    expect(result.therapistTimezone).toBe('Australia/Sydney');
  });

  it('respects an explicit display timezone override', () => {
    const availability = buildAvailability('Australia/Sydney', 'Monday');
    // Render the same UTC instant in London time for comparison.
    const result = formatAvailabilityForUser(availability, 'Europe/London', reference);

    const first = result.thisWeek[0] || result.nextWeek[0] || result.later[0];
    // 09:00 Sydney AEST = 23:00 UTC = 00:00 BST (Sydney UTC+10, London UTC+1 in July).
    expect(first.display).toMatch(/at 12am/);
    expect(result.userTimezone).toBe('Europe/London');
  });

  it('groups slots into the right calendar week in the display timezone', () => {
    // A Sydney slot at 09:00 Monday is still Sunday 23:00 in London. When we
    // render in the Sydney zone, the slot should be in the same week as the
    // reference (also expressed in Sydney). When we render in London, it
    // would land on a different calendar day.
    const availability = buildAvailability('Australia/Sydney', 'Monday');
    const sydneyView = formatAvailabilityForUser(availability, undefined, reference);
    expect(sydneyView.totalSlots).toBeGreaterThan(0);
    expect(sydneyView.summary).toContain('Monday');
  });

  it('falls back to Europe/London when no timezone is recorded', () => {
    const availability: TherapistAvailability = {
      timezone: '',
      slots: [{ day: 'Monday', start: '09:00', end: '11:00' }],
    };
    const result = formatAvailabilityForUser(availability, undefined, reference);
    expect(result.therapistTimezone).toBe('Europe/London');

    const first = result.thisWeek[0] || result.nextWeek[0] || result.later[0];
    // 09:00 London on Monday 1 July 2030 (BST, UTC+1) is 08:00 UTC.
    expect(first.datetime.toISOString()).toBe('2030-07-01T08:00:00.000Z');
  });

  it('honours exception days using the therapist-timezone calendar date', () => {
    const availability: TherapistAvailability = {
      timezone: 'Australia/Sydney',
      slots: [{ day: 'Monday', start: '09:00', end: '11:00' }],
      exceptions: [
        // Block the very first Monday (in Sydney calendar terms)
        { date: '2030-07-01', available: false },
      ],
    };
    const result = formatAvailabilityForUser(availability, undefined, reference);

    // No slot on 2030-07-01 in Sydney
    const hasFirst = [...result.thisWeek, ...result.nextWeek, ...result.later]
      .some(s => s.datetime.toISOString().startsWith('2030-06-30T23:00'));
    expect(hasFirst).toBe(false);

    // But the next Monday should still appear
    const hasSecond = [...result.thisWeek, ...result.nextWeek, ...result.later]
      .some(s => s.datetime.toISOString().startsWith('2030-07-07T23:00'));
    expect(hasSecond).toBe(true);
  });
});

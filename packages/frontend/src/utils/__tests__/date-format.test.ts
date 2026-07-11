/**
 * Timezone tests for the admin UI's date helpers.
 *
 * These run under TZ=America/New_York (set in the `test` script) — five
 * hours behind the Europe/London zone every value here is defined in.
 * That is the point: every assertion doubles as proof that the helpers
 * are independent of the machine's local timezone. The original bug
 * these guard against was `new Date(pickerValue).toISOString()`
 * re-encoding a UK wall-clock against the admin's browser zone.
 */

import { describe, it, expect } from 'vitest';
import {
  londonWallClockToIso,
  toDatetimeLocalValue,
  datetimeLocalToLondonProse,
  formatDateTime,
} from '../date-format';

describe('londonWallClockToIso', () => {
  it('encodes a winter (GMT) wall-clock as the same UTC hour', () => {
    expect(londonWallClockToIso('2026-01-15T10:00')).toBe('2026-01-15T10:00:00.000Z');
  });

  it('encodes a summer (BST) wall-clock one hour earlier in UTC', () => {
    expect(londonWallClockToIso('2026-07-15T14:00')).toBe('2026-07-15T13:00:00.000Z');
  });

  it('handles the day straddle: London midnight in summer is 23:00Z the previous day', () => {
    expect(londonWallClockToIso('2026-07-15T00:00')).toBe('2026-07-14T23:00:00.000Z');
  });

  it('returns empty string for malformed input', () => {
    expect(londonWallClockToIso('')).toBe('');
    expect(londonWallClockToIso('not-a-date')).toBe('');
    expect(londonWallClockToIso('2026-07-15')).toBe('');
  });
});

describe('toDatetimeLocalValue', () => {
  it('renders an instant as its LONDON wall-clock, not the local zone', () => {
    // 13:00Z in July = 14:00 London = 09:00 New York. The machine runs in
    // New York; the picker must still show London time.
    expect(toDatetimeLocalValue('2026-07-15T13:00:00.000Z')).toBe('2026-07-15T14:00');
  });

  it('renders winter instants without the BST shift', () => {
    expect(toDatetimeLocalValue('2026-01-15T10:00:00.000Z')).toBe('2026-01-15T10:00');
  });

  it('returns empty string for null or unparseable values (legacy prose)', () => {
    expect(toDatetimeLocalValue(null)).toBe('');
    expect(toDatetimeLocalValue('Tuesday 23 June 2026 at 14:00')).toBe('');
  });
});

describe('picker round-trip (seed → save)', () => {
  it.each(['2026-01-15T10:30', '2026-07-15T14:00', '2026-03-29T09:00', '2026-10-25T09:00'])(
    'toDatetimeLocalValue(londonWallClockToIso(%s)) is the identity',
    (wallClock) => {
      expect(toDatetimeLocalValue(londonWallClockToIso(wallClock))).toBe(wallClock);
    },
  );
});

describe('datetimeLocalToLondonProse', () => {
  it('produces the explicit UK prose wire format', () => {
    expect(datetimeLocalToLondonProse('2026-07-14T14:00')).toBe('Tuesday 14 July 2026 at 14:00');
  });

  it('names the weekday of the LONDON calendar date, not the local one', () => {
    // London midnight Wed 15 July = still Tue 14 July in New York; the
    // prose must say Wednesday.
    expect(datetimeLocalToLondonProse('2026-07-15T00:00')).toBe('Wednesday 15 July 2026 at 00:00');
  });

  it('returns empty string for malformed input', () => {
    expect(datetimeLocalToLondonProse('nope')).toBe('');
  });
});

describe('formatDateTime', () => {
  it('renders instants in London time regardless of the machine zone', () => {
    expect(formatDateTime('2026-07-15T13:00:00.000Z')).toBe('15 Jul 2026, 14:00');
    expect(formatDateTime('2026-01-15T10:00:00.000Z')).toBe('15 Jan 2026, 10:00');
  });

  it('keeps the London calendar day across the UTC midnight boundary', () => {
    // 23:30Z on the 14th during BST is already 00:30 on the 15th in London.
    expect(formatDateTime('2026-07-14T23:30:00.000Z')).toBe('15 Jul 2026, 00:30');
  });

  it('handles null and invalid input', () => {
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime('Tuesday at 11am')).toBe('Invalid Date');
  });
});

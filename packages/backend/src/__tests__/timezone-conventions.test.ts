/**
 * Cross-layer timezone convention tests.
 *
 * Locks in the contracts the timezone audit consolidated onto:
 *
 *   1. The admin-UI wire format — the explicit UK prose string both
 *      frontend editors submit ("Tuesday 14 July 2026 at 14:00") —
 *      chrono-parses under the platform default to the exact instant
 *      the admin picked, in both BST and GMT.
 *   2. `parseConfirmedDateTime` interprets ISO-with-offset strings
 *      (the mark_scheduling_complete structured form's output)
 *      exactly, ignoring the platform timezone.
 *   3. One string, one instant: the default parse used by validation,
 *      storage, follow-ups, and admin routes is deterministic — the
 *      historic bug was the storage path using the USER's timezone
 *      while validation used the platform's.
 *   4. Legacy day-keyed availability keeps Sunday (index 0 is falsy;
 *      a truthiness check silently dropped it).
 *   5. `formatLondonDate` renders the LONDON calendar day for
 *      late-evening BST instants that have already rolled over.
 *
 * Pure function tests; only logger/config/settings mocks needed.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { timezone: 'Europe/London' },
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(),
}));

import { parseConfirmedDateTime, formatLondonDate } from '../utils/date';
import { formatAvailabilityForUser } from '../domain/scheduling/availability/windows/formatter';

describe('admin-UI wire format → stored instant', () => {
  // A reference date makes year resolution deterministic.
  const ref = new Date('2026-07-01T09:00:00Z');

  it('parses the UK prose format to the intended instant during BST', () => {
    const parsed = parseConfirmedDateTime('Tuesday 14 July 2026 at 14:00', ref);
    expect(parsed?.toISOString()).toBe('2026-07-14T13:00:00.000Z'); // 14:00 BST
  });

  it('parses the UK prose format to the intended instant during GMT', () => {
    const parsed = parseConfirmedDateTime('Friday 15 January 2027 at 10:30', ref);
    expect(parsed?.toISOString()).toBe('2027-01-15T10:30:00.000Z'); // 10:30 GMT
  });

  it('round-trips a prose string generated for London midnight (day straddle)', () => {
    const parsed = parseConfirmedDateTime('Wednesday 15 July 2026 at 00:00', ref);
    expect(parsed?.toISOString()).toBe('2026-07-14T23:00:00.000Z');
  });
});

describe('structured-form ISO output → stored instant', () => {
  it('honours an explicit offset exactly, ignoring the platform timezone', () => {
    // What mark_scheduling_complete's structured form synthesises for
    // "3pm New York" — must store 19:00Z, not be re-read as London.
    const parsed = parseConfirmedDateTime('2026-07-14T15:00:00-04:00');
    expect(parsed?.toISOString()).toBe('2026-07-14T19:00:00.000Z');
  });

  it('honours Z-suffixed UTC strings exactly', () => {
    const parsed = parseConfirmedDateTime('2026-07-14T13:00:00Z');
    expect(parsed?.toISOString()).toBe('2026-07-14T13:00:00.000Z');
  });
});

describe('one string, one instant', () => {
  it('the default parse is deterministic across repeated calls (validation vs storage)', () => {
    const s = 'Tuesday 14 July 2026 at 14:00';
    const a = parseConfirmedDateTime(s, new Date('2026-07-01T09:00:00Z'));
    const b = parseConfirmedDateTime(s, new Date('2026-07-01T09:00:00Z'));
    expect(a?.getTime()).toBe(b?.getTime());
  });
});

describe('legacy day-keyed availability', () => {
  it('keeps Sunday slots (day index 0 must not be treated as falsy)', () => {
    const legacy = {
      timezone: 'Europe/London',
      Sunday: '09:00-12:00',
      Monday: '09:00-12:00',
    } as Record<string, unknown>;

    const result = formatAvailabilityForUser(legacy, undefined, new Date('2026-07-01T09:00:00Z'));

    const allSlots = [...result.thisWeek, ...result.nextWeek, ...result.later];
    const daysSeen = new Set(
      allSlots.map((s) =>
        s.datetime.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/London' }),
      ),
    );
    expect(daysSeen).toContain('Sunday');
    expect(daysSeen).toContain('Monday');
  });
});

describe('formatLondonDate', () => {
  it('renders the LONDON calendar day for a late-evening BST instant', () => {
    // 23:30Z on 14 July = 00:30 BST on 15 July.
    expect(formatLondonDate(new Date('2026-07-14T23:30:00Z'))).toBe('15 July 2026');
  });

  it('renders winter instants without a shift', () => {
    expect(formatLondonDate(new Date('2026-01-14T23:30:00Z'))).toBe('14 January 2026');
  });
});

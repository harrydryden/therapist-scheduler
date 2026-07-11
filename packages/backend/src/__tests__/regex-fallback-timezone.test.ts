/**
 * Timezone behaviour of parseConfirmedDateTime's REGEX fallback.
 *
 * chrono-node is mocked to return no results — in production chrono
 * handles almost every string the regex can, so this path is only
 * reachable when chrono fails, and it can't be exercised honestly
 * through real inputs. The fallback must still convert wall-clock
 * components in the target timezone via Intl (wallClockToUtc), not
 * via server-local Date construction: these tests pin that down and
 * pass under any system TZ.
 */

jest.mock('chrono-node', () => ({
  parse: jest.fn(() => []),
}));

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { timezone: 'Europe/London' },
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(),
}));

import { parseConfirmedDateTime } from '../utils/date';

describe('regex fallback — timezone conversion', () => {
  it('resolves a summer wall-clock as BST', () => {
    const parsed = parseConfirmedDateTime(
      'Tuesday 14th July at 2:00pm',
      new Date('2026-07-01T09:00:00Z'),
    );
    expect(parsed?.toISOString()).toBe('2026-07-14T13:00:00.000Z'); // 14:00 BST
  });

  it('resolves a winter wall-clock as GMT', () => {
    const parsed = parseConfirmedDateTime(
      'Friday 15th January at 10:30am',
      new Date('2026-01-02T09:00:00Z'),
    );
    expect(parsed?.toISOString()).toBe('2026-01-15T10:30:00.000Z');
  });

  it('takes the reference year from the LONDON calendar, not the server-local one', () => {
    // Reference is 00:30 UTC on 1 Jan 2026 — already 2026 in London and
    // UTC, but still 31 Dec 2025 in e.g. New York. The old
    // getFullYear() read made the year (and therefore the forwardDate
    // roll) depend on the process TZ.
    const parsed = parseConfirmedDateTime(
      'Sunday 8th March at 10:00am',
      new Date('2026-01-01T00:30:00Z'),
    );
    expect(parsed?.toISOString()).toBe('2026-03-08T10:00:00.000Z'); // GMT
  });

  it('rolls a past date forward a year when forwardDate is set (default)', () => {
    const parsed = parseConfirmedDateTime(
      'Monday 2nd February at 9:00am',
      new Date('2026-06-01T09:00:00Z'),
    );
    expect(parsed?.toISOString()).toBe('2027-02-02T09:00:00.000Z'); // GMT, next year
  });

  it('keeps a past date literal with forwardDate: false', () => {
    const parsed = parseConfirmedDateTime(
      'Monday 2nd February at 9:00am',
      new Date('2026-06-01T09:00:00Z'),
      { forwardDate: false },
    );
    expect(parsed?.toISOString()).toBe('2026-02-02T09:00:00.000Z');
  });
});

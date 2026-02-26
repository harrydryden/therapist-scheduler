/**
 * Tests for email date formatting utility
 * Covers: formatEmailDate, formatEmailDateFromSettings
 */

// Mock logger to prevent actual logging during tests
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock settings service
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(),
}));

import { formatEmailDate, formatEmailDateFromSettings } from '../utils/email-date-formatter';
import { getSettingValue } from '../services/settings.service';

const mockGetSettingValue = getSettingValue as jest.MockedFunction<typeof getSettingValue>;

describe('formatEmailDate', () => {
  const timezone = 'Europe/London';

  describe('relative day prefixes', () => {
    it('formats "today" for same-day appointments', () => {
      // Wednesday 5 Feb 2025 at 10:00 UTC
      const now = new Date('2025-02-05T09:00:00Z');
      const appointment = new Date('2025-02-05T14:30:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toBe('today February 5th at 14:30');
    });

    it('formats "tomorrow" for next-day appointments', () => {
      const now = new Date('2025-02-05T09:00:00Z');
      const appointment = new Date('2025-02-06T13:45:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toBe('tomorrow February 6th at 13:45');
    });

    it('formats "this [Day]" for same-week appointments', () => {
      // Monday 3 Feb 2025, checking Thursday 6 Feb
      const now = new Date('2025-02-03T09:00:00Z');
      const appointment = new Date('2025-02-06T09:30:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toBe('this Thursday February 6th at 09:30');
    });

    it('formats "next [Day]" for next-week appointments', () => {
      // Monday 3 Feb 2025, checking next Monday 10 Feb
      const now = new Date('2025-02-03T09:00:00Z');
      const appointment = new Date('2025-02-10T10:00:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toBe('next Monday February 10th at 10:00');
    });

    it('formats "next [Day]" for next-week appointments from mid-week', () => {
      // Wednesday 5 Feb 2025, checking next Tuesday 11 Feb
      const now = new Date('2025-02-05T09:00:00Z');
      const appointment = new Date('2025-02-11T14:00:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toBe('next Tuesday February 11th at 14:00');
    });

    it('uses day name only for appointments far out', () => {
      // Monday 3 Feb 2025, checking Monday 17 Feb (2 weeks out)
      const now = new Date('2025-02-03T09:00:00Z');
      const appointment = new Date('2025-02-17T11:00:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toBe('Monday February 17th at 11:00');
    });
  });

  describe('24-hour time format', () => {
    it('formats morning time in 24h', () => {
      const now = new Date('2025-02-05T06:00:00Z');
      const appointment = new Date('2025-02-20T09:30:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toContain('at 09:30');
    });

    it('formats afternoon time in 24h', () => {
      const now = new Date('2025-02-05T06:00:00Z');
      const appointment = new Date('2025-02-20T15:45:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toContain('at 15:45');
    });

    it('formats midnight in 24h', () => {
      const now = new Date('2025-02-05T06:00:00Z');
      const appointment = new Date('2025-02-20T00:00:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toContain('at 00:00');
    });
  });

  describe('12-hour time format', () => {
    it('formats morning time in 12h', () => {
      const now = new Date('2025-02-05T06:00:00Z');
      const appointment = new Date('2025-02-20T09:30:00Z');

      const result = formatEmailDate(appointment, timezone, false, now);
      expect(result).toContain('at 9:30am');
    });

    it('formats afternoon time in 12h', () => {
      const now = new Date('2025-02-05T06:00:00Z');
      const appointment = new Date('2025-02-20T15:45:00Z');

      const result = formatEmailDate(appointment, timezone, false, now);
      expect(result).toContain('at 3:45pm');
    });

    it('formats noon in 12h', () => {
      const now = new Date('2025-02-05T06:00:00Z');
      const appointment = new Date('2025-02-20T12:00:00Z');

      const result = formatEmailDate(appointment, timezone, false, now);
      expect(result).toContain('at 12:00pm');
    });
  });

  describe('ordinal suffixes', () => {
    it('uses "st" for 1st', () => {
      const now = new Date('2025-02-25T06:00:00Z');
      const appointment = new Date('2025-03-01T10:00:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toContain('March 1st');
    });

    it('uses "nd" for 2nd', () => {
      const now = new Date('2025-02-25T06:00:00Z');
      const appointment = new Date('2025-03-02T10:00:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toContain('March 2nd');
    });

    it('uses "rd" for 3rd', () => {
      const now = new Date('2025-02-25T06:00:00Z');
      const appointment = new Date('2025-03-03T10:00:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toContain('March 3rd');
    });

    it('uses "th" for 4th-20th', () => {
      const now = new Date('2025-02-25T06:00:00Z');
      const appointment = new Date('2025-03-13T10:00:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toContain('March 13th');
    });

    it('uses "st" for 21st', () => {
      const now = new Date('2025-02-25T06:00:00Z');
      const appointment = new Date('2025-03-21T10:00:00Z');

      const result = formatEmailDate(appointment, timezone, true, now);
      expect(result).toContain('March 21st');
    });
  });

  describe('timezone handling', () => {
    it('converts UTC to Europe/London (GMT)', () => {
      // In winter (GMT = UTC+0), times should match
      const now = new Date('2025-01-10T06:00:00Z');
      const appointment = new Date('2025-01-15T14:30:00Z');

      const result = formatEmailDate(appointment, 'Europe/London', true, now);
      expect(result).toContain('at 14:30');
    });

    it('converts UTC to Europe/London (BST)', () => {
      // In summer (BST = UTC+1), 14:30 UTC = 15:30 BST
      const now = new Date('2025-06-10T06:00:00Z');
      const appointment = new Date('2025-06-15T14:30:00Z');

      const result = formatEmailDate(appointment, 'Europe/London', true, now);
      expect(result).toContain('at 15:30');
    });

    it('converts UTC to America/New_York (EST)', () => {
      // EST = UTC-5, so 14:30 UTC = 9:30 EST
      const now = new Date('2025-01-10T06:00:00Z');
      const appointment = new Date('2025-01-15T14:30:00Z');

      const result = formatEmailDate(appointment, 'America/New_York', true, now);
      expect(result).toContain('at 09:30');
    });
  });

  describe('month names', () => {
    it('formats all months correctly', () => {
      const now = new Date('2025-01-01T06:00:00Z');

      const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ];

      for (let m = 0; m < 12; m++) {
        const date = new Date(2025, m, 15, 10, 0);
        const result = formatEmailDate(date, 'UTC', true, now);
        expect(result).toContain(months[m]);
      }
    });
  });
});

describe('formatEmailDateFromSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns formatted date when parsed date is available', async () => {
    mockGetSettingValue.mockImplementation(((key: string) => {
      if (key === 'general.timezone') return Promise.resolve('Europe/London');
      if (key === 'email.use24HourTime') return Promise.resolve(true);
      return Promise.resolve('');
    }) as typeof getSettingValue);

    const parsedDate = new Date('2025-02-13T13:45:00Z');
    const result = await formatEmailDateFromSettings(
      parsedDate,
      'Thursday 13th February at 1:45pm',
      new Date('2025-02-12T09:00:00Z'),
    );

    expect(result).toBe('tomorrow February 13th at 13:45');
  });

  it('uses 12-hour format when setting is false', async () => {
    mockGetSettingValue.mockImplementation(((key: string) => {
      if (key === 'general.timezone') return Promise.resolve('Europe/London');
      if (key === 'email.use24HourTime') return Promise.resolve(false);
      return Promise.resolve('');
    }) as typeof getSettingValue);

    const parsedDate = new Date('2025-02-13T13:45:00Z');
    const result = await formatEmailDateFromSettings(
      parsedDate,
      'Thursday 13th February at 1:45pm',
      new Date('2025-02-12T09:00:00Z'),
    );

    expect(result).toBe('tomorrow February 13th at 1:45pm');
  });

  it('falls back to raw string when parsed date is null', async () => {
    const result = await formatEmailDateFromSettings(
      null,
      'Monday 3rd February at 10:00am',
    );

    expect(result).toBe('Monday 3rd February at 10:00am');
  });

  it('falls back to default when both dates are null', async () => {
    const result = await formatEmailDateFromSettings(null, null);
    expect(result).toBe('your scheduled time');
  });

  it('falls back to raw string when settings fail', async () => {
    mockGetSettingValue.mockRejectedValue(new Error('Settings unavailable'));

    const parsedDate = new Date('2025-02-13T13:45:00Z');
    const result = await formatEmailDateFromSettings(
      parsedDate,
      'Thursday 13th February at 1:45pm',
    );

    expect(result).toBe('Thursday 13th February at 1:45pm');
  });
});

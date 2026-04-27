/**
 * Unit tests for parseDayStringsToSlots and buildPersistedAvailability — the
 * bridges that convert the agent's `{ Monday: "09:00-12:00, 14:00-17:00" }`
 * shape into structured AvailabilitySlot/TherapistAvailability objects
 * before they're persisted to Postgres.
 */

import {
  parseDayStringsToSlots,
  buildPersistedAvailability,
} from '../services/availability-day-parser';
import type { TherapistAvailability } from '@therapist-scheduler/shared';

describe('parseDayStringsToSlots', () => {
  it('parses a single range per day', () => {
    expect(parseDayStringsToSlots({ Monday: '09:00-17:00' })).toEqual([
      { day: 'Monday', start: '09:00', end: '17:00' },
    ]);
  });

  it('splits multiple comma-separated ranges into separate slots', () => {
    expect(parseDayStringsToSlots({ Tuesday: '09:00-12:00, 14:00-17:00' })).toEqual([
      { day: 'Tuesday', start: '09:00', end: '12:00' },
      { day: 'Tuesday', start: '14:00', end: '17:00' },
    ]);
  });

  it('handles multiple days', () => {
    const result = parseDayStringsToSlots({
      Monday: '09:00-12:00',
      Wednesday: '13:00-15:00',
    });
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.day).sort()).toEqual(['Monday', 'Wednesday']);
  });

  it('normalises lowercase day names to capitalised form', () => {
    expect(parseDayStringsToSlots({ monday: '09:00-10:00' })).toEqual([
      { day: 'Monday', start: '09:00', end: '10:00' },
    ]);
  });

  it('drops unrecognised day names', () => {
    const result = parseDayStringsToSlots({
      Funday: '09:00-12:00',
      Tuesday: '10:00-11:00',
    });
    expect(result).toEqual([{ day: 'Tuesday', start: '10:00', end: '11:00' }]);
  });

  it('drops malformed time ranges but keeps valid ones', () => {
    const result = parseDayStringsToSlots({
      Monday: '09:00-12:00, not-a-range, 14:00-17:00',
    });
    expect(result).toEqual([
      { day: 'Monday', start: '09:00', end: '12:00' },
      { day: 'Monday', start: '14:00', end: '17:00' },
    ]);
  });

  it('returns an empty array for empty / null / undefined input', () => {
    expect(parseDayStringsToSlots({})).toEqual([]);
    expect(parseDayStringsToSlots(null)).toEqual([]);
    expect(parseDayStringsToSlots(undefined)).toEqual([]);
  });

  it('ignores empty-string day values', () => {
    expect(parseDayStringsToSlots({ Monday: '', Tuesday: '09:00-12:00' })).toEqual([
      { day: 'Tuesday', start: '09:00', end: '12:00' },
    ]);
  });

  it('tolerates whitespace around hyphens', () => {
    expect(parseDayStringsToSlots({ Friday: '09:00 - 12:00' })).toEqual([
      { day: 'Friday', start: '09:00', end: '12:00' },
    ]);
  });
});

describe('buildPersistedAvailability', () => {
  const slots = [{ day: 'Monday', start: '09:00', end: '17:00' }];

  it('uses the existing timezone when one is recorded', () => {
    const existing: TherapistAvailability = {
      timezone: 'America/Los_Angeles',
      slots: [{ day: 'Tuesday', start: '10:00', end: '11:00' }],
    };
    const result = buildPersistedAvailability({
      slots,
      existing,
      country: 'AU', // multi-timezone — should be ignored
      platformTimezone: 'Europe/London',
    });
    expect(result.timezone).toBe('America/Los_Angeles');
    expect(result.slots).toEqual(slots);
  });

  it('falls back to the country default when no existing timezone', () => {
    const result = buildPersistedAvailability({
      slots,
      existing: null,
      country: 'IE',
      platformTimezone: 'Europe/London',
    });
    expect(result.timezone).toBe('Europe/Dublin');
  });

  it('falls back to the platform timezone for multi-timezone countries with no existing record', () => {
    // US has multiple timezones, so getDefaultTimezone returns null and we
    // should land on the platform default. Logged for admin follow-up.
    const result = buildPersistedAvailability({
      slots,
      existing: null,
      country: 'US',
      platformTimezone: 'Europe/London',
    });
    expect(result.timezone).toBe('Europe/London');
  });

  it('preserves existing exceptions through the update', () => {
    const existing: TherapistAvailability = {
      timezone: 'Europe/London',
      slots: [],
      exceptions: [{ date: '2026-12-25', available: false }],
    };
    const result = buildPersistedAvailability({
      slots,
      existing,
      country: 'UK',
      platformTimezone: 'Europe/London',
    });
    expect(result.exceptions).toEqual([{ date: '2026-12-25', available: false }]);
  });

  it('omits exceptions when the existing record had none', () => {
    const result = buildPersistedAvailability({
      slots,
      existing: null,
      country: 'UK',
      platformTimezone: 'Europe/London',
    });
    expect(result.exceptions).toBeUndefined();
  });

  it('replaces only the slots, not the timezone or exceptions', () => {
    const existing: TherapistAvailability = {
      timezone: 'Europe/Berlin',
      slots: [{ day: 'Wednesday', start: '08:00', end: '09:00' }],
      exceptions: [{ date: '2026-08-01', available: false }],
    };
    const newSlots = [{ day: 'Friday', start: '14:00', end: '15:00' }];
    const result = buildPersistedAvailability({
      slots: newSlots,
      existing,
      country: 'DE',
      platformTimezone: 'Europe/London',
    });
    expect(result).toEqual({
      timezone: 'Europe/Berlin',
      slots: newSlots,
      exceptions: [{ date: '2026-08-01', available: false }],
    });
  });
});

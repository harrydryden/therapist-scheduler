/**
 * Unit tests for parseDayStringsToSlots — the bridge that converts the
 * agent's `{ Monday: "09:00-12:00, 14:00-17:00" }` shape into structured
 * AvailabilitySlot objects before they're persisted to Postgres.
 */

import { parseDayStringsToSlots } from '../services/availability-day-parser';

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

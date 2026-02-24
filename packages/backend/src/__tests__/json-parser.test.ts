/**
 * Tests for JSON parsing utilities
 * Covers: safeJsonParse, parseConversationState, parseTherapistAvailability,
 *         safeJsonStringify, size limits
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { z } from 'zod';
import {
  safeJsonParse,
  parseConversationState,
  parseTherapistAvailability,
  safeJsonStringify,
} from '../utils/json-parser';

describe('safeJsonParse', () => {
  describe('basic parsing', () => {
    it('parses valid JSON', () => {
      const result = safeJsonParse('{"key": "value"}', {});
      expect(result).toEqual({ key: 'value' });
    });

    it('returns fallback for null input', () => {
      expect(safeJsonParse(null, 'default')).toBe('default');
    });

    it('returns fallback for undefined input', () => {
      expect(safeJsonParse(undefined, 'default')).toBe('default');
    });

    it('returns fallback for empty string', () => {
      expect(safeJsonParse('', 'default')).toBe('default');
    });

    it('returns fallback for invalid JSON', () => {
      expect(safeJsonParse('{not valid json}', 'default')).toBe('default');
    });

    it('parses arrays', () => {
      const result = safeJsonParse('[1, 2, 3]', []);
      expect(result).toEqual([1, 2, 3]);
    });

    it('parses numbers', () => {
      expect(safeJsonParse('42', 0)).toBe(42);
    });

    it('parses booleans', () => {
      expect(safeJsonParse('true', false)).toBe(true);
    });
  });

  describe('schema validation', () => {
    const testSchema = z.object({
      name: z.string(),
      age: z.number(),
    });

    it('validates against schema and returns data on success', () => {
      const result = safeJsonParse(
        '{"name": "Alice", "age": 30}',
        null,
        { schema: testSchema }
      );
      expect(result).toEqual({ name: 'Alice', age: 30 });
    });

    it('returns fallback when schema validation fails', () => {
      const result = safeJsonParse(
        '{"name": "Alice", "age": "not a number"}',
        null,
        { schema: testSchema }
      );
      expect(result).toBeNull();
    });

    it('returns fallback when required fields are missing', () => {
      const result = safeJsonParse(
        '{"name": "Alice"}',
        null,
        { schema: testSchema }
      );
      expect(result).toBeNull();
    });
  });

  describe('size limits', () => {
    it('rejects JSON exceeding default size limit', () => {
      const largeJson = JSON.stringify({ data: 'x'.repeat(1_100_000) });
      const result = safeJsonParse(largeJson, 'fallback');
      expect(result).toBe('fallback');
    });

    it('respects custom maxSize', () => {
      const json = JSON.stringify({ data: 'x'.repeat(200) });
      const result = safeJsonParse(json, 'fallback', { maxSize: 100 });
      expect(result).toBe('fallback');
    });

    it('accepts JSON within size limit', () => {
      const json = JSON.stringify({ key: 'value' });
      const result = safeJsonParse(json, 'fallback', { maxSize: 1000 });
      expect(result).toEqual({ key: 'value' });
    });
  });
});

describe('parseConversationState', () => {
  const validState = {
    systemPrompt: 'You are a scheduling assistant.',
    messages: [
      { role: 'user', content: 'Hello', timestamp: '2025-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Hi there!' },
    ],
  };

  it('parses valid conversation state object', () => {
    const result = parseConversationState(validState);
    expect(result).not.toBeNull();
    expect(result!.systemPrompt).toBe('You are a scheduling assistant.');
    expect(result!.messages).toHaveLength(2);
  });

  it('parses valid conversation state JSON string', () => {
    const result = parseConversationState(JSON.stringify(validState));
    expect(result).not.toBeNull();
    expect(result!.systemPrompt).toBe('You are a scheduling assistant.');
  });

  it('returns null for null input', () => {
    expect(parseConversationState(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseConversationState(undefined)).toBeNull();
  });

  it('returns null for invalid JSON string', () => {
    expect(parseConversationState('{bad json}')).toBeNull();
  });

  it('salvages partial data with loose validation', () => {
    const partial = {
      systemPrompt: 'Test prompt',
      messages: [{ content: 'Hello' }], // Missing 'role'
    };
    const result = parseConversationState(partial);
    expect(result).not.toBeNull();
    expect(result!.messages[0].role).toBe('user'); // Default
    expect(result!.messages[0].content).toBe('Hello');
  });

  it('returns null for completely invalid data', () => {
    const invalid = { foo: 'bar', baz: 42 };
    expect(parseConversationState(invalid)).toBeNull();
  });

  it('rejects oversized conversation state strings', () => {
    const hugeState = JSON.stringify({
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'x'.repeat(600_000) }],
    });
    expect(parseConversationState(hugeState)).toBeNull();
  });
});

describe('parseTherapistAvailability', () => {
  const validAvailability = {
    timezone: 'Europe/London',
    slots: [
      { day: 'Monday', start: '09:00', end: '17:00' },
      { day: 'Wednesday', start: '10:00', end: '14:00' },
    ],
    exceptions: [
      { date: '2025-02-14', available: false },
    ],
  };

  it('parses valid availability object', () => {
    const result = parseTherapistAvailability(validAvailability);
    expect(result).not.toBeNull();
    expect(result!.timezone).toBe('Europe/London');
    expect(result!.slots).toHaveLength(2);
    expect(result!.exceptions).toHaveLength(1);
  });

  it('parses valid availability JSON string', () => {
    const result = parseTherapistAvailability(JSON.stringify(validAvailability));
    expect(result).not.toBeNull();
    expect(result!.timezone).toBe('Europe/London');
  });

  it('returns null for null input', () => {
    expect(parseTherapistAvailability(null)).toBeNull();
  });

  it('returns null for invalid JSON string', () => {
    expect(parseTherapistAvailability('{bad json}')).toBeNull();
  });

  it('parses availability without exceptions', () => {
    const withoutExceptions = {
      timezone: 'US/Eastern',
      slots: [{ day: 'Tuesday', start: '08:00', end: '12:00' }],
    };
    const result = parseTherapistAvailability(withoutExceptions);
    expect(result).not.toBeNull();
    expect(result!.exceptions).toBeUndefined();
  });

  it('salvages partial data with loose validation', () => {
    const partial = {
      timezone: 'UTC',
      slots: [{ day: 'Mon' }], // Missing start/end
    };
    const result = parseTherapistAvailability(partial);
    expect(result).not.toBeNull();
    expect(result!.slots[0].day).toBe('Mon');
    expect(result!.slots[0].start).toBe('');
  });

  it('rejects oversized availability strings', () => {
    const hugeAvail = JSON.stringify({
      timezone: 'UTC',
      slots: Array(1000).fill({ day: 'Monday', start: '09:00', end: 'x'.repeat(100) }),
    });
    expect(parseTherapistAvailability(hugeAvail)).toBeNull();
  });
});

describe('safeJsonStringify', () => {
  it('stringifies objects', () => {
    expect(safeJsonStringify({ key: 'value' })).toBe('{"key":"value"}');
  });

  it('stringifies arrays', () => {
    expect(safeJsonStringify([1, 2, 3])).toBe('[1,2,3]');
  });

  it('returns "{}" for circular references', () => {
    const circular: any = {};
    circular.self = circular;
    expect(safeJsonStringify(circular)).toBe('{}');
  });

  it('stringifies null', () => {
    expect(safeJsonStringify(null)).toBe('null');
  });
});

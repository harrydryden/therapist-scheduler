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
  isConversationStage,
} from '../utils/json-parser';
import { CONVERSATION_LIMITS } from '../constants';

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
      messages: [{ role: 'user', content: 'x'.repeat(CONVERSATION_LIMITS.MAX_STATE_BYTES * 2 + 1) }],
    });
    expect(parseConversationState(hugeState)).toBeNull();
  });

  // Regression (review #10): the read limit (500,000) sat BELOW the
  // writer's trim cap (512,000), so a state the writer happily saved was
  // unreadable on the next turn ("Conversation state not found").
  it('reads back any state up to (and beyond) the writer\'s trim cap', () => {
    const atCap = JSON.stringify({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'x'.repeat(CONVERSATION_LIMITS.MAX_STATE_BYTES - 64) }],
    });
    expect(atCap.length).toBeLessThanOrEqual(CONVERSATION_LIMITS.MAX_STATE_BYTES);
    expect(atCap.length).toBeGreaterThan(500_000);
    expect(parseConversationState(atCap)).not.toBeNull();
  });
});

// Regression for A1: the zod schema used to declare only systemPrompt +
// messages, and zod's default strip mode silently discarded everything
// else — so every read lost the agent's checkpoint (each turn restarted at
// initial_contact and the next save wrote that back to the checkpointStage
// column), its extracted facts, and therapist response-time tracking.
describe('parseConversationState — preserves checkpoint / facts / responseTracking', () => {
  const checkpoint = {
    stage: 'awaiting_user_slot_selection',
    lastSuccessfulAction: 'sent_availability_to_user',
    pendingAction: 'Waiting for user to select a time slot',
    checkpoint_at: '2026-09-20T10:00:00.000Z',
    recovery_attempts: 1,
    context: { lastEmailSentTo: 'user', userSelectedSlot: 'Tue 3pm' },
  };
  const facts = {
    proposedTimes: ['Tuesday at 3pm', 'Wednesday at 10am'],
    selectedTime: 'Tuesday at 3pm',
    therapistPreferences: ['mornings'],
    userPreferences: [],
    blockers: ['away 1-5 Oct'],
    specialNotes: [],
    updatedAt: '2026-09-20T10:00:00.000Z',
  };
  const responseTracking = {
    lastEmailSentToTherapist: '2026-09-19T09:00:00.000Z',
    pendingSince: '2026-09-19T09:00:00.000Z',
    emailType: 'availability_request',
    events: [{ appointmentId: 'apt-1', responseTimeHours: 4 }],
    somethingNew: 'kept',
  };
  const fullState = {
    systemPrompt: '',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ],
    checkpoint,
    facts,
    responseTracking,
  };

  it('round-trips all three fields from an object (jsonb object column)', () => {
    const result = parseConversationState(fullState);
    expect(result).not.toBeNull();
    expect(result!.checkpoint).toEqual(checkpoint);
    expect(result!.facts).toEqual(facts);
    expect(result!.responseTracking).toEqual(responseTracking);
  });

  it('round-trips all three fields from a JSON string (legacy string-typed rows)', () => {
    const result = parseConversationState(JSON.stringify(fullState));
    expect(result!.checkpoint).toEqual(checkpoint);
    expect(result!.facts).toEqual(facts);
    expect(result!.responseTracking).toEqual(responseTracking);
  });

  it('is stable across a parse → stringify → parse cycle', () => {
    const once = parseConversationState(fullState);
    const twice = parseConversationState(JSON.stringify(once));
    expect(twice).toEqual(once);
  });

  it('leaves the fields absent (not null) when the stored state has none', () => {
    const result = parseConversationState({ systemPrompt: '', messages: [], checkpoint: null });
    expect(result).not.toBeNull();
    expect(result!.checkpoint).toBeUndefined();
    expect(result!.facts).toBeUndefined();
    expect(result!.responseTracking).toBeUndefined();
    expect(JSON.parse(JSON.stringify(result))).toEqual({ systemPrompt: '', messages: [] });
  });

  it('drops only a malformed field, never the message log', () => {
    const result = parseConversationState({
      ...fullState,
      checkpoint: 'not-an-object',
      facts: ['not', 'an', 'object'],
    });
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
    expect(result!.checkpoint).toBeUndefined();
    expect(result!.facts).toBeUndefined();
    expect(result!.responseTracking).toEqual(responseTracking);
  });

  it('drops a checkpoint whose stage is not a known ConversationStage', () => {
    const result = parseConversationState({
      ...fullState,
      checkpoint: { ...checkpoint, stage: 'no_such_stage' },
    });
    expect(result!.checkpoint).toBeUndefined();
    expect(result!.facts).toEqual(facts);
  });

  it('normalises facts with missing arrays so updateFacts/mergeFacts cannot throw', () => {
    const result = parseConversationState({
      ...fullState,
      facts: { selectedTime: 'Tue 3pm', updatedAt: 'x' },
    });
    expect(result!.facts).toEqual(
      expect.objectContaining({
        selectedTime: 'Tue 3pm',
        proposedTimes: [],
        therapistPreferences: [],
        userPreferences: [],
        blockers: [],
        specialNotes: [],
      }),
    );
  });

  it('keeps the three fields on the loose-fallback path too', () => {
    const result = parseConversationState({
      ...fullState,
      // role missing → strict schema fails → loose salvage path
      messages: [{ content: 'Hello' }],
    });
    expect(result).not.toBeNull();
    expect(result!.messages[0].role).toBe('user');
    expect(result!.checkpoint).toEqual(checkpoint);
    expect(result!.facts).toEqual(facts);
    expect(result!.responseTracking).toEqual(responseTracking);
  });
});

describe('isConversationStage', () => {
  it('accepts every known stage and rejects anything else', () => {
    expect(isConversationStage('initial_contact')).toBe(true);
    expect(isConversationStage('closure_recommended')).toBe(true);
    expect(isConversationStage('awaiting_nothing')).toBe(false);
    expect(isConversationStage(null)).toBe(false);
    expect(isConversationStage('toString')).toBe(false);
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

  it('drops slots with missing start/end rather than coercing to empty strings', () => {
    // Used to "salvage" {day: "Mon"} → {day: "Mon", start: "", end: ""} which
    // the frontend formatter rendered as "Mon: -". Now we drop the slot.
    const partial = {
      timezone: 'UTC',
      slots: [{ day: 'Mon' }],
    };
    const result = parseTherapistAvailability(partial);
    expect(result).not.toBeNull();
    expect(result!.slots).toHaveLength(0);
  });

  it('drops slots whose day is freeform garbage like "flexible timings"', () => {
    // The exact shape that produced "Fle: flexible timings-flexible timings"
    // on the public therapist card. After the fix, the slot is filtered
    // and the public site falls back to "Available on request".
    const garbage = {
      timezone: 'Europe/London',
      slots: [
        { day: 'flexible timings', start: 'flexible timings', end: 'flexible timings' },
        { day: 'Not specified', start: 'Not specified', end: 'Not specified' },
        { day: 'Monday', start: '09:00', end: '12:00' },
      ],
    };
    const result = parseTherapistAvailability(garbage);
    expect(result).not.toBeNull();
    // Only the well-formed Monday slot survives.
    expect(result!.slots).toEqual([{ day: 'Monday', start: '09:00', end: '12:00' }]);
  });

  it('drops slots with null start/end (formerly stringified to "null")', () => {
    const withNulls = {
      timezone: 'Europe/London',
      slots: [
        { day: 'Thursday', start: null, end: null },
        { day: 'Friday', start: null, end: null },
      ],
    };
    const result = parseTherapistAvailability(withNulls);
    expect(result).not.toBeNull();
    expect(result!.slots).toHaveLength(0);
  });

  it('rejects HH:MM strings that look right but are out of range', () => {
    const bad = {
      timezone: 'UTC',
      slots: [
        { day: 'Monday', start: '25:00', end: '26:00' },
        { day: 'Tuesday', start: '09:60', end: '10:00' },
      ],
    };
    const result = parseTherapistAvailability(bad);
    expect(result).not.toBeNull();
    expect(result!.slots).toHaveLength(0);
  });

  it('rejects three-letter day abbreviations (must be full weekday name)', () => {
    const abbreviated = {
      timezone: 'UTC',
      slots: [{ day: 'Mon', start: '09:00', end: '12:00' }],
    };
    const result = parseTherapistAvailability(abbreviated);
    expect(result).not.toBeNull();
    expect(result!.slots).toHaveLength(0);
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

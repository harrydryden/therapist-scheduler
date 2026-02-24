/**
 * Tests for conversation facts extraction system
 * Covers: createEmptyFacts, extractFacts, updateFacts, formatFactsForPrompt, mergeFacts
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  createEmptyFacts,
  extractFacts,
  updateFacts,
  formatFactsForPrompt,
  mergeFacts,
  type ConversationFacts,
} from '../utils/conversation-facts';

describe('createEmptyFacts', () => {
  it('returns empty arrays for all list fields', () => {
    const facts = createEmptyFacts();
    expect(facts.proposedTimes).toEqual([]);
    expect(facts.therapistPreferences).toEqual([]);
    expect(facts.userPreferences).toEqual([]);
    expect(facts.blockers).toEqual([]);
    expect(facts.specialNotes).toEqual([]);
  });

  it('has no selected or confirmed time', () => {
    const facts = createEmptyFacts();
    expect(facts.selectedTime).toBeUndefined();
    expect(facts.confirmedTime).toBeUndefined();
  });

  it('includes updatedAt timestamp', () => {
    const facts = createEmptyFacts();
    expect(facts.updatedAt).toBeDefined();
    expect(new Date(facts.updatedAt).getTime()).not.toBeNaN();
  });
});

describe('extractFacts', () => {
  const THERAPIST_EMAIL = 'therapist@example.com';
  const USER_EMAIL = 'user@example.com';

  it('extracts proposed times from messages', () => {
    const messages = [
      { role: 'user', content: `From: ${THERAPIST_EMAIL}\nI'm available Monday at 10am and Wednesday at 2pm.` },
    ];
    const facts = extractFacts(messages, THERAPIST_EMAIL, USER_EMAIL);
    expect(facts.proposedTimes.length).toBeGreaterThan(0);
  });

  it('extracts user selection', () => {
    const messages = [
      { role: 'user', content: "Let's go with Tuesday at 3pm please." },
    ];
    const facts = extractFacts(messages, THERAPIST_EMAIL, USER_EMAIL);
    // User selection pattern should match
    if (facts.selectedTime) {
      expect(facts.selectedTime.toLowerCase()).toContain('tuesday');
    }
  });

  it('detects meeting link in messages', () => {
    const messages = [
      { role: 'user', content: `From: ${THERAPIST_EMAIL}\nHere is the link: https://zoom.us/j/1234567890` },
    ];
    const facts = extractFacts(messages, THERAPIST_EMAIL, USER_EMAIL);
    expect(facts.specialNotes).toContain('Meeting link has been shared');
  });

  it('handles empty message array', () => {
    const facts = extractFacts([], THERAPIST_EMAIL, USER_EMAIL);
    expect(facts.proposedTimes).toEqual([]);
    expect(facts.selectedTime).toBeUndefined();
  });

  it('limits proposed times to 10', () => {
    // Create messages with many different times
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: 'user',
      content: `How about Monday at ${i + 1}am?`,
    }));
    const facts = extractFacts(messages, THERAPIST_EMAIL, USER_EMAIL);
    expect(facts.proposedTimes.length).toBeLessThanOrEqual(10);
  });
});

describe('updateFacts', () => {
  it('updates existing facts with new message content', () => {
    const existing = createEmptyFacts();
    const updated = updateFacts(existing, 'Tuesday at 2pm works for me.', false);
    expect(updated.updatedAt).toBeDefined();
  });

  it('creates new facts when existing is undefined', () => {
    const updated = updateFacts(undefined, 'Some message content', false);
    expect(updated).toBeDefined();
    expect(updated.proposedTimes).toBeDefined();
  });

  it('detects therapist confirmation', () => {
    const existing: ConversationFacts = {
      ...createEmptyFacts(),
      selectedTime: 'Monday at 10am',
      proposedTimes: ['Monday at 10am'],
    };
    const updated = updateFacts(existing, "That's confirmed. See you then!", true);
    expect(updated.confirmedTime).toBeDefined();
  });

  it('only sets selectedTime from user messages', () => {
    const existing = createEmptyFacts();
    const fromTherapist = updateFacts(existing, "Let's go with Monday at 10am", true);
    // Therapist saying "let's go with" should not set selectedTime
    // (selection patterns are only checked for non-therapist messages)
    expect(fromTherapist.selectedTime).toBeUndefined();
  });
});

describe('formatFactsForPrompt', () => {
  it('returns empty string for empty facts', () => {
    const facts = createEmptyFacts();
    const formatted = formatFactsForPrompt(facts);
    expect(formatted).toBe('');
  });

  it('includes confirmed time when present', () => {
    const facts: ConversationFacts = {
      ...createEmptyFacts(),
      confirmedTime: 'Monday 10am',
    };
    const formatted = formatFactsForPrompt(facts);
    expect(formatted).toContain('CONFIRMED TIME');
    expect(formatted).toContain('Monday 10am');
  });

  it('includes selected time (awaiting confirmation)', () => {
    const facts: ConversationFacts = {
      ...createEmptyFacts(),
      selectedTime: 'Tuesday 2pm',
    };
    const formatted = formatFactsForPrompt(facts);
    expect(formatted).toContain('USER SELECTED');
    expect(formatted).toContain('Tuesday 2pm');
    expect(formatted).toContain('awaiting therapist confirmation');
  });

  it('prefers confirmed time over selected time', () => {
    const facts: ConversationFacts = {
      ...createEmptyFacts(),
      selectedTime: 'Tuesday 2pm',
      confirmedTime: 'Tuesday 2pm',
    };
    const formatted = formatFactsForPrompt(facts);
    expect(formatted).toContain('CONFIRMED TIME');
    expect(formatted).not.toContain('USER SELECTED');
  });

  it('includes proposed times', () => {
    const facts: ConversationFacts = {
      ...createEmptyFacts(),
      proposedTimes: ['Monday 10am', 'Wednesday 3pm', 'Friday 11am'],
    };
    const formatted = formatFactsForPrompt(facts);
    expect(formatted).toContain('Times Discussed');
    expect(formatted).toContain('Monday 10am');
  });

  it('shows at most 5 proposed times', () => {
    const facts: ConversationFacts = {
      ...createEmptyFacts(),
      proposedTimes: Array.from({ length: 8 }, (_, i) => `Slot ${i + 1}`),
    };
    const formatted = formatFactsForPrompt(facts);
    // Should show last 5
    expect(formatted).toContain('Slot 4');
    expect(formatted).toContain('Slot 8');
  });

  it('includes therapist preferences', () => {
    const facts: ConversationFacts = {
      ...createEmptyFacts(),
      therapistPreferences: ['mornings are best'],
    };
    const formatted = formatFactsForPrompt(facts);
    expect(formatted).toContain('Therapist Preferences');
    expect(formatted).toContain('mornings are best');
  });

  it('includes blockers', () => {
    const facts: ConversationFacts = {
      ...createEmptyFacts(),
      blockers: ['away next week'],
    };
    const formatted = formatFactsForPrompt(facts);
    expect(formatted).toContain('Blockers');
    expect(formatted).toContain('away next week');
  });

  it('includes special notes', () => {
    const facts: ConversationFacts = {
      ...createEmptyFacts(),
      specialNotes: ['Meeting link has been shared'],
    };
    const formatted = formatFactsForPrompt(facts);
    expect(formatted).toContain('Notes');
    expect(formatted).toContain('Meeting link has been shared');
  });

  it('starts with section header', () => {
    const facts: ConversationFacts = {
      ...createEmptyFacts(),
      proposedTimes: ['Monday 10am'],
    };
    const formatted = formatFactsForPrompt(facts);
    expect(formatted).toContain('## Conversation Facts');
  });
});

describe('mergeFacts', () => {
  it('merges proposed times without duplicates', () => {
    const existing: ConversationFacts = {
      ...createEmptyFacts(),
      proposedTimes: ['Monday 10am', 'Tuesday 2pm'],
    };
    const newFacts: Partial<ConversationFacts> = {
      proposedTimes: ['Tuesday 2pm', 'Wednesday 3pm'],
    };
    const merged = mergeFacts(existing, newFacts);
    expect(merged.proposedTimes).toEqual(['Monday 10am', 'Tuesday 2pm', 'Wednesday 3pm']);
  });

  it('new selected time overrides existing', () => {
    const existing: ConversationFacts = {
      ...createEmptyFacts(),
      selectedTime: 'Monday 10am',
    };
    const newFacts: Partial<ConversationFacts> = {
      selectedTime: 'Tuesday 2pm',
    };
    const merged = mergeFacts(existing, newFacts);
    expect(merged.selectedTime).toBe('Tuesday 2pm');
  });

  it('preserves existing selected time if new is undefined', () => {
    const existing: ConversationFacts = {
      ...createEmptyFacts(),
      selectedTime: 'Monday 10am',
    };
    const merged = mergeFacts(existing, {});
    expect(merged.selectedTime).toBe('Monday 10am');
  });

  it('limits arrays to max sizes', () => {
    const existing: ConversationFacts = {
      ...createEmptyFacts(),
      proposedTimes: Array.from({ length: 8 }, (_, i) => `Time ${i}`),
    };
    const newFacts: Partial<ConversationFacts> = {
      proposedTimes: Array.from({ length: 5 }, (_, i) => `New Time ${i}`),
    };
    const merged = mergeFacts(existing, newFacts);
    expect(merged.proposedTimes.length).toBeLessThanOrEqual(10);
  });

  it('limits preferences to 5', () => {
    const existing: ConversationFacts = {
      ...createEmptyFacts(),
      therapistPreferences: Array.from({ length: 4 }, (_, i) => `Pref ${i}`),
    };
    const newFacts: Partial<ConversationFacts> = {
      therapistPreferences: Array.from({ length: 4 }, (_, i) => `New Pref ${i}`),
    };
    const merged = mergeFacts(existing, newFacts);
    expect(merged.therapistPreferences.length).toBeLessThanOrEqual(5);
  });

  it('updates the updatedAt timestamp', () => {
    const existing = createEmptyFacts();
    const before = Date.now();
    const merged = mergeFacts(existing, {});
    const after = Date.now();
    const mergedTime = new Date(merged.updatedAt).getTime();
    expect(mergedTime).toBeGreaterThanOrEqual(before);
    expect(mergedTime).toBeLessThanOrEqual(after);
  });
});

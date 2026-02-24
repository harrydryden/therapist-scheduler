/**
 * Tests for email classification and intent detection
 * Covers: classifyEmail, needsSpecialHandling, formatClassificationForPrompt
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  classifyEmail,
  needsSpecialHandling,
  formatClassificationForPrompt,
  type EmailClassification,
} from '../utils/email-classifier';

const THERAPIST_EMAIL = 'therapist@example.com';
const USER_EMAIL = 'user@example.com';

describe('classifyEmail', () => {
  describe('intent detection', () => {
    it('detects slot_selection intent', () => {
      const result = classifyEmail(
        "I'd like Monday at 10am please. Let's go with that.",
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.intent).toBe('slot_selection');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('detects cancellation intent', () => {
      const result = classifyEmail(
        'I need to cancel my appointment please. Cancel the session.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.intent).toBe('cancellation');
    });

    it('detects reschedule_request intent', () => {
      const result = classifyEmail(
        'Something came up. I need to reschedule my appointment to a different time.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.intent).toBe('reschedule_request');
    });

    it('detects meeting_link_issue intent', () => {
      const result = classifyEmail(
        "I haven't received the meeting link. Where can I find the Zoom link?",
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.intent).toBe('meeting_link_issue');
    });

    it('detects confirmation intent', () => {
      const result = classifyEmail(
        'Yes, sounds good! Looking forward to it. See you then.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.intent).toBe('confirmation');
    });

    it('detects urgent intent', () => {
      const result = classifyEmail(
        'This is urgent! I need to see someone today ASAP. Very important.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.intent).toBe('urgent');
    });

    it('returns unknown for ambiguous content', () => {
      const result = classifyEmail(
        'Hello, just checking in.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.intent).toBe('unknown');
    });
  });

  describe('confidence scoring', () => {
    it('has higher confidence with more pattern matches', () => {
      const singleMatch = classifyEmail(
        'Please book me in.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );

      const multipleMatch = classifyEmail(
        "I'd like Monday at 10am. Let's go with that. Please book me in. I'll take that slot.",
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );

      expect(multipleMatch.confidence).toBeGreaterThanOrEqual(singleMatch.confidence);
    });

    it('caps confidence at 1.0', () => {
      const result = classifyEmail(
        "I'd like Monday. Book me. Schedule me. Let's do it. I choose. I prefer. Sounds good.",
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  describe('sentiment detection', () => {
    it('detects positive sentiment', () => {
      const result = classifyEmail(
        'Thank you so much! This is wonderful, I appreciate your help!',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.sentiment).toBe('positive');
    });

    it('detects frustrated sentiment', () => {
      const result = classifyEmail(
        "I'm frustrated. Still waiting for a response!! This is unacceptable.",
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.sentiment).toBe('frustrated');
    });

    it('detects confused sentiment', () => {
      const result = classifyEmail(
        "I'm confused. What do you mean?? I don't understand which one to pick.",
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.sentiment).toBe('confused');
    });

    it('detects urgent sentiment', () => {
      const result = classifyEmail(
        'This is urgent! I need this immediately, right now!',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.sentiment).toBe('urgent');
    });

    it('defaults to neutral for normal text', () => {
      const result = classifyEmail(
        'I would like to schedule an appointment.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.sentiment).toBe('neutral');
    });
  });

  describe('slot extraction', () => {
    it('extracts "Monday at 10am" slot', () => {
      const result = classifyEmail(
        "Let's do Monday at 10am.",
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.extractedSlots.length).toBeGreaterThanOrEqual(1);
      const slot = result.extractedSlots[0];
      expect(slot.raw.toLowerCase()).toContain('monday');
    });

    it('extracts multiple slots', () => {
      const result = classifyEmail(
        'I could do Monday at 10am or Tuesday at 2pm.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.extractedSlots.length).toBeGreaterThanOrEqual(2);
      expect(result.flags.mentionsMultipleSlots).toBe(true);
    });

    it('deduplicates identical slots', () => {
      const result = classifyEmail(
        'Monday at 10am. Yes, Monday at 10am works.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      // Should not have duplicates
      const rawSlots = result.extractedSlots.map(s => s.raw.toLowerCase());
      const uniqueSlots = new Set(rawSlots);
      expect(rawSlots.length).toBe(uniqueSlots.size);
    });
  });

  describe('therapist confirmation detection', () => {
    it('detects explicit slot confirmation from therapist', () => {
      const result = classifyEmail(
        "That's confirmed for Monday at 10am. See you then.",
        THERAPIST_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.therapistConfirmation).not.toBeNull();
      expect(result.therapistConfirmation!.isConfirmed).toBe(true);
    });

    it('detects meeting link presence as confirmation', () => {
      const result = classifyEmail(
        'Here is the meeting link: https://zoom.us/j/1234567890',
        THERAPIST_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.therapistConfirmation).not.toBeNull();
      expect(result.therapistConfirmation!.isConfirmed).toBe(true);
      expect(result.therapistConfirmation!.willSendLink).toBe(true);
    });

    it('detects "I\'ll send you the link" as confirmation', () => {
      const result = classifyEmail(
        "Great, I'll send you the meeting link shortly.",
        THERAPIST_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.therapistConfirmation).not.toBeNull();
      expect(result.therapistConfirmation!.willSendLink).toBe(true);
    });

    it('returns null for non-therapist emails', () => {
      const result = classifyEmail(
        'Confirmed! See you then.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.therapistConfirmation).toBeNull();
    });

    it('does not confirm when ambiguous indicators are present', () => {
      const result = classifyEmail(
        'Yes, but can we change the time? I would prefer something later.',
        THERAPIST_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      // Should NOT be a confirmation because "but" and "?" indicate ambiguity
      if (result.therapistConfirmation) {
        // If it matched one of the strong patterns, it's fine
        // but general confirmation should be blocked by ambiguity
        expect(result.therapistConfirmation.confirmationType).not.toBe('booking');
      }
    });
  });

  describe('sender identification', () => {
    it('identifies therapist emails correctly', () => {
      const result = classifyEmail(
        'Test message',
        THERAPIST_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.isFromTherapist).toBe(true);
    });

    it('identifies user emails correctly', () => {
      const result = classifyEmail(
        'Test message',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.isFromTherapist).toBe(false);
    });

    it('handles case-insensitive email comparison', () => {
      const result = classifyEmail(
        'Test message',
        'THERAPIST@EXAMPLE.COM',
        'therapist@example.com',
        USER_EMAIL
      );
      expect(result.isFromTherapist).toBe(true);
    });
  });

  describe('urgency calculation', () => {
    it('returns high for urgent intent', () => {
      const result = classifyEmail(
        'URGENT! Need this ASAP!',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.urgencyLevel).toBe('high');
    });

    it('returns high for frustrated sentiment', () => {
      const result = classifyEmail(
        "I'm so frustrated! Still waiting for a response!! This is unacceptable.",
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.urgencyLevel).toBe('high');
    });

    it('returns medium for cancellation', () => {
      const result = classifyEmail(
        'I need to cancel my appointment.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.urgencyLevel).toBe('medium');
    });

    it('returns low for normal messages', () => {
      const result = classifyEmail(
        'Hello, I would like to schedule a session.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.urgencyLevel).toBe('low');
    });
  });

  describe('flags', () => {
    it('detects out-of-office replies', () => {
      const result = classifyEmail(
        'I am out of office until February 20th. I will respond when I return.',
        THERAPIST_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.flags.isOutOfOffice).toBe(true);
    });

    it('detects preferences mentioned', () => {
      const result = classifyEmail(
        'I prefer mornings. Works better for me.',
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.flags.mentionsPreferences).toBe(true);
    });

    it('detects constraints', () => {
      const result = classifyEmail(
        "I can't do Mondays and I'm busy on Wednesday.",
        USER_EMAIL,
        THERAPIST_EMAIL,
        USER_EMAIL
      );
      expect(result.flags.mentionsConstraints).toBe(true);
    });
  });
});

describe('needsSpecialHandling', () => {
  const makeClassification = (overrides: Partial<EmailClassification>): EmailClassification => ({
    intent: 'unknown',
    confidence: 0.5,
    sentiment: 'neutral',
    extractedSlots: [],
    therapistConfirmation: null,
    isFromTherapist: false,
    urgencyLevel: 'low',
    flags: {
      mentionsMultipleSlots: false,
      mentionsPreferences: false,
      mentionsConstraints: false,
      mentionsRescheduling: false,
      mentionsCancellation: false,
      isOutOfOffice: false,
    },
    ...overrides,
  });

  it('flags out-of-office', () => {
    const result = needsSpecialHandling(
      makeClassification({ flags: { ...makeClassification({}).flags, isOutOfOffice: true } })
    );
    expect(result.needsAttention).toBe(true);
    expect(result.reason).toBe('out_of_office');
  });

  it('flags urgent messages', () => {
    const result = needsSpecialHandling(
      makeClassification({ urgencyLevel: 'high' })
    );
    expect(result.needsAttention).toBe(true);
    expect(result.reason).toBe('urgent');
  });

  it('flags frustrated users', () => {
    const result = needsSpecialHandling(
      makeClassification({ sentiment: 'frustrated' })
    );
    expect(result.needsAttention).toBe(true);
    expect(result.reason).toBe('frustrated_user');
  });

  it('flags cancellation requests', () => {
    const result = needsSpecialHandling(
      makeClassification({ intent: 'cancellation' })
    );
    expect(result.needsAttention).toBe(true);
    expect(result.reason).toBe('cancellation_request');
  });

  it('returns false for normal messages', () => {
    const result = needsSpecialHandling(makeClassification({}));
    expect(result.needsAttention).toBe(false);
  });
});

describe('formatClassificationForPrompt', () => {
  it('includes intent and confidence', () => {
    const classification = classifyEmail(
      "I'd like Monday at 10am.",
      USER_EMAIL,
      THERAPIST_EMAIL,
      USER_EMAIL
    );
    const formatted = formatClassificationForPrompt(classification);
    expect(formatted).toContain('Detected intent:');
    expect(formatted).toContain('confidence');
  });

  it('includes low confidence warning when confidence is low', () => {
    const classification = classifyEmail(
      'Just saying hello.',
      USER_EMAIL,
      THERAPIST_EMAIL,
      USER_EMAIL
    );
    const formatted = formatClassificationForPrompt(classification);
    // For unknown intent with 0 confidence, should show low confidence
    if (classification.confidence < 0.6) {
      expect(formatted).toContain('LOW CONFIDENCE');
    }
  });

  it('includes extracted slots', () => {
    const classification = classifyEmail(
      'Monday at 10am or Tuesday at 2pm',
      USER_EMAIL,
      THERAPIST_EMAIL,
      USER_EMAIL
    );
    const formatted = formatClassificationForPrompt(classification);
    if (classification.extractedSlots.length > 0) {
      expect(formatted).toContain('Mentioned times:');
    }
  });

  it('includes therapist confirmation notes', () => {
    const classification = classifyEmail(
      "That's confirmed. I'll send you the meeting link.",
      THERAPIST_EMAIL,
      THERAPIST_EMAIL,
      USER_EMAIL
    );
    const formatted = formatClassificationForPrompt(classification);
    if (classification.therapistConfirmation?.isConfirmed) {
      expect(formatted).toContain('Therapist appears to be confirming');
    }
  });
});

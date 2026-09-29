/**
 * Edge-case tests for the thread-divergence detector.
 *
 * The base divergence tests in thread-divergence.test.ts cover the happy
 * path. This file pins down behavior on the FALSE-POSITIVE RISK cases
 * that matter most because divergence-blocked messages consume the same
 * MAX_PROCESSING_FAILURES retry budget as real failures — a persistent
 * false positive permanently abandons a legitimate message after 3 attempts.
 *
 * If any of these tests start failing, someone has changed the heuristics
 * in a way that may abandon legitimate messages. Investigate before merging.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils/database', () => ({
  prisma: {},
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { notifyThreadDivergence: jest.fn() },
}));

import {
  detectThreadDivergence,
  shouldBlockProcessing,
  type EmailContext,
  type AppointmentContext,
} from '../services/thread-divergence.service';

function makeEmailContext(overrides: Partial<EmailContext> = {}): EmailContext {
  return {
    threadId: 'thread-1',
    messageId: 'msg-1',
    from: 'user@example.com',
    to: 'scheduler@example.com',
    subject: 'Re: Appointment Request',
    body: 'I would like to book a session.',
    date: new Date(),
    ...overrides,
  };
}

function makeAppointmentContext(overrides: Partial<AppointmentContext> = {}): AppointmentContext {
  return {
    id: 'apt-1',
    userEmail: 'user@example.com',
    therapistEmail: 'therapist@example.com',
    therapistName: 'Dr. Smith',
    gmailThreadId: 'thread-1',
    therapistGmailThreadId: 'thread-t1',
    initialMessageId: 'init-msg-1',
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('thread-divergence edge cases', () => {
  describe('forward detection — false positive risks', () => {
    it('flags "Fwd:" subject as forward (current behavior — known FP risk)', () => {
      const email = makeEmailContext({ subject: 'Fwd: Your appointment with Dr. Smith' });
      const appointment = makeAppointmentContext();
      const result = detectThreadDivergence(email, appointment, [appointment]);
      // Documented as detected=true; if you change this, update the
      // recovery playbook because it changes the abandonment math.
      expect(result.detected).toBe(true);
      expect(result.type).toBe('forward_new_thread');
    });

    it('does NOT flag a normal "Re:" subject containing the word "forward"', () => {
      const email = makeEmailContext({
        subject: 'Re: Looking forward to our session',
      });
      const appointment = makeAppointmentContext();
      const result = detectThreadDivergence(email, appointment, [appointment]);
      expect(result.detected).toBe(false);
    });

    it('does NOT flag body text mentioning forwarding casually', () => {
      const email = makeEmailContext({
        body: 'Hi Justin, just letting you know I am looking forward to our session next week.',
      });
      const appointment = makeAppointmentContext();
      const result = detectThreadDivergence(email, appointment, [appointment]);
      expect(result.detected).toBe(false);
    });
  });

  describe('therapist name mismatch — substring false positives', () => {
    it('does NOT cross-flag "Smith" when only one appointment exists', () => {
      // No other therapists in the user's appointments → no cross-contamination risk
      const email = makeEmailContext({
        body: 'Looking forward to seeing Dr. Smith next week.',
      });
      const appointment = makeAppointmentContext();
      const result = detectThreadDivergence(email, appointment, [appointment]);
      expect(result.detected).toBe(false);
    });

    it('correctly flags cross-contamination across two appointments', () => {
      const email = makeEmailContext({
        body: 'Actually I would prefer to see Dr. Jones instead.',
      });
      const matched = makeAppointmentContext({ id: 'apt-1', therapistName: 'Dr. Smith' });
      const other = makeAppointmentContext({
        id: 'apt-2',
        therapistName: 'Dr. Jones',
        // A different therapist always has a different email
        // (Therapist.email is @unique) — same-email rows are treated as
        // the same therapist and excluded (E4).
        therapistEmail: 'jones@example.com',
        gmailThreadId: 'thread-2',
        therapistGmailThreadId: 'thread-t2',
      });
      const result = detectThreadDivergence(email, matched, [matched, other]);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('therapist_name_mismatch');
    });

    it('flags "mentions both" when email talks about the matched AND another therapist', () => {
      const email = makeEmailContext({
        body: 'Hi Dr. Smith, I am wondering if I should also see Dr. Jones.',
      });
      const matched = makeAppointmentContext({ id: 'apt-1', therapistName: 'Dr. Smith' });
      const other = makeAppointmentContext({
        id: 'apt-2',
        therapistName: 'Dr. Jones',
        therapistEmail: 'jones@example.com', // different therapist ⇒ different email
      });
      const result = detectThreadDivergence(email, matched, [matched, other]);
      expect(result.detected).toBe(true);
      expect(result.severity).toBe('high'); // Both mentioned → high (not critical)
    });

    it('handles missing therapist names gracefully (returns no detection)', () => {
      const email = makeEmailContext();
      const matched = makeAppointmentContext({ therapistName: '' as any });
      const result = detectThreadDivergence(email, matched, [matched]);
      // Empty therapist name should not throw or trigger false detection
      expect(result.type === 'none' || result.type === 'forward_new_thread').toBe(true);
    });

    it('is case-insensitive when matching therapist names', () => {
      const email = makeEmailContext({
        body: 'I changed my mind, I want to see DR. JONES instead.',
      });
      const matched = makeAppointmentContext({ id: 'apt-1', therapistName: 'Dr. Smith' });
      const other = makeAppointmentContext({
        id: 'apt-2',
        therapistName: 'Dr. Jones',
        therapistEmail: 'jones@example.com', // different therapist ⇒ different email
      });
      const result = detectThreadDivergence(email, matched, [matched, other]);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('therapist_name_mismatch');
    });
  });

  // E4 regression: the "other therapists" list used to include the SAME
  // therapist when the sender had two active rows with them, so every
  // signed reply scored high/manual_review and was blocked, then abandoned.
  describe('therapist name mismatch — same therapist on two active rows (E4)', () => {
    const matched = makeAppointmentContext({
      id: 'apt-new',
      therapistName: 'Sarah Jones',
      therapistEmail: 'sarah@clinic.example',
      status: 'negotiating',
    });
    const earlier = makeAppointmentContext({
      id: 'apt-earlier',
      therapistName: 'Sarah Jones',
      therapistEmail: 'sarah@clinic.example',
      gmailThreadId: 'thread-earlier',
      therapistGmailThreadId: 'thread-t-earlier',
      status: 'feedback_requested',
    });

    it('does not flag (or block) a signed reply when the client is rebooking the same therapist', () => {
      const email = makeEmailContext({
        from: 'sarah@clinic.example',
        body: 'Tuesday at 3pm works for me.\n\nBest,\nSarah',
      });
      const result = detectThreadDivergence(email, matched, [matched, earlier]);
      expect(result.detected).toBe(false);
      expect(shouldBlockProcessing(result)).toBe(false);
    });

    it('recognises the same therapist by email even when the stored names differ', () => {
      const renamed = { ...earlier, therapistName: 'Dr Sarah Jones-Smith', therapistEmail: 'Sarah@Clinic.example' };
      const email = makeEmailContext({ body: 'Thanks, Dr Sarah Jones-Smith' });
      const result = detectThreadDivergence(email, matched, [matched, renamed]);
      expect(result.detected).toBe(false);
    });

    it('recognises the same therapist by handle / id even when the email changed', () => {
      const a = { ...matched, therapistHandle: 'sarah-jones', therapistId: 'th-1' };
      const b = { ...earlier, therapistEmail: 'old-address@clinic.example', therapistHandle: 'sarah-jones', therapistId: 'th-1' };
      const email = makeEmailContext({ body: 'See you then — Sarah' });
      expect(detectThreadDivergence(email, a, [a, b]).detected).toBe(false);
    });

    it('still flags a genuinely different therapist named in the reply (critical, blocking)', () => {
      const other = makeAppointmentContext({
        id: 'apt-other',
        therapistName: 'Emily Clarke',
        therapistEmail: 'emily@clinic.example',
        gmailThreadId: 'thread-other',
        therapistGmailThreadId: 'thread-t-other',
      });
      const email = makeEmailContext({ body: 'Actually I would rather see Emily Clarke.' });
      const result = detectThreadDivergence(email, matched, [matched, earlier, other]);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('therapist_name_mismatch');
      expect(result.severity).toBe('critical');
      expect(result.relatedAppointmentIds).toEqual(['apt-new', 'apt-other']);
      expect(shouldBlockProcessing(result)).toBe(true);
    });
  });

  describe('therapist name mismatch — whole-word matching (E4)', () => {
    const otherFor = (therapistName: string) =>
      makeAppointmentContext({
        id: 'apt-2',
        therapistName,
        therapistEmail: 'other@example.com',
        gmailThreadId: 'thread-2',
        therapistGmailThreadId: 'thread-t2',
      });

    it('does not match a first name inside another word ("Ann" in "planning")', () => {
      const matched = makeAppointmentContext({ therapistName: 'Emily Smith' });
      const email = makeEmailContext({ body: 'I am planning to come on Tuesday.' });
      expect(detectThreadDivergence(email, matched, [matched, otherFor('Ann Lee')]).detected).toBe(false);
    });

    it('does not treat the honorific "Dr." as a first name', () => {
      // Old behaviour: firstName of "Dr. Jones" was "dr.", so ANY email
      // containing "Dr." mentioned "another therapist".
      const matched = makeAppointmentContext({ therapistName: 'Dr. Smith' });
      const email = makeEmailContext({ body: 'Thanks Dr. Smith, see you Tuesday.' });
      expect(detectThreadDivergence(email, matched, [matched, otherFor('Dr. Jones')]).detected).toBe(false);
    });

    it('ignores very short first names on their own ("Al" in "also")', () => {
      const matched = makeAppointmentContext({ therapistName: 'Emily Smith' });
      const email = makeEmailContext({ body: 'I also wanted to ask about Al.' });
      expect(detectThreadDivergence(email, matched, [matched, otherFor('Al Green')]).detected).toBe(false);
      // …but the full name still counts.
      const named = makeEmailContext({ body: 'Can I switch to Al Green?' });
      expect(detectThreadDivergence(named, matched, [matched, otherFor('Al Green')]).severity).toBe('critical');
    });

    it('does not flag a first name shared with the matched therapist', () => {
      const matched = makeAppointmentContext({ therapistName: 'Sarah Jones' });
      const email = makeEmailContext({ body: 'Thanks Sarah!' });
      expect(detectThreadDivergence(email, matched, [matched, otherFor('Sarah Clarke')]).detected).toBe(false);
      const full = makeEmailContext({ body: 'Is this with Sarah Clarke?' });
      expect(detectThreadDivergence(full, matched, [matched, otherFor('Sarah Clarke')]).severity).toBe('critical');
    });

    it('still matches a whole-word first name of a different therapist', () => {
      const matched = makeAppointmentContext({ therapistName: 'Emily Smith' });
      const email = makeEmailContext({ body: 'Could Ann do Thursday instead?' });
      const result = detectThreadDivergence(email, matched, [matched, otherFor('Ann Lee')]);
      expect(result.type).toBe('therapist_name_mismatch');
      expect(result.severity).toBe('critical');
    });
  });

  describe('orphaned reply detection — boundary cases', () => {
    it('returns no detection for an email with empty references AND no inReplyTo', () => {
      const email = makeEmailContext({ inReplyTo: undefined, references: [] });
      const result = detectThreadDivergence(email, null, []);
      expect(result.detected).toBe(false);
    });

    it('flags a reply (has inReplyTo) when no appointment matched', () => {
      const email = makeEmailContext({ inReplyTo: '<some-id>' });
      const result = detectThreadDivergence(email, null, []);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('orphaned_reply');
    });

    it('flags a reply with references but no inReplyTo as orphaned', () => {
      const email = makeEmailContext({
        inReplyTo: undefined,
        references: ['<a>', '<b>'],
      });
      const result = detectThreadDivergence(email, null, []);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('orphaned_reply');
    });
  });

  describe('graceful handling of malformed input', () => {
    it('does not throw on empty body', () => {
      const email = makeEmailContext({ body: '' });
      const appointment = makeAppointmentContext();
      expect(() => detectThreadDivergence(email, appointment, [appointment])).not.toThrow();
    });

    it('does not throw on empty subject', () => {
      const email = makeEmailContext({ subject: '' });
      const appointment = makeAppointmentContext();
      expect(() => detectThreadDivergence(email, appointment, [appointment])).not.toThrow();
    });

    it('handles very long body without timing out', () => {
      const email = makeEmailContext({ body: 'a'.repeat(50000) });
      const appointment = makeAppointmentContext();
      const start = Date.now();
      const result = detectThreadDivergence(email, appointment, [appointment]);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500); // sanity check for catastrophic backtracking
      expect(result).toBeDefined();
    });
  });

  describe('first-thread cases (no prior thread on the appointment)', () => {
    it('does not flag a brand-new conversation as wrong-thread', () => {
      const email = makeEmailContext({ threadId: 'fresh-thread' });
      const appointment = makeAppointmentContext({
        gmailThreadId: null,
        therapistGmailThreadId: null,
      });
      const result = detectThreadDivergence(email, appointment, [appointment]);
      expect(result.detected).toBe(false);
    });

    it('does not flag a reply on the existing thread when only one thread is set', () => {
      const email = makeEmailContext({ threadId: 'thread-1' });
      const appointment = makeAppointmentContext({
        gmailThreadId: 'thread-1',
        therapistGmailThreadId: null,
      });
      const result = detectThreadDivergence(email, appointment, [appointment]);
      expect(result.detected).toBe(false);
    });
  });
});

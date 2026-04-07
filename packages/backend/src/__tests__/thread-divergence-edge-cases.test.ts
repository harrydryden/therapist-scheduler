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
  type EmailContext,
  type AppointmentContext,
} from '../utils/thread-divergence';

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
      });
      const result = detectThreadDivergence(email, matched, [matched, other]);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('therapist_name_mismatch');
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

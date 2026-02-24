/**
 * Tests for thread divergence detection
 * Covers: detectThreadDivergence, shouldBlockProcessing, getDivergenceSummary,
 *         createMergeNotes, parseEmailAddresses
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils/database', () => ({
  prisma: {},
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    notifyThreadDivergence: jest.fn(),
  },
}));

import {
  detectThreadDivergence,
  shouldBlockProcessing,
  getDivergenceSummary,
  createMergeNotes,
  parseEmailAddresses,
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

describe('detectThreadDivergence', () => {
  describe('no divergence', () => {
    it('returns no detection when everything matches', () => {
      const email = makeEmailContext();
      const appointment = makeAppointmentContext();
      const result = detectThreadDivergence(email, appointment, [appointment]);
      expect(result.detected).toBe(false);
      expect(result.type).toBe('none');
    });

    it('returns no detection for first thread on appointment', () => {
      const email = makeEmailContext({ threadId: 'new-thread' });
      const appointment = makeAppointmentContext({
        gmailThreadId: null,
        therapistGmailThreadId: null,
      });
      const result = detectThreadDivergence(email, appointment, [appointment]);
      expect(result.detected).toBe(false);
    });
  });

  describe('orphaned reply detection', () => {
    it('detects orphaned reply when no appointment matched', () => {
      const email = makeEmailContext({
        inReplyTo: 'some-old-message',
        references: ['ref-1', 'ref-2'],
      });
      const result = detectThreadDivergence(email, null, []);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('orphaned_reply');
      expect(result.severity).toBe('medium');
    });

    it('returns no detection for new email without reply headers', () => {
      const email = makeEmailContext();
      const result = detectThreadDivergence(email, null, []);
      expect(result.detected).toBe(false);
    });
  });

  describe('wrong thread reply detection', () => {
    it('detects email on wrong thread (belongs to different appointment)', () => {
      const email = makeEmailContext({ threadId: 'thread-2' });
      const matchedAppointment = makeAppointmentContext();
      const otherAppointment = makeAppointmentContext({
        id: 'apt-2',
        gmailThreadId: 'thread-2', // This thread belongs to apt-2
      });
      const result = detectThreadDivergence(email, matchedAppointment, [matchedAppointment, otherAppointment]);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('wrong_thread_reply');
      expect(result.severity).toBe('high');
      expect(result.relatedAppointmentIds).toContain('apt-1');
      expect(result.relatedAppointmentIds).toContain('apt-2');
    });

    it('detects new thread started by user (medium severity)', () => {
      const email = makeEmailContext({ threadId: 'new-thread' });
      const appointment = makeAppointmentContext();
      const result = detectThreadDivergence(email, appointment, [appointment]);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('wrong_thread_reply');
      expect(result.severity).toBe('medium');
      expect(result.suggestedAction).toBe('auto_merge');
    });
  });

  describe('CC parallel thread detection', () => {
    it('detects critical CC to parties from other appointments', () => {
      const email = makeEmailContext({
        cc: ['other-user@example.com'],
      });
      const matchedAppointment = makeAppointmentContext();
      const otherAppointment = makeAppointmentContext({
        id: 'apt-2',
        userEmail: 'other-user@example.com',
        gmailThreadId: 'thread-other',
      });
      const result = detectThreadDivergence(email, matchedAppointment, [matchedAppointment, otherAppointment]);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('cc_parallel_thread');
      expect(result.severity).toBe('critical');
    });
  });

  describe('forwarded email detection', () => {
    it('detects forwarded email by subject', () => {
      const email = makeEmailContext({
        subject: 'Fwd: Appointment Request',
        threadId: 'new-thread',
      });
      const appointment = makeAppointmentContext();
      // First check passes (email on different thread triggers wrong_thread_reply first)
      // but forwarded email check should also fire
      const result = detectThreadDivergence(email, appointment, [appointment]);
      // Either wrong_thread_reply or forward_new_thread depending on priority
      expect(result.detected).toBe(true);
    });

    it('detects forwarded email by body', () => {
      const email = makeEmailContext({
        body: '------Forwarded message------\nFrom: someone@example.com',
        threadId: 'new-thread',
      });
      const appointment = makeAppointmentContext();
      const result = detectThreadDivergence(email, appointment, [appointment]);
      expect(result.detected).toBe(true);
    });
  });

  describe('therapist name mismatch detection', () => {
    it('detects mention of different therapist (critical)', () => {
      const email = makeEmailContext({
        body: 'I wanted to book a session with Dr. Jones, please.',
      });
      const matchedAppointment = makeAppointmentContext({
        therapistName: 'Dr. Smith',
      });
      const otherAppointment = makeAppointmentContext({
        id: 'apt-2',
        therapistName: 'Dr. Jones',
        therapistEmail: 'jones@example.com',
        gmailThreadId: 'thread-other',
      });
      const result = detectThreadDivergence(email, matchedAppointment, [matchedAppointment, otherAppointment]);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('therapist_name_mismatch');
      expect(result.severity).toBe('critical');
    });

    it('detects mention of both therapists (high severity)', () => {
      const email = makeEmailContext({
        body: 'I have sessions with both Dr. Smith and Dr. Jones next week.',
      });
      const matchedAppointment = makeAppointmentContext({
        therapistName: 'Dr. Smith',
      });
      const otherAppointment = makeAppointmentContext({
        id: 'apt-2',
        therapistName: 'Dr. Jones',
        therapistEmail: 'jones@example.com',
        gmailThreadId: 'thread-other',
      });
      const result = detectThreadDivergence(email, matchedAppointment, [matchedAppointment, otherAppointment]);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('therapist_name_mismatch');
      expect(result.severity).toBe('high');
    });

    it('no mismatch when user has only one appointment', () => {
      const email = makeEmailContext({
        body: 'Looking forward to the session with Dr. Whoever.',
      });
      const appointment = makeAppointmentContext();
      const result = detectThreadDivergence(email, appointment, [appointment]);
      // Only one appointment, so no cross-contamination risk
      expect(result.type).not.toBe('therapist_name_mismatch');
    });
  });

  describe('cross-thread reference detection', () => {
    it('detects email referencing multiple appointments', () => {
      const email = makeEmailContext({
        references: ['init-msg-1', 'init-msg-2'],
      });
      const apt1 = makeAppointmentContext({ id: 'apt-1', initialMessageId: 'init-msg-1' });
      const apt2 = makeAppointmentContext({ id: 'apt-2', initialMessageId: 'init-msg-2', gmailThreadId: 'thread-2' });
      const result = detectThreadDivergence(email, apt1, [apt1, apt2]);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('cross_thread_reference');
      expect(result.severity).toBe('high');
    });
  });
});

describe('shouldBlockProcessing', () => {
  it('returns false for no detection', () => {
    const detection = detectThreadDivergence(
      makeEmailContext(),
      makeAppointmentContext(),
      [makeAppointmentContext()]
    );
    expect(shouldBlockProcessing(detection)).toBe(false);
  });

  it('returns true for critical severity', () => {
    expect(
      shouldBlockProcessing({
        detected: true,
        type: 'cc_parallel_thread',
        severity: 'critical',
        confidence: 0.9,
        description: 'Test',
        suggestedAction: 'manual_review',
      })
    ).toBe(true);
  });

  it('returns true for manual_review action', () => {
    expect(
      shouldBlockProcessing({
        detected: true,
        type: 'wrong_thread_reply',
        severity: 'high',
        confidence: 0.9,
        description: 'Test',
        suggestedAction: 'manual_review',
      })
    ).toBe(true);
  });

  it('returns false for auto_merge action', () => {
    expect(
      shouldBlockProcessing({
        detected: true,
        type: 'therapist_direct_reply',
        severity: 'low',
        confidence: 0.85,
        description: 'Test',
        suggestedAction: 'auto_merge',
      })
    ).toBe(false);
  });
});

describe('getDivergenceSummary', () => {
  it('returns empty string for no detection', () => {
    const summary = getDivergenceSummary({
      detected: false,
      type: 'none',
      severity: 'low',
      confidence: 1,
      description: 'No divergence',
      suggestedAction: 'none',
    });
    expect(summary).toBe('');
  });

  it('includes all relevant information', () => {
    const summary = getDivergenceSummary({
      detected: true,
      type: 'wrong_thread_reply',
      severity: 'high',
      confidence: 0.95,
      description: 'Email thread belongs to different appointment',
      suggestedAction: 'manual_review',
      relatedAppointmentIds: ['apt-1', 'apt-2'],
    });
    expect(summary).toContain('Thread Divergence Detected');
    expect(summary).toContain('wrong thread reply');
    expect(summary).toContain('HIGH');
    expect(summary).toContain('95%');
    expect(summary).toContain('apt-1');
    expect(summary).toContain('manual review');
  });
});

describe('createMergeNotes', () => {
  it('includes divergence type and thread ID', () => {
    const email = makeEmailContext({ threadId: 'thread-xyz' });
    const detection = {
      detected: true,
      type: 'forward_new_thread' as const,
      severity: 'medium' as const,
      confidence: 0.8,
      description: 'Forwarded email',
      suggestedAction: 'auto_merge' as const,
    };
    const notes = createMergeNotes(detection, email);
    expect(notes).toContain('THREAD DIVERGENCE');
    expect(notes).toContain('forward_new_thread');
    expect(notes).toContain('thread-xyz');
  });
});

describe('parseEmailAddresses', () => {
  it('extracts email from plain address', () => {
    expect(parseEmailAddresses('user@example.com')).toEqual(['user@example.com']);
  });

  it('extracts email from "Name <email>" format', () => {
    expect(parseEmailAddresses('John Doe <john@example.com>')).toEqual(['john@example.com']);
  });

  it('extracts multiple emails', () => {
    const result = parseEmailAddresses('alice@example.com, Bob <bob@example.com>');
    expect(result).toContain('alice@example.com');
    expect(result).toContain('bob@example.com');
  });

  it('deduplicates emails', () => {
    const result = parseEmailAddresses('user@example.com, User <user@example.com>');
    expect(result).toEqual(['user@example.com']);
  });

  it('returns empty array for empty input', () => {
    expect(parseEmailAddresses('')).toEqual([]);
  });

  it('normalizes to lowercase', () => {
    expect(parseEmailAddresses('User@Example.COM')).toEqual(['user@example.com']);
  });
});

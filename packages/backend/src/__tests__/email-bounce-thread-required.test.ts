/**
 * Tests for the unauthenticated-bounce-cancel hardening.
 *
 * Before the fix, `handleBounce` cancelled appointments based on:
 *   1. an attacker-controllable threadId, OR
 *   2. an attacker-controllable email address extracted from the body
 *      via regex (when threadId was missing).
 *
 * Both routes pushed the appointment through `transitionToCancelled`
 * with `skipNotifications: true`, so neither the user nor the therapist
 * was emailed. An attacker could craft a fake `mailer-daemon` email
 * naming a victim's address and silently cancel that user's appointment.
 *
 * After the fix, `handleBounce` requires a threadId match against an
 * appointment we own (gmailThreadId or therapistGmailThreadId). Body
 * recipient extraction is no longer authoritative.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindFirst = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: { findFirst: (...a: unknown[]) => mockFindFirst(...a) },
  },
}));

const mockTransitionToCancelled = jest.fn();
jest.mock('../services/appointment-lifecycle.service', () => ({
  appointmentLifecycleService: {
    transitionToCancelled: (...a: unknown[]) => mockTransitionToCancelled(...a),
  },
}));

const mockNotifyEmailBounce = jest.fn();
const mockSendAlert = jest.fn();
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    notifyEmailBounce: (...a: unknown[]) => mockNotifyEmailBounce(...a),
    sendAlert: (...a: unknown[]) => mockSendAlert(...a),
  },
}));

import { handleBounce, processPotentialBounce, type BounceInfo } from '../services/email-bounce.service';

const VICTIM_EMAIL = 'victim@example.com';
const APPOINTMENT_THREAD_ID = 'thread-real-123';

const baseAppointment = {
  id: 'apt-real',
  therapistHandle: 'therapist-1',
  userName: 'Victim',
  userEmail: VICTIM_EMAIL,
  therapistName: 'Therapist',
  therapistEmail: 'therapist@example.com',
  gmailThreadId: APPOINTMENT_THREAD_ID,
  therapistGmailThreadId: null,
};

const bounceInfo: BounceInfo = {
  isBounce: true,
  bounceType: 'hard',
  detectionMethod: 'sender',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockTransitionToCancelled.mockResolvedValue({});
  mockNotifyEmailBounce.mockResolvedValue(true);
  mockSendAlert.mockResolvedValue(true);
});

describe('handleBounce — thread-id requirement', () => {
  it('refuses to cancel when no threadId is provided', async () => {
    // The attacker scenario: forged `mailer-daemon` email arriving with
    // no threadId (it didn't arrive in any of our existing Gmail
    // threads). After the body-extraction removal, refusal is the only
    // possible behaviour here — there's nothing for the attacker to
    // even attempt to spoof.
    const result = await handleBounce(bounceInfo, { messageId: 'attacker-msg' });

    expect(result.handled).toBe(false);
    expect(result.therapistUnfrozen).toBe(false);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockTransitionToCancelled).not.toHaveBeenCalled();
  });

  it('refuses to cancel when threadId does not match a tracked appointment', async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const result = await handleBounce(bounceInfo, {
      threadId: 'attacker-controlled-thread',
      messageId: 'msg-1',
    });

    expect(result.handled).toBe(false);
    expect(result.therapistUnfrozen).toBe(false);
    expect(mockTransitionToCancelled).not.toHaveBeenCalled();
  });

  it('cancels and unfreezes when the bounce thread matches an appointment we own', async () => {
    mockFindFirst.mockResolvedValueOnce(baseAppointment);

    const result = await handleBounce(bounceInfo, {
      threadId: APPOINTMENT_THREAD_ID,
      messageId: 'msg-bounce',
    });

    expect(result.handled).toBe(true);
    expect(result.therapistUnfrozen).toBe(true);
    expect(mockTransitionToCancelled).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: 'apt-real',
        cancelledBy: 'system',
      }),
    );
  });

  it('derives bouncedRole from the matched thread', async () => {
    // The matched thread (gmailThreadId) is the client thread, so the
    // bouncedRole must be 'client'. The body-extracted recipient was
    // removed entirely after C1 — there is no longer any way for the
    // attacker-controlled body to override this decision.
    mockFindFirst.mockResolvedValueOnce(baseAppointment);

    await handleBounce(bounceInfo, { threadId: APPOINTMENT_THREAD_ID, messageId: 'msg-1' });

    expect(mockNotifyEmailBounce).toHaveBeenCalledWith(
      'apt-real',
      'Victim',
      'Therapist',
      'client',
      expect.any(String),
    );
  });

  it('reports therapist role when therapistGmailThreadId is the one that matched', async () => {
    mockFindFirst.mockResolvedValueOnce({
      ...baseAppointment,
      gmailThreadId: 'unrelated-client-thread',
      therapistGmailThreadId: APPOINTMENT_THREAD_ID,
    });

    await handleBounce(bounceInfo, {
      threadId: APPOINTMENT_THREAD_ID,
      messageId: 'msg-1',
    });

    expect(mockNotifyEmailBounce).toHaveBeenCalledWith(
      'apt-real',
      'Victim',
      'Therapist',
      'therapist',
      expect.any(String),
    );
  });
});

describe('processPotentialBounce — admin alert when un-actioned', () => {
  it('alerts admins when a bounce regex matches but no auto-action ran', async () => {
    // Sender pattern matches 'mailer-daemon', threadId is missing/unknown.
    await processPotentialBounce({
      from: 'mailer-daemon@evil.test',
      subject: 'Delivery failed',
      body: '550 user unknown',
      messageId: 'msg-attack',
    });

    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Bounce-shaped email — manual review',
      }),
    );
    expect(mockTransitionToCancelled).not.toHaveBeenCalled();
  });

  it('does not alert when the email is not a bounce at all', async () => {
    await processPotentialBounce({
      from: 'someone@example.com',
      subject: 'Just saying hi',
      body: 'Nothing here',
      messageId: 'msg-normal',
    });

    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});

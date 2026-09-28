/**
 * E2 regression: subject-pattern "bounces" auto-cancelled live appointments.
 *
 * Before the fix, ANY inbound on one of our threads whose subject matched a
 * loose regex was a bounce and the appointment was cancelled with
 * notifications suppressed. The audit reproduced isBounce:true for:
 *   - a Gmail "Delivery Status Notification (Delay)" (Gmail still retrying),
 *   - an ordinary reply "Re: … my last message was not delivered?",
 *   - an ordinary reply "… availability unknown" (via /user.*unknown/),
 * and the status filter let session_held / feedback_requested be cancelled.
 *
 * After the fix:
 *   - a bounce must look machine-generated (DSN sender, DSN MIME structure,
 *     or subject + Auto-Submitted) — an ordinary sender is never a bounce;
 *   - delay notices are non-fatal (no cancel, no alert);
 *   - only HARD failures auto-cancel, and only pre-booking appointments.
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
jest.mock('../domain/scheduling/lifecycle', () => ({
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

import {
  detectBounce,
  handleBounce,
  processPotentialBounce,
} from '../services/email-bounce.service';

const THREAD_ID = 'thread-owned-by-us';
const THERAPIST = 'sarah@clinic.example';

const pendingAppointment = {
  id: 'apt-negotiating',
  therapistHandle: 'sarah-jones',
  userName: 'Jamie',
  userEmail: 'jamie@example.com',
  therapistName: 'Sarah Jones',
  therapistEmail: THERAPIST,
  gmailThreadId: null,
  therapistGmailThreadId: THREAD_ID,
};

// --- The three audit inputs -------------------------------------------------

const GMAIL_DELAY_DSN = {
  from: 'mailer-daemon@googlemail.com',
  subject: 'Delivery Status Notification (Delay)',
  body:
    "There was a temporary problem delivering your message to sarah@clinic.example. " +
    'Gmail will retry for 46 more hours. You\'ll be notified if the delivery fails permanently.\n\n' +
    'The response from the remote server was:\n451 4.7.1 Greylisted, please try again later',
  autoSubmitted: 'auto-replied',
  isDeliveryStatusReport: true,
  deliveryStatus: 'Action: delayed\nStatus: 4.7.1',
};

const ORDINARY_REPLY_NOT_DELIVERED = {
  from: THERAPIST,
  subject: 'Re: [SPL-4821] New client for you - my last message was not delivered?',
  body: 'Hi Justin, did my last message get through? I can do Tuesday 3pm.',
};

const ORDINARY_REPLY_AVAILABILITY_UNKNOWN = {
  from: THERAPIST,
  subject: 'Re: [SPL-4821] Spill user booking request - availability unknown',
  body: 'My availability is unknown until Friday, will confirm then.',
};

// --- A real hard bounce ------------------------------------------------------

const GMAIL_HARD_BOUNCE = {
  from: 'mailer-daemon@googlemail.com',
  subject: 'Delivery Status Notification (Failure)',
  body:
    "Address not found\n\nYour message wasn't delivered to sarah@clinic.example because the address " +
    "couldn't be found, or is unable to receive mail.\n\nThe response from the remote server was:\n" +
    '550 5.1.1 The email account that you tried to reach does not exist.',
  autoSubmitted: 'auto-replied',
  isDeliveryStatusReport: true,
  deliveryStatus: 'Action: failed\nStatus: 5.1.1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockTransitionToCancelled.mockResolvedValue({});
  mockNotifyEmailBounce.mockResolvedValue(true);
  mockSendAlert.mockResolvedValue(true);
});

describe('detectBounce — audit inputs (E2)', () => {
  it('classifies a Gmail "Delivery Status Notification (Delay)" as a non-fatal delay', () => {
    const info = detectBounce(GMAIL_DELAY_DSN);
    expect(info.isBounce).toBe(true);
    expect(info.bounceType).toBe('delay');
  });

  it('classifies a delay by subject alone even without DSN fields (Exchange/Postfix/Exim shapes)', () => {
    for (const subject of [
      'Delivery delayed: Re: your session',
      'Delayed Mail (still being retried)',
      'Warning: message 1qXyZ-0003 delayed 24 hours',
    ]) {
      expect(detectBounce({ from: 'postmaster@mx.example', subject, body: '' }).bounceType).toBe('delay');
    }
  });

  it('does NOT treat an ordinary "my last message was not delivered?" reply as a bounce', () => {
    expect(detectBounce(ORDINARY_REPLY_NOT_DELIVERED)).toEqual({
      isBounce: false,
      bounceType: null,
      detectionMethod: null,
    });
  });

  it('does NOT treat an ordinary "availability unknown" reply as a bounce', () => {
    expect(detectBounce(ORDINARY_REPLY_AVAILABILITY_UNKNOWN).isBounce).toBe(false);
  });

  it('a subject match counts only with an Auto-Submitted header', () => {
    const base = { from: 'robot@mx.example', subject: 'Undeliverable: Re: your session', body: '550 5.1.1 user unknown' };
    expect(detectBounce(base).isBounce).toBe(false);
    expect(detectBounce({ ...base, autoSubmitted: 'no' }).isBounce).toBe(false);
    expect(detectBounce({ ...base, autoSubmitted: 'auto-replied' })).toEqual({
      isBounce: true,
      bounceType: 'hard',
      detectionMethod: 'subject',
    });
  });

  it('detects a DSN by MIME structure even from an unrecognised sender', () => {
    const info = detectBounce({
      from: 'no-reply@mx.relay.example',
      subject: 'Returned message',
      body: '',
      isDeliveryStatusReport: true,
      deliveryStatus: 'Action: failed\nStatus: 5.1.1',
    });
    expect(info).toEqual({ isBounce: true, bounceType: 'hard', detectionMethod: 'dsn-report' });
  });

  it('classifies hard / soft / unknown failures', () => {
    expect(detectBounce(GMAIL_HARD_BOUNCE).bounceType).toBe('hard');
    expect(
      detectBounce({
        from: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Failure)',
        body: "The recipient's inbox is out of storage space. 552 5.2.2 Mailbox full",
      }).bounceType,
    ).toBe('soft');
    expect(
      detectBounce({ from: 'mailer-daemon@googlemail.com', subject: 'Notice', body: 'Something happened.' }).bounceType,
    ).toBe('unknown');
  });

  it('a final-failure notice that quotes an earlier temporary error is not a delay', () => {
    const info = detectBounce({
      from: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      body: 'Message not delivered. Gmail will not retry. 550 5.1.1 user unknown',
      deliveryStatus: 'Action: failed\nStatus: 5.1.1',
    });
    expect(info.bounceType).toBe('hard');
  });
});

describe('processPotentialBounce — only hard DSNs on our pre-booking threads cancel (E2)', () => {
  it('delay notice on our thread: no cancel, no lookup, no alert — but still flagged as a DSN', async () => {
    mockFindFirst.mockResolvedValue(pendingAppointment);

    const result = await processPotentialBounce({ ...GMAIL_DELAY_DSN, threadId: THREAD_ID, messageId: 'm1' });

    expect(result).toEqual({ isBounce: true, cancelled: false, bounceType: 'delay' });
    expect(mockTransitionToCancelled).not.toHaveBeenCalled();
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('ordinary "not delivered?" reply on our thread: not a bounce, nothing cancelled', async () => {
    mockFindFirst.mockResolvedValue(pendingAppointment);

    const result = await processPotentialBounce({
      ...ORDINARY_REPLY_NOT_DELIVERED,
      threadId: THREAD_ID,
      messageId: 'm2',
    });

    expect(result.isBounce).toBe(false);
    expect(mockTransitionToCancelled).not.toHaveBeenCalled();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('ordinary "availability unknown" reply on our thread: not a bounce, nothing cancelled', async () => {
    mockFindFirst.mockResolvedValue(pendingAppointment);

    const result = await processPotentialBounce({
      ...ORDINARY_REPLY_AVAILABILITY_UNKNOWN,
      threadId: THREAD_ID,
      messageId: 'm3',
    });

    expect(result.isBounce).toBe(false);
    expect(mockTransitionToCancelled).not.toHaveBeenCalled();
  });

  it('a real hard bounce on our pre-booking thread STILL cancels', async () => {
    mockFindFirst.mockResolvedValueOnce(pendingAppointment);

    const result = await processPotentialBounce({ ...GMAIL_HARD_BOUNCE, threadId: THREAD_ID, messageId: 'm4' });

    expect(result).toEqual({ isBounce: true, cancelled: true, bounceType: 'hard' });
    expect(mockTransitionToCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: 'apt-negotiating', cancelledBy: 'system', skipNotifications: true }),
    );
    expect(mockNotifyEmailBounce).toHaveBeenCalledWith(expect.objectContaining({ bouncedRole: 'therapist' }));
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('a soft bounce is not auto-cancelled — admins get the manual-review alert', async () => {
    mockFindFirst.mockResolvedValue(pendingAppointment);

    const result = await processPotentialBounce({
      from: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      body: "The recipient's inbox is out of storage space. 552 5.2.2 Mailbox full",
      threadId: THREAD_ID,
      messageId: 'm5',
    });

    expect(result).toEqual({ isBounce: true, cancelled: false, bounceType: 'soft' });
    expect(mockTransitionToCancelled).not.toHaveBeenCalled();
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bounce-shaped email — manual review' }),
    );
  });
});

describe('handleBounce — never cancels post-session appointments (E2c)', () => {
  const hard = { isBounce: true, bounceType: 'hard' as const, detectionMethod: 'sender' as const };

  it('only looks up pre-booking appointments on the bounce thread', async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    await handleBounce(hard, { threadId: THREAD_ID, messageId: 'm6' });

    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['pending', 'contacted', 'negotiating'] });
    for (const protectedStatus of ['confirmed', 'session_held', 'feedback_requested', 'completed', 'cancelled']) {
      expect(where.status.in).not.toContain(protectedStatus);
    }
  });

  it('guards the transition atomically against every post-booking status', async () => {
    mockFindFirst.mockResolvedValueOnce(pendingAppointment);

    await handleBounce(hard, { threadId: THREAD_ID, messageId: 'm7' });

    const { atomic } = mockTransitionToCancelled.mock.calls[0][0];
    expect(atomic.requireStatusNotIn).toEqual(
      expect.arrayContaining(['cancelled', 'confirmed', 'session_held', 'feedback_requested', 'completed']),
    );
  });

  it('a hard bounce on a thread whose appointment is feedback_requested is not cancelled and is escalated', async () => {
    // The status filter excludes it, so no pre-booking appointment is found.
    mockFindFirst.mockResolvedValueOnce(null);

    const result = await processPotentialBounce({ ...GMAIL_HARD_BOUNCE, threadId: THREAD_ID, messageId: 'm8' });

    expect(result).toEqual({ isBounce: true, cancelled: false, bounceType: 'hard' });
    expect(mockTransitionToCancelled).not.toHaveBeenCalled();
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bounce-shaped email — manual review' }),
    );
  });

  it('refuses non-hard bounce types even when called directly', async () => {
    mockFindFirst.mockResolvedValue(pendingAppointment);
    for (const bounceType of ['soft', 'delay', 'unknown'] as const) {
      const result = await handleBounce(
        { isBounce: true, bounceType, detectionMethod: 'sender' },
        { threadId: THREAD_ID, messageId: `m-${bounceType}` },
      );
      expect(result.handled).toBe(false);
    }
    expect(mockTransitionToCancelled).not.toHaveBeenCalled();
  });
});

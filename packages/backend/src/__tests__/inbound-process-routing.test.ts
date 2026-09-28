/**
 * Pipeline-level regression tests for domain/scheduling/inbound/process.ts.
 *
 *   E9  — when the availability agent's processReply threw, routing
 *         returned false "leaving for retry", and processMessage fell
 *         through to nudge / appointment matching: the failure was never
 *         recorded in MessageProcessingFailure and the reply was misrouted
 *         (therapist-nudge-reply) or abandoned as unmatched.
 *   E2d — bounce detection ran BEFORE the own-outbound skip, so our own
 *         SENT copies were subject-tested as bounces.
 *   E2  — a DSN that was not auto-cancelled fell through to the agent and
 *         was attributed to the "therapist".
 *   E14 — the divergence pre-query matched sender emails case-sensitively.
 *
 * Everything processMessage touches is mocked; the REAL
 * availability-routing module runs so the E9 propagation is end-to-end.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockAppointmentFindMany = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: { findMany: (...a: unknown[]) => mockAppointmentFindMany(...a) },
  },
}));

jest.mock('../utils/redis', () => ({
  redis: {
    zadd: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(0),
    zremrangebyscore: jest.fn().mockResolvedValue(0),
  },
}));

jest.mock('../utils/redis-locks', () => ({ releaseLock: jest.fn().mockResolvedValue(true) }));

jest.mock('../utils/request-tracing', () => ({
  runWithTrace: (_ctx: unknown, fn: () => unknown) => fn(),
  extendTraceContext: jest.fn(),
}));

jest.mock('../core/email/inbound/lock-renewal', () => ({
  createLockRenewal: () => ({ stop: jest.fn(), isLockValid: () => true }),
}));

const mockMarkMessageProcessed = jest.fn();
jest.mock('../core/messaging/message-dedup', () => ({
  acquireMessageLock: jest.fn().mockResolvedValue({ outcome: 'acquired' }),
  isMessageProcessed: jest.fn().mockResolvedValue(false),
  markMessageProcessed: (...a: unknown[]) => mockMarkMessageProcessed(...a),
  releaseDbLock: jest.fn(),
  shouldEmitProcessingAlert: jest.fn().mockResolvedValue(false),
}));

const mockTrackProcessingFailure = jest.fn();
jest.mock('../core/email/inbound/processing-failures', () => ({
  trackProcessingFailure: (...a: unknown[]) => mockTrackProcessingFailure(...a),
  clearProcessingFailure: jest.fn(),
  markFailureAbandoned: jest.fn(),
}));

let mockGmailMessage: Record<string, unknown> = {};
jest.mock('../services/email-oauth.service', () => ({
  emailOAuthService: {
    ensureGmailClient: jest.fn().mockResolvedValue({
      users: { messages: { get: jest.fn(), modify: jest.fn().mockResolvedValue({}) } },
    }),
  },
  executeGmailWithProtection: jest.fn(async () => ({ data: mockGmailMessage })),
}));

const mockProcessPotentialBounce = jest.fn();
jest.mock('../services/email-bounce.service', () => ({
  emailBounceService: {
    processPotentialBounce: (...a: unknown[]) => mockProcessPotentialBounce(...a),
  },
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: jest.fn().mockResolvedValue(true),
    notifyUnmatchedEmailAbandoned: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock('../services/thread-fetching.service', () => ({
  threadFetchingService: {
    fetchThreadById: jest.fn().mockResolvedValue(null),
    formatThreadForAgent: jest.fn().mockReturnValue(''),
  },
}));

jest.mock('../services/email-classifier.service', () => ({
  classifyEmail: jest.fn().mockReturnValue({ intent: 'other' }),
}));

jest.mock('../services/invitation-reply.service', () => ({
  tryHandleInvitationReply: jest.fn().mockResolvedValue(false),
}));

const mockFindMatchingAppointmentRequest = jest.fn();
const mockFindMatchingTherapistConversation = jest.fn();
jest.mock('../utils/thread-matcher', () => ({
  findMatchingAppointmentRequest: (...a: unknown[]) => mockFindMatchingAppointmentRequest(...a),
  findMatchingTherapistConversation: (...a: unknown[]) => mockFindMatchingTherapistConversation(...a),
  senderIsPartyWhere: jest.requireActual('../utils/thread-matcher').senderIsPartyWhere,
}));

const mockProcessReply = jest.fn();
jest.mock('../domain/scheduling/availability/agent/service', () => ({
  AvailabilityAgentService: jest.fn().mockImplementation(() => ({
    processReply: (...a: unknown[]) => mockProcessReply(...a),
    sendSupersessionAck: jest.fn(),
  })),
}));

const mockDetectNudgeReplyByThreadId = jest.fn();
jest.mock('../domain/scheduling/inbound/nudge-reply', () => ({
  detectNudgeReplyByThreadId: (...a: unknown[]) => mockDetectNudgeReplyByThreadId(...a),
  detectNudgeReplyBySender: jest.fn().mockResolvedValue(null),
  alertAdminOfNudgeReply: jest.fn(),
}));

jest.mock('../domain/scheduling/inbound/weekly-mailing', () => ({
  isWeeklyMailingReply: jest.fn().mockResolvedValue(false),
  processWeeklyMailingReply: jest.fn(),
}));

jest.mock('../domain/scheduling/inbound/closure-auto-dismiss', () => ({
  maybeDismissClosureRecommendation: jest.fn(),
}));

const mockCheckAndHandleDivergence = jest.fn();
jest.mock('../domain/scheduling/inbound/divergence-handling', () => ({
  checkAndHandleDivergence: (...a: unknown[]) => mockCheckAndHandleDivergence(...a),
}));

jest.mock('../domain/scheduling/inbound/unmatched-attempts', () => ({
  trackUnmatchedAttempt: jest.fn().mockResolvedValue(1),
  abandonUnmatched: jest.fn(),
}));

const mockProcessEmailReply = jest.fn();
jest.mock('../domain/scheduling/inbound/agent-processor', () => ({
  getAgentProcessor: () => ({ processEmailReply: (...a: unknown[]) => mockProcessEmailReply(...a) }),
}));

import { processMessage } from '../domain/scheduling/inbound/process';
import { EMAIL } from '../constants';

function gmailMessage(headers: Record<string, string>, body = 'Tuesday 3pm works.'): Record<string, unknown> {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    payload: {
      mimeType: 'text/plain',
      headers: Object.entries({
        Subject: 'Re: availability',
        To: EMAIL.FROM_ADDRESS,
        Date: 'Mon, 28 Sep 2026 10:00:00 +0000',
        ...headers,
      }).map(([name, value]) => ({ name, value })),
      body: { data: Buffer.from(body).toString('base64url') },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMarkMessageProcessed.mockResolvedValue(undefined);
  mockTrackProcessingFailure.mockResolvedValue(1);
  mockProcessPotentialBounce.mockResolvedValue({ isBounce: false, cancelled: false, bounceType: null });
  mockFindMatchingTherapistConversation.mockResolvedValue(null);
  mockDetectNudgeReplyByThreadId.mockResolvedValue(null);
  mockFindMatchingAppointmentRequest.mockResolvedValue(null);
  mockAppointmentFindMany.mockResolvedValue([]);
  mockCheckAndHandleDivergence.mockResolvedValue('retry');
});

describe('availability-agent failure propagates to failure tracking (E9)', () => {
  beforeEach(() => {
    mockGmailMessage = gmailMessage({ From: 'Sarah Jones <sarah@clinic.example>' });
    mockFindMatchingTherapistConversation.mockResolvedValue({
      id: 'convo-1',
      therapistId: 'th-1',
      therapistEmail: 'sarah@clinic.example',
      status: 'active',
      supersededAckSent: false,
      kind: 'nudge_reply',
    });
    // The nudge thread would match the legacy nudge branch if we fell through.
    mockDetectNudgeReplyByThreadId.mockResolvedValue({ id: 'th-1', name: 'Sarah Jones', email: 'sarah@clinic.example' });
  });

  it('records a MessageProcessingFailure instead of falling through to nudge / appointment matching', async () => {
    mockProcessReply.mockRejectedValueOnce(new Error('Anthropic API overloaded'));

    const result = await processMessage('msg-1', 'trace-1');

    expect(result).toBe(false);
    expect(mockTrackProcessingFailure).toHaveBeenCalledWith('msg-1', 'Anthropic API overloaded');
    expect(mockDetectNudgeReplyByThreadId).not.toHaveBeenCalled();
    expect(mockFindMatchingAppointmentRequest).not.toHaveBeenCalled();
    // Left unmarked so the retry path re-delivers it.
    expect(mockMarkMessageProcessed).not.toHaveBeenCalled();
  });

  it('defers WITHOUT consuming an abandon attempt when the failure is infrastructural (O3)', async () => {
    const { CircuitBreakerError } = jest.requireActual('../utils/circuit-breaker');
    mockProcessReply.mockRejectedValueOnce(new CircuitBreakerError('Circuit claude is OPEN', 'claude', 'OPEN'));

    const result = await processMessage('msg-1', 'trace-1');

    expect(result).toBe(false);
    // Not counted against MAX_PROCESSING_FAILURES — a short Claude outage
    // must not permanently abandon every email that arrived during it.
    expect(mockTrackProcessingFailure).not.toHaveBeenCalled();
    // Left unmarked so the poller / scanner re-drive it once the
    // dependency recovers.
    expect(mockMarkMessageProcessed).not.toHaveBeenCalled();
    expect(mockDetectNudgeReplyByThreadId).not.toHaveBeenCalled();
  });

  it('marks the message availability-agent-active when processReply succeeds', async () => {
    mockProcessReply.mockResolvedValueOnce(undefined);

    const result = await processMessage('msg-1', 'trace-1');

    expect(result).toBe(true);
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'availability-agent-active');
    expect(mockTrackProcessingFailure).not.toHaveBeenCalled();
    expect(mockDetectNudgeReplyByThreadId).not.toHaveBeenCalled();
  });
});

describe('own-outbound skip runs before bounce detection (E2d)', () => {
  it('never bounce-tests our own SENT copy, even with a bounce-shaped subject', async () => {
    mockGmailMessage = gmailMessage({
      From: `Justin Time <${EMAIL.FROM_ADDRESS.toUpperCase()}>`,
      Subject: 'Re: [SPL-1234] your message could not be delivered',
    });

    const result = await processMessage('msg-1', 'trace-1');

    expect(result).toBe(false);
    expect(mockProcessPotentialBounce).not.toHaveBeenCalled();
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'own-email');
  });
});

describe('delivery-status notifications never reach the agent (E2)', () => {
  it('records a non-cancelled DSN as a bounce and stops routing', async () => {
    mockGmailMessage = gmailMessage(
      { From: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', Subject: 'Delivery Status Notification (Delay)' },
      'Gmail will retry for 46 more hours.',
    );
    mockProcessPotentialBounce.mockResolvedValueOnce({ isBounce: true, cancelled: false, bounceType: 'delay' });

    const result = await processMessage('msg-1', 'trace-1');

    expect(result).toBe(false);
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'bounce');
    expect(mockFindMatchingTherapistConversation).not.toHaveBeenCalled();
    expect(mockFindMatchingAppointmentRequest).not.toHaveBeenCalled();
    expect(mockProcessEmailReply).not.toHaveBeenCalled();
  });

  it('passes the parsed DSN signals through to bounce detection', async () => {
    mockGmailMessage = gmailMessage({ From: 'sarah@clinic.example', 'Auto-Submitted': 'auto-replied' });

    await processMessage('msg-1', 'trace-1');

    expect(mockProcessPotentialBounce).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'sarah@clinic.example', autoSubmitted: 'auto-replied', threadId: 'thread-1' }),
    );
  });

  it('returns true (handled) when a hard bounce cancelled the appointment', async () => {
    mockGmailMessage = gmailMessage({ From: 'mailer-daemon@googlemail.com' });
    mockProcessPotentialBounce.mockResolvedValueOnce({ isBounce: true, cancelled: true, bounceType: 'hard' });

    expect(await processMessage('msg-1', 'trace-1')).toBe(true);
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'bounce');
  });
});

describe('divergence pre-query is case-insensitive and carries therapist identity (E14 / E4)', () => {
  it('queries the sender case-insensitively and selects therapistId / therapistHandle', async () => {
    mockGmailMessage = gmailMessage({ From: 'Jamie <Jamie.Client@Example.com>' });
    mockFindMatchingAppointmentRequest.mockResolvedValueOnce({
      id: 'apt-1',
      userEmail: 'Jamie.Client@Example.com',
      therapistEmail: 'sarah@clinic.example',
    });

    await processMessage('msg-1', 'trace-1');

    const args = mockAppointmentFindMany.mock.calls[0][0];
    expect(args.where.OR).toEqual([
      { userEmail: { equals: 'jamie.client@example.com', mode: 'insensitive' } },
      { therapistEmail: { equals: 'jamie.client@example.com', mode: 'insensitive' } },
    ]);
    expect(args.select).toEqual(expect.objectContaining({ therapistId: true, therapistHandle: true }));
    expect(mockCheckAndHandleDivergence).toHaveBeenCalled();
  });
});

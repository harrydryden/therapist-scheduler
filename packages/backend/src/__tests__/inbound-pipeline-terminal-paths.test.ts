/**
 * Pipeline regressions for domain/scheduling/inbound/process.ts:
 *
 *   #7   UNREAD was only cleared after a successful agent turn, so nudge /
 *        weekly-mailing / bounce / abandoned / skipped messages kept
 *        occupying the backup poll's fixed unread window forever.
 *   E7   With Redis down, the DB-fallback "lock" was the message's own
 *        processed row and was deleted only on the generic error path, so
 *        paused / unmatched-within-budget / divergence-retry /
 *        optimistic-lock outcomes left the message permanently processed.
 *        The lease is now separate and released on every return.
 *   E10  Paused (human-control) messages re-ran the whole pipeline every
 *        poll. They are now recorded as deferred and skipped, and the
 *        closure / divergence side effects wait until release.
 *   §4.3 Auto-submitted / out-of-office replies got a full agent turn;
 *        classification read our own quoted text.
 *
 * Everything processMessage touches is mocked.
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
  createLeaseRenewal: () => ({ stop: jest.fn(), isLockValid: () => true }),
}));

const mockAcquire = jest.fn();
const mockMarkMessageProcessed = jest.fn();
const mockReleaseDbLock = jest.fn();
jest.mock('../core/messaging/message-dedup', () => ({
  acquireMessageLock: (...a: unknown[]) => mockAcquire(...a),
  isMessageProcessed: jest.fn().mockResolvedValue(false),
  markMessageProcessed: (...a: unknown[]) => mockMarkMessageProcessed(...a),
  releaseDbLock: (...a: unknown[]) => mockReleaseDbLock(...a),
  renewDbLock: jest.fn().mockResolvedValue(true),
  shouldEmitProcessingAlert: jest.fn().mockResolvedValue(false),
}));

const mockTrackProcessingFailure = jest.fn();
jest.mock('../core/email/inbound/processing-failures', () => ({
  trackProcessingFailure: (...a: unknown[]) => mockTrackProcessingFailure(...a),
  clearProcessingFailure: jest.fn(),
  markFailureAbandoned: jest.fn(),
}));

let mockGmailMessage: Record<string, unknown> = {};
const mockModify = jest.fn().mockResolvedValue({});
const mockExecuteGmail = jest.fn(async () => ({ data: mockGmailMessage }));
jest.mock('../services/email-oauth.service', () => ({
  emailOAuthService: {
    ensureGmailClient: jest.fn().mockResolvedValue({
      users: { messages: { get: jest.fn(), modify: (...a: unknown[]) => mockModify(...a) } },
    }),
  },
  executeGmailWithProtection: (...a: unknown[]) => (mockExecuteGmail as jest.Mock)(...a),
}));

const mockProcessPotentialBounce = jest.fn();
jest.mock('../services/email-bounce.service', () => ({
  emailBounceService: { processPotentialBounce: (...a: unknown[]) => mockProcessPotentialBounce(...a) },
}));

const mockSendAlert = jest.fn().mockResolvedValue(true);
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: (...a: unknown[]) => mockSendAlert(...a),
    notifyUnmatchedEmailAbandoned: jest.fn().mockResolvedValue(true),
  },
}));

const mockFetchThread = jest.fn().mockResolvedValue(null);
jest.mock('../services/thread-fetching.service', () => ({
  threadFetchingService: {
    fetchThreadById: (...a: unknown[]) => mockFetchThread(...a),
    formatThreadForAgent: jest.fn().mockReturnValue(''),
  },
}));

const mockClassifyEmail = jest.fn().mockReturnValue({ intent: 'other' });
jest.mock('../services/email-classifier.service', () => ({
  classifyEmail: (...a: unknown[]) => mockClassifyEmail(...a),
}));

jest.mock('../services/invitation-reply.service', () => ({
  tryHandleInvitationReply: jest.fn().mockResolvedValue(false),
}));

const mockFindMatchingAppointmentRequest = jest.fn();
jest.mock('../utils/thread-matcher', () => ({
  findMatchingAppointmentRequest: (...a: unknown[]) => mockFindMatchingAppointmentRequest(...a),
  findMatchingTherapistConversation: jest.fn().mockResolvedValue(null),
  senderIsPartyWhere: jest.requireActual('../utils/thread-matcher').senderIsPartyWhere,
}));

jest.mock('../domain/scheduling/inbound/availability-routing', () => ({
  routeToAvailabilityAgent: jest.fn(),
}));

const mockDetectNudgeReplyByThreadId = jest.fn();
jest.mock('../domain/scheduling/inbound/nudge-reply', () => ({
  detectNudgeReplyByThreadId: (...a: unknown[]) => mockDetectNudgeReplyByThreadId(...a),
  detectNudgeReplyBySender: jest.fn().mockResolvedValue(null),
  alertAdminOfNudgeReply: jest.fn(),
}));

const mockIsWeeklyMailingReply = jest.fn();
const mockProcessWeeklyMailingReply = jest.fn();
jest.mock('../domain/scheduling/inbound/weekly-mailing', () => ({
  isWeeklyMailingReply: (...a: unknown[]) => mockIsWeeklyMailingReply(...a),
  processWeeklyMailingReply: (...a: unknown[]) => mockProcessWeeklyMailingReply(...a),
}));

const mockDismissClosure = jest.fn();
jest.mock('../domain/scheduling/inbound/closure-auto-dismiss', () => ({
  maybeDismissClosureRecommendation: (...a: unknown[]) => mockDismissClosure(...a),
}));

const mockCheckAndHandleDivergence = jest.fn();
jest.mock('../domain/scheduling/inbound/divergence-handling', () => ({
  checkAndHandleDivergence: (...a: unknown[]) => mockCheckAndHandleDivergence(...a),
}));

const mockTrackUnmatchedAttempt = jest.fn();
jest.mock('../domain/scheduling/inbound/unmatched-attempts', () => ({
  trackUnmatchedAttempt: (...a: unknown[]) => mockTrackUnmatchedAttempt(...a),
  abandonUnmatched: jest.fn(),
}));

const mockSkipIfDeferred = jest.fn();
const mockIsUnderHumanControl = jest.fn();
const mockRecordPausedDeferral = jest.fn();
jest.mock('../domain/scheduling/inbound/paused-deferral', () => ({
  skipIfDeferredWhilePaused: (...a: unknown[]) => mockSkipIfDeferred(...a),
  isUnderHumanControl: (...a: unknown[]) => mockIsUnderHumanControl(...a),
  recordPausedDeferral: (...a: unknown[]) => mockRecordPausedDeferral(...a),
}));

const mockProcessEmailReply = jest.fn();
jest.mock('../domain/scheduling/inbound/agent-processor', () => ({
  getAgentProcessor: () => ({ processEmailReply: (...a: unknown[]) => mockProcessEmailReply(...a) }),
}));

import { processMessage } from '../domain/scheduling/inbound/process';
import { ConcurrentModificationError } from '../errors';
import { EMAIL } from '../constants';

const APPOINTMENT = { id: 'apt-1', userEmail: 'client@example.com', therapistEmail: 'sarah@clinic.example' };

function gmailMessage(
  headers: Record<string, string>,
  body = 'Tuesday 3pm works.',
  labelIds: string[] = ['INBOX', 'UNREAD'],
): Record<string, unknown> {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    labelIds,
    payload: {
      mimeType: 'text/plain',
      headers: Object.entries({
        From: 'client@example.com',
        Subject: 'Re: availability',
        To: EMAIL.FROM_ADDRESS,
        Date: 'Mon, 28 Sep 2026 10:00:00 +0000',
        ...headers,
      }).map(([name, value]) => ({ name, value })),
      body: { data: Buffer.from(body).toString('base64url') },
    },
  };
}

const unreadCleared = () =>
  mockModify.mock.calls.some(([args]) => (args as { requestBody: { removeLabelIds: string[] } }).requestBody.removeLabelIds.includes('UNREAD'));

beforeEach(() => {
  jest.clearAllMocks();
  mockAcquire.mockResolvedValue({ outcome: 'acquired' });
  mockMarkMessageProcessed.mockResolvedValue(undefined);
  mockTrackProcessingFailure.mockResolvedValue(1);
  mockProcessPotentialBounce.mockResolvedValue({ isBounce: false, cancelled: false, bounceType: null });
  mockDetectNudgeReplyByThreadId.mockResolvedValue(null);
  mockIsWeeklyMailingReply.mockResolvedValue(false);
  mockFindMatchingAppointmentRequest.mockResolvedValue(APPOINTMENT);
  mockAppointmentFindMany.mockResolvedValue([]);
  mockCheckAndHandleDivergence.mockResolvedValue('proceed');
  mockTrackUnmatchedAttempt.mockResolvedValue(1);
  mockSkipIfDeferred.mockResolvedValue(false);
  mockIsUnderHumanControl.mockResolvedValue(false);
  mockProcessEmailReply.mockResolvedValue({ success: true, message: 'ok' });
  mockGmailMessage = gmailMessage({});
});

describe('UNREAD is cleared on every terminal branch (#7)', () => {
  it('bounce (not cancelled)', async () => {
    mockProcessPotentialBounce.mockResolvedValueOnce({ isBounce: true, cancelled: false, bounceType: 'delay' });
    await processMessage('msg-1', 't');
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'bounce');
    expect(unreadCleared()).toBe(true);
  });

  it('legacy nudge reply', async () => {
    mockDetectNudgeReplyByThreadId.mockResolvedValueOnce({ id: 'th-1', name: 'Sarah', email: 'sarah@clinic.example' });
    await processMessage('msg-1', 't');
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'therapist-nudge-reply');
    expect(unreadCleared()).toBe(true);
  });

  it('weekly-mailing reply', async () => {
    mockIsWeeklyMailingReply.mockResolvedValueOnce(true);
    mockProcessWeeklyMailingReply.mockResolvedValueOnce(true);
    await processMessage('msg-1', 't');
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'weekly-mailing-reply');
    expect(unreadCleared()).toBe(true);
  });

  it('unmatched, abandoned after the retry budget', async () => {
    mockFindMatchingAppointmentRequest.mockResolvedValue(null);
    mockTrackUnmatchedAttempt.mockResolvedValueOnce(3);
    await processMessage('msg-1', 't');
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'unmatched-abandoned');
    expect(unreadCleared()).toBe(true);
  });

  it('own outbound copy (skipped)', async () => {
    mockGmailMessage = gmailMessage({ From: EMAIL.FROM_ADDRESS });
    await processMessage('msg-1', 't');
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'own-email');
    expect(unreadCleared()).toBe(true);
  });

  it('divergence-blocked, abandoned', async () => {
    mockCheckAndHandleDivergence.mockResolvedValueOnce('abandoned');
    await processMessage('msg-1', 't');
    expect(unreadCleared()).toBe(true);
  });

  it('processing failure, abandoned after the retry budget', async () => {
    mockProcessEmailReply.mockRejectedValueOnce(new Error('agent exploded'));
    mockTrackProcessingFailure.mockResolvedValueOnce(3);
    await processMessage('msg-1', 't');
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'processing-failed-abandoned');
    expect(unreadCleared()).toBe(true);
  });

  it('agent success (unchanged)', async () => {
    expect(await processMessage('msg-1', 't')).toBe(true);
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'successfully-processed');
    expect(unreadCleared()).toBe(true);
  });

  it.each([
    ['unmatched within budget', () => { mockFindMatchingAppointmentRequest.mockResolvedValue(null); }],
    ['divergence retry', () => { mockCheckAndHandleDivergence.mockResolvedValueOnce('retry'); }],
    ['failure within budget', () => { mockProcessEmailReply.mockRejectedValueOnce(new Error('boom')); }],
  ])('keeps UNREAD on a retryable outcome: %s', async (_name, arrange) => {
    arrange();
    await processMessage('msg-1', 't');
    expect(unreadCleared()).toBe(false);
  });

  it('makes no label call for a message that is already read', async () => {
    mockGmailMessage = gmailMessage({}, 'Tuesday 3pm works.', ['INBOX']);
    mockProcessPotentialBounce.mockResolvedValueOnce({ isBounce: true, cancelled: false, bounceType: 'delay' });
    await processMessage('msg-1', 't');
    expect(mockModify).not.toHaveBeenCalled();
  });
});

describe('Redis-down DB lease is released on every return and never marks processed (E7)', () => {
  beforeEach(() => {
    mockAcquire.mockResolvedValue({ outcome: 'acquired_db_fallback', leaseToken: 'lease-tok' });
  });

  it.each([
    ['unmatched within budget', () => { mockFindMatchingAppointmentRequest.mockResolvedValue(null); }],
    ['divergence retry', () => { mockCheckAndHandleDivergence.mockResolvedValueOnce('retry'); }],
    ['logged while paused', () => {
      mockProcessEmailReply.mockResolvedValueOnce({ success: true, message: 'paused', loggedWhilePaused: true });
    }],
    ['deferred for retry', () => {
      mockProcessEmailReply.mockResolvedValueOnce({ success: false, message: 'busy', deferredForRetry: true });
    }],
    ['optimistic-lock conflict', () => {
      mockProcessEmailReply.mockRejectedValueOnce(new ConcurrentModificationError('apt-1'));
    }],
  ])('%s: lease released, message NOT marked processed', async (_name, arrange) => {
    arrange();
    await processMessage('msg-1', 't');
    expect(mockReleaseDbLock).toHaveBeenCalledWith('msg-1', 'lease-tok', 't');
    expect(mockMarkMessageProcessed).not.toHaveBeenCalled();
  });

  it('success: the dedup record comes from markMessageProcessed, and the lease is still released', async () => {
    await processMessage('msg-1', 't');
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'successfully-processed');
    expect(mockReleaseDbLock).toHaveBeenCalledWith('msg-1', 'lease-tok', 't');
  });
});

describe('human-control (paused) messages (E10)', () => {
  it('skips a message already deferred for a still-paused appointment before any Gmail work', async () => {
    mockSkipIfDeferred.mockResolvedValueOnce(true);

    expect(await processMessage('msg-1', 't')).toBe(false);
    expect(mockExecuteGmail).not.toHaveBeenCalled();
    expect(mockProcessEmailReply).not.toHaveBeenCalled();
    expect(mockMarkMessageProcessed).not.toHaveBeenCalled();
  });

  it('logs a paused reply once via the agent, records the deferral, and defers the side effects', async () => {
    mockIsUnderHumanControl.mockResolvedValueOnce(true);
    mockProcessEmailReply.mockResolvedValueOnce({ success: true, message: 'paused', loggedWhilePaused: true });

    await processMessage('msg-1', 't');

    expect(mockProcessEmailReply).toHaveBeenCalledTimes(1);
    expect(mockRecordPausedDeferral).toHaveBeenCalledWith('msg-1', 'apt-1');
    expect(mockMarkMessageProcessed).not.toHaveBeenCalled();
    // Closure auto-dismiss and divergence tracking wait for the replay
    // after release.
    expect(mockDismissClosure).not.toHaveBeenCalled();
    expect(mockCheckAndHandleDivergence).not.toHaveBeenCalled();
  });

  it('runs the side effects normally when the appointment is not paused', async () => {
    await processMessage('msg-1', 't');
    expect(mockDismissClosure).toHaveBeenCalledTimes(1);
    expect(mockCheckAndHandleDivergence).toHaveBeenCalledTimes(1);
    expect(mockFetchThread).toHaveBeenCalledTimes(1);
    expect(mockRecordPausedDeferral).not.toHaveBeenCalled();
  });
});

describe('auto-replies never get an agent turn (§4.3)', () => {
  it('Auto-Submitted header: recorded as auto-reply, admin alerted, no Claude call', async () => {
    mockGmailMessage = gmailMessage({ From: 'sarah@clinic.example', 'Auto-Submitted': 'auto-replied' }, 'I am away until Monday.');

    expect(await processMessage('msg-1', 't')).toBe(true);

    expect(mockProcessEmailReply).not.toHaveBeenCalled();
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'auto-reply');
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: 'apt-1', severity: 'low', dedupGroup: 'auto-reply' }),
    );
    expect(unreadCleared()).toBe(true);
  });

  it('Outlook-style "Automatic reply:" subject without the header', async () => {
    mockGmailMessage = gmailMessage({ Subject: 'Automatic reply: Re: availability' });
    await processMessage('msg-1', 't');
    expect(mockProcessEmailReply).not.toHaveBeenCalled();
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'auto-reply');
  });

  it('a human reply that mentions a holiday still reaches the agent', async () => {
    mockGmailMessage = gmailMessage({ 'Auto-Submitted': 'no' }, "I'm on holiday next week but Tuesday 3pm works.");
    await processMessage('msg-1', 't');
    expect(mockProcessEmailReply).toHaveBeenCalledTimes(1);
    expect(mockMarkMessageProcessed).toHaveBeenCalledWith('msg-1', 'successfully-processed');
  });
});

describe('classification ignores quoted history (§4.3)', () => {
  it('classifies only what the sender wrote, but gives the agent the full body', async () => {
    const body =
      'Tuesday works for me, thanks!\n\n' +
      'On Mon, 28 Sep 2026 at 09:00, Justin Time <scheduling@spill.chat> wrote:\n' +
      '> If you need to cancel or reschedule, just reply.';
    mockGmailMessage = gmailMessage({}, body);

    await processMessage('msg-1', 't');

    expect(mockClassifyEmail.mock.calls[0][0]).toBe('Tuesday works for me, thanks!');
    expect(mockProcessEmailReply.mock.calls[0][1]).toContain('cancel or reschedule');
  });
});

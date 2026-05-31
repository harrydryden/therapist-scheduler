/**
 * Wiring test for the terminal-appointment guard inside
 * JustinTimeService.processEmailReply (product decision: flag-for-review on
 * inbound to a CANCELLED/COMPLETED appointment).
 *
 * Pins that:
 *   - a terminal-status inbound skips the agent loop, fires the admin alert,
 *     and returns a marked-processed result (NO loggedWhilePaused — there's
 *     nothing to replay on a closed booking); and
 *   - a non-terminal inbound is unaffected: the loop still runs and the
 *     terminal alert does NOT fire.
 *
 * The orchestrator's heavy collaborators are mocked (same approach as
 * justin-time-outbox.test.ts) so the test exercises the real control flow
 * without the anthropic / prisma graph.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const findUniqueMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: { appointmentRequest: { findUnique: (...a: unknown[]) => findUniqueMock(...a) } },
}));

const runToolLoopMock = jest.fn();
jest.mock('../services/agent-tool-loop', () => ({
  runToolLoop: (...a: unknown[]) => runToolLoopMock(...a),
}));

const reconcileStatusAfterReplyMock = jest.fn();
jest.mock('../services/post-reply-status', () => ({
  reconcileStatusAfterReply: (...a: unknown[]) => reconcileStatusAfterReplyMock(...a),
}));

const buildSystemPromptMock = jest.fn().mockResolvedValue('SYSTEM');
jest.mock('../services/system-prompt-builder', () => ({
  buildSystemPrompt: (...a: unknown[]) => buildSystemPromptMock(...a),
}));

const getConversationStateMock = jest.fn();
const storeConversationStateMock = jest.fn();
const storeWithRetryMock = jest.fn();
jest.mock('../services/ai-conversation.service', () => ({
  truncateMessageContent: (s: string) => s,
  AIConversationService: jest.fn().mockImplementation(() => ({
    getConversationState: (...a: unknown[]) => getConversationStateMock(...a),
    storeConversationState: (...a: unknown[]) => storeConversationStateMock(...a),
    storeConversationStateWithRetry: (...a: unknown[]) => storeWithRetryMock(...a),
  })),
}));

jest.mock('../core/agent/tools', () => ({
  AIToolExecutorService: jest.fn().mockImplementation(() => ({
    executeToolCall: jest.fn(),
    flagForHumanReviewFromLoop: jest.fn(),
  })),
}));

const sendAlertMock = jest.fn();
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: (...a: unknown[]) => sendAlertMock(...a) },
}));

const logEmailReceivedMock = jest.fn();
jest.mock('../services/audit-event.service', () => ({
  auditEventService: {
    logEmailReceived: (...a: unknown[]) => logEmailReceivedMock(...a),
    logFactsExtracted: jest.fn(),
  },
}));

jest.mock('../domain/scheduling/lifecycle', () => ({
  appointmentLifecycleService: { transitionToContacted: jest.fn(), transitionToNegotiating: jest.fn() },
}));

jest.mock('../services/email-classifier.service', () => ({
  classifyEmail: jest.fn(),
  needsSpecialHandling: () => ({ needsAttention: false }),
  formatClassificationForPrompt: () => 'CLASSIFICATION',
}));

jest.mock('../utils/content-sanitizer', () => ({
  checkForInjection: () => ({ injectionDetected: false, detectedPatterns: [] }),
  wrapUntrustedContent: (s: string) => s,
}));

// runBackgroundTask runs its task synchronously so the alert is observable.
jest.mock('../utils/background-task', () => ({
  runBackgroundTask: (fn: () => unknown) => {
    void fn();
  },
}));

jest.mock('../utils/conversation-facts', () => ({
  createEmptyFacts: () => ({}),
  updateFacts: () => ({}),
}));

import { JustinTimeService } from '../services/justin-time.service';
import type { EmailClassification } from '../services/email-classifier.service';

const CLASSIFICATION = {
  intent: 'general',
  sentiment: 'neutral',
  urgencyLevel: 'low',
  isFromTherapist: false,
  extractedSlots: [],
  therapistConfirmation: undefined,
} as unknown as EmailClassification;

function appointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apt-1',
    status: 'negotiating',
    userName: 'Alice',
    userEmail: 'client@example.com',
    therapistEmail: 'therapist@example.com',
    therapistName: 'Dr Taylor',
    humanControlEnabled: false,
    confirmedDateTime: null,
    reschedulingInProgress: false,
    bookingMethod: 'agent_negotiated',
    therapistAvailability: null,
    userId: 'u-1',
    therapistId: 'th-1',
    user: { country: 'UK', timezone: null },
    therapist: { country: 'UK', timezone: null },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  buildSystemPromptMock.mockResolvedValue('SYSTEM');
  runToolLoopMock.mockResolvedValue({
    messages: [],
    result: {
      iterations: 1,
      totalToolErrors: 0,
      executedTools: [],
      flaggedForHumanReview: false,
      hitMaxIterations: false,
    },
  });
  reconcileStatusAfterReplyMock.mockResolvedValue(undefined);
  getConversationStateMock.mockResolvedValue({ messages: [], checkpoint: null, facts: {}, _version: new Date() });
  storeWithRetryMock.mockResolvedValue({ success: true, retriesUsed: 0 });
});

describe('processEmailReply — terminal-appointment guard', () => {
  it.each(['cancelled', 'completed'])(
    'skips the agent loop and alerts admin on a %s appointment',
    async (status) => {
      findUniqueMock.mockResolvedValue(appointmentRow({ status }));

      const svc = new JustinTimeService('trace-terminal');
      const result = await svc.processEmailReply(
        'apt-1',
        'Hi, just following up',
        'client@example.com',
        undefined,
        CLASSIFICATION,
      );

      // Agent skipped, admin alerted.
      expect(runToolLoopMock).not.toHaveBeenCalled();
      expect(sendAlertMock).toHaveBeenCalledTimes(1);
      expect(sendAlertMock.mock.calls[0][0]).toMatchObject({
        appointmentId: 'apt-1',
        additionalFields: { Sender: 'client', Status: status },
      });

      // Marked processed (no replay) — loggedWhilePaused must be absent.
      expect(result.success).toBe(true);
      expect(result.message).toContain(status);
      expect(result.loggedWhilePaused).toBeUndefined();
    },
  );

  it('does NOT trigger on an active appointment — the loop runs as normal', async () => {
    findUniqueMock.mockResolvedValue(appointmentRow({ status: 'negotiating' }));

    const svc = new JustinTimeService('trace-active');
    await svc.processEmailReply(
      'apt-1',
      'Tuesday at 3pm works for me',
      'client@example.com',
      undefined,
      CLASSIFICATION,
    );

    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(runToolLoopMock).toHaveBeenCalledTimes(1);
    expect(reconcileStatusAfterReplyMock).toHaveBeenCalledTimes(1);
  });
});

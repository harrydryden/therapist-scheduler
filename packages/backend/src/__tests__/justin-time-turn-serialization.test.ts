/**
 * Wiring test for the `agent.turnSerialization` gate in JustinTimeService.
 *
 * Pins the wrapper contract described in appointment-turn-lock.ts:
 *   - setting off (default): startScheduling/processEmailReply delegate
 *     straight through, never touching the lock.
 *   - setting on + lock acquired: delegates through the lock, unwrapping
 *     `{acquired: true, result}` back to the plain return shape.
 *   - setting on + lock NOT acquired: startScheduling throws (so the
 *     justintime_start outbox row is marked failed and retried later);
 *     processEmailReply returns `deferredForRetry: true` (so the pipeline
 *     leaves the triggering message unmarked for redelivery instead of
 *     silently dropping it).
 *
 * Same heavy-collaborator mocking approach as
 * process-email-reply-terminal-skip.test.ts.
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
const storeWithRetryMock = jest.fn();
jest.mock('../services/ai-conversation.service', () => ({
  truncateMessageContent: (s: string) => s,
  AIConversationService: jest.fn().mockImplementation(() => ({
    getConversationState: (...a: unknown[]) => getConversationStateMock(...a),
    storeConversationState: jest.fn(),
    storeConversationStateWithRetry: (...a: unknown[]) => storeWithRetryMock(...a),
  })),
}));

jest.mock('../core/agent/tools', () => ({
  AIToolExecutorService: jest.fn().mockImplementation(() => ({
    executeToolCall: jest.fn(),
    flagForHumanReviewFromLoop: jest.fn(),
  })),
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: jest.fn() },
}));

jest.mock('../services/audit-event.service', () => ({
  auditEventService: { logEmailReceived: jest.fn(), logFactsExtracted: jest.fn() },
}));

const transitionToContactedMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../domain/scheduling/lifecycle', () => ({
  appointmentLifecycleService: {
    transitionToContacted: (...a: unknown[]) => transitionToContactedMock(...a),
    transitionToNegotiating: jest.fn(),
  },
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

jest.mock('../utils/background-task', () => ({
  runBackgroundTask: (fn: () => unknown) => {
    void fn();
  },
}));

jest.mock('../utils/conversation-facts', () => ({
  createEmptyFacts: () => ({}),
  updateFacts: () => ({}),
}));

const getSettingValueMock = jest.fn();
jest.mock('../services/settings.service', () => ({
  getSettingValue: (...a: unknown[]) => getSettingValueMock(...a),
}));

const withAppointmentTurnLockMock = jest.fn();
jest.mock('../services/appointment-turn-lock', () => ({
  withAppointmentTurnLock: (...a: unknown[]) => withAppointmentTurnLockMock(...a),
}));

import { JustinTimeService } from '../services/justin-time.service';
import type { EmailClassification } from '../services/email-classifier.service';
import type { SchedulingContext } from '../services/scheduling-context.service';

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

function schedulingContext(overrides: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    appointmentRequestId: 'apt-1',
    userName: 'Alice',
    userEmail: 'client@example.com',
    therapistEmail: 'therapist@example.com',
    therapistName: 'Dr Taylor',
    therapistAvailability: null,
    bookingMethod: 'agent_negotiated',
    userCountry: 'UK',
    therapistCountry: 'UK',
    ...overrides,
  } as SchedulingContext;
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
  findUniqueMock.mockResolvedValue(appointmentRow());
});

describe('agent.turnSerialization off (default)', () => {
  it('processEmailReply never touches the turn lock', async () => {
    getSettingValueMock.mockResolvedValue(false);

    const svc = new JustinTimeService('trace-off');
    const result = await svc.processEmailReply('apt-1', 'hi', 'client@example.com', undefined, CLASSIFICATION);

    expect(withAppointmentTurnLockMock).not.toHaveBeenCalled();
    expect(runToolLoopMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('startScheduling never touches the turn lock', async () => {
    getSettingValueMock.mockResolvedValue(false);

    const svc = new JustinTimeService('trace-off');
    const result = await svc.startScheduling(schedulingContext());

    expect(withAppointmentTurnLockMock).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});

describe('agent.turnSerialization on', () => {
  it('processEmailReply delegates through an acquired lock and unwraps the result', async () => {
    getSettingValueMock.mockResolvedValue(true);
    withAppointmentTurnLockMock.mockImplementation(async (_apptId, _traceId, fn) => ({
      acquired: true,
      result: await fn(),
    }));

    const svc = new JustinTimeService('trace-on');
    const result = await svc.processEmailReply('apt-1', 'hi', 'client@example.com', undefined, CLASSIFICATION);

    expect(withAppointmentTurnLockMock).toHaveBeenCalledWith('apt-1', 'trace-on', expect.any(Function));
    expect(runToolLoopMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('processEmailReply defers instead of dropping the message when the lock is not acquired', async () => {
    getSettingValueMock.mockResolvedValue(true);
    withAppointmentTurnLockMock.mockResolvedValue({ acquired: false });

    const svc = new JustinTimeService('trace-on');
    const result = await svc.processEmailReply('apt-1', 'hi', 'client@example.com', undefined, CLASSIFICATION);

    expect(runToolLoopMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.deferredForRetry).toBe(true);
  });

  it('startScheduling delegates through an acquired lock and unwraps the result', async () => {
    getSettingValueMock.mockResolvedValue(true);
    withAppointmentTurnLockMock.mockImplementation(async (_apptId, _traceId, fn) => ({
      acquired: true,
      result: await fn(),
    }));

    const svc = new JustinTimeService('trace-on');
    const result = await svc.startScheduling(schedulingContext());

    expect(withAppointmentTurnLockMock).toHaveBeenCalledWith('apt-1', 'trace-on', expect.any(Function));
    expect(result.success).toBe(true);
  });

  it('startScheduling throws (rather than silently succeeding) when the lock is not acquired', async () => {
    getSettingValueMock.mockResolvedValue(true);
    withAppointmentTurnLockMock.mockResolvedValue({ acquired: false });

    const svc = new JustinTimeService('trace-on');

    await expect(svc.startScheduling(schedulingContext())).rejects.toThrow(/turn lock/i);
    expect(runToolLoopMock).not.toHaveBeenCalled();
  });
});

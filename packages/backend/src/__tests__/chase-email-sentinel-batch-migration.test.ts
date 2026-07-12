/**
 * Regression tests for chase-email.service.ts's sendChaseFollowUps
 * migration onto processSentinelBatch (Stage D follow-up — see
 * docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md). The pre-send Gmail-thread-reply
 * safety check runs AFTER the sentinel claim and can release the claim
 * back (so a future tick re-evaluates the same candidate) — a third
 * outcome beyond the runner's original "queued" / "skipped-and-advanced"
 * pair, added here as 'skip-and-release'. These tests pin that the real
 * runner + the migrated service wire together correctly end to end,
 * since the runner's own unit tests (sentinel-batch-runner.test.ts) only
 * cover the runner in isolation with a fake `schedule`.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const settingsMock: Record<string, unknown> = {
  'chase.afterStaleHours': 72,
  'chase.maxChaseBatchSize': 50,
};
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn((key: string) => Promise.resolve(settingsMock[key])),
}));

const findManyMock = jest.fn();
const findUniqueMock = jest.fn();
// tryClaimSentinel/releaseSentinelClaim (atomic-sentinel-claim.ts, NOT
// mocked — the real implementation is exercised) are plain
// prisma.appointmentRequest.updateMany calls with a conditional `where`,
// no Redis involved. This tiny in-memory store mimics Prisma's atomic
// conditional-update semantics for the one field (chaseSentAt) those
// calls touch, so the claim/release dance is genuinely exercised rather
// than stubbed to always succeed.
const sentinelState: Record<string, Date | null> = {};
const updateManyMock = jest.fn(
  async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const id = where.id as string;
    const current = sentinelState[id] ?? null;
    const gate = where.chaseSentAt;
    const matches =
      gate === null ? current === null : current?.getTime() === (gate as Date)?.getTime();
    if (!matches) return { count: 0 };
    sentinelState[id] = data.chaseSentAt as Date | null;
    return { count: 1 };
  },
);
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findMany: (...a: unknown[]) => findManyMock(...a),
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
      updateMany: (...a: unknown[]) =>
        updateManyMock(...(a as [{ where: Record<string, unknown>; data: Record<string, unknown> }])),
      update: jest.fn(),
    },
  },
}));

const threadContainsInboundRepliesMock = jest.fn();
const checkThreadForUnprocessedRepliesMock = jest.fn();
jest.mock('../services/email-ingest.service', () => ({
  emailIngestService: {
    threadContainsInboundReplies: (...a: unknown[]) => threadContainsInboundRepliesMock(...a),
    checkThreadForUnprocessedReplies: (...a: unknown[]) => checkThreadForUnprocessedRepliesMock(...a),
  },
}));

const sendAlertMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: (...a: unknown[]) => sendAlertMock(...a) },
}));

const sendEmailMock = jest.fn().mockResolvedValue({ threadId: 't1', messageId: 'm1' });
jest.mock('../core/email', () => ({
  sendEmail: (...a: unknown[]) => sendEmailMock(...a),
}));

jest.mock('../utils/email-templates', () => ({
  getEmailSubject: jest.fn().mockResolvedValue('Subject'),
  getEmailBody: jest.fn().mockResolvedValue('Body'),
}));

const runPeriodicTrackedSideEffectMock = jest.fn();
jest.mock('../services/side-effect-harness', () => ({
  runPeriodicTrackedSideEffect: (...a: unknown[]) => runPeriodicTrackedSideEffectMock(...a),
}));

jest.mock('../services/periodic-effect-finalizers', () => ({
  finalizeChase: jest.fn().mockResolvedValue(undefined),
}));

// Unused by sendChaseFollowUps but imported at module scope by the other
// two ChaseEmailService methods — stub so the module loads.
jest.mock('../domain/scheduling/lifecycle', () => ({
  appointmentLifecycleService: { transitionToCompleted: jest.fn() },
}));
jest.mock('../services/ai-conversation.service', () => ({
  aiConversationService: { applyCheckpointAction: jest.fn() },
}));
jest.mock('../services/appointment-event.service', () => ({
  recordAppointmentEvent: jest.fn(),
}));

import { chaseEmailService } from '../services/chase-email.service';

function candidate(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'apt-1',
    userName: 'Sam',
    userEmail: 'sam@example.com',
    therapistName: 'Alex',
    therapistEmail: 'alex@example.com',
    checkpointStage: 'awaiting_therapist_availability',
    checkpointAt: new Date('2026-01-01T00:00:00Z'),
    gmailThreadId: null,
    therapistGmailThreadId: 'thread-therapist',
    lastActivityAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('chaseEmailService.sendChaseFollowUps — processSentinelBatch migration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(sentinelState)) delete sentinelState[key];
    threadContainsInboundRepliesMock.mockResolvedValue(false);
    checkThreadForUnprocessedRepliesMock.mockResolvedValue(0);
  });

  it('queues a chase and counts it as sent when no reply is on the thread', async () => {
    findManyMock.mockResolvedValue([candidate()]);

    const count = await chaseEmailService.sendChaseFollowUps('check-1');

    expect(count).toBe(1);
    expect(runPeriodicTrackedSideEffectMock).toHaveBeenCalledTimes(1);
    // Claimed (flipped null -> EPOCH_SENTINEL) and never released back to
    // null — a real send doesn't roll the sentinel back.
    expect(sentinelState['apt-1']?.getTime()).toBe(new Date(0).getTime());
  });

  it("releases the sentinel claim back to null and does NOT queue a chase when the thread has a newer inbound reply ('skip-and-release')", async () => {
    findManyMock.mockResolvedValue([candidate()]);
    threadContainsInboundRepliesMock.mockResolvedValue(true);

    const count = await chaseEmailService.sendChaseFollowUps('check-1');

    expect(count).toBe(0);
    expect(runPeriodicTrackedSideEffectMock).not.toHaveBeenCalled();
    // The regression this migration exists to preserve: claimed, then
    // released back to null (not left stuck at EPOCH_SENTINEL) so the
    // next tick's candidate query picks this row up again.
    expect(sentinelState['apt-1']).toBeNull();
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][0].title).toBe('Chase prevented — reply exists on thread');
    // The recovery attempt runs against the thread that had the reply.
    expect(checkThreadForUnprocessedRepliesMock).toHaveBeenCalledWith(
      'thread-therapist',
      expect.stringContaining('chase-presend-recovery:apt-1'),
    );
  });

  it('does not attempt a claim when no chase target can be determined (preCheck skip)', async () => {
    // A stage that is neither therapist-pending, user-pending, nor one of
    // the legacy inference stages, and with no threads on file.
    findManyMock.mockResolvedValue([
      candidate({ checkpointStage: 'confirmed', gmailThreadId: null, therapistGmailThreadId: null }),
    ]);

    const count = await chaseEmailService.sendChaseFollowUps('check-1');

    expect(count).toBe(0);
    expect(runPeriodicTrackedSideEffectMock).not.toHaveBeenCalled();
  });

  it('continues to the next candidate when preCheck throws for an earlier one', async () => {
    findUniqueMock.mockRejectedValueOnce(new Error('db down'));

    findManyMock.mockResolvedValue([
      // Legacy stage forces the lazy conversationState lookup, which throws.
      candidate({ id: 'apt-1', checkpointStage: 'stalled' }),
      candidate({ id: 'apt-2' }),
    ]);

    const count = await chaseEmailService.sendChaseFollowUps('check-1');

    // apt-1's preCheck threw and was skipped; apt-2 still got chased.
    expect(count).toBe(1);
    expect(runPeriodicTrackedSideEffectMock).toHaveBeenCalledTimes(1);
    expect(runPeriodicTrackedSideEffectMock.mock.calls[0][0]).toEqual({
      kind: 'appointment',
      appointmentId: 'apt-2',
    });
  });
});

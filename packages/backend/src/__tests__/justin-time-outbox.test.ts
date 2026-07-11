/**
 * Tests for the appointment-creation outbox path: a `justintime_start`
 * row is registered inside the appointment-creation tx so that
 * even if the in-process startScheduling never resolves (process crash,
 * unhandled rejection), the periodic side-effect-retry runner picks up
 * the stale-pending row and re-drives the kickoff.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    redisUrl: 'redis://localhost:6379',
    env: 'test',
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret',
  },
}));

jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

jest.mock('../utils/redis-locks', () => ({
  releaseLock: jest.fn(() => Promise.resolve()),
  renewLock: jest.fn(() => Promise.resolve(true)),
}));

const findManyMock = jest.fn();
const sideEffectFindUniqueMock = jest.fn();
const appointmentFindUniqueMock = jest.fn();
const updateMock = jest.fn();
const txCreateMock = jest.fn();
// CAS-claim used by tryClaimEffect before execute. Default `count: 1`
// so existing tests continue to take the execute branch.
const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });

jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      findMany: (...args: unknown[]) => findManyMock(...args),
      findUnique: (...args: unknown[]) => sideEffectFindUniqueMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
      updateMany: (...args: unknown[]) => updateManyMock(...args),
    },
    appointmentRequest: {
      findUnique: (...args: unknown[]) => appointmentFindUniqueMock(...args),
    },
  },
}));

const startSchedulingMock = jest.fn();
jest.mock('../services/justin-time.service', () => ({
  JustinTimeService: jest.fn().mockImplementation(() => ({
    startScheduling: (...args: unknown[]) => startSchedulingMock(...args),
  })),
}));

const fetchSchedulingContextMock = jest.fn();
jest.mock('../services/scheduling-context.service', () => ({
  fetchSchedulingContext: (...args: unknown[]) => fetchSchedulingContextMock(...args),
}));

jest.mock('../services/email-queue.service', () => ({
  emailQueueService: { enqueue: jest.fn() },
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    notifyAppointmentConfirmed: jest.fn(),
    notifyAppointmentCancelled: jest.fn(),
    notifyAppointmentCompleted: jest.fn(),
    sendAlert: jest.fn(),
  },
}));

import { sideEffectTrackerService } from '../services/side-effect-tracker.service';
import { slackNotificationService as slackNotificationServiceMock } from '../services/slack-notification.service';

describe('appointment-creation outbox: registerInTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    txCreateMock.mockReset();
  });

  it('writes a pending side-effect row using the supplied tx client', async () => {
    txCreateMock.mockResolvedValue({ id: 'log-1' });
    const tx = { sideEffectLog: { create: txCreateMock } } as any;

    const registered = await sideEffectTrackerService.registerInTransaction(
      tx,
      'apt-1',
      'requested',
      { effectType: 'justintime_start' },
    );

    expect(txCreateMock).toHaveBeenCalledTimes(1);
    const callArgs = txCreateMock.mock.calls[0][0];
    expect(callArgs.data).toMatchObject({
      appointmentId: 'apt-1',
      effectType: 'justintime_start',
      transition: 'requested',
      status: 'pending',
    });
    expect(typeof callArgs.data.idempotencyKey).toBe('string');
    expect(callArgs.data.idempotencyKey.length).toBeGreaterThan(0);
    expect(registered.status).toBe('pending');
    expect(registered.effectType).toBe('justintime_start');
  });

  it('derives a deterministic idempotency key from appointment+transition+effect', async () => {
    txCreateMock.mockResolvedValue({ id: 'log-1' });
    const tx = { sideEffectLog: { create: txCreateMock } } as any;

    await sideEffectTrackerService.registerInTransaction(
      tx,
      'apt-1',
      'requested',
      { effectType: 'justintime_start' },
    );
    const key1 = txCreateMock.mock.calls[0][0].data.idempotencyKey;

    txCreateMock.mockResolvedValue({ id: 'log-2' });
    await sideEffectTrackerService.registerInTransaction(
      tx,
      'apt-1',
      'requested',
      { effectType: 'justintime_start' },
    );
    const key2 = txCreateMock.mock.calls[1][0].data.idempotencyKey;

    expect(key1).toBe(key2);
  });
});

describe('appointment-creation outbox: getEffectsToRetry stale-pending pickup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queries for both failed-and-ready and stale-pending rows', async () => {
    findManyMock.mockResolvedValue([]);

    await sideEffectTrackerService.getEffectsToRetry(5, 60_000, 100, 10 * 60 * 1000);

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const where = findManyMock.mock.calls[0][0].where;
    expect(where).toHaveProperty('OR');
    expect(Array.isArray(where.OR)).toBe(true);
    // Three eligible-status branches: failed (retry), pending (stuck-
    // pending recovery), running (stuck-running recovery added when
    // tryClaimEffect's execute-lease was introduced — a worker that
    // died mid-execute leaves the row in `running` indefinitely without
    // this branch).
    expect(where.OR).toHaveLength(3);

    const failedClause = where.OR.find((c: any) => c.status === 'failed');
    const pendingClause = where.OR.find((c: any) => c.status === 'pending');
    const runningClause = where.OR.find((c: any) => c.status === 'running');
    expect(failedClause).toBeDefined();
    expect(pendingClause).toBeDefined();
    expect(runningClause).toBeDefined();
    expect(pendingClause.attempts).toBe(0);
    expect(pendingClause.createdAt).toHaveProperty('lt');
    expect(runningClause.lastAttempt).toHaveProperty('lt');
    expect(runningClause.attempts).toHaveProperty('lt');
  });

  it('returns mapped rows from the combined query', async () => {
    findManyMock.mockResolvedValue([
      {
        id: 'log-1',
        appointmentId: 'apt-1',
        effectType: 'justintime_start',
        idempotencyKey: 'key-1',
        attempts: 0,
        payload: null,
      },
    ]);

    const effects = await sideEffectTrackerService.getEffectsToRetry();

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      id: 'log-1',
      appointmentId: 'apt-1',
      effectType: 'justintime_start',
      idempotencyKey: 'key-1',
      attempts: 0,
    });
  });
});

describe('appointment-creation outbox: justintime_start retry executor', () => {
  let executeEffect: (effect: {
    id: string;
    appointmentId: string;
    effectType: string;
    idempotencyKey: string;
    attempts: number;
    payload: unknown;
  }) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('../services/side-effect-retry.service');
    const svc = mod.sideEffectRetryService as unknown as {
      executeEffect: typeof executeEffect;
    };
    executeEffect = svc.executeEffect.bind(mod.sideEffectRetryService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseEffect = {
    id: 'log-1',
    appointmentId: 'apt-1',
    effectType: 'justintime_start' as const,
    idempotencyKey: 'key-1',
    attempts: 0,
    payload: null,
  };

  it('skips when the appointment has been advanced past pending', async () => {
    appointmentFindUniqueMock.mockResolvedValue({
      id: 'apt-1',
      userName: 'Alice',
      userEmail: 'alice@example.com',
      therapistName: 'Dr T',
      therapistEmail: 't@example.com',
      therapistHandle: 'th-1',
      status: 'contacted',
      messageCount: 0,
      conversationState: null,
      confirmedDateTime: null,
      trackingCode: 'SPL1',
    });

    await executeEffect(baseEffect);

    expect(startSchedulingMock).not.toHaveBeenCalled();
    expect(fetchSchedulingContextMock).not.toHaveBeenCalled();
  });

  it('skips when conversation activity is recorded but status is still pending', async () => {
    appointmentFindUniqueMock.mockResolvedValue({
      id: 'apt-1',
      userName: 'Alice',
      userEmail: 'alice@example.com',
      therapistName: 'Dr T',
      therapistEmail: 't@example.com',
      therapistHandle: 'th-1',
      status: 'pending',
      messageCount: 4,
      conversationState: { messages: [{}] },
      confirmedDateTime: null,
      trackingCode: 'SPL1',
    });

    await executeEffect(baseEffect);

    expect(startSchedulingMock).not.toHaveBeenCalled();
    expect(fetchSchedulingContextMock).not.toHaveBeenCalled();
  });

  it('re-drives startScheduling for a clean pending appointment', async () => {
    appointmentFindUniqueMock.mockResolvedValue({
      id: 'apt-1',
      userName: 'Alice',
      userEmail: 'alice@example.com',
      therapistName: 'Dr T',
      therapistEmail: 't@example.com',
      therapistHandle: 'th-1',
      status: 'pending',
      messageCount: 0,
      conversationState: null,
      confirmedDateTime: null,
      trackingCode: 'SPL1',
    });
    fetchSchedulingContextMock.mockResolvedValue({
      appointmentRequestId: 'apt-1',
      userName: 'Alice',
      userEmail: 'alice@example.com',
      therapistEmail: 't@example.com',
      therapistName: 'Dr T',
      therapistAvailability: null,
      bookingMethod: 'agent_negotiated',
      userCountry: 'UK',
      therapistCountry: 'UK',
    });
    startSchedulingMock.mockResolvedValue({ success: true, message: 'ok' });

    await executeEffect(baseEffect);

    expect(fetchSchedulingContextMock).toHaveBeenCalledWith('apt-1', expect.stringContaining('retry:'));
    expect(startSchedulingMock).toHaveBeenCalledTimes(1);
    expect(startSchedulingMock).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentRequestId: 'apt-1' }),
    );
  });

  it('throws when the appointment row is missing so the retry runner records the failure', async () => {
    appointmentFindUniqueMock.mockResolvedValue(null);

    await expect(executeEffect(baseEffect)).rejects.toThrow(/not found/i);
  });

  it('skips re-drive and alerts when a Gmail thread was stamped but state was never saved', async () => {
    appointmentFindUniqueMock.mockResolvedValue({
      id: 'apt-1',
      userName: 'Alice',
      userEmail: 'alice@example.com',
      therapistName: 'Dr T',
      therapistEmail: 't@example.com',
      therapistHandle: 'th-1',
      status: 'pending',
      messageCount: 0,
      conversationState: null,
      confirmedDateTime: null,
      trackingCode: 'SPL1',
      gmailThreadId: 'thread-abc',
      therapistGmailThreadId: null,
    });

    await executeEffect(baseEffect);

    expect(startSchedulingMock).not.toHaveBeenCalled();
    expect(fetchSchedulingContextMock).not.toHaveBeenCalled();
    expect(slackNotificationServiceMock.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: 'apt-1', severity: 'high' }),
    );
  });
});

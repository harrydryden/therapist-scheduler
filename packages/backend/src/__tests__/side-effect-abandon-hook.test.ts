/**
 * Pins the post-abandon cleanup hook in side-effect-retry.
 *
 * When the retry runner exhausts MAX_RETRY_ATTEMPTS for an
 * email_therapist_nudge row, it must release the Therapist.lastNudgeAt
 * sentinel so the next 6h cron tick re-evaluates this therapist with
 * a fresh cycle. Without this hook, a single transient outage that
 * outlasts the 5-retry burst (~25m) would silently suppress the
 * therapist for intervalWeeks (typically 4 weeks) — a regression vs
 * the pre-harness behaviour where every-6h retries eventually
 * recovered.
 *
 * Guard: the release is conditional on the current lastNudgeAt being
 * older than the abandoned row's createdAt. If a newer cycle has
 * already claimed (lastNudgeAt > row.createdAt), some other cycle is
 * in flight and we must NOT clobber its claim.
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

const therapistUpdateManyMock = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    appointmentRequest: {
      findUnique: jest.fn(),
    },
    therapist: {
      updateMany: (...args: unknown[]) => therapistUpdateManyMock(...args),
    },
  },
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

type AbandonHook = (effect: {
  id: string;
  effectType: string;
  therapistId: string | null;
  createdAt: Date;
}) => Promise<void>;

let postAbandonCleanup: AbandonHook;

beforeAll(async () => {
  const mod = await import('../services/side-effect-retry.service');
  const svc = mod.sideEffectRetryService as unknown as {
    postAbandonCleanup: AbandonHook;
  };
  postAbandonCleanup = svc.postAbandonCleanup.bind(mod.sideEffectRetryService);
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('side-effect-retry: postAbandonCleanup for email_therapist_nudge', () => {
  it('releases lastNudgeAt when the sentinel is still pointing at this cycle', async () => {
    therapistUpdateManyMock.mockResolvedValue({ count: 1 });

    const rowCreatedAt = new Date('2026-05-16T10:00:00.000Z');
    await postAbandonCleanup({
      id: 'log-1',
      effectType: 'email_therapist_nudge',
      therapistId: 'ther-1',
      createdAt: rowCreatedAt,
    });

    expect(therapistUpdateManyMock).toHaveBeenCalledTimes(1);
    const call = therapistUpdateManyMock.mock.calls[0][0];
    expect(call.where.id).toBe('ther-1');
    // Guard: only release if Therapist.lastNudgeAt < this row.createdAt.
    // The cycle's claim happens immediately before the row is created,
    // so this comparison rejects any later cycle's claim.
    expect(call.where.lastNudgeAt).toEqual({ lt: rowCreatedAt });
    expect(call.data).toEqual({ lastNudgeAt: null });
  });

  it('is a no-op for non-therapist-nudge effect types', async () => {
    await postAbandonCleanup({
      id: 'log-2',
      effectType: 'email_chase_user',
      therapistId: null,
      createdAt: new Date(),
    });

    expect(therapistUpdateManyMock).not.toHaveBeenCalled();
  });

  it('is a no-op when therapistId is missing (defensive — DB CHECK should prevent this)', async () => {
    await postAbandonCleanup({
      id: 'log-3',
      effectType: 'email_therapist_nudge',
      therapistId: null,
      createdAt: new Date(),
    });

    expect(therapistUpdateManyMock).not.toHaveBeenCalled();
  });

  it('swallows DB errors so abandon + slack-alert always reach completion', async () => {
    therapistUpdateManyMock.mockRejectedValue(new Error('connection refused'));

    await expect(
      postAbandonCleanup({
        id: 'log-4',
        effectType: 'email_therapist_nudge',
        therapistId: 'ther-1',
        createdAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });

  it('skips the release silently when count=0 (newer cycle already claimed)', async () => {
    // updateMany matched zero rows because lastNudgeAt is newer than
    // this row's createdAt — a concurrent cycle has taken over and
    // we must not clobber its claim.
    therapistUpdateManyMock.mockResolvedValue({ count: 0 });

    await postAbandonCleanup({
      id: 'log-5',
      effectType: 'email_therapist_nudge',
      therapistId: 'ther-1',
      createdAt: new Date('2026-05-16T10:00:00.000Z'),
    });

    // The call still happened with the guard, but it matched nothing.
    // Caller (markAbandoned + slack alert) still proceeds.
    expect(therapistUpdateManyMock).toHaveBeenCalledTimes(1);
  });
});

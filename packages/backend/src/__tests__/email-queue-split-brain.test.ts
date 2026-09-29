/**
 * Regression tests for the email-queue split-brain bugs.
 *
 *   - C1 / #8: the BullMQ worker and the polling fallback both consumed the
 *     same pending_emails rows with "check status → send" (first a Redis
 *     guard, later a DB status read), so a retry could be sent twice. The
 *     worker now delegates every attempt to core/email/outbound/queue.ts's
 *     `attemptPendingEmailSend`, which claims the row atomically
 *     (pending → sending) — the claim semantics themselves are covered in
 *     pending-email-atomic-claim.test.ts. Pinned here: the worker never
 *     sends outside that path, completes the job when the row is not
 *     claimable (already sent by the poller, abandoned, gone), and rethrows
 *     only when the attempt was put back for retry so BullMQ reschedules.
 *
 *   - H4: the DB row's retry state is written by the claim holder (with
 *     nextRetryAt on the shared backoff schedule), not by the worker's
 *     async 'failed' event — which used to race the claim.
 *
 *   - #9: a permanently abandoned email raises a deduped Slack alert.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    redisUrl: 'redis://localhost:6379',
    env: 'test',
    port: 3000,
  },
}));

jest.mock('../constants', () => ({
  EMAIL: {
    MAX_RETRIES: 5,
    RETRY_DELAYS_MS: [60_000, 300_000, 900_000, 3_600_000, 14_400_000],
    FROM_ADDRESS: 'test@example.com',
  },
  REDIS_BACKPRESSURE: { DEFAULT_CACHE_TTL_SECONDS: 300 },
  PENDING_EMAIL_LOCK: {
    KEY: 'email-queue:lock',
    TTL_SECONDS: 60,
    RENEWAL_INTERVAL_MS: 30_000,
  },
}));

jest.mock('../utils/redis-locks', () => ({
  releaseLock: jest.fn(() => Promise.resolve()),
  renewLock: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../utils/database', () => ({ prisma: { pendingEmail: {} } }));
jest.mock('../utils/redis', () => ({ redis: { get: jest.fn(), getStrict: jest.fn(), set: jest.fn() } }));

const sendEmailMock = jest.fn();
jest.mock('../core/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
  processPendingEmails: jest.fn(),
}));

const mockAttempt = jest.fn();
jest.mock('../core/email/outbound/queue', () => ({
  attemptPendingEmailSend: (...a: unknown[]) => mockAttempt(...a),
  // Called at import time (before module-level consts exist), so the mock
  // lives inside the factory and is read back via jest.requireMock.
  registerEmailAbandonedNotifier: jest.fn(),
  retryDelayMs: (attempt: number) => [60_000, 300_000][attempt - 1] ?? 900_000,
}));

const sendAlertMock = jest.fn().mockResolvedValue(true);
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: (...a: unknown[]) => sendAlertMock(...a) },
}));

// Avoid pulling the BullMQ + Worker modules into the test process —
// they would open Redis sockets at import time. We only need the class
// to instantiate; the queue/worker stay null because we never call
// start().
jest.mock('bullmq', () => ({
  Queue: jest.fn(),
  Worker: jest.fn(),
  QueueEvents: jest.fn(),
}));

import { emailQueueService, notifyEmailAbandoned } from '../services/email-queue.service';

// Captured at import time, before any beforeEach clears the mocks.
const registeredNotifier = (
  jest.requireMock('../core/email/outbound/queue') as { registerEmailAbandonedNotifier: jest.Mock }
).registerEmailAbandonedNotifier.mock.calls[0]?.[0];

beforeEach(() => {
  jest.clearAllMocks();
});

function buildJob(overrides: Partial<{ id: string; pendingEmailId: string; attemptsMade: number; threadId: string }> = {}) {
  return {
    id: overrides.id ?? 'job-1',
    attemptsMade: overrides.attemptsMade ?? 0,
    data: {
      pendingEmailId: overrides.pendingEmailId ?? 'pending-1',
      to: 'recipient@example.com',
      subject: 'Subject',
      body: 'Body',
      ...(overrides.threadId ? { threadId: overrides.threadId } : {}),
    },
  };
}

const internal = emailQueueService as unknown as {
  processJob: (job: ReturnType<typeof buildJob>) => Promise<void>;
};

describe('processJob delegates to the atomic claim-then-send path (C1 / #8)', () => {
  it('completes without sending when the row is not claimable (e.g. the poller already sent it)', async () => {
    mockAttempt.mockResolvedValue({ outcome: 'not-claimed' });

    await expect(internal.processJob(buildJob())).resolves.toBeUndefined();

    expect(mockAttempt).toHaveBeenCalledWith('pending-1', 'bullmq:job-1', undefined);
    // The worker itself never talks to Gmail.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('passes the enqueuer\'s thread id through as the thread hint', async () => {
    mockAttempt.mockResolvedValue({ outcome: 'sent' });

    await internal.processJob(buildJob({ threadId: 'thread-42' }));

    expect(mockAttempt).toHaveBeenCalledWith('pending-1', 'bullmq:job-1', 'thread-42');
  });

  it.each(['sent', 'already-sent', 'skipped', 'marker'])('completes the job on %s', async (outcome) => {
    mockAttempt.mockResolvedValue({ outcome });
    await expect(internal.processJob(buildJob())).resolves.toBeUndefined();
  });

  it('completes (does not rethrow) once the row was abandoned — retries are over and the alert is sent', async () => {
    mockAttempt.mockResolvedValue({ outcome: 'abandoned', error: new Error('invalid_grant'), attempt: 5 });
    await expect(internal.processJob(buildJob())).resolves.toBeUndefined();
  });

  it('rethrows when the attempt was put back for retry, so BullMQ reschedules it', async () => {
    const error = new Error('Gmail rate limited');
    mockAttempt.mockResolvedValue({ outcome: 'retrying', error, attempt: 1, nextRetryAt: new Date() });

    await expect(internal.processJob(buildJob())).rejects.toBe(error);
  });
});

describe('email-abandoned alert (#9)', () => {
  it('registers the Slack notifier with the shared delivery module at import', () => {
    expect(registeredNotifier).toEqual(expect.any(Function));
    expect(registeredNotifier).toBe(notifyEmailAbandoned);
  });

  it('sends a high-severity alert deduped per appointment under the email-abandoned group', async () => {
    await notifyEmailAbandoned({
      pendingEmailId: 'pe-1',
      appointmentId: 'apt-1',
      subject: '[SPL-1] Spill: availability',
      attempts: 5,
      errorMessage: 'invalid_grant',
    });

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][0]).toMatchObject({
      title: 'Outbound Email Abandoned',
      severity: 'high',
      appointmentId: 'apt-1',
      dedupGroup: 'email-abandoned',
    });
    expect(sendAlertMock.mock.calls[0][0].details).toContain('invalid_grant');
  });
});

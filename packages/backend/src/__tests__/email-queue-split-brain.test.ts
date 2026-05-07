/**
 * Regression tests for the email-queue split-brain bugs surfaced by
 * the deep audit and verified by manual code-walk:
 *
 *   - C1 (DB status check): when the polling fallback sends an email
 *     during a Redis outage, the Redis send-guard never gets written.
 *     If BullMQ later processes the same job after Redis recovers,
 *     processJob's old logic would only check the missing guard and
 *     send the email AGAIN. processJob must check the DB row's
 *     `status` first — that's the authoritative source of truth.
 *
 *   - H4 (nextRetryAt on BullMQ retry): the polling fallback's filter
 *     is `nextRetryAt <= now OR nextRetryAt IS NULL`. BullMQ's
 *     updateRetryState was only writing retryCount/lastRetryAt and
 *     leaving nextRetryAt null, so the polling fallback would re-pick
 *     the row up on its 2-minute tick and bypass BullMQ's exponential
 *     backoff. updateRetryState must set nextRetryAt to the backoff
 *     window so both paths agree.
 *
 * Both methods are private on the EmailQueueService class. The tests
 * reach in via `as unknown as { method }` — same pattern other tests
 * in this suite use for private-method coverage. The contract is the
 * DB writes those methods perform; that's what the asserts pin.
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
  PENDING_EMAIL_QUEUE: {
    DEFAULT_BATCH_SIZE: 10,
    MAX_BATCH_SIZE: 50,
    BACKLOG_WARNING_THRESHOLD: 20,
    BACKLOG_CRITICAL_THRESHOLD: 50,
    BATCH_SIZE_MULTIPLIER_WARNING: 2,
    BATCH_SIZE_MULTIPLIER_CRITICAL: 3,
  },
}));

jest.mock('../utils/redis-locks', () => ({
  releaseLock: jest.fn(() => Promise.resolve()),
  renewLock: jest.fn(() => Promise.resolve(true)),
}));

const findUniqueMock = jest.fn();
const updateMock = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    pendingEmail: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}));

const redisGetMock = jest.fn();
jest.mock('../utils/redis', () => ({
  redis: {
    get: (...args: unknown[]) => redisGetMock(...args),
    set: jest.fn(),
  },
}));

const sendEmailMock = jest.fn();
jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: {
    sendEmail: (...args: unknown[]) => sendEmailMock(...args),
  },
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

import { emailQueueService } from '../services/email-queue.service';

beforeEach(() => {
  jest.clearAllMocks();
  redisGetMock.mockResolvedValue(null);
  updateMock.mockResolvedValue({});
  sendEmailMock.mockResolvedValue({});
});

// Helper: build the minimal Job<EmailJobData> shape processJob expects.
function buildJob(overrides: Partial<{ id: string; pendingEmailId: string; attemptsMade: number }> = {}) {
  return {
    id: overrides.id ?? 'job-1',
    attemptsMade: overrides.attemptsMade ?? 0,
    data: {
      pendingEmailId: overrides.pendingEmailId ?? 'pending-1',
      to: 'recipient@example.com',
      subject: 'Subject',
      body: 'Body',
    },
  };
}

const internal = emailQueueService as unknown as {
  processJob: (job: ReturnType<typeof buildJob>) => Promise<void>;
  updateRetryState: (job: ReturnType<typeof buildJob>, msg: string) => Promise<void>;
};

describe('processJob: DB status check (C1 fix)', () => {
  it('skips the send when DB row already has status=sent (polling fallback won during Redis outage)', async () => {
    findUniqueMock.mockResolvedValue({ status: 'sent' });

    await internal.processJob(buildJob());

    expect(sendEmailMock).not.toHaveBeenCalled();
    // Crucial: did NOT update DB either — the polling fallback
    // already set status=sent, no need to overwrite.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('skips the send when DB row is abandoned (final-fail handler ran in another path)', async () => {
    findUniqueMock.mockResolvedValue({ status: 'abandoned' });

    await internal.processJob(buildJob());

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('skips and logs when the DB row is gone entirely (cascade-delete after enqueue)', async () => {
    findUniqueMock.mockResolvedValue(null);

    await internal.processJob(buildJob());

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('proceeds with send when DB status=pending (normal happy path)', async () => {
    findUniqueMock.mockResolvedValue({ status: 'pending' });
    redisGetMock.mockResolvedValue(null); // No Redis guard present

    await internal.processJob(buildJob());

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // Final DB update flips status='sent'.
    const lastUpdate = updateMock.mock.calls[updateMock.mock.calls.length - 1][0];
    expect(lastUpdate.data).toMatchObject({ status: 'sent' });
  });

  it('checks DB BEFORE Redis guard (DB is authoritative)', async () => {
    // Sequence test: with status=sent in DB, we should never even
    // reach the redis.get call.
    findUniqueMock.mockResolvedValue({ status: 'sent' });

    await internal.processJob(buildJob());

    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(redisGetMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('updateRetryState: nextRetryAt set from BullMQ backoff (H4 fix)', () => {
  it('writes nextRetryAt so the polling fallback respects BullMQ backoff', async () => {
    const before = Date.now();
    await internal.updateRetryState(buildJob({ attemptsMade: 1 }), 'Gmail rate limited');

    expect(updateMock).toHaveBeenCalledTimes(1);
    const data = updateMock.mock.calls[0][0].data;
    expect(data.errorMessage).toBe('Gmail rate limited');
    expect(data.retryCount).toBe(1);
    expect(data.lastRetryAt).toBeInstanceOf(Date);
    // nextRetryAt must be in the future and roughly at attempt-1's
    // backoff window (60_000 ms — index [0] of RETRY_DELAYS_MS).
    expect(data.nextRetryAt).toBeInstanceOf(Date);
    const delay = (data.nextRetryAt as Date).getTime() - before;
    // getBackoffDelay adds up to +10% jitter (so 60_000 → up to 66_000).
    // Allow generous bounds — exact-value pinning isn't the contract;
    // the contract is that nextRetryAt sits in the BullMQ backoff
    // window, not null.
    expect(delay).toBeGreaterThanOrEqual(50_000);
    expect(delay).toBeLessThanOrEqual(80_000);
  });

  it('uses progressively longer backoff for higher attemptsMade (matches RETRY_DELAYS_MS)', async () => {
    await internal.updateRetryState(buildJob({ attemptsMade: 1 }), 'fail');
    const firstDelay = (updateMock.mock.calls[0][0].data.nextRetryAt as Date).getTime() - Date.now();

    updateMock.mockClear();

    await internal.updateRetryState(buildJob({ attemptsMade: 3 }), 'fail');
    const thirdDelay = (updateMock.mock.calls[0][0].data.nextRetryAt as Date).getTime() - Date.now();

    // Attempt 3 should sit at index [2] = 900_000ms = 15 min, much
    // longer than attempt 1's 60_000 ms.
    expect(thirdDelay).toBeGreaterThan(firstDelay);
  });
});

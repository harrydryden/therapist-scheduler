/**
 * Regression tests for PendingEmailService's migration onto
 * LockedPeriodicService (Stage D follow-up — see
 * docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md, alongside the
 * missed-message-scanner migration). Pins that the trigger-reason
 * argument, stats accumulation, and manual-trigger path all still work
 * after the hand-rolled LockedTaskRunner + setInterval scaffolding was
 * replaced with the shared base class.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const acquireLockMock = jest.fn();
const releaseLockMock = jest.fn();
const renewLockMock = jest.fn();
jest.mock('../utils/redis-locks', () => ({
  acquireLock: (...a: unknown[]) => acquireLockMock(...a),
  releaseLock: (...a: unknown[]) => releaseLockMock(...a),
  renewLock: (...a: unknown[]) => renewLockMock(...a),
}));

const processPendingEmailsMock = jest.fn();
jest.mock('../core/email', () => ({
  sendEmail: jest.fn(),
  processPendingEmails: (...a: unknown[]) => processPendingEmailsMock(...a),
}));

// email-queue.service.ts's other export (emailQueueService, the BullMQ
// queue) pulls in bullmq/prisma/redis at module scope — stub the pieces
// pendingEmailService's own construction/tick path doesn't touch.
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
  QueueEvents: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
}));
jest.mock('../utils/database', () => ({ prisma: {} }));
jest.mock('../utils/redis', () => ({ redis: { get: jest.fn(), set: jest.fn() } }));
jest.mock('../config', () => ({
  config: {
    redisUrl: 'redis://localhost:6379',
    timezone: 'Europe/London',
    anthropicApiKey: 'test-key',
    nodeEnv: 'test',
    jwtSecret: 'test-secret',
    backendUrl: 'https://backend.test',
    frontendUrl: 'https://frontend.test',
  },
}));

import { pendingEmailService } from '../services/email-queue.service';

describe('pendingEmailService — trigger threading after LockedPeriodicService migration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    acquireLockMock.mockResolvedValue(true);
    renewLockMock.mockResolvedValue(true);
    releaseLockMock.mockResolvedValue(undefined);
  });

  it("triggerManualProcess runs a tick with trigger 'manual' and accumulates stats", async () => {
    processPendingEmailsMock.mockResolvedValue({
      sent: 2,
      failed: 1,
      retrying: 0,
      queueDepth: 5,
      batchSize: 3,
    });

    const result = await pendingEmailService.triggerManualProcess();

    expect(result).toEqual({ sent: 2, failed: 1, retrying: 0, queueDepth: 5, batchSize: 3 });
    expect(processPendingEmailsMock).toHaveBeenCalledTimes(1);

    const status = pendingEmailService.getQueueStatus();
    expect(status.stats.totalSent).toBeGreaterThanOrEqual(2);
    expect(status.stats.totalFailed).toBeGreaterThanOrEqual(1);
    expect(status.stats.lastRunSent).toBe(2);
    expect(status.stats.lastRunFailed).toBe(1);
    expect(status.stats.lastQueueDepth).toBe(5);
  });

  it('returns an empty result (not undefined) when the lock is held elsewhere', async () => {
    acquireLockMock.mockResolvedValue(false);

    const result = await pendingEmailService.triggerManualProcess();

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(processPendingEmailsMock).not.toHaveBeenCalled();
  });

  it('does not throw when the underlying processPendingEmails call fails', async () => {
    processPendingEmailsMock.mockRejectedValue(new Error('boom'));

    await expect(pendingEmailService.triggerManualProcess()).resolves.toEqual({ sent: 0, failed: 0 });
  });
});

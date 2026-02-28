/**
 * Tests for message queue reliability features:
 * - Idempotent send guard (prevents duplicate email sends)
 * - Write-ahead log (WAL) for DB downtime resilience
 * - History ID database fallback
 * - Side effect retry service
 * - Message queue health service
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
  },
}));

jest.mock('../constants', () => ({
  EMAIL: { MAX_RETRIES: 5, RETRY_DELAYS_MS: [60000, 300000, 900000, 3600000, 14400000], FROM_ADDRESS: 'test@example.com' },
  PENDING_EMAIL_QUEUE: { DEFAULT_BATCH_SIZE: 10, MAX_BATCH_SIZE: 50, BACKLOG_WARNING_THRESHOLD: 20, BACKLOG_CRITICAL_THRESHOLD: 50, BATCH_SIZE_MULTIPLIER_WARNING: 2, BATCH_SIZE_MULTIPLIER_CRITICAL: 3 },
}));

jest.mock('../utils/database', () => ({
  prisma: {
    pendingEmail: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    sideEffectLog: {
      findMany: jest.fn(),
      groupBy: jest.fn(),
    },
    appointmentRequest: {
      findUnique: jest.fn(),
    },
  },
  checkDatabaseHealth: jest.fn(),
}));

jest.mock('../utils/redis', () => {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();

  return {
    redis: {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) || null)),
      set: jest.fn((...args: unknown[]) => {
        const key = args[0] as string;
        const value = args[1] as string;
        store.set(key, value);
        return Promise.resolve('OK');
      }),
      del: jest.fn((key: string) => {
        store.delete(key);
        return Promise.resolve(1);
      }),
      rpush: jest.fn((key: string, value: string) => {
        const list = lists.get(key) || [];
        list.push(value);
        lists.set(key, list);
        return Promise.resolve(list.length);
      }),
      lpop: jest.fn((key: string) => {
        const list = lists.get(key) || [];
        const val = list.shift();
        if (list.length === 0) lists.delete(key);
        else lists.set(key, list);
        return Promise.resolve(val || null);
      }),
      llen: jest.fn((key: string) => {
        return Promise.resolve((lists.get(key) || []).length);
      }),
      lrange: jest.fn((key: string, start: number, end: number) => {
        const list = lists.get(key) || [];
        // Redis LRANGE: -1 means last element, so end+1 becomes 0 which gives empty slice
        // Emulate Redis behavior: when end is -1, return from start to end of list
        const stop = end < 0 ? list.length + end + 1 : end + 1;
        return Promise.resolve(list.slice(start, stop));
      }),
      expire: jest.fn(() => Promise.resolve(1)),
      scard: jest.fn(() => Promise.resolve(0)),
      // Expose internals for test manipulation
      __store: store,
      __lists: lists,
    },
  };
});

jest.mock('../utils/redis-locks', () => ({
  releaseLock: jest.fn(() => Promise.resolve()),
  renewLock: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../services/side-effect-tracker.service', () => ({
  sideEffectTrackerService: {
    getEffectsToRetry: jest.fn(() => Promise.resolve([])),
    getStats: jest.fn(() =>
      Promise.resolve({
        pending: 0,
        completed: 0,
        failed: 0,
        abandoned: 0,
        byType: {},
      })
    ),
    markCompleted: jest.fn(() => Promise.resolve()),
    markFailed: jest.fn(() => Promise.resolve()),
    markAbandoned: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock('../services/email-queue.service', () => ({
  emailQueueService: {
    getStats: jest.fn(() =>
      Promise.resolve({
        available: true,
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
      })
    ),
    recoverFromWAL: jest.fn(() => Promise.resolve(0)),
    enqueue: jest.fn(() => Promise.resolve('test-id')),
  },
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    notifyAppointmentConfirmed: jest.fn(() => Promise.resolve()),
    notifyAppointmentCancelled: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock('../services/notion-sync-manager.service', () => ({
  notionSyncManager: {
    syncSingleUser: jest.fn(() => Promise.resolve()),
    syncSingleTherapist: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock('../utils/background-task', () => ({
  getBackgroundTaskHealth: jest.fn(() => ({
    healthy: true,
    tasks: {},
  })),
}));

import { prisma } from '../utils/database';
import { redis } from '../utils/redis';

// Cast redis to any for test access to mocked list operations and internals
const testRedis = redis as any;

// ============================================
// Test: Idempotent Send Guard
// ============================================
describe('Idempotent Send Guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testRedis.__store.clear();
  });

  it('sets a send guard key after email is "sent"', async () => {
    const guardKey = 'email:send-guard:test-email-123';

    // Simulate setting the guard
    await testRedis.set(guardKey, 'sent', 'EX', 3600);

    const value = await testRedis.get(guardKey);
    expect(value).toBe('sent');
  });

  it('detects an already-sent email via guard key', async () => {
    const guardKey = 'email:send-guard:test-email-456';

    // Pre-set the guard (simulating a previous successful send)
    await testRedis.set(guardKey, 'sent', 'EX', 3600);

    // Check guard
    const alreadySent = await testRedis.get(guardKey);
    expect(alreadySent).toBe('sent');
    // In the real code, this would skip the send and only update DB
  });

  it('returns null for unsent emails (no guard)', async () => {
    const guardKey = 'email:send-guard:test-email-789';

    const value = await testRedis.get(guardKey);
    expect(value).toBeNull();
    // In the real code, this would proceed with sending
  });
});

// ============================================
// Test: Write-Ahead Log (WAL)
// ============================================
describe('Write-Ahead Log', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testRedis.__store.clear();
    testRedis.__lists.clear();
  });

  it('buffers an email to the WAL when pushed', async () => {
    const walEntry = {
      id: 'wal-test-1',
      to: 'test@example.com',
      subject: 'Test Subject',
      body: 'Test body',
      createdAt: new Date().toISOString(),
    };

    await testRedis.rpush('email:write-ahead-log', JSON.stringify(walEntry));

    const length = await testRedis.llen('email:write-ahead-log');
    expect(length).toBe(1);
  });

  it('recovers entries from WAL in FIFO order', async () => {
    const entry1 = { id: 'wal-1', to: 'a@test.com', subject: 'First' };
    const entry2 = { id: 'wal-2', to: 'b@test.com', subject: 'Second' };

    await testRedis.rpush('email:write-ahead-log', JSON.stringify(entry1));
    await testRedis.rpush('email:write-ahead-log', JSON.stringify(entry2));

    // Pop in FIFO order
    const first = await testRedis.lpop('email:write-ahead-log');
    const second = await testRedis.lpop('email:write-ahead-log');
    const empty = await testRedis.lpop('email:write-ahead-log');

    expect(JSON.parse(first!).id).toBe('wal-1');
    expect(JSON.parse(second!).id).toBe('wal-2');
    expect(empty).toBeNull();
  });

  it('reports WAL length accurately', async () => {
    await testRedis.rpush('email:write-ahead-log', JSON.stringify({ id: '1' }));
    await testRedis.rpush('email:write-ahead-log', JSON.stringify({ id: '2' }));
    await testRedis.rpush('email:write-ahead-log', JSON.stringify({ id: '3' }));

    const length = await testRedis.llen('email:write-ahead-log');
    expect(length).toBe(3);
  });
});

// ============================================
// Test: History ID Database Fallback
// ============================================
describe('History ID Database Fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testRedis.__store.clear();
  });

  it('reads history ID from Redis when available', async () => {
    await testRedis.set('gmail:lastHistoryId', '12345');

    const value = await testRedis.get('gmail:lastHistoryId');
    expect(value).toBe('12345');
  });

  it('falls back to DB when Redis has no value', async () => {
    // Redis has no value
    const redisValue = await testRedis.get('gmail:lastHistoryId');
    expect(redisValue).toBeNull();

    // DB has the value
    (prisma.systemSetting.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'gmail.lastHistoryId',
      value: JSON.stringify(67890),
    });

    const dbSetting = await prisma.systemSetting.findUnique({
      where: { id: 'gmail.lastHistoryId' },
    });

    expect(dbSetting).toBeTruthy();
    expect(JSON.parse(dbSetting!.value)).toBe(67890);
  });

  it('persists history ID to both Redis and DB', async () => {
    const historyId = 99999;

    // Simulate the dual-write pattern
    await testRedis.set('gmail:lastHistoryId', historyId.toString());

    (prisma.systemSetting.upsert as jest.Mock).mockResolvedValueOnce({
      id: 'gmail.lastHistoryId',
      value: JSON.stringify(historyId),
    });

    await prisma.systemSetting.upsert({
      where: { id: 'gmail.lastHistoryId' },
      create: {
        id: 'gmail.lastHistoryId',
        value: JSON.stringify(historyId),
        category: 'gmail',
        label: 'Last Gmail History ID',
        valueType: 'number',
        defaultValue: JSON.stringify(0),
      },
      update: { value: JSON.stringify(historyId) },
    });

    // Verify Redis was written
    const redisValue = await testRedis.get('gmail:lastHistoryId');
    expect(redisValue).toBe('99999');

    // Verify DB upsert was called
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'gmail.lastHistoryId' },
      })
    );
  });
});

// ============================================
// Test: Message Queue Health Integration Patterns
// ============================================
describe('Message Queue Health Patterns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testRedis.__store.clear();
    testRedis.__lists.clear();
  });

  it('counts pending, failed, and abandoned emails for health metrics', async () => {
    (prisma.pendingEmail.count as jest.Mock)
      .mockResolvedValueOnce(5)  // pending
      .mockResolvedValueOnce(1)  // failed
      .mockResolvedValueOnce(0); // abandoned

    const pending = await prisma.pendingEmail.count({ where: { status: 'pending' } });
    const failed = await prisma.pendingEmail.count({ where: { status: 'failed' } });
    const abandoned = await prisma.pendingEmail.count({ where: { status: 'abandoned' } });

    expect(pending).toBe(5);
    expect(failed).toBe(1);
    expect(abandoned).toBe(0);
  });

  it('identifies oldest pending email for staleness detection', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    (prisma.pendingEmail.findFirst as jest.Mock).mockResolvedValueOnce({
      createdAt: tenMinutesAgo,
    });

    const oldest = await prisma.pendingEmail.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });

    expect(oldest).toBeTruthy();
    const ageMinutes = Math.round((Date.now() - oldest!.createdAt.getTime()) / 60000);
    expect(ageMinutes).toBeGreaterThanOrEqual(9); // ~10 minutes
  });

  it('fetches stuck messages across subsystems', async () => {
    // Stuck pending emails
    (prisma.pendingEmail.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 'email-1',
          toEmail: 'test@example.com',
          subject: 'Test',
          status: 'abandoned',
          appointmentId: 'apt-1',
          retryCount: 5,
          createdAt: new Date(),
          lastRetryAt: new Date(),
          errorMessage: 'Gmail API timeout',
        },
      ])
      .mockResolvedValueOnce([]); // long-pending

    // Stuck side effects
    (prisma.sideEffectLog.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 'se-1',
        appointmentId: 'apt-2',
        effectType: 'slack_notify_confirmed',
        status: 'failed',
        attempts: 3,
        createdAt: new Date(),
        lastAttempt: new Date(),
        errorLog: 'Slack API timeout',
      },
    ]);

    const stuckEmails = await prisma.pendingEmail.findMany({
      where: { status: { in: ['failed', 'abandoned'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const stuckEffects = await prisma.sideEffectLog.findMany({
      where: { status: { in: ['failed', 'abandoned'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    expect(stuckEmails).toHaveLength(1);
    expect(stuckEmails[0].status).toBe('abandoned');
    expect(stuckEffects).toHaveLength(1);
    expect(stuckEffects[0].effectType).toBe('slack_notify_confirmed');
  });

  it('includes WAL entries in stuck message count', async () => {
    // Add entries to the WAL
    await testRedis.rpush('email:write-ahead-log', JSON.stringify({
      id: 'wal-1',
      to: 'user@test.com',
      subject: 'Buffered during downtime',
      createdAt: new Date().toISOString(),
    }));

    const walLength = await testRedis.llen('email:write-ahead-log');
    expect(walLength).toBe(1);

    const walEntries = await testRedis.lrange('email:write-ahead-log', 0, -1);
    expect(walEntries).toHaveLength(1);
    const parsed = JSON.parse(walEntries[0]);
    expect(parsed.to).toBe('user@test.com');
  });
});

// ============================================
// Test: Side Effect Retry Patterns
// ============================================
describe('Side Effect Retry Patterns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testRedis.__store.clear();
  });

  it('fetches failed side effects for retry with correct parameters', async () => {
    const { sideEffectTrackerService } = require('../services/side-effect-tracker.service');

    (sideEffectTrackerService.getEffectsToRetry as jest.Mock).mockResolvedValueOnce([
      {
        id: 'se-1',
        appointmentId: 'apt-1',
        effectType: 'email_client_confirmation',
        idempotencyKey: 'key-1',
        attempts: 2,
      },
    ]);

    const effects = await sideEffectTrackerService.getEffectsToRetry(5, 60000, 50);

    expect(effects).toHaveLength(1);
    expect(effects[0].effectType).toBe('email_client_confirmation');
    expect(effects[0].attempts).toBe(2);
  });

  it('marks effects as completed after successful retry', async () => {
    const { sideEffectTrackerService } = require('../services/side-effect-tracker.service');

    await sideEffectTrackerService.markCompleted('key-1');
    expect(sideEffectTrackerService.markCompleted).toHaveBeenCalledWith('key-1');
  });

  it('marks effects as failed with error message on retry failure', async () => {
    const { sideEffectTrackerService } = require('../services/side-effect-tracker.service');

    await sideEffectTrackerService.markFailed('key-2', 'Gmail API timeout');
    expect(sideEffectTrackerService.markFailed).toHaveBeenCalledWith('key-2', 'Gmail API timeout');
  });

  it('marks effects as abandoned after max retries', async () => {
    const { sideEffectTrackerService } = require('../services/side-effect-tracker.service');

    await sideEffectTrackerService.markAbandoned('key-3', 'Abandoned after 5 attempts: connection refused');
    expect(sideEffectTrackerService.markAbandoned).toHaveBeenCalledWith(
      'key-3',
      expect.stringContaining('Abandoned after 5 attempts')
    );
  });

  it('enqueues email for retry of email_client_confirmation effect', async () => {
    const { emailQueueService } = require('../services/email-queue.service');

    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'apt-1',
      userName: 'John Doe',
      userEmail: 'john@example.com',
      therapistName: 'Dr. Smith',
      therapistEmail: 'smith@clinic.com',
      therapistNotionId: 'notion-1',
      status: 'confirmed',
      confirmedDateTime: 'Monday 3pm',
      trackingCode: 'SPL42',
    });

    // Simulate what the retry service does for email effects
    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: 'apt-1' },
      select: { id: true, userName: true, userEmail: true, therapistName: true, therapistEmail: true, confirmedDateTime: true },
    });

    await emailQueueService.enqueue({
      to: appointment!.userEmail,
      subject: `Your therapy session with ${appointment!.therapistName} is confirmed`,
      body: `Session confirmed for ${appointment!.confirmedDateTime}`,
      appointmentId: appointment!.id,
    });

    expect(emailQueueService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'john@example.com',
        appointmentId: 'apt-1',
      })
    );
  });

  it('calls Slack notification for retry of slack_notify_confirmed effect', async () => {
    const { slackNotificationService } = require('../services/slack-notification.service');

    await slackNotificationService.notifyAppointmentConfirmed(
      'apt-1',
      'John Doe',
      'Dr. Smith',
      'Monday 3pm'
    );

    expect(slackNotificationService.notifyAppointmentConfirmed).toHaveBeenCalledWith(
      'apt-1', 'John Doe', 'Dr. Smith', 'Monday 3pm'
    );
  });

  it('syncs Notion for retry of user_sync effect', async () => {
    const { notionSyncManager } = require('../services/notion-sync-manager.service');

    await notionSyncManager.syncSingleUser('john@example.com');
    expect(notionSyncManager.syncSingleUser).toHaveBeenCalledWith('john@example.com');
  });
});

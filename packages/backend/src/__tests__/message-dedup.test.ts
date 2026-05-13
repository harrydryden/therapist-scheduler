/**
 * Tests for the `core/messaging/message-dedup` facade.
 *
 * The facade wraps the existing Redis + DB dedup primitives without
 * changing semantics; these tests pin the surface so future callsite
 * migration can rely on stable behaviour. They mock Redis and Prisma
 * directly rather than running against a live instance — the
 * integration tests under `__tests__/integration/` exercise the real
 * primitives.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

jest.mock('../utils/redis', () => ({
  redis: {
    eval: jest.fn(),
    zadd: jest.fn(),
    zscore: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    set: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
  },
}));

jest.mock('../utils/database', () => ({
  prisma: {
    processedGmailMessage: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import {
  acquireMessageLock,
  markMessageProcessed,
  releaseMessageLock,
  isMessageProcessed,
  filterUnprocessed,
  recordUnmatchedAttempt,
  shouldEmitProcessingAlert,
} from '../core/messaging/message-dedup';
import { redis } from '../utils/redis';
import { prisma } from '../utils/database';

// Cast back to jest.Mock so we can drive .mockResolvedValue etc.
const redisMock = redis as unknown as Record<string, jest.Mock>;
const prismaMock = prisma as unknown as {
  processedGmailMessage: Record<string, jest.Mock>;
  $transaction: jest.Mock;
};

beforeEach(() => {
  Object.values(redisMock).forEach((fn) => fn.mockReset());
  Object.values(prismaMock.processedGmailMessage).forEach((fn) => fn.mockReset());
  prismaMock.processedGmailMessage.upsert.mockResolvedValue(undefined);
  prismaMock.$transaction.mockReset();
});

describe('acquireMessageLock — Redis path', () => {
  it('returns "acquired" when the Lua script returns 1', async () => {
    redisMock.eval.mockResolvedValue(1);
    const r = await acquireMessageLock('msg-1', 'trace-1');
    expect(r).toEqual({ outcome: 'acquired' });
  });

  it('returns "already_processed" when the Lua script returns -1', async () => {
    redisMock.eval.mockResolvedValue(-1);
    const r = await acquireMessageLock('msg-1', 'trace-1');
    expect(r).toEqual({ outcome: 'already_processed' });
  });

  it('returns "held_by_other" when the Lua script returns 0', async () => {
    redisMock.eval.mockResolvedValue(0);
    const r = await acquireMessageLock('msg-1', 'trace-1');
    expect(r).toEqual({ outcome: 'held_by_other' });
  });
});

describe('acquireMessageLock — DB fallback', () => {
  it('falls back to DB when Redis throws and reports prior processing', async () => {
    redisMock.eval.mockRejectedValue(new Error('redis down'));
    prismaMock.$transaction.mockImplementation(async (cb: any) =>
      cb({
        processedGmailMessage: {
          findUnique: jest.fn().mockResolvedValue({ id: 'msg-1' }),
          create: jest.fn(),
        },
      }),
    );
    const r = await acquireMessageLock('msg-1', 'trace-1');
    expect(r).toEqual({ outcome: 'already_processed_db_fallback' });
  });

  it('falls back to DB and acquires the lock when no prior row exists', async () => {
    redisMock.eval.mockRejectedValue(new Error('redis down'));
    prismaMock.$transaction.mockImplementation(async (cb: any) =>
      cb({
        processedGmailMessage: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
        },
      }),
    );
    const r = await acquireMessageLock('msg-1', 'trace-1');
    expect(r).toEqual({ outcome: 'acquired_db_fallback' });
  });

  it('treats a P2002 unique-constraint violation as another worker winning the race', async () => {
    redisMock.eval.mockRejectedValue(new Error('redis down'));
    prismaMock.$transaction.mockImplementation(async (cb: any) =>
      cb({
        processedGmailMessage: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        },
      }),
    );
    const r = await acquireMessageLock('msg-1', 'trace-1');
    expect(r).toEqual({ outcome: 'already_processed_db_fallback' });
  });
});

describe('markMessageProcessed', () => {
  it('writes to Redis ZSET AND upserts the DB row', async () => {
    redisMock.zadd.mockResolvedValue(1);
    await markMessageProcessed('msg-1', 'successfully-processed');
    expect(redisMock.zadd).toHaveBeenCalledWith(
      'gmail:processedMessages',
      expect.any(Number),
      'msg-1',
    );
    expect(prismaMock.processedGmailMessage.upsert).toHaveBeenCalledWith({
      where: { id: 'msg-1' },
      create: { id: 'msg-1', context: 'successfully-processed' },
      update: { context: 'successfully-processed' },
    });
  });

  it('still upserts the DB row when the Redis write throws', async () => {
    redisMock.zadd.mockRejectedValue(new Error('redis down'));
    await markMessageProcessed('msg-1', 'unparseable');
    expect(prismaMock.processedGmailMessage.upsert).toHaveBeenCalled();
  });
});

describe('releaseMessageLock', () => {
  it('deletes the lock only when the stored trace ID matches', async () => {
    redisMock.get.mockResolvedValue('trace-1');
    await releaseMessageLock('msg-1', 'trace-1');
    expect(redisMock.del).toHaveBeenCalledWith('gmail:lock:message:msg-1');
  });

  it('does not delete when the lock is owned by a different trace', async () => {
    redisMock.get.mockResolvedValue('different-trace');
    await releaseMessageLock('msg-1', 'trace-1');
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('does not throw when Redis is unavailable', async () => {
    redisMock.get.mockRejectedValue(new Error('redis down'));
    await expect(releaseMessageLock('msg-1', 'trace-1')).resolves.toBeUndefined();
  });
});

describe('isMessageProcessed', () => {
  it('returns true on a Redis hit', async () => {
    redisMock.zscore.mockResolvedValue(123);
    await expect(isMessageProcessed('msg-1')).resolves.toBe(true);
    expect(prismaMock.processedGmailMessage.findUnique).not.toHaveBeenCalled();
  });

  it('falls through to the DB on a Redis miss', async () => {
    redisMock.zscore.mockResolvedValue(null);
    prismaMock.processedGmailMessage.findUnique.mockResolvedValue({ id: 'msg-1' });
    await expect(isMessageProcessed('msg-1')).resolves.toBe(true);
    expect(prismaMock.processedGmailMessage.findUnique).toHaveBeenCalled();
  });

  it('falls through to the DB when Redis errors, and returns false on a true miss', async () => {
    redisMock.zscore.mockRejectedValue(new Error('redis down'));
    prismaMock.processedGmailMessage.findUnique.mockResolvedValue(null);
    await expect(isMessageProcessed('msg-1')).resolves.toBe(false);
  });
});

describe('filterUnprocessed', () => {
  it('returns the input minus the IDs found in the DB', async () => {
    prismaMock.processedGmailMessage.findMany.mockResolvedValue([
      { id: 'msg-2' },
      { id: 'msg-3' },
    ]);
    await expect(filterUnprocessed(['msg-1', 'msg-2', 'msg-3', 'msg-4'])).resolves.toEqual([
      'msg-1',
      'msg-4',
    ]);
  });

  it('short-circuits on an empty input without touching the DB', async () => {
    await expect(filterUnprocessed([])).resolves.toEqual([]);
    expect(prismaMock.processedGmailMessage.findMany).not.toHaveBeenCalled();
  });
});

describe('recordUnmatchedAttempt', () => {
  it('sets the TTL on first attempt and abandons at the third', async () => {
    redisMock.incr.mockResolvedValueOnce(1);
    let r = await recordUnmatchedAttempt('msg-1');
    expect(r).toEqual({ attempts: 1, abandon: false });
    expect(redisMock.expire).toHaveBeenCalledTimes(1);

    redisMock.incr.mockResolvedValueOnce(2);
    r = await recordUnmatchedAttempt('msg-1');
    expect(r).toEqual({ attempts: 2, abandon: false });

    redisMock.incr.mockResolvedValueOnce(3);
    r = await recordUnmatchedAttempt('msg-1');
    expect(r).toEqual({ attempts: 3, abandon: true });
  });

  it('reports the first attempt when Redis errors (fail-open, not fail-abandon)', async () => {
    redisMock.incr.mockRejectedValue(new Error('redis down'));
    const r = await recordUnmatchedAttempt('msg-1');
    expect(r).toEqual({ attempts: 1, abandon: false });
  });
});

describe('shouldEmitProcessingAlert', () => {
  it('emits on first call (SET NX returns OK)', async () => {
    redisMock.set.mockResolvedValue('OK');
    await expect(shouldEmitProcessingAlert('msg-1')).resolves.toBe(true);
  });

  it('suppresses on duplicate call within TTL (SET NX returns null)', async () => {
    redisMock.set.mockResolvedValue(null);
    await expect(shouldEmitProcessingAlert('msg-1')).resolves.toBe(false);
  });

  it('emits anyway when Redis errors — better to noise-alert than to swallow a real failure', async () => {
    redisMock.set.mockRejectedValue(new Error('redis down'));
    await expect(shouldEmitProcessingAlert('msg-1')).resolves.toBe(true);
  });
});

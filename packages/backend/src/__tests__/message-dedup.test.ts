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
    getStrict: jest.fn(),
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
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import {
  acquireMessageLock,
  markMessageProcessed,
  releaseDbLock,
  renewDbLock,
  DB_LEASE_TTL_SECONDS,
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

/**
 * In-memory processed_gmail_messages table with a real primary key, wired
 * into the prisma mock for the DB-fallback (Redis down) tests.
 */
function useInMemoryProcessedTable(): Map<string, { id: string; context: string; processedAt: Date }> {
  const table = new Map<string, { id: string; context: string; processedAt: Date }>();
  const m = prismaMock.processedGmailMessage;
  m.findUnique.mockImplementation(async ({ where }: any) => table.get(where.id) ?? null);
  m.create.mockImplementation(async ({ data }: any) => {
    if (table.has(data.id)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const row = { id: data.id, context: data.context ?? 'legacy', processedAt: new Date() };
    table.set(data.id, row);
    return row;
  });
  const matches = (row: any, where: any) =>
    row.id === where.id &&
    (where.context === undefined || row.context === where.context) &&
    (where.processedAt?.lt === undefined || row.processedAt < where.processedAt.lt);
  m.deleteMany.mockImplementation(async ({ where }: any) => {
    let count = 0;
    for (const row of [...table.values()]) if (matches(row, where)) { table.delete(row.id); count++; }
    return { count };
  });
  m.updateMany.mockImplementation(async ({ where, data }: any) => {
    let count = 0;
    for (const row of table.values()) if (matches(row, where)) { Object.assign(row, data); count++; }
    return { count };
  });
  m.upsert.mockImplementation(async ({ where, create, update }: any) => {
    const existing = table.get(where.id);
    if (existing) Object.assign(existing, update);
    else table.set(where.id, { ...create, processedAt: new Date() });
  });
  return table;
}

describe('acquireMessageLock — DB fallback lease (E7)', () => {
  beforeEach(() => {
    redisMock.eval.mockRejectedValue(new Error('redis down'));
  });

  it('reports prior processing when the message already has a dedup row', async () => {
    const table = useInMemoryProcessedTable();
    table.set('msg-1', { id: 'msg-1', context: 'successfully-processed', processedAt: new Date() });

    const r = await acquireMessageLock('msg-1', 'trace-1');

    expect(r).toEqual({ outcome: 'already_processed_db_fallback' });
    expect(table.has('lease:msg-1')).toBe(false);
  });

  it('takes a lease row in its own namespace and never writes the message\'s dedup row', async () => {
    const table = useInMemoryProcessedTable();

    const r = await acquireMessageLock('msg-1', 'trace-1');

    expect(r.outcome).toBe('acquired_db_fallback');
    expect(table.has('lease:msg-1')).toBe(true);
    // The old fallback inserted THIS row as the lock — the message then
    // looked processed on every non-success return.
    expect(table.has('msg-1')).toBe(false);
  });

  it('a released lease leaves the message retryable (paused / deferred / unmatched / retry returns)', async () => {
    const table = useInMemoryProcessedTable();
    const first = await acquireMessageLock('msg-1', 'trace-1');
    if (first.outcome !== 'acquired_db_fallback') throw new Error('expected lease');

    // processMessage returns false without marking (e.g. paused) and releases.
    await releaseDbLock('msg-1', first.leaseToken, 'trace-1');

    expect(table.size).toBe(0);
    expect((await acquireMessageLock('msg-1', 'trace-2')).outcome).toBe('acquired_db_fallback');
  });

  it('reports held_by_other (not "already processed") while another worker holds the lease', async () => {
    useInMemoryProcessedTable();
    expect((await acquireMessageLock('msg-1', 'trace-1')).outcome).toBe('acquired_db_fallback');

    expect(await acquireMessageLock('msg-1', 'trace-2')).toEqual({ outcome: 'held_by_other' });
  });

  it('expires a crashed holder\'s lease after the TTL', async () => {
    const table = useInMemoryProcessedTable();
    table.set('lease:msg-1', {
      id: 'lease:msg-1',
      context: 'processing-lease:dead-worker:x',
      processedAt: new Date(Date.now() - (DB_LEASE_TTL_SECONDS + 5) * 1000),
    });

    const r = await acquireMessageLock('msg-1', 'trace-1');

    expect(r.outcome).toBe('acquired_db_fallback');
    expect(table.get('lease:msg-1')!.context).not.toBe('processing-lease:dead-worker:x');
  });

  it('backs off if the message was marked processed between the check and the lease insert', async () => {
    const table = useInMemoryProcessedTable();
    const m = prismaMock.processedGmailMessage;
    const realCreate = m.create.getMockImplementation()!;
    m.create.mockImplementationOnce(async (args: any) => {
      const row = await realCreate(args);
      // Another holder finished in the meantime.
      table.set('msg-1', { id: 'msg-1', context: 'successfully-processed', processedAt: new Date() });
      return row;
    });

    expect(await acquireMessageLock('msg-1', 'trace-1')).toEqual({ outcome: 'already_processed_db_fallback' });
    expect(table.has('lease:msg-1')).toBe(false);
  });

  it('release and renew are owner-checked', async () => {
    const table = useInMemoryProcessedTable();
    const r = await acquireMessageLock('msg-1', 'trace-1');
    if (r.outcome !== 'acquired_db_fallback') throw new Error('expected lease');

    // A stale holder with another token can neither renew nor release it.
    expect(await renewDbLock('msg-1', 'processing-lease:someone-else')).toBe(false);
    await releaseDbLock('msg-1', 'processing-lease:someone-else');
    expect(table.has('lease:msg-1')).toBe(true);

    const before = table.get('lease:msg-1')!.processedAt;
    await new Promise((res) => setTimeout(res, 5));
    expect(await renewDbLock('msg-1', r.leaseToken)).toBe(true);
    expect(table.get('lease:msg-1')!.processedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('treats a DB error as held_by_other rather than processing without a lock', async () => {
    prismaMock.processedGmailMessage.findUnique.mockRejectedValue(new Error('db down'));
    expect(await acquireMessageLock('msg-1', 'trace-1')).toEqual({ outcome: 'held_by_other' });
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

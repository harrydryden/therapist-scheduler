/**
 * Regression tests for lifecycle audit L13 — "WAL recovery pops the entry
 * before inserting it".
 *
 * When the DB is down, EmailQueueService.enqueue buffers the email in a
 * Redis list (the write-ahead log). recoverFromWAL used to LPOP an entry and
 * only then insert its PendingEmail row, so any insert failure — most
 * commonly the DB still being down on the next recovery run — landed in a
 * catch labelled "entry may be corrupt" and the email was lost.
 *
 * Recovery now peeks the head, inserts, and removes the entry only after the
 * insert committed. The PendingEmail id is derived from the WAL entry, so a
 * re-run over an already-recovered entry collides on the primary key rather
 * than creating a duplicate email.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { redisUrl: 'redis://localhost:6379', env: 'test', port: 3000 },
}));

jest.mock('../constants', () => ({
  EMAIL: {
    MAX_RETRIES: 5,
    RETRY_DELAYS_MS: [60_000, 300_000, 900_000, 3_600_000, 14_400_000],
    FROM_ADDRESS: 'test@example.com',
  },
  PENDING_EMAIL_LOCK: { KEY: 'email-queue:lock', TTL_SECONDS: 60, RENEWAL_INTERVAL_MS: 30_000 },
}));

jest.mock('../utils/redis-locks', () => ({
  releaseLock: jest.fn(() => Promise.resolve()),
  renewLock: jest.fn(() => Promise.resolve(true)),
}));

// In-memory Redis list standing in for the WAL.
let wal: string[] = [];
jest.mock('../utils/redis', () => ({
  redis: {
    llen: jest.fn(async () => wal.length),
    lrange: jest.fn(async (_key: string, start: number, stop: number) => wal.slice(start, stop + 1)),
    lpop: jest.fn(async () => wal.shift() ?? null),
    rpush: jest.fn(async (_key: string, v: string) => wal.push(v)),
    expire: jest.fn(async () => 1),
    eval: jest.fn(async (script: string, _numKeys: number, _key: string, value: string) => {
      if (!script.includes('LREM')) throw new Error(`unexpected script: ${script}`);
      const idx = wal.indexOf(value);
      if (idx === -1) return 0;
      wal.splice(idx, 1);
      return 1;
    }),
    get: jest.fn(),
    set: jest.fn(),
  },
}));

// In-memory pending_emails table with a real primary-key constraint.
const table = new Map<string, Record<string, unknown>>();
let dbDown = false;
const createMock = jest.fn(async (args: { data: Record<string, unknown> }) => {
  if (dbDown) throw new Error("Can't reach database server");
  const id = (args.data.id as string | undefined) ?? `auto-${table.size + 1}`;
  if (table.has(id)) {
    throw Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' });
  }
  table.set(id, { ...args.data, id });
  return { ...args.data, id };
});
jest.mock('../utils/database', () => ({
  prisma: {
    pendingEmail: {
      create: (...a: unknown[]) => createMock(...(a as [{ data: Record<string, unknown> }])),
    },
  },
}));

jest.mock('../core/email', () => ({ sendEmail: jest.fn(), processPendingEmails: jest.fn() }));
jest.mock('bullmq', () => ({ Queue: jest.fn(), Worker: jest.fn(), QueueEvents: jest.fn() }));

import { emailQueueService } from '../services/email-queue.service';

const queueAdd = jest.fn().mockResolvedValue(undefined);

function walEntry(id: string, to = `${id}@example.com`): string {
  return JSON.stringify({ id, to, subject: `subject ${id}`, body: `body ${id}`, createdAt: '2026-09-28T10:00:00.000Z' });
}

beforeEach(() => {
  jest.clearAllMocks();
  wal = [];
  table.clear();
  dbDown = false;
  // Pretend BullMQ is up so enqueue behaviour is observable.
  (emailQueueService as unknown as { queue: unknown }).queue = { add: queueAdd };
});

afterAll(() => {
  (emailQueueService as unknown as { queue: unknown }).queue = null;
});

describe('recoverFromWAL — an insert failure never drops the email (L13)', () => {
  it('leaves every entry in the WAL, in order, when the DB insert fails', async () => {
    wal = [walEntry('wal-1'), walEntry('wal-2')];
    dbDown = true;

    const recovered = await emailQueueService.recoverFromWAL();

    expect(recovered).toBe(0);
    expect(wal).toEqual([walEntry('wal-1'), walEntry('wal-2')]);
    // Stops at the first failure rather than hammering a down DB.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('recovers the retained entries on the next run once the DB is back', async () => {
    wal = [walEntry('wal-1'), walEntry('wal-2')];
    dbDown = true;
    await emailQueueService.recoverFromWAL();

    dbDown = false;
    const recovered = await emailQueueService.recoverFromWAL();

    expect(recovered).toBe(2);
    expect(wal).toEqual([]);
    expect([...table.values()].map((r) => r.toEmail)).toEqual(['wal-1@example.com', 'wal-2@example.com']);
    expect(queueAdd).toHaveBeenCalledTimes(2);
  });

  it('never creates a duplicate row when an already-recovered entry is still in the WAL', async () => {
    // Simulates a crash between the insert and the removal on a previous
    // run (or a concurrent recoverer that inserted but has not removed yet).
    wal = [walEntry('wal-1')];
    await emailQueueService.recoverFromWAL();
    expect(table.size).toBe(1);
    wal = [walEntry('wal-1')];
    queueAdd.mockClear();

    const recovered = await emailQueueService.recoverFromWAL();

    expect(recovered).toBe(0);
    expect(table.size).toBe(1);
    expect(wal).toEqual([]);
    // The original recoverer owns the send — no second enqueue.
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('uses a stable, UUID-shaped id per WAL entry and enqueues under it', async () => {
    wal = [walEntry('wal-1')];

    await emailQueueService.recoverFromWAL();

    const [row] = [...table.values()];
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(queueAdd).toHaveBeenCalledWith(
      'send-email',
      expect.objectContaining({ pendingEmailId: row.id, to: 'wal-1@example.com' }),
      { jobId: row.id },
    );
  });

  it('drops only a genuinely corrupt entry and carries on with the rest', async () => {
    wal = ['{not json', JSON.stringify({ id: 'wal-x', subject: 'no recipient' }), walEntry('wal-2')];

    const recovered = await emailQueueService.recoverFromWAL();

    expect(recovered).toBe(1);
    expect(wal).toEqual([]);
    expect([...table.values()].map((r) => r.toEmail)).toEqual(['wal-2@example.com']);
  });
});

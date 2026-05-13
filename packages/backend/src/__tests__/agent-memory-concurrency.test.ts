/**
 * Concurrency contract for the per-appointment memory writes.
 *
 * Mirrors `therapist-availability.test.ts`'s row-lock contract test —
 * two `Promise.all`-ed `addAvailabilityWindow` calls must serialize on
 * the appointment row, not race. Same model: per-row async mutex stands
 * in for Postgres `SELECT ... FOR UPDATE`.
 *
 * Lives in its own file so the existing `agent-memory.test.ts` keeps a
 * simple sequential mock and this file owns the concurrency simulation.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const memoryStore: Record<string, unknown> = {};
const transactionSpy = jest.fn();
const queryRawSpy = jest.fn();

jest.mock('../utils/database', () => {
  const rowLocks = new Map<string, Promise<void>>();
  async function withRowLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = rowLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    rowLocks.set(id, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  const findUniqueImpl = async ({ where }: { where: { id: string } }) => {
    if (!(where.id in memoryStore)) return null;
    return { memory: memoryStore[where.id] };
  };
  const updateImpl = async ({
    where,
    data,
  }: {
    where: { id: string };
    data: { memory: unknown };
  }) => {
    if (!(where.id in memoryStore)) throw new Error('P2025: record not found');
    memoryStore[where.id] = data.memory;
    return { id: where.id };
  };
  const queryRawImpl = async () => {
    queryRawSpy();
    return [];
  };

  const tx = {
    appointmentRequest: { findUnique: findUniqueImpl, update: updateImpl },
    $queryRaw: queryRawImpl,
  };
  const $transaction = async (fn: (txArg: unknown) => Promise<unknown>) => {
    transactionSpy();
    return withRowLock('global', () => fn(tx));
  };

  return {
    prisma: {
      appointmentRequest: { findUnique: findUniqueImpl, update: updateImpl },
      $transaction,
      $queryRaw: queryRawImpl,
    },
  };
});

import { addNote, addAvailabilityWindow, getThreadMemory } from '../services/agent-memory.service';

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(memoryStore)) delete memoryStore[k];
});

function seedAppointment(id: string) {
  memoryStore[id] = { notes: [], availabilityWindows: [] };
}

describe('addAvailabilityWindow — concurrency contract', () => {
  it('serializes concurrent appends so neither write clobbers the other', async () => {
    seedAppointment('apt-1');

    const [r1, r2] = await Promise.all([
      addAvailabilityWindow('apt-1', {
        startsAt: '2030-06-02T09:00:00+01:00',
        endsAt: '2030-06-02T11:00:00+01:00',
        status: 'available',
        source: 'therapist',
        quote: 'A: free Tuesday',
      }),
      addAvailabilityWindow('apt-1', {
        startsAt: '2030-06-04T14:00:00+01:00',
        endsAt: '2030-06-04T16:00:00+01:00',
        status: 'available',
        source: 'user',
        quote: 'B: free Thursday',
      }),
    ]);

    expect(r1.added).toBe(true);
    expect(r2.added).toBe(true);

    const memory = await getThreadMemory('apt-1');
    expect(memory.availabilityWindows.map((w) => w.startsAt).sort()).toEqual([
      '2030-06-02T09:00:00+01:00',
      '2030-06-04T14:00:00+01:00',
    ]);
  });

  it('runs the read-modify-write inside $transaction with a row-lock SELECT', async () => {
    seedAppointment('apt-2');

    await addAvailabilityWindow('apt-2', {
      startsAt: '2030-06-02T09:00:00+01:00',
      endsAt: '2030-06-02T11:00:00+01:00',
      status: 'available',
      source: 'therapist',
      quote: 'fresh',
    });

    expect(transactionSpy).toHaveBeenCalled();
    expect(queryRawSpy).toHaveBeenCalled();
  });
});

describe('addNote — concurrency contract', () => {
  it('serializes concurrent appends so notes do not clobber each other', async () => {
    seedAppointment('apt-3');

    await Promise.all([
      addNote('apt-3', 'preference', 'A wants morning'),
      addNote('apt-3', 'constraint', 'B has a kid pickup'),
    ]);

    const memory = await getThreadMemory('apt-3');
    expect(memory.notes).toHaveLength(2);
    const texts = memory.notes.map((n) => n.text).sort();
    expect(texts).toEqual(['A wants morning', 'B has a kid pickup']);
  });
});

/**
 * Tests for therapist-availability.service.
 *
 * The highest-value test here is the concurrent-write contract:
 * `addUpcomingAvailability` MUST serialize on the therapist row,
 * because two writers (the availability-collection agent's
 * record_availability_window and the booking agent's same tool with
 * source='therapist') can target the same row from independent
 * conversations. Without the row lock, the read-modify-write pattern
 * is a classic lost-update — two concurrent calls each read [], each
 * compute a single-entry result, and the second write clobbers the
 * first. This file pins the locking contract.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The mock prisma client lives entirely inside the factory because
// jest.mock is hoisted above module-scope `const`s — referencing a
// top-level const from the factory would fire before initialisation.
// Outside the factory we expose just the bookkeeping store and a
// `transactionSpy` for assertions.
const therapistStore: Record<
  string,
  { upcomingAvailability: unknown; bookingLink: string | null }
> = {};
const transactionSpy = jest.fn();
const queryRawSpy = jest.fn();

jest.mock('../utils/database', () => {
  // Per-row async mutex mirroring Postgres SELECT FOR UPDATE: two
  // concurrent transactions on the same id serialize. The lock id is
  // 'global' here — the test exercises a single therapist row, and a
  // global lock is the conservative model for that case.
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
    if (!(where.id in therapistStore)) return null;
    return therapistStore[where.id];
  };

  const updateImpl = async ({
    where,
    data,
  }: {
    where: { id: string };
    data: { upcomingAvailability?: unknown; bookingLink?: string };
  }) => {
    if (!(where.id in therapistStore)) {
      throw new Error('P2025: record not found');
    }
    if (data.upcomingAvailability !== undefined) {
      therapistStore[where.id].upcomingAvailability = data.upcomingAvailability;
    }
    if (data.bookingLink !== undefined) {
      therapistStore[where.id].bookingLink = data.bookingLink;
    }
    return { id: where.id };
  };

  const queryRawImpl = async () => {
    queryRawSpy();
    return [];
  };

  const tx = {
    therapist: { findUnique: findUniqueImpl, update: updateImpl },
    $queryRaw: queryRawImpl,
  };

  const $transaction = async (fn: (txArg: unknown) => Promise<unknown>) => {
    transactionSpy();
    return withRowLock('global', () => fn(tx));
  };

  return {
    prisma: {
      therapist: { findUnique: findUniqueImpl, update: updateImpl },
      $transaction,
      $queryRaw: queryRawImpl,
    },
  };
});

import {
  addUpcomingAvailability,
  getUpcomingAvailability,
  MAX_UPCOMING_WINDOWS_PER_THERAPIST,
} from '../domain/scheduling/availability/windows/therapist-store';

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(therapistStore)) delete therapistStore[k];
});

function seedTherapist(id: string) {
  therapistStore[id] = { upcomingAvailability: null, bookingLink: null };
}

// Windows must sit in the future relative to the real clock — the store
// compacts fully-past windows (endsAt < now), so hardcoded dates turn
// into time-bombs that start failing the day they lapse (this bit us
// with 2026-06 fixtures).
const futureIso = (daysAhead: number, hourOffset = 0): string =>
  new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000 + hourOffset * 60 * 60 * 1000).toISOString();

const tuesdayStart = futureIso(7);
const tuesdayEnd = futureIso(7, 2);
const thursdayStart = futureIso(9);
const thursdayEnd = futureIso(9, 2);

describe('addUpcomingAvailability — concurrency contract', () => {
  it('serializes concurrent appends so neither write clobbers the other', async () => {
    seedTherapist('therapist-1');

    // Two writers fire at the same time. Without the FOR UPDATE +
    // transaction wrapper, both read [], both compute a 1-element
    // result, the second update overwrites the first, and one window
    // is lost. With the lock, the second waits and sees the first's
    // write before computing.
    const [r1, r2] = await Promise.all([
      addUpcomingAvailability('therapist-1', {
        startsAt: tuesdayStart,
        endsAt: tuesdayEnd,
        status: 'available',
        source: 'therapist',
        quote: 'A: free Tuesday morning',
      }),
      addUpcomingAvailability('therapist-1', {
        startsAt: thursdayStart,
        endsAt: thursdayEnd,
        status: 'available',
        source: 'therapist',
        quote: 'B: free Thursday afternoon',
      }),
    ]);

    expect(r1.added).toBe(true);
    expect(r2.added).toBe(true);

    const windows = await getUpcomingAvailability('therapist-1');
    expect(windows.map((w) => w.startsAt).sort()).toEqual(
      [tuesdayStart, thursdayStart].sort(),
    );
  });

  it('runs the read-modify-write inside $transaction with a row-lock SELECT', async () => {
    seedTherapist('therapist-2');

    await addUpcomingAvailability('therapist-2', {
      startsAt: tuesdayStart,
      endsAt: tuesdayEnd,
      status: 'available',
      source: 'therapist',
      quote: 'fresh',
    });

    // Pin the lock contract — if a refactor accidentally drops the
    // $transaction wrapper or the FOR UPDATE query, this fails fast
    // rather than only re-introducing the race under load.
    expect(transactionSpy).toHaveBeenCalled();
    expect(queryRawSpy).toHaveBeenCalled();
  });

  it('deduplicates identical (status,source,starts,ends) on the same therapist', async () => {
    seedTherapist('therapist-3');

    const first = await addUpcomingAvailability('therapist-3', {
      startsAt: tuesdayStart,
      endsAt: tuesdayEnd,
      status: 'available',
      source: 'therapist',
      quote: 'first phrasing',
    });
    const second = await addUpcomingAvailability('therapist-3', {
      startsAt: tuesdayStart,
      endsAt: tuesdayEnd,
      status: 'available',
      source: 'therapist',
      quote: 'rephrased — should dedupe',
    });

    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    expect(second.windowId).toBe(first.windowId);

    const windows = await getUpcomingAvailability('therapist-3');
    expect(windows).toHaveLength(1);
    expect(windows[0].quote).toBe('first phrasing');
  });

  it('FIFO-evicts the oldest window once MAX is reached', async () => {
    seedTherapist('therapist-4');

    // Fill to capacity with windows that all sit in the future, then
    // add one more — the oldest (by recordedAt, which is in insertion
    // order) should be evicted.
    const baseTime = Date.now() + 24 * 60 * 60 * 1000;
    const hour = 60 * 60 * 1000;
    for (let i = 0; i < MAX_UPCOMING_WINDOWS_PER_THERAPIST; i++) {
      await addUpcomingAvailability('therapist-4', {
        startsAt: new Date(baseTime + i * hour).toISOString(),
        endsAt: new Date(baseTime + (i + 1) * hour).toISOString(),
        status: 'available',
        source: 'therapist',
        quote: `slot ${i}`,
      });
    }

    const result = await addUpcomingAvailability('therapist-4', {
      startsAt: '2030-01-01T09:00:00+00:00',
      endsAt: '2030-01-01T10:00:00+00:00',
      status: 'available',
      source: 'therapist',
      quote: 'much later',
    });
    expect(result.added).toBe(true);

    const final = await getUpcomingAvailability('therapist-4');
    expect(final).toHaveLength(MAX_UPCOMING_WINDOWS_PER_THERAPIST);
    expect(final.some((w) => w.quote === 'much later')).toBe(true);
    expect(final.some((w) => w.quote === 'slot 0')).toBe(false);
  });
});

describe('getUpcomingAvailability — primary-key scoping', () => {
  it('returns [] for a therapist that does not exist; never falls back', async () => {
    seedTherapist('therapist-real');
    await addUpcomingAvailability('therapist-real', {
      startsAt: tuesdayStart,
      endsAt: tuesdayEnd,
      status: 'available',
      source: 'therapist',
      quote: 'real',
    });

    const missing = await getUpcomingAvailability('therapist-missing');
    expect(missing).toEqual([]);
  });
});

/**
 * Tests for the atomic sentinel-claim helper.
 *
 * The helper centralises the "claim by flipping null → epoch sentinel,
 * confirm by flipping sentinel → real timestamp, release by flipping
 * sentinel → null" pattern used by chase-email and post-booking-followup
 * services. These tests pin the SQL shape so a refactor of the helper
 * won't silently break the precondition contract that all callers rely on.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { redisUrl: 'redis://localhost:6379', env: 'test' },
}));

const updateManyMock = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      updateMany: (...args: unknown[]) => updateManyMock(...args),
    },
  },
}));

import {
  EPOCH_SENTINEL,
  tryClaimSentinel,
  confirmSentinelClaim,
  releaseSentinelClaim,
  cleanupStuckSentinels,
} from '../utils/atomic-sentinel-claim';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('tryClaimSentinel', () => {
  it('returns true when the gate field was null and the claim landed', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const won = await tryClaimSentinel('apt-1', 'chaseSentAt');

    expect(won).toBe(true);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const args = updateManyMock.mock.calls[0][0];
    // Gate condition: id matches AND field is null.
    expect(args.where).toEqual({ id: 'apt-1', chaseSentAt: null });
    // Claim sets the field to the shared epoch sentinel.
    expect(args.data).toEqual({ chaseSentAt: EPOCH_SENTINEL });
  });

  it('returns false when count is 0 (another writer beat us, or the row drifted)', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    const won = await tryClaimSentinel('apt-1', 'chaseSentAt');

    expect(won).toBe(false);
  });

  it('passes extraWhere clauses through to the updateMany precondition', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    await tryClaimSentinel('apt-1', 'reminderSentAt', {
      extraWhere: { status: 'confirmed' },
    });

    const args = updateManyMock.mock.calls[0][0];
    // Crucial: the status precondition must be in the WHERE so a
    // status drift between candidate query and claim aborts the
    // claim atomically.
    expect(args.where).toEqual({
      id: 'apt-1',
      reminderSentAt: null,
      status: 'confirmed',
    });
  });

  it('uses the SAME EPOCH_SENTINEL across all callers (so confirm/release can match it)', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    await tryClaimSentinel('a', 'chaseSentAt');
    await tryClaimSentinel('b', 'reminderSentAt');

    const a = updateManyMock.mock.calls[0][0].data.chaseSentAt;
    const b = updateManyMock.mock.calls[1][0].data.reminderSentAt;
    expect(a).toBe(EPOCH_SENTINEL);
    expect(b).toBe(EPOCH_SENTINEL);
    // Sanity: it's actually the Unix epoch.
    expect((a as Date).getTime()).toBe(0);
  });
});

describe('confirmSentinelClaim', () => {
  it('flips the sentinel to the final value with the SAME-sentinel precondition', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });
    const now = new Date('2026-05-07T10:00:00Z');

    const ok = await confirmSentinelClaim('apt-1', 'chaseSentAt', now);

    expect(ok).toBe(true);
    const args = updateManyMock.mock.calls[0][0];
    // The "must still be our sentinel" guard prevents two ticks
    // confirming on top of each other.
    expect(args.where).toEqual({ id: 'apt-1', chaseSentAt: EPOCH_SENTINEL });
    expect(args.data).toEqual({ chaseSentAt: now });
  });

  it('returns false when count is 0 (sentinel was already moved by another writer)', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    const ok = await confirmSentinelClaim('apt-1', 'chaseSentAt', new Date());
    expect(ok).toBe(false);
  });

  it('writes extraData fields atomically with the confirm', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });
    const now = new Date();

    await confirmSentinelClaim('apt-1', 'reminderSentAt', now, {
      extraData: { isStale: true, notes: 'partial send' },
    });

    const data = updateManyMock.mock.calls[0][0].data;
    expect(data).toEqual({
      reminderSentAt: now,
      isStale: true,
      notes: 'partial send',
    });
  });
});

describe('releaseSentinelClaim', () => {
  it('flips the sentinel back to null for re-evaluation next tick', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const ok = await releaseSentinelClaim('apt-1', 'chaseSentAt');

    expect(ok).toBe(true);
    const args = updateManyMock.mock.calls[0][0];
    // The release must be sentinel-conditioned too — we don't want to
    // null out a real timestamp that another writer just wrote.
    expect(args.where).toEqual({ id: 'apt-1', chaseSentAt: EPOCH_SENTINEL });
    expect(args.data).toEqual({ chaseSentAt: null });
  });

  it('returns false when count is 0 (sentinel was already replaced)', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    const ok = await releaseSentinelClaim('apt-1', 'chaseSentAt');
    expect(ok).toBe(false);
  });
});

describe('cleanupStuckSentinels', () => {
  it('resets every requested field independently, gated on EPOCH_SENTINEL + staleness cutoff', async () => {
    updateManyMock
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 0 });

    const counts = await cleanupStuckSentinels(['chaseSentAt', 'reminderSentAt'], 2 * 60 * 1000);

    expect(counts).toEqual({ chaseSentAt: 2, reminderSentAt: 0 });
    expect(updateManyMock).toHaveBeenCalledTimes(2);

    const firstArgs = updateManyMock.mock.calls[0][0];
    expect(firstArgs.where.chaseSentAt).toBe(EPOCH_SENTINEL);
    expect(firstArgs.where.updatedAt.lt).toBeInstanceOf(Date);
    expect(firstArgs.data).toEqual({ chaseSentAt: null });

    const secondArgs = updateManyMock.mock.calls[1][0];
    expect(secondArgs.where.reminderSentAt).toBe(EPOCH_SENTINEL);
    expect(secondArgs.data).toEqual({ reminderSentAt: null });
  });

  it('uses a cutoff older-than-olderThanMs so freshly-claimed sentinels are not reset', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    const before = Date.now();

    await cleanupStuckSentinels(['chaseSentAt'], 5 * 60 * 1000);

    const cutoff = updateManyMock.mock.calls[0][0].where.updatedAt.lt as Date;
    const expectedCutoff = before - 5 * 60 * 1000;
    // Allow a small margin for test execution time.
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedCutoff - 1000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(expectedCutoff + 1000);
  });
});

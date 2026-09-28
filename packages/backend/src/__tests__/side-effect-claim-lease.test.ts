/**
 * Tests for the side-effect execute-lease claim added to close the
 * retry-while-in-flight concurrency hole called out by the
 * production-readiness audit.
 *
 * Before this fix, the harness flow was:
 *   register row (status='pending') → execute → markCompleted
 *
 * If the original execute took >10 minutes (Anthropic + Gmail spike),
 * the retry runner's next tick picked up the still-pending row
 * (`createdAt < now - 10min`) and ran a SECOND execute in parallel,
 * producing duplicate user-visible emails for periodic effects (chase,
 * feedback dispatch, session reminder pair). The harness comments
 * explicitly acknowledged the gap: "the harness's `pending` status does
 * NOT block parallel `execute` calls".
 *
 * The fix introduces an atomic CAS-claim: `tryClaimEffect` transitions
 * pending/failed/stuck-running rows to `running` + sets `lastAttempt`
 * to now. The retry runner (and the original harness execute) must
 * claim before executing; if the claim fails, another worker holds the
 * lease and we skip silently.
 *
 * These tests pin:
 *   - CAS semantics (which states accept the claim, which don't)
 *   - Lease expiry behaviour (stuck-running rows can be re-claimed)
 *   - `getEffectsToRetry` includes stuck-running rows
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const updateManyMock = jest.fn();
const findManyMock = jest.fn();
const deleteManyMock = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      updateMany: (...args: unknown[]) => updateManyMock(...args),
      findMany: (...args: unknown[]) => findManyMock(...args),
      deleteMany: (...args: unknown[]) => deleteManyMock(...args),
    },
  },
}));

import { sideEffectTrackerService } from '../services/side-effect-tracker.service';

beforeEach(() => {
  jest.resetAllMocks();
});

describe('tryClaimEffect — atomic CAS-claim before execute', () => {
  it('returns the lease (the stamped lastAttempt) when a pending/failed row is claimed', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    const lease = await sideEffectTrackerService.tryClaimEffect('idem-pending');

    expect(lease).toBeInstanceOf(Date);
    // The CAS transitions to status='running' and stamps the lease.
    const call = updateManyMock.mock.calls[0][0];
    expect(call.where.idempotencyKey).toBe('idem-pending');
    expect(call.where.status).toEqual({ in: ['pending', 'failed'] });
    expect(call.data.status).toBe('running');
    expect(call.data.lastAttempt).toEqual(lease);
    // A fresh claim does not count an attempt — markFailed does that.
    expect(call.data.attempts).toBeUndefined();
    // No second (orphan re-claim) statement when the first one lands.
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when neither branch finds an eligible row', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });

    const lease = await sideEffectTrackerService.tryClaimEffect('idem-already-running');

    expect(lease).toBeNull();
  });

  it('re-claims an expired running row AND counts the crashed attempt', async () => {
    // Regression (review §4.4): a worker that died mid-execute never ran
    // markFailed, so re-claims never incremented attempts and an effect
    // that crashed the process retried every lease period forever.
    updateManyMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    const lease = await sideEffectTrackerService.tryClaimEffect('idem-orphan');

    expect(lease).toBeInstanceOf(Date);
    const orphanCall = updateManyMock.mock.calls[1][0];
    expect(orphanCall.where.status).toBe('running');
    expect(orphanCall.where.lastAttempt).toMatchObject({ lt: expect.any(Date) });
    expect(orphanCall.data.attempts).toEqual({ increment: 1 });
    expect(orphanCall.data.lastAttempt).toEqual(lease);
  });

  it('the stuck-running cutoff matches CLAIM_LEASE_MS (10 min)', async () => {
    const before = Date.now();
    updateManyMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    await sideEffectTrackerService.tryClaimEffect('idem-x');
    const after = Date.now();

    const cutoff = (updateManyMock.mock.calls[1][0].where.lastAttempt as { lt: Date }).lt.getTime();
    expect(cutoff).toBeGreaterThan(before - 11 * 60 * 1000);
    expect(cutoff).toBeLessThan(after - 9 * 60 * 1000);
  });
});

describe('outcome writes are lease-checked', () => {
  it('markCompleted with a lease only matches a running row carrying exactly that lastAttempt', async () => {
    const lease = new Date('2026-09-28T10:00:00.123Z');
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await expect(sideEffectTrackerService.markCompleted('k', lease)).resolves.toBe(true);

    expect(updateManyMock.mock.calls[0][0].where).toEqual({
      idempotencyKey: 'k',
      status: 'running',
      lastAttempt: lease,
    });
  });

  it('a stale worker cannot flip a re-claimed/completed row: markFailed writes nothing and reports false', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });

    await expect(
      sideEffectTrackerService.markFailed('k', 'boom', new Date('2026-09-28T10:00:00.000Z')),
    ).resolves.toBe(false);
  });

  it('markAbandoned / markSuperseded carry the same ownership guard', async () => {
    const lease = new Date();
    updateManyMock.mockResolvedValue({ count: 1 });

    await sideEffectTrackerService.markAbandoned('k', 'why', lease);
    await sideEffectTrackerService.markSuperseded('k', 'why', lease);

    for (const [args] of updateManyMock.mock.calls) {
      expect(args.where).toEqual({ idempotencyKey: 'k', status: 'running', lastAttempt: lease });
    }
    expect(updateManyMock.mock.calls[1][0].data).toMatchObject({ status: 'superseded', completedAt: expect.any(Date) });
  });

  it('without a lease (legacy never-claimed callers) never resurrects a terminal row', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await sideEffectTrackerService.markCompleted('k');

    expect(updateManyMock.mock.calls[0][0].where).toEqual({
      idempotencyKey: 'k',
      status: { in: ['pending', 'running', 'failed'] },
    });
  });

  it('markCompletedAfterExecute does not retry when the lease was lost', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    const recorded = await sideEffectTrackerService.markCompletedAfterExecute('k', {}, {
      lease: new Date(),
      inlineRetryDelaysMs: [1, 1],
      deferredRetryDelaysMs: [],
    });

    expect(recorded).toBe(false);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });
});

describe('getEffectsToRetry', () => {
  beforeEach(() => {
    findManyMock.mockResolvedValueOnce([]);
  });

  it('OR clause includes status=running with stale lastAttempt, NOT capped by attempts', async () => {
    await sideEffectTrackerService.getEffectsToRetry();

    const orClauses = findManyMock.mock.calls[0][0].where.OR as Array<Record<string, unknown>>;
    const states = orClauses.map((c) => c.status).sort();
    // failed (retry), pending (stuck-pending recovery), running (stuck-
    // running recovery). Without `running`, a worker that died mid-
    // execute leaves its row in `running` forever — invisible to retry.
    expect(states).toEqual(['failed', 'pending', 'running']);

    const runningClause = orClauses.find((c) => c.status === 'running')!;
    expect(runningClause.lastAttempt).toMatchObject({ lt: expect.any(Date) });
    // Crash orphans at the cap must still surface so the runner abandons
    // (and alerts on) them instead of leaving them running forever.
    expect(runningClause.attempts).toBeUndefined();
  });

  it('failed and pending clauses are preserved unchanged', async () => {
    await sideEffectTrackerService.getEffectsToRetry();

    const orClauses = findManyMock.mock.calls[0][0].where.OR as Array<Record<string, unknown>>;
    const failedClause = orClauses.find((c) => c.status === 'failed')!;
    expect(failedClause.attempts).toMatchObject({ lt: expect.any(Number) });
    expect(failedClause.lastAttempt).toMatchObject({ lt: expect.any(Date) });

    const pendingClause = orClauses.find((c) => c.status === 'pending')!;
    expect(pendingClause.attempts).toBe(0);
    expect(pendingClause.createdAt).toMatchObject({ lt: expect.any(Date) });
  });

  it('orders never-attempted rows (null lastAttempt) FIRST so they are not starved', async () => {
    await sideEffectTrackerService.getEffectsToRetry();

    expect(findManyMock.mock.calls[0][0].orderBy).toEqual([
      { lastAttempt: { sort: 'asc', nulls: 'first' } },
      { createdAt: 'asc' },
    ]);
  });
});

describe('cleanupOldEffects', () => {
  it('deletes only finished (completed/superseded) rows older than 30 days by default', async () => {
    deleteManyMock.mockResolvedValueOnce({ count: 3 });
    const before = Date.now();

    await expect(sideEffectTrackerService.cleanupOldEffects()).resolves.toBe(3);

    const where = deleteManyMock.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['completed', 'superseded'] });
    const cutoff = (where.completedAt as { lt: Date }).lt.getTime();
    expect(cutoff).toBeLessThanOrEqual(before - 30 * 24 * 60 * 60 * 1000 + 1000);
    expect(cutoff).toBeGreaterThan(before - 31 * 24 * 60 * 60 * 1000);
  });
});

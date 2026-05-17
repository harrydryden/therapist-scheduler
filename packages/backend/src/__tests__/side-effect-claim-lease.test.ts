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

jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      updateMany: (...args: unknown[]) => updateManyMock(...args),
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

import { sideEffectTrackerService } from '../services/side-effect-tracker.service';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('tryClaimEffect — atomic CAS-claim before execute', () => {
  it('returns true when the row was in `pending` and the CAS lands', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    const claimed = await sideEffectTrackerService.tryClaimEffect('idem-pending');

    expect(claimed).toBe(true);
    // The CAS transitions to status='running' with a fresh lastAttempt.
    const call = updateManyMock.mock.calls[0][0];
    expect(call.where.idempotencyKey).toBe('idem-pending');
    expect(call.data.status).toBe('running');
    expect(call.data.lastAttempt).toBeInstanceOf(Date);
  });

  it('returns false when the CAS finds no eligible row (count === 0)', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });

    const claimed = await sideEffectTrackerService.tryClaimEffect('idem-already-running');

    expect(claimed).toBe(false);
  });

  it('CAS where-clause accepts pending, failed, or stale-lease running rows', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await sideEffectTrackerService.tryClaimEffect('idem-x');

    // Each clause in the OR is an explicit eligibility case. Inspecting
    // the call args pins the exact shape so a refactor that drops one
    // of the branches (e.g. deleting stuck-running recovery) fails this test.
    const orClauses = updateManyMock.mock.calls[0][0].where.OR as Array<Record<string, unknown>>;
    const states = orClauses.map((c) => c.status).sort();
    expect(states).toEqual(['failed', 'pending', 'running']);

    // The running branch is conditional on an expired lease.
    const runningClause = orClauses.find((c) => c.status === 'running')!;
    expect(runningClause.lastAttempt).toMatchObject({ lt: expect.any(Date) });
  });

  it('the stuck-running cutoff in the CAS where-clause matches CLAIM_LEASE_MS (10 min)', async () => {
    const before = Date.now();
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    await sideEffectTrackerService.tryClaimEffect('idem-x');
    const after = Date.now();

    const orClauses = updateManyMock.mock.calls[0][0].where.OR as Array<Record<string, unknown>>;
    const runningClause = orClauses.find((c) => c.status === 'running')!;
    const cutoff = (runningClause.lastAttempt as { lt: Date }).lt.getTime();
    // Cutoff should be ~10 min before "now"; allow generous bounds.
    expect(cutoff).toBeGreaterThan(before - 11 * 60 * 1000);
    expect(cutoff).toBeLessThan(after - 9 * 60 * 1000);
  });
});

describe('getEffectsToRetry — includes stuck-running rows', () => {
  beforeEach(() => {
    findManyMock.mockResolvedValueOnce([]);
  });

  it('OR clause includes status=running with stale lastAttempt', async () => {
    await sideEffectTrackerService.getEffectsToRetry();

    const orClauses = findManyMock.mock.calls[0][0].where.OR as Array<Record<string, unknown>>;
    const states = orClauses.map((c) => c.status).sort();
    // failed (retry), pending (stuck-pending recovery), running (stuck-
    // running recovery). Without `running`, a worker that died mid-
    // execute leaves its row in `running` forever — invisible to retry.
    expect(states).toEqual(['failed', 'pending', 'running']);

    const runningClause = orClauses.find((c) => c.status === 'running')!;
    expect(runningClause.lastAttempt).toMatchObject({ lt: expect.any(Date) });
    expect(runningClause.attempts).toMatchObject({ lt: expect.any(Number) });
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
});

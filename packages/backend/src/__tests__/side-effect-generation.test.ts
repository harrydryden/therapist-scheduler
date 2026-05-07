/**
 * Regression for the cancel → re-confirm side-effect dedup bug.
 *
 * Before this fix, `generateIdempotencyKey` hashed only
 * (appointmentId, transition, effectType). When admin cancelled then
 * re-confirmed an appointment, the second `transitionToConfirmed` would
 * call `runTrackedSideEffect('slack_notify_confirmed', …)` which found
 * the previous *completed* row from the first confirmation and
 * short-circuited at "already completed; skipping". No Slack ping, no
 * confirmation emails on the re-confirmation.
 *
 * Fix: include `transitionGeneration` in the key when provided. The
 * lifecycle service bumps `appointmentRequest.transitionGeneration` in
 * the same atomic update as the status flip and threads the new value
 * through the notifications service into the tracker.
 *
 * These tests pin the contract:
 *   1. Same (appointmentId, transition, effectType) but different
 *      generations produce different idempotency keys.
 *   2. When generation is omitted (existing call sites — appointment-
 *      creation outbox), the key shape stays backwards-compatible.
 *   3. registerSideEffects writes new rows for new generations even
 *      when older generations' rows are already 'completed'.
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
    jwtSecret: 'test-secret',
  },
}));

const findUniqueMock = jest.fn();
const createMock = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../utils/background-task', () => ({
  runBackgroundTask: jest.fn(),
}));

import { sideEffectTrackerService } from '../services/side-effect-tracker.service';

describe('side-effect-tracker — transitionGeneration in idempotency key', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
    createMock.mockImplementation(({ data }) =>
      Promise.resolve({ id: `log-${data.idempotencyKey.slice(0, 8)}`, ...data }),
    );
  });

  it('same (appointmentId, transition, effectType) with different generations yields DIFFERENT keys', async () => {
    // First confirmation, generation 1.
    const [gen1] = await sideEffectTrackerService.registerSideEffects(
      'apt-1',
      'confirmed',
      [{ effectType: 'slack_notify_confirmed' }],
      1,
    );

    // Second confirmation after cancel → re-confirm, generation 3.
    // (gen 2 was the cancellation in between.)
    const [gen3] = await sideEffectTrackerService.registerSideEffects(
      'apt-1',
      'confirmed',
      [{ effectType: 'slack_notify_confirmed' }],
      3,
    );

    expect(gen1.idempotencyKey).not.toBe(gen3.idempotencyKey);
    expect(gen1.idempotencyKey).toHaveLength(32);
    expect(gen3.idempotencyKey).toHaveLength(32);
  });

  it('omitting generation (legacy callers) keeps the original key shape', async () => {
    const [withGen] = await sideEffectTrackerService.registerSideEffects(
      'apt-2',
      'requested',
      [{ effectType: 'justintime_start' }],
      // generation explicitly omitted — same shape as before this fix
    );

    // The point of the omit-branch is that pre-existing keys (from
    // before the migration) keep working. A second call without
    // generation produces the SAME key, so dedup against the legacy
    // row still works for the appointment-creation outbox path.
    const [legacy] = await sideEffectTrackerService.registerSideEffects(
      'apt-2',
      'requested',
      [{ effectType: 'justintime_start' }],
    );

    expect(withGen.idempotencyKey).toBe(legacy.idempotencyKey);
  });

  it('with-generation key never collides with omit-generation key (no key-shape ambiguity)', async () => {
    const [withGen] = await sideEffectTrackerService.registerSideEffects(
      'apt-3',
      'confirmed',
      [{ effectType: 'slack_notify_confirmed' }],
      0,
    );

    const [withoutGen] = await sideEffectTrackerService.registerSideEffects(
      'apt-3',
      'confirmed',
      [{ effectType: 'slack_notify_confirmed' }],
    );

    // Even at generation 0, the with-generation key includes the
    // `gen0:` prefix so the input string differs from the omit case.
    // This prevents the "implicit zero" trap where existing
    // pre-migration rows (no generation) could collide with new
    // generation-0 rows.
    expect(withGen.idempotencyKey).not.toBe(withoutGen.idempotencyKey);
  });

  it('cancel → re-confirm: second confirmation with new generation does NOT dedupe against first confirmation completed row', async () => {
    // Simulate: first confirmation completed (gen 1).
    findUniqueMock.mockImplementation(({ where }) => {
      // The first confirmation's row is in the DB, status=completed,
      // with the gen-1 key.
      return Promise.resolve(null);
    });

    const [gen1Reg] = await sideEffectTrackerService.registerSideEffects(
      'apt-4',
      'confirmed',
      [{ effectType: 'slack_notify_confirmed' }],
      1,
    );
    const gen1Key = gen1Reg.idempotencyKey;

    // Now register the SECOND confirmation (after cancel and re-confirm).
    // The DB lookup for the gen-3 key returns null (no row yet) — but
    // simulate that the gen-1 key's row IS in the DB and 'completed'.
    findUniqueMock.mockImplementation(({ where }) => {
      if (where.idempotencyKey === gen1Key) {
        return Promise.resolve({
          id: 'log-1',
          status: 'completed',
          idempotencyKey: gen1Key,
        });
      }
      return Promise.resolve(null);
    });

    const [gen3Reg] = await sideEffectTrackerService.registerSideEffects(
      'apt-4',
      'confirmed',
      [{ effectType: 'slack_notify_confirmed' }],
      3,
    );

    // The crucial assertion: gen 3 produces a fresh 'pending' row, NOT
    // a 'completed' echo of the gen-1 row. Without the generation in
    // the key, this test would fail because the lookup would find the
    // gen-1 row and short-circuit to 'completed'.
    expect(gen3Reg.status).toBe('pending');
    expect(gen3Reg.idempotencyKey).not.toBe(gen1Key);
    // create was called for gen-3 (the new row is being persisted).
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('SAME generation re-register IS deduped — within a generation, idempotency still applies', async () => {
    // The ONLY way to get a duplicate registration within the same
    // generation is a process-restart between mark-complete and
    // runBackgroundTask exit (the existing idempotency case). Make sure
    // we still dedupe in that case.
    const [first] = await sideEffectTrackerService.registerSideEffects(
      'apt-5',
      'confirmed',
      [{ effectType: 'slack_notify_confirmed' }],
      2,
    );

    findUniqueMock.mockImplementation(({ where }) => {
      if (where.idempotencyKey === first.idempotencyKey) {
        return Promise.resolve({
          id: 'log-existing',
          status: 'completed',
          idempotencyKey: first.idempotencyKey,
        });
      }
      return Promise.resolve(null);
    });

    const [second] = await sideEffectTrackerService.registerSideEffects(
      'apt-5',
      'confirmed',
      [{ effectType: 'slack_notify_confirmed' }],
      2,
    );

    // Same generation → same key → dedupes against the existing
    // completed row.
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.status).toBe('completed');
  });
});

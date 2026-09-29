/**
 * Regression tests for lifecycle audit L3 — "the outbox runs an effect
 * again after it already succeeded".
 *
 * The harness used to run `execute` and `markCompleted` in ONE try/catch.
 * When `execute` had already sent the email and `markCompleted` then hit a
 * DB blip, the catch ran `markFailed` and re-threw; every transition
 * notification uses `retry: true`, so runBackgroundTask re-ran the whole
 * closure ~1s later, re-claimed the now-`failed` row and sent the email a
 * second time. Separately, when `register()` threw, the harness ran the
 * effect untracked — even though the transition had already pre-registered
 * a durable row in its own transaction, which the retry runner would then
 * send AGAIN ~10 minutes later.
 *
 * These tests drive the REAL runBackgroundTask (with its retry loop) and
 * the REAL sideEffectTrackerService against a mocked Prisma client, under
 * fake timers, so the retry/back-off sequences run to completion.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const findUniqueMock = jest.fn();
const createMock = jest.fn();
const updateMock = jest.fn();
const updateManyMock = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
      updateMany: (...args: unknown[]) => updateManyMock(...args),
    },
  },
}));

import { logger } from '../utils/logger';
import {
  runTrackedSideEffect,
  runReplayableTrackedSideEffect,
  runPeriodicTrackedSideEffect,
} from '../services/side-effect-harness';

type UpdateArgs = { where: { idempotencyKey: string }; data: Record<string, unknown> };

/**
 * Outcome writes (markCompleted / markFailed / …) are lease-checked
 * updateMany calls; the claim is also an updateMany (data.status =
 * 'running'). Claims always win; `outcomeImpl` decides outcome writes.
 */
let outcomeImpl: (args: UpdateArgs) => Promise<unknown> = async () => ({ count: 1 });

/** updateMany() calls that wrote the given status. */
function statusWrites(status: string): UpdateArgs[] {
  return updateManyMock.mock.calls
    .map((c) => c[0] as UpdateArgs)
    .filter((a) => a.data.status === status);
}

/** Execute-lease claims (tryClaimEffect). */
function claims(): UpdateArgs[] {
  return statusWrites('running');
}

/** Let setImmediate + every retry/back-off timer (inline AND deferred) run out. */
async function drainAllTimers(): Promise<void> {
  // 15 minutes of fake time covers runBackgroundTask's retry delay, the
  // inline markCompleted back-off, and the deferred reconciliation chain.
  for (let i = 0; i < 30; i++) {
    await jest.advanceTimersByTimeAsync(30_000);
  }
}

const RETRY_OPTS = { name: 'test-effect', retry: true, maxRetries: 2 } as const;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  // Row pre-registered in the transition transaction (register-in-tx).
  findUniqueMock.mockResolvedValue({ id: 'row-1', status: 'pending' });
  createMock.mockResolvedValue({ id: 'row-1', status: 'pending' });
  // tryClaimEffect CAS always wins; outcome writes succeed unless a test
  // overrides outcomeImpl.
  outcomeImpl = async () => ({ count: 1 });
  updateManyMock.mockImplementation(async (args: UpdateArgs) =>
    args.data.status === 'running' ? { count: 1 } : outcomeImpl(args),
  );
  updateMock.mockResolvedValue({});
});

afterEach(() => {
  jest.useRealTimers();
});

describe('L3 — execute succeeded, markCompleted failed', () => {
  it('runTrackedSideEffect: executes exactly once, never marks failed, never re-throws into a retry', async () => {
    // markCompleted keeps failing (DB blip that outlasts every retry);
    // every other update (none expected) succeeds.
    outcomeImpl = async (args: UpdateArgs) => {
      if (args.data.status === 'completed') throw new Error('pool timeout');
      return { count: 1 };
    };
    const execute = jest.fn().mockResolvedValue(undefined);

    runTrackedSideEffect('apt-1', 'cancelled', 'slack_notify_cancelled', execute, RETRY_OPTS, 3);
    await drainAllTimers();

    expect(execute).toHaveBeenCalledTimes(1);
    // The row was never flipped to failed — that is what let the retry re-claim it.
    expect(statusWrites('failed')).toHaveLength(0);
    // markCompleted was retried (inline + deferred), not given up on after one try.
    expect(statusWrites('completed').length).toBeGreaterThan(1);
    // Registration ran once: runBackgroundTask did not re-run the closure.
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(claims()).toHaveLength(1);
    // Logged at error level WITH the effect key so the row can be reconciled.
    const errorCalls = (logger.error as jest.Mock).mock.calls;
    expect(errorCalls.some(([ctx]) => typeof ctx?.idempotencyKey === 'string')).toBe(true);
    // runBackgroundTask never saw a failure (no "Background task ... failed" log).
    expect(errorCalls.some(([, msg]) => typeof msg === 'string' && msg.startsWith("Background task 'test-effect' failed"))).toBe(false);
  });

  it('runReplayableTrackedSideEffect: the email is sent exactly once when markCompleted throws', async () => {
    outcomeImpl = async (args: UpdateArgs) => {
      if (args.data.status === 'completed') throw new Error('connection reset');
      return { count: 1 };
    };
    const send = jest.fn().mockResolvedValue(undefined);

    runReplayableTrackedSideEffect(
      'apt-1',
      'confirmed',
      'email_client_confirmation',
      {
        renderPayload: async () => ({ to: 'a@example.com', subject: 'S', body: 'B' }),
        execute: send,
      },
      RETRY_OPTS,
      4,
    );
    await drainAllTimers();

    expect(send).toHaveBeenCalledTimes(1);
    expect(statusWrites('failed')).toHaveLength(0);
  });

  it('a transient markCompleted failure is retried inline and the row ends up completed', async () => {
    let completedAttempts = 0;
    outcomeImpl = async (args: UpdateArgs) => {
      if (args.data.status === 'completed' && ++completedAttempts === 1) {
        throw new Error('pool timeout');
      }
      return { count: 1 };
    };
    const execute = jest.fn().mockResolvedValue(undefined);

    runTrackedSideEffect('apt-1', 'confirmed', 'slack_notify_confirmed', execute, RETRY_OPTS, 2);
    await drainAllTimers();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(statusWrites('completed')).toHaveLength(2);
    expect(statusWrites('failed')).toHaveLength(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('periodic wrapper: same guarantee — one execute, no markFailed', async () => {
    outcomeImpl = async (args: UpdateArgs) => {
      if (args.data.status === 'completed') throw new Error('pool timeout');
      return { count: 1 };
    };
    const execute = jest.fn().mockResolvedValue(undefined);

    runPeriodicTrackedSideEffect(
      { kind: 'appointment', appointmentId: 'apt-1' },
      'email_chase_user',
      { renderPayload: async () => ({ to: 'u@x', subject: 's', body: 'b' }), execute },
      RETRY_OPTS,
    );
    await drainAllTimers();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(statusWrites('failed')).toHaveLength(0);
  });

  it('an execute failure still marks the row failed and lets runBackgroundTask retry (unchanged)', async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('Slack 503'))
      .mockResolvedValueOnce(undefined);

    runTrackedSideEffect('apt-1', 'cancelled', 'slack_notify_cancelled', execute, RETRY_OPTS, 3);
    await drainAllTimers();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(statusWrites('failed')).toHaveLength(1);
    expect(statusWrites('completed')).toHaveLength(1);
  });
});

describe('L3 — registration failure for pre-registered (status-transition) effects', () => {
  it('runTrackedSideEffect: never runs the effect untracked when registration keeps failing', async () => {
    findUniqueMock.mockRejectedValue(new Error('DB unavailable'));
    const execute = jest.fn().mockResolvedValue(undefined);

    runTrackedSideEffect('apt-1', 'cancelled', 'slack_notify_cancelled', execute, RETRY_OPTS, 3);
    await drainAllTimers();

    // The in-tx row is left pending for the retry runner; running it here
    // untracked would make the retry runner send it a second time.
    expect(execute).not.toHaveBeenCalled();
    // Registration was re-attempted by runBackgroundTask's in-process retry.
    expect(findUniqueMock).toHaveBeenCalledTimes(2);
  });

  it('runReplayableTrackedSideEffect: never sends untracked when registration keeps failing', async () => {
    findUniqueMock.mockRejectedValue(new Error('DB unavailable'));
    const send = jest.fn().mockResolvedValue(undefined);

    runReplayableTrackedSideEffect(
      'apt-1',
      'cancelled',
      'email_client_cancellation',
      {
        renderPayload: async () => ({ to: 'a@example.com', subject: 'S', body: 'B' }),
        execute: send,
      },
      RETRY_OPTS,
      3,
    );
    await drainAllTimers();

    expect(send).not.toHaveBeenCalled();
  });

  it('a transient registration failure is recovered by the in-process retry and executes once, tracked', async () => {
    findUniqueMock
      .mockRejectedValueOnce(new Error('DB blip'))
      .mockResolvedValue({ id: 'row-1', status: 'pending' });
    const execute = jest.fn().mockResolvedValue(undefined);

    runTrackedSideEffect('apt-1', 'confirmed', 'slack_notify_confirmed', execute, RETRY_OPTS, 2);
    await drainAllTimers();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(claims()).toHaveLength(1); // claimed the pre-registered row
    expect(statusWrites('completed')).toHaveLength(1);
  });

  it('periodic wrapper keeps its degrade-to-untracked fallback (no row exists anywhere else)', async () => {
    findUniqueMock.mockRejectedValue(new Error('DB unavailable'));
    const execute = jest.fn().mockResolvedValue(undefined);

    runPeriodicTrackedSideEffect(
      { kind: 'appointment', appointmentId: 'apt-1' },
      'email_chase_user',
      { renderPayload: async () => ({ to: 'u@x', subject: 's', body: 'b' }), execute },
      RETRY_OPTS,
    );
    await drainAllTimers();

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('outcome writes carry the execute lease (review §4.4)', () => {
  it('markFailed / markCompleted are scoped to the lease this worker claimed', async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('Slack 503'))
      .mockResolvedValueOnce(undefined);

    runTrackedSideEffect('apt-1', 'cancelled', 'slack_notify_cancelled', execute, RETRY_OPTS, 3);
    await drainAllTimers();

    const [firstClaim, secondClaim] = claims();
    const [failed] = statusWrites('failed');
    const [completed] = statusWrites('completed');
    // Each outcome write matches only the row state its own claim left.
    expect(failed.where).toEqual({
      idempotencyKey: firstClaim.where.idempotencyKey,
      status: 'running',
      lastAttempt: firstClaim.data.lastAttempt,
    });
    expect(completed.where).toEqual({
      idempotencyKey: secondClaim.where.idempotencyKey,
      status: 'running',
      lastAttempt: secondClaim.data.lastAttempt,
    });
  });

  it('a lost lease is not retried as if it were a DB blip', async () => {
    // Another worker re-claimed the row while we executed: our completion
    // write matches nothing. It must not be retried (inline or deferred) —
    // the new owner records its own outcome.
    outcomeImpl = async () => ({ count: 0 });
    const execute = jest.fn().mockResolvedValue(undefined);

    runTrackedSideEffect('apt-1', 'confirmed', 'slack_notify_confirmed', execute, RETRY_OPTS, 2);
    await drainAllTimers();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(statusWrites('completed')).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('terminal rows are not executed', () => {
  it('a superseded row is skipped without claiming it', async () => {
    findUniqueMock.mockResolvedValue({ id: 'row-1', status: 'superseded' });
    const execute = jest.fn().mockResolvedValue(undefined);

    runTrackedSideEffect('apt-1', 'confirmed', 'slack_notify_confirmed', execute, RETRY_OPTS, 2);
    await drainAllTimers();

    expect(execute).not.toHaveBeenCalled();
    expect(claims()).toHaveLength(0);
  });

  it('periodic: an already-completed row calls onAlreadyCompleted (sentinel reconcile) instead of executing', async () => {
    findUniqueMock.mockResolvedValue({ id: 'row-1', status: 'completed' });
    const execute = jest.fn().mockResolvedValue(undefined);
    const onAlreadyCompleted = jest.fn().mockResolvedValue(undefined);

    runPeriodicTrackedSideEffect(
      { kind: 'appointment', appointmentId: 'apt-1' },
      'email_chase_user',
      { renderPayload: async () => ({ to: 'u@x', subject: 's', body: 'b' }), execute, onAlreadyCompleted },
      RETRY_OPTS,
      1234,
    );
    await drainAllTimers();

    expect(execute).not.toHaveBeenCalled();
    expect(onAlreadyCompleted).toHaveBeenCalledTimes(1);
    expect(claims()).toHaveLength(0);
  });
});

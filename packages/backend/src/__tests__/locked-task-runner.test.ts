/**
 * Regression test for the LockedTaskRunner timeout-zombie bug.
 *
 * `Promise.race` doesn't cancel its loser: when a task exceeds
 * `maxExecutionMs`, the timeout branch "wins" the race and the runner
 * returns/logs — but the original task keeps running in the background.
 * Previously the `finally` block released the lock unconditionally, so a
 * new claimant (the next scheduled tick, or another process) could
 * acquire the lock and start work concurrently with that zombie task.
 * The fix: on timeout, leave the lock in place — renewal has already
 * stopped, so the lock's TTL fences the zombie and expires on its own
 * instead of being handed to a new owner immediately.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const acquireLockMock = jest.fn();
const releaseLockMock = jest.fn();
const renewLockMock = jest.fn();
jest.mock('../utils/redis-locks', () => ({
  acquireLock: (...a: unknown[]) => acquireLockMock(...a),
  releaseLock: (...a: unknown[]) => releaseLockMock(...a),
  renewLock: (...a: unknown[]) => renewLockMock(...a),
}));

import { LockedTaskRunner } from '../utils/locked-task-runner';

describe('LockedTaskRunner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    acquireLockMock.mockResolvedValue(true);
    renewLockMock.mockResolvedValue(true);
    releaseLockMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('releases the lock on successful completion', async () => {
    const runner = new LockedTaskRunner({
      lockKey: 'lock:test',
      lockTtlSeconds: 60,
      renewalIntervalMs: 20_000,
      instanceId: 'inst-1',
      maxExecutionMs: 5_000,
    });

    const result = await runner.run(async () => 'done');

    expect(result).toEqual({ acquired: true, result: 'done' });
    expect(releaseLockMock).toHaveBeenCalledWith('lock:test', 'inst-1', expect.any(String));
  });

  it('releases the lock when the task throws a normal error', async () => {
    const runner = new LockedTaskRunner({
      lockKey: 'lock:test',
      lockTtlSeconds: 60,
      renewalIntervalMs: 20_000,
      instanceId: 'inst-1',
      maxExecutionMs: 5_000,
    });

    const result = await runner.run(async () => {
      throw new Error('task failed');
    });

    expect(result.acquired).toBe(true);
    expect(result.error?.message).toBe('task failed');
    expect(releaseLockMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT release the lock when the task times out — the zombie must not race a new claimant', async () => {
    const runner = new LockedTaskRunner({
      lockKey: 'lock:test',
      lockTtlSeconds: 60,
      renewalIntervalMs: 20_000,
      instanceId: 'inst-1',
      maxExecutionMs: 5_000,
    });

    // A task that never resolves within the test — simulates a deadlocked
    // / runaway task. The timeout branch wins the race.
    const runPromise = runner.run(() => new Promise(() => {}));

    await jest.advanceTimersByTimeAsync(5_000);
    const result = await runPromise;

    expect(result.acquired).toBe(true);
    expect(result.error?.message).toMatch(/exceeded max execution time/i);
    // THE FIX: no release call — releasing here would let a new claimant
    // start concurrently with the still-running zombie task.
    expect(releaseLockMock).not.toHaveBeenCalled();
  });

  it('does not acquire or run the task when the lock is already held', async () => {
    acquireLockMock.mockResolvedValue(false);
    const runner = new LockedTaskRunner({
      lockKey: 'lock:test',
      lockTtlSeconds: 60,
      renewalIntervalMs: 20_000,
      instanceId: 'inst-1',
    });
    const task = jest.fn();

    const result = await runner.run(task);

    expect(result).toEqual({ acquired: false });
    expect(task).not.toHaveBeenCalled();
    expect(releaseLockMock).not.toHaveBeenCalled();
  });
});

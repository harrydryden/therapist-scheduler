/**
 * Regression tests for the trigger-threading extension to
 * LockedPeriodicService (Stage D follow-up — see
 * docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md's deferred missed-message-scanner
 * / PendingEmailService migration item).
 *
 * `tick(ctx, trigger)` and the new `onLockNotAcquired(trigger)` hook let a
 * subclass distinguish the delayed first run ('startup') from a regular
 * scheduled run ('scheduled') and an explicit `.trigger()` call ('manual')
 * — needed for missed-message-scanner's trigger-reason logging and
 * consecutive-skip health tracking, which a mechanical LockedPeriodicService
 * swap couldn't previously support.
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

import { LockedPeriodicService } from '../utils/locked-periodic-service';
import type { LockedTaskContext } from '../utils/locked-task-runner';

type Trigger = 'startup' | 'scheduled' | 'manual';

class TestService extends LockedPeriodicService<string> {
  tickCalls: Trigger[] = [];
  lockNotAcquiredCalls: Trigger[] = [];
  errorCalls: Array<{ message: string; trigger: Trigger }> = [];
  tickImpl: (ctx: LockedTaskContext, trigger: Trigger) => Promise<string> = async (_ctx, trigger) => `ok:${trigger}`;

  constructor() {
    super({
      name: 'test-service',
      intervalMs: 60_000,
      lockKey: 'lock:test-service',
      lockTtlSeconds: 60,
      renewalIntervalMs: 20_000,
    });
  }

  protected async tick(ctx: LockedTaskContext, trigger: Trigger): Promise<string> {
    this.tickCalls.push(trigger);
    return this.tickImpl(ctx, trigger);
  }

  protected onLockNotAcquired(trigger: Trigger): void {
    this.lockNotAcquiredCalls.push(trigger);
  }

  protected onError(err: Error, trigger: Trigger): void {
    this.errorCalls.push({ message: err.message, trigger });
  }
}

describe('LockedPeriodicService — trigger threading', () => {
  let service: TestService;

  beforeEach(() => {
    jest.clearAllMocks();
    acquireLockMock.mockResolvedValue(true);
    renewLockMock.mockResolvedValue(true);
    releaseLockMock.mockResolvedValue(undefined);
    service = new TestService();
  });

  it("passes 'manual' to tick() when triggered explicitly", async () => {
    const result = await service.trigger();

    expect(service.tickCalls).toEqual(['manual']);
    expect(result).toEqual({ acquired: true, result: 'ok:manual' });
  });

  it("calls onLockNotAcquired with 'manual' when the lock is held elsewhere", async () => {
    acquireLockMock.mockResolvedValue(false);

    const result = await service.trigger();

    expect(service.tickCalls).toEqual([]);
    expect(service.lockNotAcquiredCalls).toEqual(['manual']);
    expect(result).toEqual({ acquired: false });
  });

  it('calls onError with the trigger when tick throws', async () => {
    service.tickImpl = async () => {
      throw new Error('boom');
    };

    const result = await service.trigger();

    expect(service.errorCalls).toEqual([{ message: 'boom', trigger: 'manual' }]);
    expect(result.error?.message).toBe('boom');
  });

  it('does NOT call onError when the lock was not acquired (no tick ran)', async () => {
    acquireLockMock.mockResolvedValue(false);

    await service.trigger();

    expect(service.errorCalls).toEqual([]);
  });

  it("runCheck (the scheduled path) passes 'scheduled' through to tick", async () => {
    // runCheck is protected — cast to invoke it the way PeriodicService's
    // internal scheduler does, without re-testing setInterval/setTimeout
    // wiring (that's PeriodicService's own concern, unchanged here).
    await (service as unknown as { runCheck(trigger: 'startup' | 'scheduled'): Promise<void> }).runCheck('scheduled');

    expect(service.tickCalls).toEqual(['scheduled']);
  });

  it("runCheck passes 'startup' through to tick", async () => {
    await (service as unknown as { runCheck(trigger: 'startup' | 'scheduled'): Promise<void> }).runCheck('startup');

    expect(service.tickCalls).toEqual(['startup']);
  });

  it('getStatus and lastResult are unaffected by the trigger extension', async () => {
    await service.trigger();

    const status = service.getStatus();
    expect(status.lastResult).toEqual({ acquired: true, result: 'ok:manual' });
    expect(status.lastRunAt).toBeInstanceOf(Date);
  });
});

/**
 * Periodic services: jittered first run and a stop() that drains
 * (review §4.7).
 *
 *   - Services that set no startupDelayMs (stale-check, post-booking,
 *     weekly-mailing, Slack summary, work report) all fired at t=0 of every
 *     restart, alongside WAL recovery and the Pub/Sub backlog.
 *   - stop() only cleared timers, so shutdown closed Redis and Prisma
 *     underneath a tick that was still running.
 *   - LockedTaskRunner never cleared its race timer: one pending timer per
 *     tick, for up to 10× the lock TTL.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

const acquireLockMock = jest.fn();
jest.mock('../utils/redis-locks', () => ({
  acquireLock: (...a: unknown[]) => acquireLockMock(...a),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  renewLock: jest.fn().mockResolvedValue(true),
}));

import {
  PeriodicService,
  DEFAULT_STARTUP_DELAY_MIN_MS,
  DEFAULT_STARTUP_DELAY_JITTER_MS,
} from '../utils/periodic-service';
import { LockedPeriodicService } from '../utils/locked-periodic-service';
import { LockedTaskRunner, type LockedTaskContext } from '../utils/locked-task-runner';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

class PlainService extends PeriodicService {
  runs = 0;
  gate: Promise<void> | null = null;
  constructor(startupDelayMs?: number) {
    // Longer than any default startup delay, like every real service
    // (15 min – 1 h), so the first run is the startup one.
    super({ name: 'plain', intervalMs: 10 * 60_000, startupDelayMs });
  }
  protected async runCheck(): Promise<void> {
    this.runs++;
    if (this.gate) await this.gate;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  acquireLockMock.mockResolvedValue(true);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('PeriodicService startup delay', () => {
  it('defaults to a jittered delay instead of running at t=0', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const svc = new PlainService();

    svc.start();
    await flush();
    expect(svc.runs).toBe(0);

    const expected = DEFAULT_STARTUP_DELAY_MIN_MS + Math.floor(0.5 * DEFAULT_STARTUP_DELAY_JITTER_MS);
    jest.advanceTimersByTime(expected - 1);
    await flush();
    expect(svc.runs).toBe(0);

    jest.advanceTimersByTime(1);
    await flush();
    expect(svc.runs).toBe(1);
    await svc.stop();
  });

  it('spreads services across the jitter window', () => {
    jest.useFakeTimers();
    const random = jest.spyOn(Math, 'random');
    random.mockReturnValueOnce(0).mockReturnValueOnce(0.99);
    const a = new PlainService();
    const b = new PlainService();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    a.start();
    b.start();

    const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
    expect(delays[0]).toBe(DEFAULT_STARTUP_DELAY_MIN_MS);
    expect(delays[1]).toBeGreaterThan(DEFAULT_STARTUP_DELAY_MIN_MS + 0.9 * DEFAULT_STARTUP_DELAY_JITTER_MS);
    void a.stop();
    void b.stop();
  });

  it('still runs immediately when startupDelayMs is 0', async () => {
    const svc = new PlainService(0);
    svc.start();
    await flush();
    expect(svc.runs).toBe(1);
    await svc.stop();
  });
});

describe('PeriodicService.stop()', () => {
  it('resolves only after the in-flight run finishes', async () => {
    const svc = new PlainService(0);
    const gate = deferred();
    svc.gate = gate.promise;
    svc.start();
    await flush();
    expect(svc.runs).toBe(1);

    let stopped = false;
    const stopping = svc.stop();
    void Promise.resolve(stopping).then(() => { stopped = true; });
    await flush();
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('resolves immediately when nothing is running', async () => {
    const svc = new PlainService(0);
    await expect(svc.stop()).resolves.toBeUndefined();
  });
});

class LockedService extends LockedPeriodicService<string> {
  tickImpl: (ctx: LockedTaskContext) => Promise<string> = async () => 'done';
  constructor() {
    super({
      name: 'locked', intervalMs: 60_000, startupDelayMs: 0,
      lockKey: 'lock:test', lockTtlSeconds: 60, renewalIntervalMs: 30_000,
    });
  }
  protected tick(ctx: LockedTaskContext): Promise<string> {
    return this.tickImpl(ctx);
  }
}

describe('LockedPeriodicService.stop()', () => {
  it('tells a running tick to wind down via isLockValid() and waits for it', async () => {
    const svc = new LockedService();
    const processed: number[] = [];
    const step = deferred();
    svc.tickImpl = async (ctx) => {
      for (let i = 0; i < 100; i++) {
        if (!ctx.isLockValid()) break;
        processed.push(i);
        if (i === 0) await step.promise;
      }
      return 'stopped early';
    };

    svc.start();
    await flush();
    const stopping = svc.stop();
    step.resolve();
    await stopping;

    expect(processed).toEqual([0]);
    expect(svc.getStatus().lastResult).toEqual({ acquired: true, result: 'stopped early' });
  });

  it('also waits for a manual trigger() that is in flight', async () => {
    const svc = new LockedService();
    const gate = deferred();
    let finished = false;
    svc.tickImpl = async () => { await gate.promise; finished = true; return 'manual'; };

    const run = svc.trigger();
    await flush();
    let stopped = false;
    const stopping = svc.stop();
    void Promise.resolve(stopping).then(() => { stopped = true; });
    await flush();
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(finished).toBe(true);
    await expect(run).resolves.toEqual({ acquired: true, result: 'manual' });
  });
});

describe('LockedTaskRunner', () => {
  it('clears its max-execution timer when the task finishes in time', async () => {
    jest.useFakeTimers();
    const runner = new LockedTaskRunner({
      lockKey: 'lock:x', lockTtlSeconds: 60, renewalIntervalMs: 30_000, instanceId: 'i',
    });

    await runner.run(async () => 'ok');

    expect(jest.getTimerCount()).toBe(0);
  });
});

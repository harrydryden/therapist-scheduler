/**
 * Redis connection errors are logged at most once per interval (review
 * §4.7). ioredis emits 'error' on every failed reconnect (~every 2s), so an
 * outage produced a continuous stream of error-level lines.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../config', () => ({ config: { env: 'test', redisUrl: 'redis://unused' } }));

import { createRateLimitedErrorLogger } from '../utils/redis-client';

describe('createRateLimitedErrorLogger', () => {
  let now = 0;
  const log = jest.fn();
  const clock = () => now;

  beforeEach(() => {
    now = 0;
    log.mockClear();
  });

  it('logs the first error, then suppresses repeats within the interval', () => {
    const limiter = createRateLimitedErrorLogger(log, 60_000, clock);
    for (let i = 0; i < 30; i++) {
      limiter.onError(new Error('ECONNREFUSED'));
      now += 2_000; // one reconnect attempt every 2s
    }
    // 30 errors over 60s → first at t=0, next due at t=60s (not reached).
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({ suppressedSinceLastLog: 0 });
  });

  it('logs again after the interval with the number suppressed', () => {
    const limiter = createRateLimitedErrorLogger(log, 60_000, clock);
    limiter.onError(new Error('a'));
    for (let i = 0; i < 5; i++) { now += 1_000; limiter.onError(new Error('b')); }
    now = 60_000;
    limiter.onError(new Error('c'), { backpressure: 'severe' });

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toMatchObject({ suppressedSinceLastLog: 5, backpressure: 'severe' });
  });

  it('logs the next error immediately after a reconnect resets it', () => {
    const limiter = createRateLimitedErrorLogger(log, 60_000, clock);
    limiter.onError(new Error('a'));
    now += 5_000;
    limiter.reset();
    limiter.onError(new Error('b'));

    expect(log).toHaveBeenCalledTimes(2);
  });
});

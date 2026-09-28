/**
 * Circuit breaker state-change alerts (review #2 / #9).
 *
 * Breaker transitions used to be logged only. Now the start of an outage
 * (CLOSED → OPEN) raises a high-severity alert and recovery (→ CLOSED) an
 * info alert, both with a per-breaker dedupGroup; re-trips while the
 * outage continues (HALF_OPEN → OPEN) stay quiet, and a breaker created
 * with alertOnStateChange: false (the Slack webhook's) only logs.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

import {
  CircuitBreaker,
  CircuitState,
  setCircuitBreakerAlertSink,
  type CircuitBreakerAlert,
} from '../utils/circuit-breaker';

let now = 5_000_000;
const sink = jest.fn();
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  now = 5_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  setCircuitBreakerAlertSink(sink);
});
afterEach(() => {
  setCircuitBreakerAlertSink(null);
  jest.restoreAllMocks();
});

function breaker(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  return new CircuitBreaker({
    name: 'gmail-api',
    failureThreshold: 2,
    successThreshold: 1,
    resetTimeout: 1000,
    failureWindow: 60_000,
    ...overrides,
  });
}

const fail = (cb: CircuitBreaker) => cb.execute(() => Promise.reject(new Error('x'))).catch(() => undefined);
const succeed = (cb: CircuitBreaker) => cb.execute(async () => 'ok');
const alerts = () => sink.mock.calls.map((c) => c[0] as CircuitBreakerAlert);

describe('circuit breaker alerts', () => {
  it('alerts once when the breaker opens, with a per-breaker dedupGroup', async () => {
    const cb = breaker();
    await fail(cb);
    await fail(cb);
    await flush();

    expect(cb.getStats().state).toBe(CircuitState.OPEN);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({
      title: 'Circuit Breaker Opened',
      severity: 'high',
      dedupGroup: 'circuit-breaker:gmail-api',
    });
    expect(alerts()[0].details).toContain('gmail-api');
  });

  it('stays quiet when a HALF_OPEN probe re-trips the breaker during the same outage', async () => {
    const cb = breaker();
    await fail(cb);
    await fail(cb);
    now += 1001;
    await fail(cb); // probe fails → OPEN again
    await flush();

    expect(cb.getStats().state).toBe(CircuitState.OPEN);
    expect(alerts().map((a) => a.title)).toEqual(['Circuit Breaker Opened']);
  });

  it('sends an info alert when the breaker recovers', async () => {
    const cb = breaker();
    await fail(cb);
    await fail(cb);
    now += 1001;
    await succeed(cb);
    await flush();

    expect(cb.getStats().state).toBe(CircuitState.CLOSED);
    expect(alerts().map((a) => [a.title, a.severity])).toEqual([
      ['Circuit Breaker Opened', 'high'],
      ['Circuit Breaker Recovered', 'low'],
    ]);
    expect(alerts()[1].dedupGroup).toBe('circuit-breaker:gmail-api');
  });

  it('does not report a recovery for a reset of a breaker that never opened', async () => {
    const cb = breaker();
    cb.reset();
    await flush();

    expect(sink).not.toHaveBeenCalled();
  });

  it('only logs for a breaker created with alertOnStateChange: false', async () => {
    const cb = breaker({ name: 'slack-webhook', alertOnStateChange: false });
    await fail(cb);
    await fail(cb);
    now += 1001;
    await succeed(cb);
    await flush();

    expect(sink).not.toHaveBeenCalled();
  });

  it('never lets a failing alert sink break the protected call', async () => {
    sink.mockRejectedValue(new Error('slack down'));
    const cb = breaker();
    await fail(cb);
    await expect(cb.execute(() => Promise.reject(new Error('real error')))).rejects.toThrow('real error');
    await flush();

    expect(sink).toHaveBeenCalledTimes(1);
  });
});

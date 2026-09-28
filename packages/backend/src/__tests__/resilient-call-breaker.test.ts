/**
 * resilientCall runs each attempt through the circuit breaker (review #2).
 *
 * It used to wrap the whole retry/sleep loop in one `execute()`. HALF_OPEN
 * admits a single probe, so a probe that hit a 429 held the probe slot for
 * the entire rate-limit back-off (up to ~111 minutes) and every other
 * Claude call was rejected meanwhile.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

// Controllable sleep: each call parks until the test releases it.
const sleepResolvers: Array<() => void> = [];
jest.mock('../utils/timeout', () => ({
  sleep: jest.fn(() => new Promise<void>((resolve) => sleepResolvers.push(resolve))),
}));

jest.mock('../utils/anthropic-client', () => {
  class RateLimitError extends Error {}
  class TransientError extends Error {}
  return {
    RateLimitError,
    TransientError,
    isTransientError: (e: unknown) => e instanceof TransientError,
    addJitter: (ms: number) => ms,
  };
});

import { resilientCall } from '../utils/resilient-call';
import { CircuitBreaker, CircuitBreakerError, CircuitState } from '../utils/circuit-breaker';
import { sleep } from '../utils/timeout';
import * as anthropicClient from '../utils/anthropic-client';

// The mocked module's classes (see the factory above) take one argument.
type ErrorCtor = new (message: string) => Error;
const mocked = anthropicClient as unknown as { RateLimitError: ErrorCtor; TransientError: ErrorCtor };
const FakeRateLimitError = mocked.RateLimitError;
const FakeTransientError = mocked.TransientError;

let now = 1_000_000;
beforeEach(() => {
  jest.clearAllMocks();
  sleepResolvers.length = 0;
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  jest.restoreAllMocks();
});

const flush = () => new Promise((r) => setImmediate(r));

function breaker(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  return new CircuitBreaker({
    name: 'claude-test',
    failureThreshold: 3,
    successThreshold: 1,
    resetTimeout: 1000,
    failureWindow: 60_000,
    alertOnStateChange: false,
    ...overrides,
  });
}

describe('resilientCall + circuit breaker', () => {
  it('passes every attempt through the breaker', async () => {
    const cb = breaker();
    const op = jest.fn()
      .mockRejectedValueOnce(new FakeTransientError('502'))
      .mockRejectedValueOnce(new FakeTransientError('503'))
      .mockResolvedValueOnce('ok');

    const call = resilientCall(op, { context: 't', traceId: 't', circuitBreaker: cb });
    await flush(); sleepResolvers.shift()!();
    await flush(); sleepResolvers.shift()!();

    await expect(call).resolves.toBe('ok');
    expect(cb.getStats().totalRequests).toBe(3);
  });

  it('does not hold the HALF_OPEN probe slot through a rate-limit back-off', async () => {
    const cb = breaker({ failureThreshold: 1 });
    await expect(cb.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cb.getStats().state).toBe(CircuitState.OPEN);

    now += 1001; // reset timeout passed: the next call is the HALF_OPEN probe
    const op = jest.fn()
      .mockRejectedValueOnce(new FakeRateLimitError('429'))
      .mockResolvedValueOnce('ok');
    const call = resilientCall(op, { context: 't', traceId: 't', circuitBreaker: cb });
    await flush();
    expect(sleep).toHaveBeenCalledTimes(1); // parked in the 429 back-off

    // While that call sleeps, another caller must be able to probe once the
    // reset timeout passes again — instead of being rejected until the
    // first caller's whole back-off finishes.
    now += 1001;
    await expect(cb.execute(async () => 'other')).resolves.toBe('other');

    sleepResolvers.shift()!();
    await expect(call).resolves.toBe('ok');
  });

  it('fails fast on an open breaker instead of retrying', async () => {
    const cb = breaker({ failureThreshold: 1 });
    await expect(cb.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow();

    const op = jest.fn().mockResolvedValue('never');
    await expect(
      resilientCall(op, { context: 't', traceId: 't', circuitBreaker: cb }),
    ).rejects.toBeInstanceOf(CircuitBreakerError);
    expect(op).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('still retries without a breaker', async () => {
    const op = jest.fn()
      .mockRejectedValueOnce(new FakeTransientError('502'))
      .mockResolvedValueOnce('ok');

    const call = resilientCall(op, { context: 't', traceId: 't' });
    await flush(); sleepResolvers.shift()!();

    await expect(call).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });
});

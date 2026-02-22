/**
 * Tests for circuit breaker implementation
 * Covers: state transitions, HALF_OPEN probe limiting, failure thresholds
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { CircuitBreaker, CircuitState } from '../utils/circuit-breaker';

function createBreaker(overrides = {}) {
  return new CircuitBreaker({
    name: 'test',
    failureThreshold: 3,
    successThreshold: 2,
    resetTimeout: 100, // 100ms for fast tests
    ...overrides,
  });
}

describe('CircuitBreaker', () => {
  describe('CLOSED state', () => {
    it('starts in CLOSED state', () => {
      const cb = createBreaker();
      expect(cb.getStats().state).toBe('CLOSED');
    });

    it('executes functions normally when CLOSED', async () => {
      const cb = createBreaker();
      const result = await cb.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });

    it('transitions to OPEN after reaching failure threshold', async () => {
      const cb = createBreaker({ failureThreshold: 2 });

      // Cause 2 failures
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      expect(cb.getStats().state).toBe('OPEN');
    });
  });

  describe('OPEN state', () => {
    it('rejects requests immediately when OPEN', async () => {
      const cb = createBreaker({ failureThreshold: 1 });

      // Trip the breaker
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(cb.getStats().state).toBe('OPEN');

      // Next request should be rejected fast
      await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(/OPEN/);
    });

    it('transitions to HALF_OPEN after reset timeout', async () => {
      const cb = createBreaker({ failureThreshold: 1, resetTimeout: 50 });

      // Trip the breaker
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(cb.getStats().state).toBe('OPEN');

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 60));

      // Next request should be allowed (HALF_OPEN)
      const result = await cb.execute(() => Promise.resolve('recovered'));
      expect(result).toBe('recovered');
    });
  });

  describe('HALF_OPEN state - probe limiting', () => {
    it('only allows one concurrent probe in HALF_OPEN', async () => {
      const cb = createBreaker({ failureThreshold: 1, resetTimeout: 50, successThreshold: 2 });

      // Trip the breaker
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 60));

      // Start a slow probe
      let resolveProbe: () => void;
      const probePromise = cb.execute(
        () => new Promise<string>((resolve) => { resolveProbe = () => resolve('probe1'); })
      );

      // Second concurrent request should be rejected
      await expect(cb.execute(() => Promise.resolve('probe2'))).rejects.toThrow(/OPEN/);

      // Resolve the first probe
      resolveProbe!();
      await probePromise;
    });

    it('transitions to CLOSED after success threshold met', async () => {
      const cb = createBreaker({ failureThreshold: 1, resetTimeout: 50, successThreshold: 2 });

      // Trip the breaker
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 60));

      // Two successes should close the circuit
      await cb.execute(() => Promise.resolve('ok'));
      await cb.execute(() => Promise.resolve('ok'));

      expect(cb.getStats().state).toBe('CLOSED');
    });

    it('transitions back to OPEN on failure in HALF_OPEN', async () => {
      const cb = createBreaker({ failureThreshold: 1, resetTimeout: 50 });

      // Trip the breaker
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 60));

      // Fail again in HALF_OPEN
      await expect(cb.execute(() => Promise.reject(new Error('still failing')))).rejects.toThrow();

      expect(cb.getStats().state).toBe('OPEN');
    });
  });

  describe('statistics', () => {
    it('tracks total requests and failures', async () => {
      const cb = createBreaker({ failureThreshold: 10 });

      await cb.execute(() => Promise.resolve('ok'));
      await cb.execute(() => Promise.resolve('ok'));
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      const stats = cb.getStats();
      expect(stats.totalRequests).toBe(3);
      expect(stats.failures).toBe(1);
      expect(stats.successes).toBe(2);
    });
  });
});

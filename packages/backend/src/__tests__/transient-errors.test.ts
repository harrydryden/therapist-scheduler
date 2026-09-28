/**
 * isTransientInfrastructureError — the gate that decides whether a
 * processMessage failure is deferred (dependency unhealthy) or counted
 * against the message's MAX_PROCESSING_FAILURES abandon budget.
 */
jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../config', () => require('./_global-mocks').configMock());

import { isTransientInfrastructureError } from '../domain/scheduling/inbound/transient-errors';
import { CircuitBreakerError } from '../utils/circuit-breaker';
import { TimeoutError } from '../utils/timeout';
import { RateLimitError } from '../errors';

describe('isTransientInfrastructureError', () => {
  it('treats circuit-breaker rejections, timeouts and rate limits as transient', () => {
    expect(isTransientInfrastructureError(new CircuitBreakerError('open', 'claude', 'OPEN' as never))).toBe(true);
    expect(isTransientInfrastructureError(new TimeoutError('slow', 1000))).toBe(true);
    expect(isTransientInfrastructureError(new RateLimitError('429', 30))).toBe(true);
  });

  it('treats network, DB-connectivity and upstream 429/5xx errors as transient', () => {
    expect(isTransientInfrastructureError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientInfrastructureError(Object.assign(new Error('db'), { code: 'P1001' }))).toBe(true);
    expect(isTransientInfrastructureError(Object.assign(new Error('init'), { name: 'PrismaClientInitializationError' }))).toBe(true);
    expect(isTransientInfrastructureError(Object.assign(new Error('gmail'), { code: 503 }))).toBe(true);
    expect(isTransientInfrastructureError(Object.assign(new Error('gmail'), { response: { status: 429 } }))).toBe(true);
    expect(isTransientInfrastructureError(Object.assign(new Error('anthropic'), { status: 529 }))).toBe(true);
    // Anthropic SDK classes are matched by name (no SDK import needed here).
    expect(isTransientInfrastructureError(Object.assign(new Error('conn'), { name: 'APIConnectionError' }))).toBe(true);
    expect(isTransientInfrastructureError(Object.assign(new Error('429'), { name: 'RateLimitError', status: 429 }))).toBe(true);
  });

  it('does NOT treat per-message failures as transient', () => {
    expect(isTransientInfrastructureError(new Error('Unknown tool: not_a_real_tool'))).toBe(false);
    expect(isTransientInfrastructureError(Object.assign(new Error('bad'), { status: 400 }))).toBe(false);
    expect(isTransientInfrastructureError(Object.assign(new Error('unique'), { code: 'P2002' }))).toBe(false);
    expect(isTransientInfrastructureError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isTransientInfrastructureError('string error')).toBe(false);
    expect(isTransientInfrastructureError(null)).toBe(false);
  });
});

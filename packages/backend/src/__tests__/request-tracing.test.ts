/**
 * Tests for AsyncLocalStorage trace context propagation.
 * Verifies runWithTrace / getTraceContext / extendTraceContext propagate
 * across async boundaries and that extendTraceContext mutates the
 * current scope without affecting parents or siblings.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  runWithTrace,
  getTraceContext,
  extendTraceContext,
} from '../utils/request-tracing';

describe('request-tracing context propagation', () => {
  it('returns undefined outside any runWithTrace scope', () => {
    expect(getTraceContext()).toBeUndefined();
  });

  it('makes the context visible inside the runWithTrace callback', () => {
    const result = runWithTrace({ traceId: 'trace-1' }, () => getTraceContext());
    expect(result).toEqual({ traceId: 'trace-1' });
  });

  it('propagates context across awaits', async () => {
    await runWithTrace({ traceId: 'trace-2', source: 'test' }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      const ctx = getTraceContext();
      expect(ctx?.traceId).toBe('trace-2');
      expect(ctx?.source).toBe('test');
    });
  });

  it('isolates nested contexts', async () => {
    await runWithTrace({ traceId: 'outer' }, async () => {
      expect(getTraceContext()?.traceId).toBe('outer');
      await runWithTrace({ traceId: 'inner' }, async () => {
        expect(getTraceContext()?.traceId).toBe('inner');
      });
      expect(getTraceContext()?.traceId).toBe('outer');
    });
  });

  it('extendTraceContext mutates the current scope', async () => {
    await runWithTrace({ traceId: 'trace-3' }, async () => {
      expect(getTraceContext()?.appointmentId).toBeUndefined();
      extendTraceContext({ appointmentId: 'apt-42' });
      expect(getTraceContext()?.appointmentId).toBe('apt-42');
      expect(getTraceContext()?.traceId).toBe('trace-3');
    });
  });

  it('extendTraceContext is a no-op outside any scope', () => {
    extendTraceContext({ appointmentId: 'apt-99' });
    expect(getTraceContext()).toBeUndefined();
  });

  it('parallel runWithTrace scopes do not bleed into each other', async () => {
    const observed: string[] = [];
    await Promise.all([
      runWithTrace({ traceId: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        observed.push(getTraceContext()!.traceId);
      }),
      runWithTrace({ traceId: 'b' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        observed.push(getTraceContext()!.traceId);
      }),
    ]);
    expect(observed.sort()).toEqual(['a', 'b']);
  });

  it('preserves HTTP fields when set via the Fastify hook style', () => {
    const result = runWithTrace(
      {
        traceId: 'trace-http',
        requestId: 'req-1',
        method: 'POST',
        url: '/api/admin/test',
        startTime: Date.now(),
      },
      () => getTraceContext()
    );
    expect(result?.method).toBe('POST');
    expect(result?.url).toBe('/api/admin/test');
  });
});

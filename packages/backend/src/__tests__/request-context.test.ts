/**
 * Tests for the AsyncLocalStorage-based request context (Phase 7).
 * Verifies that runWithContext / getContext / extendContext propagate
 * traceId across async boundaries and that extendContext mutates the
 * current scope without affecting parent scopes.
 */

import { runWithContext, getContext, extendContext } from '../utils/request-context';

describe('request-context', () => {
  it('returns undefined outside any runWithContext scope', () => {
    expect(getContext()).toBeUndefined();
  });

  it('makes the context visible inside the runWithContext callback', () => {
    const result = runWithContext({ traceId: 'trace-1' }, () => getContext());
    expect(result).toEqual({ traceId: 'trace-1' });
  });

  it('propagates context across awaits', async () => {
    await runWithContext({ traceId: 'trace-2', source: 'test' }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      const ctx = getContext();
      expect(ctx?.traceId).toBe('trace-2');
      expect(ctx?.source).toBe('test');
    });
  });

  it('isolates nested contexts', async () => {
    await runWithContext({ traceId: 'outer' }, async () => {
      expect(getContext()?.traceId).toBe('outer');

      await runWithContext({ traceId: 'inner' }, async () => {
        expect(getContext()?.traceId).toBe('inner');
      });

      // Back in the outer scope
      expect(getContext()?.traceId).toBe('outer');
    });
  });

  it('extendContext mutates the current scope', async () => {
    await runWithContext({ traceId: 'trace-3' }, async () => {
      expect(getContext()?.appointmentId).toBeUndefined();
      extendContext({ appointmentId: 'apt-42' });
      expect(getContext()?.appointmentId).toBe('apt-42');
      expect(getContext()?.traceId).toBe('trace-3');
    });
  });

  it('extendContext is a no-op outside any scope', () => {
    extendContext({ appointmentId: 'apt-99' });
    expect(getContext()).toBeUndefined();
  });

  it('parallel runWithContext scopes do not bleed into each other', async () => {
    const observed: string[] = [];
    await Promise.all([
      runWithContext({ traceId: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        observed.push(getContext()!.traceId);
      }),
      runWithContext({ traceId: 'b' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        observed.push(getContext()!.traceId);
      }),
    ]);
    expect(observed.sort()).toEqual(['a', 'b']);
  });
});

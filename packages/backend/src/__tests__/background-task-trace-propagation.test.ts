/**
 * Tests for trace-context propagation through `runBackgroundTask`.
 *
 * The fire-and-forget helper used to schedule deferred work via
 * `setImmediate` without re-entering the scheduling scope's
 * AsyncLocalStorage trace. The pino logger mixin reads traceId/
 * appointmentId/source from that store on every log call, so background
 * tasks emitted log lines with no trace data — admins couldn't follow a
 * failure from an inbound email through the side effects it spawned.
 *
 * This file pins the new behaviour:
 *   - A task scheduled inside a runWithTrace scope inherits the parent's
 *     traceId + appointmentId + other trace fields.
 *   - `source` is overwritten to `bg:${name}` so log lines self-identify
 *     as background work rather than masquerading as their originator.
 *   - Tasks scheduled outside any scope still get a structured traceId
 *     (`bg-...`) so their logs aren't trace-less.
 *   - Sibling tasks scheduled from the same parent get independent
 *     copies — one task's `extendTraceContext` mutation must not bleed
 *     into a sibling.
 */

jest.mock('../config', () => ({
  config: { logLevel: 'silent', env: 'test' },
}));

import { runBackgroundTask } from '../utils/background-task';
import {
  runWithTrace,
  getTraceContext,
  extendTraceContext,
} from '../utils/request-tracing';

// Helper: schedule a task and resolve when it has observed its trace
// context. Returns a promise the test can await, plus the observed value.
function scheduleAndObserve<T>(
  observer: () => T,
  name = 'test-task',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runBackgroundTask(
      async () => {
        try {
          resolve(observer());
        } catch (err) {
          reject(err);
        }
      },
      { name },
    );
  });
}

describe('runBackgroundTask — trace context propagation', () => {
  it('inherits the parent traceId when scheduled inside a runWithTrace scope', async () => {
    const observed = await runWithTrace(
      { traceId: 'parent-trace', source: 'request' },
      () => scheduleAndObserve(() => getTraceContext()),
    );

    expect(observed?.traceId).toBe('parent-trace');
  });

  it('overwrites source to bg:${name} so background work self-identifies', async () => {
    const observed = await runWithTrace(
      { traceId: 'tr', source: 'inbound-message-processor' },
      () => scheduleAndObserve(() => getTraceContext(), 'slack-notify-confirmed'),
    );

    expect(observed?.source).toBe('bg:slack-notify-confirmed');
  });

  it('inherits the parent appointmentId', async () => {
    const observed = await runWithTrace(
      { traceId: 'tr', appointmentId: 'apt-42', source: 'inbound' },
      () => scheduleAndObserve(() => getTraceContext()),
    );

    expect(observed?.appointmentId).toBe('apt-42');
  });

  it('mints a fresh bg- traceId when scheduled outside any scope', async () => {
    const observed = await scheduleAndObserve(() => getTraceContext(), 'orphan-task');

    expect(observed?.traceId).toBeDefined();
    expect(observed?.traceId).toMatch(/^bg-/);
    expect(observed?.source).toBe('bg:orphan-task');
  });

  it("one task's extendTraceContext mutation does not bleed into a sibling task", async () => {
    let task1ApptId: string | undefined;
    let task2ApptId: string | undefined;

    await runWithTrace({ traceId: 'shared' }, async () => {
      await new Promise<void>((resolve) => {
        let remaining = 2;
        const done = () => { if (--remaining === 0) resolve(); };

        runBackgroundTask(
          async () => {
            extendTraceContext({ appointmentId: 'apt-from-task-1' });
            task1ApptId = getTraceContext()?.appointmentId;
            done();
          },
          { name: 'task-1' },
        );

        runBackgroundTask(
          async () => {
            // Run after task-1 has had a chance to mutate its scope.
            await new Promise((r) => setTimeout(r, 5));
            task2ApptId = getTraceContext()?.appointmentId;
            done();
          },
          { name: 'task-2' },
        );
      });
    });

    expect(task1ApptId).toBe('apt-from-task-1');
    // Critical: task-1's mutation must not have leaked into task-2's snapshot.
    expect(task2ApptId).toBeUndefined();
  });

  it("task's extendTraceContext mutation does not bleed back into the scheduling scope", async () => {
    let scopeApptIdAfter: string | undefined;

    await runWithTrace({ traceId: 'p' }, async () => {
      await new Promise<void>((resolve) => {
        runBackgroundTask(
          async () => {
            extendTraceContext({ appointmentId: 'apt-from-task' });
            resolve();
          },
          { name: 'task' },
        );
      });
      // After the task runs, the scheduling scope should not have been
      // mutated. Otherwise a parent request could pick up state from a
      // descendant background task — a tracing footgun.
      scopeApptIdAfter = getTraceContext()?.appointmentId;
    });

    expect(scopeApptIdAfter).toBeUndefined();
  });

  it('preserves trace context across the task body and any awaits within it', async () => {
    const observations: Array<string | undefined> = [];

    await runWithTrace({ traceId: 'multi-await', source: 'request' }, async () => {
      await new Promise<void>((resolve) => {
        runBackgroundTask(
          async () => {
            observations.push(getTraceContext()?.traceId);
            await new Promise((r) => setTimeout(r, 1));
            observations.push(getTraceContext()?.traceId);
            await Promise.resolve();
            observations.push(getTraceContext()?.traceId);
            resolve();
          },
          { name: 'multi-await-task' },
        );
      });
    });

    expect(observations).toEqual(['multi-await', 'multi-await', 'multi-await']);
  });
});

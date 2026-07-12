/**
 * Unit tests for `runReplayableTrackedSideEffect` (side-effect-harness.ts),
 * specifically the payload-persist step added for register-in-tx (see
 * docs/agent-harness-review/register-in-tx-design.md §9.2).
 *
 * `registerSideEffects` no-ops (returns the existing row untouched) when
 * a row with the computed idempotency key already exists — the case for
 * a row pre-registered atomically with the status commit (intent-only or
 * render-context-only). Without an explicit persist step, the DB row
 * would keep whatever smaller pre-commit payload it started with forever,
 * even after a real render + send succeeded. These tests pin that the
 * freshly-rendered payload is always written back via `updatePayload`,
 * regardless of whether the row was newly created or pre-existing.
 *
 * `runBackgroundTask` is mocked to invoke the task immediately (instead of
 * via the real `setImmediate` + timeout race) so the test can await it
 * directly.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The real runBackgroundTask fires via setImmediate and swallows the
// task's rejection internally (logs + records metrics) — the caller
// never sees it. Mirror both properties here: run the task immediately
// and catch its rejection, but keep a handle the test can await so
// assertions don't race the async chain inside runReplayableTrackedSideEffect.
let lastTaskPromise: Promise<unknown> = Promise.resolve();
jest.mock('../utils/background-task', () => ({
  runBackgroundTask: (task: () => Promise<unknown>) => {
    lastTaskPromise = task().catch(() => undefined);
  },
}));

const findUniqueMock = jest.fn();
const createMock = jest.fn();
const updateMock = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

import { runReplayableTrackedSideEffect } from '../services/side-effect-harness';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runReplayableTrackedSideEffect — payload persisted after render', () => {
  it('persists the freshly-rendered payload even when the row was pre-registered (register-in-tx) with a smaller payload', async () => {
    // Pre-existing row, as register-in-tx would leave it: registered
    // atomically with the status commit, before the original render ran.
    findUniqueMock.mockResolvedValue({
      id: 'row-1',
      status: 'pending',
      idempotencyKey: 'ignored-by-registration-logic',
    });

    const execute = jest.fn().mockResolvedValue(undefined);
    const renderedPayload = { to: 'a@example.com', subject: 'S', body: 'B' };

    runReplayableTrackedSideEffect(
      'apt-1',
      'cancelled',
      'email_client_cancellation',
      {
        renderPayload: async () => renderedPayload,
        execute,
      },
      { name: 'test-effect' },
    );
    await lastTaskPromise;

    // registerSideEffects found the existing row and did NOT create a new one.
    expect(createMock).not.toHaveBeenCalled();

    // Two update() calls: the payload-persist (this test's target) and
    // markCompleted's status write after execute succeeds. The payload
    // write uses the SAME idempotency key the findUnique lookup queried,
    // so it lands on the right row.
    expect(updateMock).toHaveBeenCalledTimes(2);
    const findUniqueKey = findUniqueMock.mock.calls[0][0].where.idempotencyKey;
    expect(updateMock).toHaveBeenCalledWith({
      where: { idempotencyKey: findUniqueKey },
      data: { payload: renderedPayload },
    });

    // execute still runs with the freshly-rendered payload (not whatever
    // was in the DB row).
    expect(execute).toHaveBeenCalledWith(renderedPayload);
  });

  it('persists the payload for a freshly-created row too (harmless redundant write)', async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: 'row-2', status: 'pending' });

    const execute = jest.fn().mockResolvedValue(undefined);
    const renderedPayload = { to: 'b@example.com', subject: 'S2', body: 'B2' };

    runReplayableTrackedSideEffect(
      'apt-2',
      'confirmed',
      'email_client_confirmation',
      {
        renderPayload: async () => renderedPayload,
        execute,
      },
      { name: 'test-effect-2' },
    );
    await lastTaskPromise;

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { payload: renderedPayload } }),
    );
    expect(execute).toHaveBeenCalledWith(renderedPayload);
  });

  it('registers nothing and never executes when renderPayload throws', async () => {
    const renderError = new Error('template load failed');
    const execute = jest.fn();

    runReplayableTrackedSideEffect(
      'apt-3',
      'confirmed',
      'email_therapist_confirmation',
      {
        renderPayload: async () => {
          throw renderError;
        },
        execute,
      },
      { name: 'test-effect-3' },
    );
    await lastTaskPromise;

    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

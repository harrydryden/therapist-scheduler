/**
 * Pins the contract of runPeriodicTrackedSideEffect — the thin wrapper
 * that lets time-driven outbound actions (chase emails, follow-ups,
 * reminders) ride on the existing tracked-side-effect harness.
 *
 * What we lock in here:
 *   1. The wrapper writes `transition: 'periodic'` to the side_effect_log
 *      row, so the retry executor can recognise periodic effects and
 *      retry-executor sweeps can filter them.
 *   2. The idempotency key is stable for repeat calls with the same
 *      (appointmentId, effectType), so two concurrent ticks register
 *      against the same row rather than racing.
 *   3. Periodic and status-transition effects produce DIFFERENT keys
 *      even for the same effectType — `email_chase_user` registered
 *      via the periodic wrapper does NOT collide with a hypothetical
 *      `email_chase_user` registered via runReplayableTrackedSideEffect
 *      with another transition.
 *
 * The execute-side flow (mark completed / failed, retry on throw) is
 * covered by runReplayableTrackedSideEffect's own behaviour and not
 * re-tested here — the wrapper is a pass-through.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    redisUrl: 'redis://localhost:6379',
    env: 'test',
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret',
  },
}));

const findUniqueMock = jest.fn();
const createMock = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));

// Capture the async function the wrapper hands to runBackgroundTask so
// we can run it synchronously in tests instead of waiting on the real
// background scheduler.
let capturedTask: (() => Promise<void>) | null = null;
jest.mock('../utils/background-task', () => ({
  runBackgroundTask: (task: () => Promise<void>) => {
    capturedTask = task;
  },
}));

import {
  runPeriodicTrackedSideEffect,
  runPeriodicTrackedTherapistSideEffect,
  sideEffectTrackerService,
} from '../services/side-effect-tracker.service';

describe('runPeriodicTrackedSideEffect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedTask = null;
    findUniqueMock.mockResolvedValue(null);
    createMock.mockImplementation(({ data }) =>
      Promise.resolve({ id: `log-${data.idempotencyKey.slice(0, 8)}`, ...data }),
    );
  });

  it('writes transition: "periodic" to the side_effect_log row', async () => {
    runPeriodicTrackedSideEffect(
      'apt-1',
      'email_chase_user',
      {
        renderPayload: async () => ({ to: 'u@x', subject: 's', body: 'b' }),
        execute: jest.fn().mockResolvedValue(undefined),
      },
      { name: 'test' },
    );

    expect(capturedTask).not.toBeNull();
    await capturedTask!();

    expect(createMock).toHaveBeenCalledTimes(1);
    const createCall = createMock.mock.calls[0][0];
    expect(createCall.data.transition).toBe('periodic');
    expect(createCall.data.effectType).toBe('email_chase_user');
    expect(createCall.data.appointmentId).toBe('apt-1');
  });

  it('passes the rendered payload through to the side_effect_log row for retry replay', async () => {
    const envelope = { to: 'u@x', subject: 'hi', body: 'body', threadId: 't123' };

    runPeriodicTrackedSideEffect(
      'apt-1',
      'email_meeting_link_check',
      {
        renderPayload: async () => envelope,
        execute: jest.fn().mockResolvedValue(undefined),
      },
      { name: 'test' },
    );

    await capturedTask!();

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data.payload).toEqual(envelope);
  });

  it('produces a stable idempotency key for repeat calls with the same (appointmentId, effectType)', async () => {
    runPeriodicTrackedSideEffect(
      'apt-2',
      'email_chase_therapist',
      {
        renderPayload: async () => ({ to: 't@x', subject: 's', body: 'b' }),
        execute: jest.fn(),
      },
      { name: 'test' },
    );
    await capturedTask!();
    const firstKey = createMock.mock.calls[0][0].data.idempotencyKey;

    // Reset capture state and re-register; the harness should find the
    // existing row via findUnique (we leave it returning null to force a
    // fresh create, which lets us compare keys directly).
    capturedTask = null;
    createMock.mockClear();

    runPeriodicTrackedSideEffect(
      'apt-2',
      'email_chase_therapist',
      {
        renderPayload: async () => ({ to: 't@x', subject: 's', body: 'b' }),
        execute: jest.fn(),
      },
      { name: 'test' },
    );
    await capturedTask!();
    const secondKey = createMock.mock.calls[0][0].data.idempotencyKey;

    expect(firstKey).toBe(secondKey);
    expect(firstKey).toHaveLength(32);
  });

  it('produces a different idempotency key from a status-transition registration of the same effectType', async () => {
    // Periodic registration of email_chase_user
    runPeriodicTrackedSideEffect(
      'apt-3',
      'email_chase_user',
      {
        renderPayload: async () => ({ to: 'u@x', subject: 's', body: 'b' }),
        execute: jest.fn(),
      },
      { name: 'test' },
    );
    await capturedTask!();
    const periodicKey = createMock.mock.calls[0][0].data.idempotencyKey;

    // Hypothetical status-transition registration of the same type
    createMock.mockClear();
    await sideEffectTrackerService.registerSideEffects(
      'apt-3',
      'requested',
      [{ effectType: 'email_chase_user' }],
    );
    const transitionKey = createMock.mock.calls[0][0].data.idempotencyKey;

    expect(periodicKey).not.toBe(transitionKey);
  });

  it('skips execute when the existing row is already completed', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'existing-log',
      status: 'completed',
      idempotencyKey: 'whatever',
    });

    const execute = jest.fn().mockResolvedValue(undefined);

    runPeriodicTrackedSideEffect(
      'apt-4',
      'email_feedback_reminder',
      {
        renderPayload: async () => ({ to: 'u@x', subject: 's', body: 'b' }),
        execute,
      },
      { name: 'test' },
    );
    await capturedTask!();

    expect(execute).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('therapist-scoped wrapper writes therapistId (not appointmentId) on the row', async () => {
    runPeriodicTrackedTherapistSideEffect(
      'ther-1',
      'email_therapist_nudge',
      {
        renderPayload: async () => ({ to: 't@x', subject: 's', body: 'b' }),
        execute: jest.fn().mockResolvedValue(undefined),
      },
      { name: 'test' },
    );

    await capturedTask!();

    expect(createMock).toHaveBeenCalledTimes(1);
    const createCall = createMock.mock.calls[0][0];
    expect(createCall.data.therapistId).toBe('ther-1');
    expect(createCall.data.appointmentId).toBeUndefined();
    expect(createCall.data.transition).toBe('periodic');
    expect(createCall.data.effectType).toBe('email_therapist_nudge');
  });

  it('therapist-scoped wrapper produces a key that does NOT collide with the same-id appointment-scoped key', async () => {
    runPeriodicTrackedSideEffect(
      'shared-uuid',
      'email_chase_user',
      {
        renderPayload: async () => ({ to: 'u@x', subject: 's', body: 'b' }),
        execute: jest.fn().mockResolvedValue(undefined),
      },
      { name: 'test' },
    );
    await capturedTask!();
    const appointmentKey = createMock.mock.calls[0][0].data.idempotencyKey;

    capturedTask = null;
    createMock.mockClear();

    runPeriodicTrackedTherapistSideEffect(
      'shared-uuid',
      'email_chase_user',
      {
        renderPayload: async () => ({ to: 'u@x', subject: 's', body: 'b' }),
        execute: jest.fn().mockResolvedValue(undefined),
      },
      { name: 'test' },
    );
    await capturedTask!();
    const therapistKey = createMock.mock.calls[0][0].data.idempotencyKey;

    // The "therapist:" prefix in the hash input guarantees disjoint
    // key spaces — see generateTherapistIdempotencyKey.
    expect(appointmentKey).not.toBe(therapistKey);
  });

  it('stores a paired { user, therapist } payload verbatim for paired-effect retries', async () => {
    // The feedback-dispatch and session-reminder-pair effects use a
    // multi-envelope payload shape. The retry executor reads both
    // envelopes back from this row, so the registration step has to
    // store the structure as-is.
    const pairedPayload = {
      user: { to: 'u@x', subject: 'user subj', body: 'user body', threadId: 't1' },
      therapist: { to: 't@x', subject: 'thx subj', body: 'thx body' },
    };

    runPeriodicTrackedSideEffect(
      'apt-5',
      'email_feedback_dispatch',
      {
        renderPayload: async () => pairedPayload,
        execute: jest.fn().mockResolvedValue(undefined),
      },
      { name: 'test' },
    );

    await capturedTask!();

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data.payload).toEqual(pairedPayload);
    expect(createMock.mock.calls[0][0].data.effectType).toBe('email_feedback_dispatch');
  });
});

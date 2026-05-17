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

// updateMany is the CAS-claim issued by tryClaimEffect before execute
// (added to close the retry-while-in-flight concurrency hole). Default
// is `count: 1` so the harness's claim succeeds and the existing tests
// continue to drive the execute branch. Individual tests can override
// to `{ count: 0 }` to exercise the claim-lost path.
const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });

jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: (...args: unknown[]) => updateManyMock(...args),
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

import { runPeriodicTrackedSideEffect } from '../services/side-effect-harness';
import { sideEffectTrackerService } from '../services/side-effect-tracker.service';

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
      { kind: 'appointment', appointmentId: 'apt-1' },
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
      { kind: 'appointment', appointmentId: 'apt-1' },
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
      { kind: 'appointment', appointmentId: 'apt-2' },
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
      { kind: 'appointment', appointmentId: 'apt-2' },
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
      { kind: 'appointment', appointmentId: 'apt-3' },
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
      { kind: 'appointment', appointmentId: 'apt-4' },
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

  it('therapist scope writes therapistId (not appointmentId) on the row', async () => {
    runPeriodicTrackedSideEffect(
      { kind: 'therapist', therapistId: 'ther-1' },
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

  it('produces disjoint keys for appointment-scoped vs therapist-scoped registrations with the same id', async () => {
    runPeriodicTrackedSideEffect(
      { kind: 'appointment', appointmentId: 'shared-uuid' },
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

    runPeriodicTrackedSideEffect(
      { kind: 'therapist', therapistId: 'shared-uuid' },
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

  it('therapist scope with different scopeGeneration values produces DIFFERENT keys', async () => {
    // This is the cycle-isolation guarantee that protects recurring
    // cadence comms (therapist-nudge fires every 6h/intervalWeeks)
    // from being permanently disabled by a single 5-retry burst that
    // ends in `abandoned`. Each cycle's claim timestamp is the
    // generation; consecutive cycles MUST hash to different keys so
    // the prior cycle's abandoned row doesn't block the new one.
    runPeriodicTrackedSideEffect(
      { kind: 'therapist', therapistId: 'ther-1' },
      'email_therapist_nudge',
      {
        renderPayload: async () => ({ to: 't@x', subject: 's', body: 'b' }),
        execute: jest.fn().mockResolvedValue(undefined),
      },
      { name: 'test' },
      1000,
    );
    await capturedTask!();
    const cycle1Key = createMock.mock.calls[0][0].data.idempotencyKey;

    capturedTask = null;
    createMock.mockClear();

    runPeriodicTrackedSideEffect(
      { kind: 'therapist', therapistId: 'ther-1' },
      'email_therapist_nudge',
      {
        renderPayload: async () => ({ to: 't@x', subject: 's', body: 'b' }),
        execute: jest.fn().mockResolvedValue(undefined),
      },
      { name: 'test' },
      2000,
    );
    await capturedTask!();
    const cycle2Key = createMock.mock.calls[0][0].data.idempotencyKey;

    expect(cycle1Key).not.toBe(cycle2Key);
  });

  it('therapist scope with the SAME scopeGeneration produces the SAME key (idempotency within a cycle)', async () => {
    runPeriodicTrackedSideEffect(
      { kind: 'therapist', therapistId: 'ther-2' },
      'email_therapist_nudge',
      {
        renderPayload: async () => ({ to: 't@x', subject: 's', body: 'b' }),
        execute: jest.fn().mockResolvedValue(undefined),
      },
      { name: 'test' },
      42,
    );
    await capturedTask!();
    const firstKey = createMock.mock.calls[0][0].data.idempotencyKey;

    capturedTask = null;
    createMock.mockClear();

    runPeriodicTrackedSideEffect(
      { kind: 'therapist', therapistId: 'ther-2' },
      'email_therapist_nudge',
      {
        renderPayload: async () => ({ to: 't@x', subject: 's', body: 'b' }),
        execute: jest.fn().mockResolvedValue(undefined),
      },
      { name: 'test' },
      42,
    );
    await capturedTask!();
    const secondKey = createMock.mock.calls[0][0].data.idempotencyKey;

    expect(firstKey).toBe(secondKey);
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
      { kind: 'appointment', appointmentId: 'apt-5' },
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

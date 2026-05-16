/**
 * Coverage for `executeEffect` / `executeTherapistEffect` per-effectType
 * branches in side-effect-retry, plus the wire from
 * `retryFailedEffects` -> `postAbandonCleanup`.
 *
 * Why this exists:
 *  - `justin-time-outbox.test.ts` is the gold-standard executor test for
 *    `justintime_start`. Every OTHER appointment-scoped effect type
 *    (paired and single periodic emails) and the therapist-scoped
 *    `email_therapist_nudge` branch reaches its executor in production
 *    but has no parallel unit coverage. This file fills that gap.
 *  - The one-line wiring between `retryFailedEffects` and the abandon
 *    hook is what makes nudge permanent-fail recovery work; it could
 *    be deleted silently in a future refactor. A focused integration
 *    test pins the connection.
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

jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

jest.mock('../utils/redis-locks', () => ({
  releaseLock: jest.fn(() => Promise.resolve()),
  renewLock: jest.fn(() => Promise.resolve(true)),
}));

const appointmentFindUniqueMock = jest.fn();
const therapistFindUniqueMock = jest.fn();
const therapistUpdateManyMock = jest.fn();
const sideEffectFindManyMock = jest.fn();
const sideEffectUpdateMock = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      findMany: (...args: unknown[]) => sideEffectFindManyMock(...args),
      findUnique: jest.fn(),
      update: (...args: unknown[]) => sideEffectUpdateMock(...args),
    },
    appointmentRequest: {
      findUnique: (...args: unknown[]) => appointmentFindUniqueMock(...args),
      count: jest.fn().mockResolvedValue(0),
    },
    therapist: {
      findUnique: (...args: unknown[]) => therapistFindUniqueMock(...args),
      updateMany: (...args: unknown[]) => therapistUpdateManyMock(...args),
    },
  },
}));

const emailEnqueueMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/email-queue.service', () => ({
  emailQueueService: { enqueue: (...args: unknown[]) => emailEnqueueMock(...args) },
}));

const slackAlertMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    notifyAppointmentConfirmed: jest.fn(),
    notifyAppointmentCancelled: jest.fn(),
    notifyAppointmentCompleted: jest.fn(),
    sendAlert: (...args: unknown[]) => slackAlertMock(...args),
  },
}));

jest.mock('../services/justin-time.service', () => ({
  JustinTimeService: jest.fn().mockImplementation(() => ({
    startScheduling: jest.fn(),
  })),
}));

jest.mock('../services/scheduling-context.service', () => ({
  fetchSchedulingContext: jest.fn(),
}));

jest.mock('../services/therapist-booking-status.service', () => ({
  therapistBookingStatusService: {
    markConfirmed: jest.fn(),
    unmarkConfirmed: jest.fn(),
    recalculateUniqueRequestCount: jest.fn(),
  },
}));

import type { SideEffectType } from '../services/side-effect-tracker.service';

type ExecuteEffect = (effect: {
  id: string;
  appointmentId: string | null;
  therapistId: string | null;
  effectType: SideEffectType;
  idempotencyKey: string;
  attempts: number;
  payload: unknown;
}) => Promise<void>;

type RetryFailedEffects = (isLockValid: () => boolean) => Promise<{
  retried: number;
  succeeded: number;
  failed: number;
  abandoned: number;
}>;

let executeEffect: ExecuteEffect;
let retryFailedEffects: RetryFailedEffects;
let retryService: any;

beforeAll(async () => {
  const mod = await import('../services/side-effect-retry.service');
  retryService = mod.sideEffectRetryService;
  executeEffect = retryService.executeEffect.bind(retryService);
  retryFailedEffects = retryService.retryFailedEffects.bind(retryService);
});

beforeEach(() => {
  jest.clearAllMocks();
});

// Standard appointment row the executor will see for every appointment-
// scoped effect type below. We keep it minimal — the executors only
// pull a handful of fields.
const APPOINTMENT_ROW = {
  id: 'apt-1',
  userName: 'Alice',
  userEmail: 'alice@example.com',
  therapistName: 'Dr T',
  therapistEmail: 't@example.com',
  therapistHandle: 'th-1',
  status: 'pending',
  confirmedDateTime: null,
  trackingCode: 'SPL1',
};

describe('executeEffect — paired periodic emails (email_feedback_dispatch, email_session_reminder_pair)', () => {
  // These two effect types share a single retry branch that reads BOTH
  // envelopes from the stored payload and enqueues both. The pair is
  // the unit of work — partial replay isn't supported.
  const PAIRED_PAYLOAD = {
    user: { to: 'alice@example.com', subject: 'user subj', body: 'user body', threadId: 'thr-u' },
    therapist: { to: 't@example.com', subject: 'thx subj', body: 'thx body' },
  };

  it('enqueues BOTH envelopes for email_feedback_dispatch using the stored payload', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);

    await executeEffect({
      id: 'log-fd',
      appointmentId: 'apt-1',
      therapistId: null,
      effectType: 'email_feedback_dispatch',
      idempotencyKey: 'key-fd',
      attempts: 1,
      payload: PAIRED_PAYLOAD,
    });

    expect(emailEnqueueMock).toHaveBeenCalledTimes(2);
    // First call: user envelope, threadId threaded through.
    expect(emailEnqueueMock).toHaveBeenNthCalledWith(1, {
      to: 'alice@example.com',
      subject: 'user subj',
      body: 'user body',
      appointmentId: 'apt-1',
      threadId: 'thr-u',
    });
    // Second call: therapist envelope, no threadId (omitted from
    // enqueue payload — pinned because the spread `...(threadId ? {...}
    // : {})` would otherwise insert undefined).
    expect(emailEnqueueMock).toHaveBeenNthCalledWith(2, {
      to: 't@example.com',
      subject: 'thx subj',
      body: 'thx body',
      appointmentId: 'apt-1',
    });
  });

  it('enqueues BOTH envelopes for email_session_reminder_pair using the stored payload', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);

    await executeEffect({
      id: 'log-srp',
      appointmentId: 'apt-1',
      therapistId: null,
      effectType: 'email_session_reminder_pair',
      idempotencyKey: 'key-srp',
      attempts: 1,
      payload: PAIRED_PAYLOAD,
    });

    expect(emailEnqueueMock).toHaveBeenCalledTimes(2);
  });

  it('throws when the paired payload is missing the user envelope', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);

    await expect(
      executeEffect({
        id: 'log-fd',
        appointmentId: 'apt-1',
        therapistId: null,
        effectType: 'email_feedback_dispatch',
        idempotencyKey: 'key-fd',
        attempts: 1,
        payload: { therapist: PAIRED_PAYLOAD.therapist },
      }),
    ).rejects.toThrow(/paired payload/i);

    expect(emailEnqueueMock).not.toHaveBeenCalled();
  });

  it('throws when the paired payload is entirely missing (legacy row predating payload support)', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);

    await expect(
      executeEffect({
        id: 'log-srp',
        appointmentId: 'apt-1',
        therapistId: null,
        effectType: 'email_session_reminder_pair',
        idempotencyKey: 'key-srp',
        attempts: 1,
        payload: null,
      }),
    ).rejects.toThrow(/paired payload/i);
  });
});

describe('executeEffect — single periodic emails (shared replay branch)', () => {
  // email_chase_user, email_chase_therapist, email_meeting_link_check,
  // email_feedback_reminder all fall through the SAME case arm in
  // executeEffect (alongside the status-transition email types). The
  // replay reads a single envelope from payload and enqueues it. We
  // test with email_chase_user as the representative; the others share
  // the branch by case-fallthrough.
  const SINGLE_PAYLOAD = {
    to: 'alice@example.com',
    subject: 'chase subj',
    body: 'chase body',
    threadId: 'thr-1',
  };

  it('replays the stored envelope for email_chase_user (representative of the case-fallthrough arm)', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);

    await executeEffect({
      id: 'log-c',
      appointmentId: 'apt-1',
      therapistId: null,
      effectType: 'email_chase_user',
      idempotencyKey: 'key-c',
      attempts: 1,
      payload: SINGLE_PAYLOAD,
    });

    expect(emailEnqueueMock).toHaveBeenCalledTimes(1);
    expect(emailEnqueueMock).toHaveBeenCalledWith({
      to: 'alice@example.com',
      subject: 'chase subj',
      body: 'chase body',
      appointmentId: 'apt-1',
      threadId: 'thr-1',
    });
  });

  it('omits threadId from enqueue when payload has no threadId', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);

    await executeEffect({
      id: 'log-c',
      appointmentId: 'apt-1',
      therapistId: null,
      effectType: 'email_meeting_link_check',
      idempotencyKey: 'key-c',
      attempts: 1,
      payload: { to: 'alice@example.com', subject: 's', body: 'b' },
    });

    expect(emailEnqueueMock).toHaveBeenCalledTimes(1);
    const call = emailEnqueueMock.mock.calls[0][0];
    expect(call).not.toHaveProperty('threadId');
  });

  it('throws when the stored payload is missing fields — legacy row predating payload support', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);

    await expect(
      executeEffect({
        id: 'log-c',
        appointmentId: 'apt-1',
        therapistId: null,
        effectType: 'email_feedback_reminder',
        idempotencyKey: 'key-c',
        attempts: 1,
        payload: null,
      }),
    ).rejects.toThrow(/missing or invalid stored payload/i);
  });
});

describe('executeTherapistEffect — email_therapist_nudge', () => {
  const THERAPIST_PAYLOAD = {
    to: 't@example.com',
    subject: 'nudge subj',
    body: 'nudge body',
  };

  it('enqueues the stored envelope when the therapist is active', async () => {
    therapistFindUniqueMock.mockResolvedValue({
      id: 'ther-1',
      email: 't@example.com',
      name: 'Dr T',
      active: true,
    });

    await executeEffect({
      id: 'log-n',
      appointmentId: null,
      therapistId: 'ther-1',
      effectType: 'email_therapist_nudge',
      idempotencyKey: 'key-n',
      attempts: 1,
      payload: THERAPIST_PAYLOAD,
    });

    expect(emailEnqueueMock).toHaveBeenCalledTimes(1);
    // The nudge has no appointment context — the enqueue payload must
    // NOT carry an appointmentId.
    expect(emailEnqueueMock).toHaveBeenCalledWith({
      to: 't@example.com',
      subject: 'nudge subj',
      body: 'nudge body',
    });
  });

  it('skips replay (no enqueue) when the therapist has been deactivated since the original send', async () => {
    therapistFindUniqueMock.mockResolvedValue({
      id: 'ther-1',
      email: 't@example.com',
      name: 'Dr T',
      active: false,
    });

    // Should not throw — the retry runner expects this to resolve cleanly
    // so the row gets markCompleted'd and won't be re-attempted.
    await executeEffect({
      id: 'log-n',
      appointmentId: null,
      therapistId: 'ther-1',
      effectType: 'email_therapist_nudge',
      idempotencyKey: 'key-n',
      attempts: 1,
      payload: THERAPIST_PAYLOAD,
    });

    expect(emailEnqueueMock).not.toHaveBeenCalled();
  });

  it('throws when the therapist row has been deleted', async () => {
    therapistFindUniqueMock.mockResolvedValue(null);

    await expect(
      executeEffect({
        id: 'log-n',
        appointmentId: null,
        therapistId: 'ther-1',
        effectType: 'email_therapist_nudge',
        idempotencyKey: 'key-n',
        attempts: 1,
        payload: THERAPIST_PAYLOAD,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('throws when the stored payload is missing — legacy row predating payload support', async () => {
    therapistFindUniqueMock.mockResolvedValue({
      id: 'ther-1',
      email: 't@example.com',
      name: 'Dr T',
      active: true,
    });

    await expect(
      executeEffect({
        id: 'log-n',
        appointmentId: null,
        therapistId: 'ther-1',
        effectType: 'email_therapist_nudge',
        idempotencyKey: 'key-n',
        attempts: 1,
        payload: null,
      }),
    ).rejects.toThrow(/missing or invalid stored payload/i);
  });
});

describe('retryFailedEffects — abandon-flow wiring', () => {
  // When a retried effect fails and pushes `attempts` to MAX (5), the
  // retry runner must:
  //   1. markAbandoned the row
  //   2. call postAbandonCleanup (the hook that releases
  //      Therapist.lastNudgeAt for nudge effects)
  //   3. fire the Slack alert
  // The hook is the one-line wire that makes nudge permanent-fail
  // recovery work; this test pins it so the wire can't be silently
  // deleted.
  it('calls postAbandonCleanup when an effect hits MAX_RETRY_ATTEMPTS', async () => {
    const rowCreatedAt = new Date('2026-05-16T10:00:00.000Z');
    // One row, already at 4 attempts (next attempt makes 5 = MAX).
    sideEffectFindManyMock.mockResolvedValue([
      {
        id: 'log-x',
        appointmentId: null,
        therapistId: 'ther-1',
        effectType: 'email_therapist_nudge',
        idempotencyKey: 'key-x',
        attempts: 4,
        payload: { to: 't@x', subject: 's', body: 'b' },
        createdAt: rowCreatedAt,
      },
    ]);
    sideEffectUpdateMock.mockResolvedValue({});
    // Executor fails -> drives the retry runner into the abandon branch.
    therapistFindUniqueMock.mockResolvedValue(null);

    const cleanupSpy = jest.spyOn(retryService, 'postAbandonCleanup');

    const result = await retryFailedEffects(() => true);

    expect(result).toMatchObject({ retried: 1, succeeded: 0, abandoned: 1 });
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'log-x',
        effectType: 'email_therapist_nudge',
        therapistId: 'ther-1',
        createdAt: rowCreatedAt,
      }),
    );
    // Slack alert also fired alongside.
    expect(slackAlertMock).toHaveBeenCalledTimes(1);

    cleanupSpy.mockRestore();
  });

  it('does NOT call postAbandonCleanup when the failure is below the cap', async () => {
    sideEffectFindManyMock.mockResolvedValue([
      {
        id: 'log-x',
        appointmentId: null,
        therapistId: 'ther-1',
        effectType: 'email_therapist_nudge',
        idempotencyKey: 'key-x',
        attempts: 1,
        payload: { to: 't@x', subject: 's', body: 'b' },
        createdAt: new Date(),
      },
    ]);
    sideEffectUpdateMock.mockResolvedValue({});
    therapistFindUniqueMock.mockResolvedValue(null);

    const cleanupSpy = jest.spyOn(retryService, 'postAbandonCleanup');

    const result = await retryFailedEffects(() => true);

    expect(result).toMatchObject({ retried: 1, succeeded: 0, failed: 1, abandoned: 0 });
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(slackAlertMock).not.toHaveBeenCalled();

    cleanupSpy.mockRestore();
  });
});

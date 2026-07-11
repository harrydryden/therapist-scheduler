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
// CAS-claim issued by retry runner before executeEffect. Default
// `count: 1` so retry tests drive the execute branch; tests for the
// "another worker holds the lease" path override to `{ count: 0 }`.
const sideEffectUpdateManyMock = jest.fn().mockResolvedValue({ count: 1 });
// Sentinel confirm — confirmSentinelClaim (utils/atomic-sentinel-claim.ts)
// runs for real against this mock, so tests can assert on its where/data
// args exactly as they would against the finalizer's real behaviour.
// Default `count: 1` (sentinel confirms cleanly); override to `{count: 0}`
// to exercise the "sentinel update failed" alert branch.
const appointmentUpdateManyMock = jest.fn().mockResolvedValue({ count: 1 });
const appointmentUpdateMock = jest.fn().mockResolvedValue({ id: 'apt-1' });

jest.mock('../utils/database', () => ({
  prisma: {
    sideEffectLog: {
      findMany: (...args: unknown[]) => sideEffectFindManyMock(...args),
      findUnique: jest.fn(),
      update: (...args: unknown[]) => sideEffectUpdateMock(...args),
      updateMany: (...args: unknown[]) => sideEffectUpdateManyMock(...args),
    },
    appointmentRequest: {
      findUnique: (...args: unknown[]) => appointmentFindUniqueMock(...args),
      updateMany: (...args: unknown[]) => appointmentUpdateManyMock(...args),
      update: (...args: unknown[]) => appointmentUpdateMock(...args),
      count: jest.fn().mockResolvedValue(0),
    },
    therapist: {
      findUnique: (...args: unknown[]) => therapistFindUniqueMock(...args),
      updateMany: (...args: unknown[]) => therapistUpdateManyMock(...args),
    },
  },
}));

const applyCheckpointActionMock = jest.fn().mockResolvedValue({ applied: true, stage: 'chased' });
jest.mock('../services/ai-conversation.service', () => ({
  aiConversationService: {
    applyCheckpointAction: (...args: unknown[]) => applyCheckpointActionMock(...args),
  },
}));

const transitionToFeedbackRequestedMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../domain/scheduling/lifecycle', () => ({
  appointmentLifecycleService: {
    transitionToFeedbackRequested: (...args: unknown[]) => transitionToFeedbackRequestedMock(...args),
  },
}));

const recordAppointmentEventMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/appointment-event.service', () => ({
  recordAppointmentEvent: (...args: unknown[]) => recordAppointmentEventMock(...args),
}));

jest.mock('../services/audit-event.service', () => ({
  auditEventService: { log: jest.fn() },
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
  notes: 'existing notes',
  lastActivityAt: new Date('2026-05-16T04:00:00.000Z'),
};

describe('executeEffect — email_feedback_dispatch (regression: finalization must run on retry)', () => {
  const PAIRED_PAYLOAD = {
    user: { to: 'alice@example.com', subject: 'user subj', body: 'user body', threadId: 'thr-u' },
    therapist: { to: 't@example.com', subject: 'thx subj', body: 'thx body' },
  };

  it('enqueues BOTH envelopes AND runs finalization (sentinel confirm + feedback_requested transition)', async () => {
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

    // THE FIX: previously the retry branch stopped after the enqueues.
    // The sentinel must now be confirmed and the lifecycle transition
    // must fire — exactly like the first-run closure — or a retried
    // dispatch permanently strands the appointment in session_held.
    expect(appointmentUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'apt-1', feedbackFormSentAt: expect.any(Date) },
        data: expect.objectContaining({ feedbackFormSentAt: expect.any(Date) }),
      }),
    );
    expect(transitionToFeedbackRequestedMock).toHaveBeenCalledWith({
      appointmentId: 'apt-1',
      source: 'system',
    });
  });

  it('sends only the user email when the stored payload has no therapist envelope (setting was disabled at render time), still finalizes', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);

    await executeEffect({
      id: 'log-fd',
      appointmentId: 'apt-1',
      therapistId: null,
      effectType: 'email_feedback_dispatch',
      idempotencyKey: 'key-fd',
      attempts: 1,
      payload: { user: PAIRED_PAYLOAD.user, therapist: null },
    });

    expect(emailEnqueueMock).toHaveBeenCalledTimes(1);
    expect(transitionToFeedbackRequestedMock).toHaveBeenCalledTimes(1);
  });

  it('does not transition when the sentinel confirm fails (possible-duplicate alert path)', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);
    appointmentUpdateManyMock.mockResolvedValueOnce({ count: 0 });

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
    expect(transitionToFeedbackRequestedMock).not.toHaveBeenCalled();
    // Alert note appended to the existing notes.
    expect(appointmentUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'apt-1' },
        data: expect.objectContaining({ notes: expect.stringContaining('existing notes') }),
      }),
    );
  });

  it('throws when the payload is missing the user envelope', async () => {
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
    ).rejects.toThrow(/missing or invalid payload/i);

    expect(emailEnqueueMock).not.toHaveBeenCalled();
  });
});

describe('executeEffect — email_session_reminder_pair (regression: finalization + per-recipient skip on retry)', () => {
  const PAIRED_PAYLOAD = {
    user: { to: 'alice@example.com', subject: 'user subj', body: 'user body', threadId: 'thr-u' },
    therapist: { to: 't@example.com', subject: 'thx subj', body: 'thx body' },
  };

  it('enqueues BOTH envelopes AND confirms the sentinel when neither side was previously sent', async () => {
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
    expect(appointmentUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'apt-1', reminderSentAt: expect.any(Date) },
      }),
    );
  });

  it('skips re-sending the side already recorded as sent in the stored payload', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);

    await executeEffect({
      id: 'log-srp',
      appointmentId: 'apt-1',
      therapistId: null,
      effectType: 'email_session_reminder_pair',
      idempotencyKey: 'key-srp',
      attempts: 1,
      // A prior crashed attempt already sent to the user (updateStoredPayload
      // persisted sentTo.user=true) before dying — retry must only re-send
      // to the therapist, not duplicate the user's already-delivered email.
      payload: { ...PAIRED_PAYLOAD, sentTo: { user: true, therapist: false } },
    });

    expect(emailEnqueueMock).toHaveBeenCalledTimes(1);
    expect(emailEnqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 't@example.com' }),
    );
    // Still finalizes as a full success (both sides are now sent).
    expect(appointmentUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'apt-1', reminderSentAt: expect.any(Date) } }),
    );
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

describe('executeEffect — email_chase_user / email_chase_therapist (regression: checkpoint advance on retry)', () => {
  const SINGLE_PAYLOAD = {
    to: 'alice@example.com',
    subject: 'chase subj',
    body: 'chase body',
    threadId: 'thr-1',
  };

  it('replays the stored envelope AND advances the checkpoint (chaseSentAt / chaseSentTo)', async () => {
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

    // THE FIX: previously the retry branch stopped after the enqueue.
    // The checkpoint must now advance (chaseSentAt/chaseSentTo/audit
    // event) exactly like the first-run closure, or a re-armed chase
    // never records that it fired.
    expect(applyCheckpointActionMock).toHaveBeenCalledWith(
      'apt-1',
      'sent_chase_followup',
      expect.objectContaining({
        extraUpdates: expect.objectContaining({ chaseSentTo: 'user' }),
      }),
    );
    expect(recordAppointmentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: 'apt-1', type: 'chase_sent' }),
    );
  });

  it('derives the therapist target from the effectType for email_chase_therapist', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);

    await executeEffect({
      id: 'log-c',
      appointmentId: 'apt-1',
      therapistId: null,
      effectType: 'email_chase_therapist',
      idempotencyKey: 'key-c',
      attempts: 1,
      payload: { to: 't@example.com', subject: 's', body: 'b' },
    });

    expect(applyCheckpointActionMock).toHaveBeenCalledWith(
      'apt-1',
      'sent_chase_followup',
      expect.objectContaining({
        extraUpdates: expect.objectContaining({ chaseSentTo: 'therapist' }),
      }),
    );
  });
});

describe('executeEffect — email_meeting_link_check / email_feedback_reminder (single-envelope periodic emails)', () => {
  it('replays the envelope and confirms the meeting-link-check sentinel', async () => {
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
    expect(appointmentUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'apt-1', meetingLinkCheckSentAt: expect.any(Date) } }),
    );
  });

  it('replays the envelope and confirms the feedback-reminder sentinel', async () => {
    appointmentFindUniqueMock.mockResolvedValue(APPOINTMENT_ROW);

    await executeEffect({
      id: 'log-c',
      appointmentId: 'apt-1',
      therapistId: null,
      effectType: 'email_feedback_reminder',
      idempotencyKey: 'key-c',
      attempts: 1,
      payload: { to: 'alice@example.com', subject: 's', body: 'b' },
    });

    expect(emailEnqueueMock).toHaveBeenCalledTimes(1);
    expect(appointmentUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'apt-1', feedbackReminderSentAt: expect.any(Date) } }),
    );
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

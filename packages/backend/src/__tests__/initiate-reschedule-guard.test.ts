/**
 * Tests for the `initiate_reschedule` past-session guard.
 *
 * Regression focus: a confirmed appointment whose session time has already
 * passed used to be reschedulable — a post-session email misread as a
 * reschedule request wiped `confirmedDateTime`/`confirmedDateTimeParsed`,
 * removing the row from the lifecycle tick's query and permanently
 * stranding it in `confirmed` (no session_held → no feedback form → no
 * completion). The guard refuses once the session is more than
 * SESSION_END_BUFFER_MS past its start — the same boundary the tick uses —
 * while the no-show window (start → start + buffer) keeps working.
 *
 * Also covers the unified reschedule-entry write: the handler previously
 * cleared only the display string and left `confirmedDateTimeParsed`
 * behind; it now writes `startReschedulingState`, which clears both.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const findUniqueMock = jest.fn();
const updateManyMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      updateMany: (...args: unknown[]) => updateManyMock(...args),
    },
  },
}));

import { handleInitiateReschedule } from '../core/agent/tools/handlers/initiate-reschedule';
import { SESSION_END_BUFFER_MS } from '../constants';
import type { SchedulingContext } from '../services/scheduling-context.service';

const APT = 'apt-1';
const TRACE = 'test-trace';
const context = { appointmentRequestId: APT } as SchedulingContext;
const input = { reason: 'client asked to move the session' };

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

beforeEach(() => {
  jest.clearAllMocks();
  updateManyMock.mockResolvedValue({ count: 1 });
});

describe('initiate_reschedule — past-session guard', () => {
  it('refuses when the confirmed session time passed more than the session-end buffer ago', async () => {
    findUniqueMock.mockResolvedValue({
      confirmedDateTime: 'Fri 23 May, 3:30pm',
      confirmedDateTimeParsed: minutesAgo(90), // buffer is 60min
    });

    const outcome = await handleInitiateReschedule(input, context, TRACE);

    expect(outcome.result.success).toBe(false);
    // The error is read by the agent — it must redirect to the correct tool.
    expect(outcome.result.error).toMatch(/already passed/i);
    expect(outcome.result.error).toMatch(/flag_for_human_review/);
    expect(outcome.checkpointAction).toBeUndefined();
    // Crucially, nothing was written: the booked datetime survives.
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('still allows a reschedule inside the no-show window (session started, buffer not elapsed)', async () => {
    findUniqueMock.mockResolvedValue({
      confirmedDateTime: 'Fri 23 May, 3:30pm',
      confirmedDateTimeParsed: minutesAgo(30),
    });

    const outcome = await handleInitiateReschedule(input, context, TRACE);

    expect(outcome.result.success).toBe(true);
    expect(outcome.checkpointAction).toBe('initiated_reschedule');
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it('allows a reschedule of an upcoming session', async () => {
    findUniqueMock.mockResolvedValue({
      confirmedDateTime: 'Fri 23 May, 3:30pm',
      confirmedDateTimeParsed: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });

    const outcome = await handleInitiateReschedule(input, context, TRACE);

    expect(outcome.result.success).toBe(true);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it('guards exactly at the tick boundary (just inside the buffer is allowed)', async () => {
    findUniqueMock.mockResolvedValue({
      confirmedDateTime: 'Fri 23 May, 3:30pm',
      confirmedDateTimeParsed: new Date(Date.now() - SESSION_END_BUFFER_MS + 5_000),
    });

    const outcome = await handleInitiateReschedule(input, context, TRACE);

    expect(outcome.result.success).toBe(true);
  });

  it('does not block when the parsed datetime is missing (unparseable booking)', async () => {
    // The tick can't act on these rows either; blocking here would strand a
    // legitimately-reschedulable booking with a datetime the parser missed.
    findUniqueMock.mockResolvedValue({
      confirmedDateTime: 'sometime next week, tbd',
      confirmedDateTimeParsed: null,
    });

    const outcome = await handleInitiateReschedule(input, context, TRACE);

    expect(outcome.result.success).toBe(true);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it('errors when the appointment does not exist', async () => {
    findUniqueMock.mockResolvedValue(null);

    const outcome = await handleInitiateReschedule(input, context, TRACE);

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error).toBe('Appointment not found');
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

describe('initiate_reschedule — unified reschedule-entry write', () => {
  it('clears the parsed datetime mirror together with the display string', async () => {
    findUniqueMock.mockResolvedValue({
      confirmedDateTime: 'Fri 23 May, 3:30pm',
      confirmedDateTimeParsed: minutesAgo(-60), // 1h in the future
    });

    await handleInitiateReschedule(input, context, TRACE);

    const arg = updateManyMock.mock.calls[0][0];
    // Atomic precondition unchanged.
    expect(arg.where).toEqual({ id: APT, status: 'confirmed', humanControlEnabled: false });
    expect(arg.data).toMatchObject({
      reschedulingInProgress: true,
      reschedulingInitiatedBy: 'agent',
      previousConfirmedDateTime: 'Fri 23 May, 3:30pm',
      confirmedDateTime: null,
      // The regression: leaving this stale let the lifecycle tick promote a
      // mid-reschedule row to session_held off the abandoned slot.
      confirmedDateTimeParsed: null,
      meetingLinkCheckSentAt: null,
      reminderSentAt: null,
    });
  });

  it('returns an error when the row is no longer confirmed (atomic precondition, count 0)', async () => {
    findUniqueMock.mockResolvedValue({
      confirmedDateTime: 'Fri 23 May, 3:30pm',
      confirmedDateTimeParsed: null,
    });
    updateManyMock.mockResolvedValue({ count: 0 });

    const outcome = await handleInitiateReschedule(input, context, TRACE);

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error).toMatch(/not in confirmed status or human control/i);
  });
});

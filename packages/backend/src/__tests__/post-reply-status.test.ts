/**
 * Tests for reconcileStatusAfterReply — the post-tool-loop status
 * reconciliation extracted from JustinTimeService.processEmailReply.
 *
 * Regression focus: the `appointmentRequest.status` snapshot is read BEFORE
 * the tool loop runs, so it can be stale. If the agent drove the row to a
 * terminal/forward state during the turn (mark_scheduling_complete →
 * confirmed, cancel_appointment → cancelled), the stale pending/contacted
 * status used to fire an unguarded transitionToNegotiating, which throws
 * InvalidTransitionError against the now-advanced row. That error escaped
 * processEmailReply → process.ts, where it was counted as a processing
 * failure (spurious Slack alert) and left the message unmarked, triggering a
 * wasteful scanner re-process of an already-terminal appointment.
 *
 * The fix wraps the transition in the same InvalidTransitionError-as-no-op
 * idiom startScheduling already uses for its pending → contacted call.
 *
 * Also covers the confirmed-reschedule branch: it's a pure no-op now — the
 * `initiate_reschedule` tool handler is the only writer of the reschedule
 * fields (see docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md finding #16).
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const transitionToNegotiatingMock = jest.fn();
jest.mock('../domain/scheduling/lifecycle', () => ({
  appointmentLifecycleService: {
    transitionToNegotiating: (...args: unknown[]) => transitionToNegotiatingMock(...args),
  },
}));

const appointmentUpdateManyMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      updateMany: (...args: unknown[]) => appointmentUpdateManyMock(...args),
    },
  },
}));

import { reconcileStatusAfterReply } from '../services/post-reply-status';
import { InvalidTransitionError } from '../errors';

const TRACE = 'test-trace';
const APT = 'apt-1';
const FROM = 'someone@example.com';

function tool(toolName: string) {
  return { toolName, timestamp: new Date().toISOString() };
}

beforeEach(() => {
  jest.clearAllMocks();
  transitionToNegotiatingMock.mockResolvedValue({ success: true });
  appointmentUpdateManyMock.mockResolvedValue({ count: 1 });
});

describe('reconcileStatusAfterReply — pending/contacted → negotiating', () => {
  it.each(['pending', 'contacted'])(
    'transitions %s → negotiating via the lifecycle service',
    async (status) => {
      await reconcileStatusAfterReply({
        appointmentRequest: { id: APT, status },
        appointmentRequestId: APT,
        fromEmail: FROM,
        executedTools: [tool('send_email')],
        traceId: TRACE,
      });

      expect(transitionToNegotiatingMock).toHaveBeenCalledTimes(1);
      expect(transitionToNegotiatingMock).toHaveBeenCalledWith({
        appointmentId: APT,
        source: 'agent',
      });
      expect(appointmentUpdateManyMock).not.toHaveBeenCalled();
    },
  );

  it('does NOT throw when the agent already confirmed mid-turn (stale contacted → InvalidTransitionError)', async () => {
    // Row is now `confirmed` in the DB, so the negotiating precondition
    // fails and the lifecycle service throws InvalidTransitionError.
    transitionToNegotiatingMock.mockRejectedValue(
      new InvalidTransitionError('confirmed', 'negotiating'),
    );

    await expect(
      reconcileStatusAfterReply({
        appointmentRequest: { id: APT, status: 'contacted' },
        appointmentRequestId: APT,
        fromEmail: FROM,
        executedTools: [tool('mark_scheduling_complete')],
        traceId: TRACE,
      }),
    ).resolves.toBeUndefined();

    expect(transitionToNegotiatingMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT throw when the agent already cancelled mid-turn (stale pending → InvalidTransitionError)', async () => {
    transitionToNegotiatingMock.mockRejectedValue(
      new InvalidTransitionError('cancelled', 'negotiating'),
    );

    await expect(
      reconcileStatusAfterReply({
        appointmentRequest: { id: APT, status: 'pending' },
        appointmentRequestId: APT,
        fromEmail: FROM,
        executedTools: [tool('cancel_appointment')],
        traceId: TRACE,
      }),
    ).resolves.toBeUndefined();
  });

  it('still propagates non-InvalidTransition errors (the guard is specific)', async () => {
    const boom = new Error('db exploded');
    transitionToNegotiatingMock.mockRejectedValue(boom);

    await expect(
      reconcileStatusAfterReply({
        appointmentRequest: { id: APT, status: 'pending' },
        appointmentRequestId: APT,
        fromEmail: FROM,
        executedTools: [],
        traceId: TRACE,
      }),
    ).rejects.toBe(boom);
  });
});

describe('reconcileStatusAfterReply — confirmed appointment', () => {
  it('does NOT re-apply the reschedule write when initiate_reschedule ran — the tool handler already did it', async () => {
    // executedTools only ever records SUCCESSFUL, non-skipped tool calls, so
    // 'initiate_reschedule' appearing here means handlers/initiate-reschedule.ts
    // already wrote startReschedulingState with initiatedBy: 'agent'. The
    // reconciler used to redundantly re-apply it with initiatedBy: fromEmail,
    // silently overwriting that attribution on every reschedule (see
    // docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md finding #16) — it must be a no-op now.
    await reconcileStatusAfterReply({
      appointmentRequest: { id: APT, status: 'confirmed', confirmedDateTime: 'Mon 3 Feb 10am' },
      appointmentRequestId: APT,
      fromEmail: FROM,
      executedTools: [tool('initiate_reschedule')],
      traceId: TRACE,
    });

    expect(transitionToNegotiatingMock).not.toHaveBeenCalled();
    expect(appointmentUpdateManyMock).not.toHaveBeenCalled();
  });

  it('is a no-op when mark_scheduling_complete finalised the reschedule', async () => {
    await reconcileStatusAfterReply({
      appointmentRequest: { id: APT, status: 'confirmed', confirmedDateTime: 'Mon 3 Feb 10am' },
      appointmentRequestId: APT,
      fromEmail: FROM,
      executedTools: [tool('mark_scheduling_complete')],
      traceId: TRACE,
    });

    expect(appointmentUpdateManyMock).not.toHaveBeenCalled();
    expect(transitionToNegotiatingMock).not.toHaveBeenCalled();
  });

  it('is a no-op for an informational reply (no reschedule tools ran)', async () => {
    await reconcileStatusAfterReply({
      appointmentRequest: { id: APT, status: 'confirmed', confirmedDateTime: 'Mon 3 Feb 10am' },
      appointmentRequestId: APT,
      fromEmail: FROM,
      executedTools: [tool('send_email')],
      traceId: TRACE,
    });

    expect(appointmentUpdateManyMock).not.toHaveBeenCalled();
    expect(transitionToNegotiatingMock).not.toHaveBeenCalled();
  });
});

describe('reconcileStatusAfterReply — cancelled appointment', () => {
  it('is a terminal no-op', async () => {
    await reconcileStatusAfterReply({
      appointmentRequest: { id: APT, status: 'cancelled' },
      appointmentRequestId: APT,
      fromEmail: FROM,
      executedTools: [tool('send_email')],
      traceId: TRACE,
    });

    expect(appointmentUpdateManyMock).not.toHaveBeenCalled();
    expect(transitionToNegotiatingMock).not.toHaveBeenCalled();
  });
});

/**
 * Finalisers for sentinel-gated periodic effects (review §4.4).
 *
 *   finalizeChase — the chase must be RECORDED (chaseSentAt real) even when
 *     the conversation checkpoint cannot be advanced (no conversation state,
 *     optimistic-lock retries exhausted). Otherwise the sentinel stays at the
 *     epoch, the sweep resets it, and the party is chased again next cycle;
 *     closure is never recommended.
 *
 *   finalizeFeedbackDispatch — once the pair has been sent it always
 *     attempts the transition (a confirm miss used to return early and
 *     strand the row in session_held), and a status that moved on is not
 *     an error (lifecycle audit L10).
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const appointmentUpdateMany = jest.fn();
const appointmentFindUnique = jest.fn();
const appointmentUpdate = jest.fn().mockResolvedValue({ id: 'apt-1' });
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      updateMany: (...a: unknown[]) => appointmentUpdateMany(...a),
      findUnique: (...a: unknown[]) => appointmentFindUnique(...a),
      update: (...a: unknown[]) => appointmentUpdate(...a),
    },
  },
}));

const applyCheckpointAction = jest.fn();
jest.mock('../services/ai-conversation.service', () => ({
  aiConversationService: { applyCheckpointAction: (...a: unknown[]) => applyCheckpointAction(...a) },
}));

const recordAppointmentEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/appointment-event.service', () => ({
  recordAppointmentEvent: (...a: unknown[]) => recordAppointmentEvent(...a),
}));
jest.mock('../services/audit-event.service', () => ({ auditEventService: { log: jest.fn() } }));

const transitionToFeedbackRequested = jest.fn();
jest.mock('../domain/scheduling/lifecycle', () => ({
  appointmentLifecycleService: {
    transitionToFeedbackRequested: (...a: unknown[]) => transitionToFeedbackRequested(...a),
  },
}));

import { logger } from '../utils/logger';
import { InvalidTransitionError } from '../errors';
import { EPOCH_SENTINEL } from '../utils/atomic-sentinel-claim';
import { finalizeChase, finalizeFeedbackDispatch } from '../services/periodic-effect-finalizers';

const NOW = new Date('2026-09-28T12:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('finalizeChase', () => {
  const args = {
    appointmentId: 'apt-1',
    target: 'therapist' as const,
    targetEmail: 'alex@example.com',
    now: NOW,
    inactiveHours: 80,
    userName: 'Sam',
    therapistName: 'Alex',
  };

  it('records the chase directly when the checkpoint cannot be advanced', async () => {
    applyCheckpointAction.mockResolvedValue({ applied: false, stage: null });
    appointmentUpdateMany.mockResolvedValue({ count: 1 });

    await finalizeChase(args);

    expect(appointmentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'apt-1', chaseSentAt: EPOCH_SENTINEL },
      data: {
        chaseSentAt: NOW,
        chaseSentTo: 'therapist',
        chaseTargetEmail: 'alex@example.com',
        lastActivityAt: NOW,
        isStale: false,
      },
    });
    // Recorded → the chase_sent event is written (closure can follow).
    expect(recordAppointmentEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'chase_sent' }));
  });

  it('alerts (and records nothing) when even the direct record misses the sentinel', async () => {
    applyCheckpointAction.mockResolvedValue({ applied: false, stage: null });
    appointmentUpdateMany.mockResolvedValue({ count: 0 });

    await finalizeChase(args);

    expect(recordAppointmentEvent).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/possible duplicate/));
  });

  it('the normal path advances the checkpoint and does not touch the sentinel separately', async () => {
    applyCheckpointAction.mockResolvedValue({ applied: true, stage: 'chased' });

    await finalizeChase(args);

    expect(appointmentUpdateMany).not.toHaveBeenCalled();
    expect(recordAppointmentEvent).toHaveBeenCalledTimes(1);
  });
});

describe('finalizeFeedbackDispatch', () => {
  const args = { appointmentId: 'apt-1', now: NOW, notesSoFar: 'n', userEmail: 'sam@example.com' };

  it('a status that moved on while the emails were in flight is not an error', async () => {
    appointmentUpdateMany.mockResolvedValue({ count: 1 }); // sentinel confirmed
    transitionToFeedbackRequested.mockRejectedValue(new InvalidTransitionError('cancelled', 'feedback_requested'));

    await expect(finalizeFeedbackDispatch(args)).resolves.toBeUndefined();
  });

  it('a transient transition failure propagates (the retry re-drives only the transition)', async () => {
    appointmentUpdateMany.mockResolvedValue({ count: 1 });
    transitionToFeedbackRequested.mockRejectedValue(new Error('connection reset'));

    await expect(finalizeFeedbackDispatch(args)).rejects.toThrow('connection reset');
  });

  it('a confirm miss on an already-confirmed sentinel transitions without a duplicate alert', async () => {
    appointmentUpdateMany.mockResolvedValue({ count: 0 });
    appointmentFindUnique.mockResolvedValue({ feedbackFormSentAt: new Date('2026-09-28T11:00:00Z') });
    transitionToFeedbackRequested.mockResolvedValue({ success: true });

    await finalizeFeedbackDispatch(args);

    expect(transitionToFeedbackRequested).toHaveBeenCalledWith({ appointmentId: 'apt-1', source: 'system' });
    expect(appointmentUpdate).not.toHaveBeenCalled(); // no "possible duplicate" note
  });

  it('a confirm miss on a released sentinel alerts but STILL transitions (never strands session_held)', async () => {
    appointmentUpdateMany.mockResolvedValue({ count: 0 });
    appointmentFindUnique.mockResolvedValue({ feedbackFormSentAt: null });
    transitionToFeedbackRequested.mockResolvedValue({ success: true });

    await finalizeFeedbackDispatch(args);

    expect(appointmentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { notes: expect.stringMatching(/review for duplicates/) } }),
    );
    expect(transitionToFeedbackRequested).toHaveBeenCalledTimes(1);
  });
});

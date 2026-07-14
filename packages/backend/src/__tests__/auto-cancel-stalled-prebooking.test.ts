/**
 * Tests for chaseEmailService.autoCancelStalledPreBooking — the target-model
 * stall-recovery path. A ghosted pre-booking appointment hides the therapist
 * from the finder (serial guard), so once it has been chased and its closure
 * recommendation goes un-actioned past the closure window it is auto-cancelled
 * (source/cancelledBy 'system'), which frees the therapist.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const settingsMock: Record<string, unknown> = {
  'chase.closureRecommendationHours': 48,
  'chase.maxClosureBatchSize': 100,
};
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn((key: string) => Promise.resolve(settingsMock[key])),
}));

const findManyMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findMany: (...a: unknown[]) => findManyMock(...a),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));

const transitionToCancelledMock = jest.fn();
jest.mock('../domain/scheduling/lifecycle', () => ({
  appointmentLifecycleService: {
    transitionToCancelled: (...a: unknown[]) => transitionToCancelledMock(...a),
    transitionToCompleted: jest.fn(),
  },
}));

// Module-scope imports pulled in by other ChaseEmailService methods — stubbed
// so the module loads.
jest.mock('../services/email-ingest.service', () => ({
  emailIngestService: {
    threadContainsInboundReplies: jest.fn(),
    checkThreadForUnprocessedReplies: jest.fn(),
  },
}));
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../core/email', () => ({ sendEmail: jest.fn() }));
jest.mock('../utils/email-templates', () => ({
  getEmailSubject: jest.fn(),
  getEmailBody: jest.fn(),
}));
jest.mock('../services/side-effect-harness', () => ({ runPeriodicTrackedSideEffect: jest.fn() }));
jest.mock('../services/periodic-effect-finalizers', () => ({ finalizeChase: jest.fn() }));
jest.mock('../services/ai-conversation.service', () => ({
  aiConversationService: { applyCheckpointAction: jest.fn() },
}));
jest.mock('../services/appointment-event.service', () => ({ recordAppointmentEvent: jest.fn() }));

import { chaseEmailService } from '../services/chase-email.service';
import { PRE_BOOKING_STATUSES } from '../constants';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('autoCancelStalledPreBooking', () => {
  it('cancels unresponsive pre-booking candidates with system initiator + atomic guards', async () => {
    findManyMock.mockResolvedValueOnce([
      { id: 'apt-1', userName: 'Sam', therapistName: 'Alex' },
      { id: 'apt-2', userName: 'Jo', therapistName: 'Alex' },
    ]);
    transitionToCancelledMock.mockResolvedValue({
      success: true,
      previousStatus: 'contacted',
      newStatus: 'cancelled',
    });

    const count = await chaseEmailService.autoCancelStalledPreBooking('check-1');

    expect(count).toBe(2);
    expect(transitionToCancelledMock).toHaveBeenCalledTimes(2);
    const firstArg = transitionToCancelledMock.mock.calls[0][0];
    expect(firstArg).toMatchObject({
      appointmentId: 'apt-1',
      cancelledBy: 'system',
      source: 'system',
    });
    expect(firstArg.atomic.requireHumanControlDisabled).toBe(true);
    expect(firstArg.atomic.requireStatusNotIn).toEqual(
      expect.arrayContaining(['confirmed', 'session_held', 'feedback_requested', 'completed']),
    );

    // Candidate query must scope to pre-booking, un-actioned closure recs,
    // not under human control.
    const where = findManyMock.mock.calls[0][0].where;
    expect(where.status.in).toEqual([...PRE_BOOKING_STATUSES]);
    expect(where.closureRecommendationActioned).toBe(false);
    expect(where.humanControlEnabled).toBe(false);
    expect(where.closureRecommendedAt.not).toBeNull();
    expect(where.closureRecommendedAt.lt).toBeInstanceOf(Date);
  });

  it('does not count rows the transition skipped (advanced to confirmed / under human control)', async () => {
    findManyMock.mockResolvedValueOnce([
      { id: 'apt-advanced', userName: 'Sam', therapistName: 'Alex' },
    ]);
    transitionToCancelledMock.mockResolvedValue({
      success: false,
      previousStatus: 'confirmed',
      newStatus: 'confirmed',
      atomicSkipped: true,
    });

    const count = await chaseEmailService.autoCancelStalledPreBooking('check-2');
    expect(count).toBe(0);
  });

  it('returns 0 when there are no stalled candidates', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const count = await chaseEmailService.autoCancelStalledPreBooking('check-3');
    expect(count).toBe(0);
    expect(transitionToCancelledMock).not.toHaveBeenCalled();
  });
});

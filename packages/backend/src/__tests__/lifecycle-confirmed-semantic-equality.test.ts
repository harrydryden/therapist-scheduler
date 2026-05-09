/**
 * Tests for the semantic-datetime idempotent-skip in
 * `appointmentLifecycleService.transitionToConfirmed`.
 *
 * Before the fix, the idempotent-skip used strict string equality:
 *
 *   appointment.confirmedDateTime === confirmedDateTime
 *
 * Two renderings of the same datetime ("Monday 3rd February at 10am"
 * vs "Mon 3rd Feb 10:00am") would NOT match, so a benign re-confirm
 * would flip wasConfirmed/isReschedule, fire a reschedule audit
 * narrative, and reset follow-up sentinels even though no real change
 * occurred. After the fix we use areDatetimesEqual (semantic compare).
 */

jest.mock('../utils/logger', () => require('./_lifecycle-mocks').loggerMock());
jest.mock('../config', () => require('./_lifecycle-mocks').configMock());
jest.mock('../utils/redis', () => require('./_lifecycle-mocks').redisMock());
jest.mock('../services/audit-event.service', () => require('./_lifecycle-mocks').auditEventMock());
jest.mock('../services/appointment-event.service', () => require('./_lifecycle-mocks').appointmentEventMock());
jest.mock('../services/ai-conversation.service', () => require('./_lifecycle-mocks').aiConversationMock());
jest.mock('../services/slack-notification.service', () => require('./_lifecycle-mocks').slackNotificationMock());

const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();
const mockExecuteRaw = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
    $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a),
  },
}));

const mockOnConfirmed = jest.fn();
const mockNotifyTransition = jest.fn();
const mockNotifyConfirmed = jest.fn();

jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    notifyTransition: (...a: unknown[]) => mockNotifyTransition(...a),
    onConfirmed: (...a: unknown[]) => mockOnConfirmed(...a),
    onSessionHeld: jest.fn(),
    onCompleted: jest.fn(),
    onCancelled: jest.fn(),
    onAdminForceUpdate: jest.fn(),
  },
}));

jest.mock('../services/appointment-notifications.service', () => ({
  appointmentNotificationsService: {
    notifyConfirmed: (...a: unknown[]) => mockNotifyConfirmed(...a),
    notifyCancelled: jest.fn(),
    notifyCompleted: jest.fn(),
  },
}));

import { appointmentLifecycleService } from '../services/appointment-lifecycle.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockExecuteRaw.mockResolvedValue(undefined);
  // fireAndForget calls .catch on these — must be thenable.
  mockOnConfirmed.mockResolvedValue(undefined);
  mockNotifyConfirmed.mockResolvedValue(undefined);
});

const baseRow = {
  id: 'apt-1',
  status: 'confirmed',
  userName: 'User',
  userEmail: 'u@example.com',
  therapistName: 'T',
  therapistEmail: 't@example.com',
  therapistHandle: 'h',
  humanControlEnabled: false,
  transitionGeneration: 7,
};

describe('transitionToConfirmed semantic idempotent-skip', () => {
  it('treats two equivalent renderings of the same datetime as idempotent (no reschedule fire)', async () => {
    // Existing record stores an ISO datetime; the caller passes the
    // same instant rendered as a human string. These should be treated
    // as the same — no DB write, no notifications.
    mockFindUnique.mockResolvedValueOnce({
      ...baseRow,
      confirmedDateTime: '2026-02-03T10:00:00.000Z',
    });

    const result = await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      // Same instant, different rendering. parseConfirmedDateTime
      // resolves "2026-02-03 at 10am UTC" to the same Date as the ISO.
      confirmedDateTime: '2026-02-03 10:00 UTC',
      source: 'agent',
    });

    expect(result).toEqual({
      success: true,
      previousStatus: 'confirmed',
      newStatus: 'confirmed',
      skipped: true,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockNotifyConfirmed).not.toHaveBeenCalled();
  });

  it('still detects a real reschedule when the new datetime is genuinely different', async () => {
    mockFindUnique.mockResolvedValueOnce({
      ...baseRow,
      confirmedDateTime: '2026-02-03T10:00:00.000Z',
    });
    mockUpdate.mockResolvedValueOnce({ transitionGeneration: 8 });

    const result = await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      // Genuinely different time — must transition
      confirmedDateTime: '2026-02-10T10:00:00.000Z',
      source: 'agent',
    });

    expect(result).toEqual({
      success: true,
      previousStatus: 'confirmed',
      newStatus: 'confirmed',
    });
    expect(mockUpdate).toHaveBeenCalled();
  });
});

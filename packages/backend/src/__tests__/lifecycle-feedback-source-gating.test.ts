/**
 * Tests for the source-gated validFromStatuses on
 * `transitionToFeedbackRequested`.
 *
 * Before the fix, validFromStatuses included CONFIRMED for all callers.
 * The post-booking-followup tick (source: 'system') could therefore
 * race the lifecycle tick and flip the appointment straight from
 * CONFIRMED to FEEDBACK_REQUESTED, skipping the session_held audit
 * event and confusing the session-reminder code that expects to fire
 * once the row enters session_held.
 *
 * After: only `source: 'admin'` keeps the wider allowlist (admin
 * back-fills); the system path requires session_held as the source.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../config', () => require('./_global-mocks').configMock());
jest.mock('../utils/redis', () => require('./_global-mocks').redisMock());
jest.mock('../services/audit-event.service', () => require('./_global-mocks').auditEventMock());
jest.mock('../services/appointment-event.service', () => require('./_global-mocks').appointmentEventMock());
jest.mock('../services/ai-conversation.service', () => require('./_global-mocks').aiConversationMock());
jest.mock('../services/slack-notification.service', () => require('./_global-mocks').slackNotificationMock());

jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    notifyTransition: jest.fn(),
    onConfirmed: jest.fn(),
    onSessionHeld: jest.fn(),
    onCompleted: jest.fn(),
    onCancelled: jest.fn(),
    onAdminForceUpdate: jest.fn(),
  },
}));

jest.mock('../services/appointment-notifications.service', () => ({
  appointmentNotificationsService: {
    notifyConfirmed: jest.fn(),
    notifyCancelled: jest.fn(),
    notifyCompleted: jest.fn(),
  },
}));

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: { findUnique: jest.fn(), update: jest.fn() },
    $executeRaw: jest.fn(),
  },
}));

import { appointmentLifecycleService } from '../services/appointment-lifecycle.service';

const mockApplyLightTransition = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  // Spy on the private applyLightTransition — once we've confirmed it
  // was called with the right validFromStatuses, the real DB pipeline
  // doesn't need to run for this test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (appointmentLifecycleService as any).applyLightTransition = mockApplyLightTransition;
  mockApplyLightTransition.mockResolvedValue({
    success: true,
    previousStatus: 'session_held',
    newStatus: 'feedback_requested',
  });
});

describe('transitionToFeedbackRequested validFromStatuses', () => {
  it('restricts the system path to session_held (cannot skip from confirmed)', async () => {
    await appointmentLifecycleService.transitionToFeedbackRequested({
      appointmentId: 'apt-1',
      source: 'system',
    });

    expect(mockApplyLightTransition).toHaveBeenCalledTimes(1);
    const args = mockApplyLightTransition.mock.calls[0][0];
    expect(args.validFromStatuses).toEqual(['session_held']);
  });

  it('keeps the wider allowlist for the admin path (back-fill scenarios)', async () => {
    await appointmentLifecycleService.transitionToFeedbackRequested({
      appointmentId: 'apt-1',
      source: 'admin',
      adminId: 'admin-7',
    });

    expect(mockApplyLightTransition).toHaveBeenCalledTimes(1);
    const args = mockApplyLightTransition.mock.calls[0][0];
    expect(args.validFromStatuses).toEqual(['session_held', 'confirmed']);
  });

  it('agent path is treated like system (no skip permission)', async () => {
    await appointmentLifecycleService.transitionToFeedbackRequested({
      appointmentId: 'apt-1',
      source: 'agent',
    });

    expect(mockApplyLightTransition).toHaveBeenCalledTimes(1);
    const args = mockApplyLightTransition.mock.calls[0][0];
    expect(args.validFromStatuses).toEqual(['session_held']);
  });
});

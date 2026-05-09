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
 * back-fills) ; the system path requires session_held as the source.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    jwtSecret: 'test-secret',
    backendUrl: 'https://backend.test',
    frontendUrl: 'https://frontend.test',
  },
}));

jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

const mockApplyLightTransition = jest.fn();

// Stub the private applyLightTransition by intercepting on the prototype.
// Once we've confirmed it's called with the right validFromStatuses we
// don't need its real behaviour for this test.
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

jest.mock('../services/audit-event.service', () => ({
  auditEventService: { log: jest.fn() },
}));

jest.mock('../services/appointment-event.service', () => ({
  recordAppointmentEvent: jest.fn(),
}));

jest.mock('../services/ai-conversation.service', () => ({
  aiConversationService: { applyCheckpointUpdate: jest.fn() },
  inferRestoredStage: jest.fn(),
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: jest.fn(),
    notifyAppointmentConfirmed: jest.fn(),
    notifyAppointmentCancelled: jest.fn(),
    notifyAppointmentCompleted: jest.fn(),
  },
}));

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: { findUnique: jest.fn(), update: jest.fn() },
    $executeRaw: jest.fn(),
  },
}));

import { appointmentLifecycleService } from '../services/appointment-lifecycle.service';

beforeEach(() => {
  jest.clearAllMocks();
  // Spy on the private applyLightTransition so we can assert what it's
  // called with without exercising the real DB pipeline.
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

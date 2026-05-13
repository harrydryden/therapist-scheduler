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
 *
 * Assertion strategy: drive `transitionToFeedbackRequested` through
 * the real (post-Phase-2a) module path with a mocked prisma, then
 * read the `where.status.in` value the transition passed to
 * `updateMany`. That set IS the validFromStatuses contract under test.
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

const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
      update: jest.fn(),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
  },
}));

import { appointmentLifecycleService } from '../domain/scheduling/lifecycle';

beforeEach(() => {
  jest.clearAllMocks();
  // Pre-stub the findUnique so the transition reads a row in
  // `session_held` (so it's not the trivial idempotent-skip path).
  mockFindUnique.mockResolvedValue({
    id: 'apt-1',
    status: 'session_held',
    userEmail: 'client@example.com',
  });
  // updateMany returns count=1 so the transition continues past the
  // post-update audit/SSE block — the test only inspects the where
  // clause, so the rest is moot but must not throw.
  mockUpdateMany.mockResolvedValue({ count: 1 });
});

/**
 * Extract the value of `where.status.in` that the transition passed to
 * updateMany. That set is the validFromStatuses applied at the DB level.
 */
function getWhereStatusIn(): unknown {
  expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  const args = mockUpdateMany.mock.calls[0][0];
  return args.where.status.in;
}

describe('transitionToFeedbackRequested validFromStatuses', () => {
  it('restricts the system path to session_held (cannot skip from confirmed)', async () => {
    await appointmentLifecycleService.transitionToFeedbackRequested({
      appointmentId: 'apt-1',
      source: 'system',
    });
    expect(getWhereStatusIn()).toEqual(['session_held']);
  });

  it('keeps the wider allowlist for the admin path (back-fill scenarios)', async () => {
    await appointmentLifecycleService.transitionToFeedbackRequested({
      appointmentId: 'apt-1',
      source: 'admin',
      adminId: 'admin-7',
    });
    expect(getWhereStatusIn()).toEqual(['session_held', 'confirmed']);
  });

  it('agent path is treated like system (no skip permission)', async () => {
    await appointmentLifecycleService.transitionToFeedbackRequested({
      appointmentId: 'apt-1',
      source: 'agent',
    });
    expect(getWhereStatusIn()).toEqual(['session_held']);
  });
});

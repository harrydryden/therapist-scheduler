/**
 * Pin the "auto-release human control on cancellation" invariant.
 *
 * The patch-dashboard route requires the admin to take human
 * control before performing a cancel — which means every admin-
 * initiated cancellation arrives at `transitionToCancelled` with
 * `humanControlEnabled === true`. The transition is required to
 * flip ALL four `humanControl*` fields back to clean / null in
 * the same DB transaction, so:
 *   1. The "Human Control" dashboard tile doesn't permanently
 *      count cancelled appointments.
 *   2. There's no lingering attribution attached to a terminal row.
 *
 * Regression target: a future refactor removes the
 * `...CLEAR_HUMAN_CONTROL_STATE` spread from `cancelled.ts`
 * `buildUpdateData`. This test fails loudly in that case.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config', () => ({
  config: { jwtSecret: 'test', frontendUrl: 'https://test', backendUrl: 'https://test' },
}));
jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: jest.fn(),
    notifyAppointmentCancelled: jest.fn(),
  },
}));
jest.mock('../services/appointment-notifications.service', () => ({
  // fireAndForget calls `.catch` on the result, so the mocks have
  // to return Promises (not undefined).
  appointmentNotificationsService: { notifyCancelled: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    onCancelled: jest.fn().mockResolvedValue(undefined),
    notifyTransition: jest.fn(),
  },
}));
jest.mock('../services/ai-conversation.service', () => ({
  aiConversationService: {},
}));
jest.mock('../services/audit-event.service', () => ({
  auditEventService: { logAdminAction: jest.fn() },
}));
jest.mock('../services/appointment-event.service', () => ({
  appointmentEventService: { emit: jest.fn() },
}));

// Capture the data object passed to tx.appointmentRequest.update so
// we can assert on its shape — that's where the human-control
// release lands.
let capturedUpdateData: Record<string, unknown> | null = null;

const sampleRow = {
  id: 'apt-1',
  status: 'confirmed',
  user_name: 'Alex',
  user_email: 'alex@example.com',
  therapist_name: 'Dr. T',
  therapist_email: 't@example.com',
  therapist_handle: 'dr-t',
  human_control_enabled: true,
  notes: null,
  confirmed_date_time: '2026-06-01T10:00:00Z',
  confirmed_date_time_parsed: new Date('2026-06-01T10:00:00Z'),
  gmail_thread_id: 'thread-c',
  therapist_gmail_thread_id: 'thread-t',
  transition_generation: 1,
};

const mockTransaction = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  capturedUpdateData = null;
  mockTransaction.mockImplementation(
    async (callback: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([sampleRow]),
        appointmentRequest: {
          update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
            capturedUpdateData = data;
            return { id: 'apt-1' };
          }),
        },
        appointmentAuditEvent: {
          create: jest.fn().mockResolvedValue(undefined),
        },
      };
      return callback(tx);
    },
  );
});

import { transitionToCancelled } from '../domain/scheduling/lifecycle/transitions/cancelled';

describe('transitionToCancelled — human-control auto-release', () => {
  it('clears all four humanControl* fields in the same DB transaction', async () => {
    await transitionToCancelled({
      appointmentId: 'apt-1',
      reason: 'Test',
      cancelledBy: 'therapist',
      source: 'admin',
      adminId: 'admin-7',
    });

    expect(capturedUpdateData).not.toBeNull();
    expect(capturedUpdateData).toMatchObject({
      status: 'cancelled',
      humanControlEnabled: false,
      humanControlTakenBy: null,
      humanControlTakenAt: null,
      humanControlReason: null,
    });
  });

  it.each(['admin', 'therapist', 'client'] as const)(
    'releases human control regardless of cancelledBy=%s',
    async (cancelledBy) => {
      await transitionToCancelled({
        appointmentId: 'apt-1',
        reason: 'Test',
        cancelledBy,
        source: 'admin',
        adminId: 'admin-7',
      });

      expect(capturedUpdateData).toMatchObject({
        humanControlEnabled: false,
        humanControlTakenBy: null,
      });
    },
  );

  it('still clears human control on system-initiated cancellations', async () => {
    // The bounce path / cleanup flows wouldn't typically have
    // human control on, but for defensiveness the release still
    // happens — keeps the invariant simple ("cancelled → all
    // human-control fields null").
    await transitionToCancelled({
      appointmentId: 'apt-1',
      reason: 'Email bounce',
      cancelledBy: 'system',
      source: 'system',
    });

    expect(capturedUpdateData).toMatchObject({
      humanControlEnabled: false,
      humanControlTakenBy: null,
      humanControlTakenAt: null,
      humanControlReason: null,
    });
  });
});

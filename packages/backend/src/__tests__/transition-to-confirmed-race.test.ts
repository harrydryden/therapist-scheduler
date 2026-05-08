/**
 * Tests for the concurrent-reschedule race fix in
 * `appointmentLifecycleService.transitionToConfirmed`.
 *
 * The hardening: each updateMany now carries a "NOT (status=CONFIRMED AND
 * confirmedDateTime = target)" precondition so two concurrent calls that
 * both pass the read-time idempotent skip can't both write — only the
 * first lands. The loser sees count=0 and the post-write re-fetch
 * detects "already at target" and returns an idempotent skip rather than
 * re-firing audit + notifications + SSE.
 *
 * What we're locking down:
 *   - non-atomic path: count=0 + re-fetch shows target state →
 *     { success: true, skipped: true }, no side effects fired
 *   - atomic path: same outcome (was previously atomicSkipped)
 *   - pre-existing behaviour preserved: count=0 + re-fetch shows a
 *     DIFFERENT state → InvalidTransitionError (non-atomic) or
 *     atomicSkipped (atomic)
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

const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();
const mockExecuteRaw = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
    },
    $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a),
  },
}));

const mockOnConfirmed = jest.fn();
const mockOnSessionHeld = jest.fn();
const mockOnCompleted = jest.fn();
const mockOnCancelled = jest.fn();
const mockOnAdminForceUpdate = jest.fn();
const mockNotifyTransition = jest.fn();
const mockNotifyConfirmed = jest.fn();
const mockAuditLog = jest.fn();

jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    notifyTransition: (...a: unknown[]) => mockNotifyTransition(...a),
    onConfirmed: (...a: unknown[]) => mockOnConfirmed(...a),
    onSessionHeld: (...a: unknown[]) => mockOnSessionHeld(...a),
    onCompleted: (...a: unknown[]) => mockOnCompleted(...a),
    onCancelled: (...a: unknown[]) => mockOnCancelled(...a),
    onAdminForceUpdate: (...a: unknown[]) => mockOnAdminForceUpdate(...a),
  },
}));

jest.mock('../services/appointment-notifications.service', () => ({
  appointmentNotificationsService: {
    notifyConfirmed: (...a: unknown[]) => mockNotifyConfirmed(...a),
    notifyCancelled: jest.fn(),
    notifyCompleted: jest.fn(),
  },
}));

jest.mock('../services/audit-event.service', () => ({
  auditEventService: { log: (...a: unknown[]) => mockAuditLog(...a) },
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

import { appointmentLifecycleService } from '../services/appointment-lifecycle.service';
import { InvalidTransitionError } from '../errors';

const TARGET = '2026-06-01T10:00:00.000Z';
const PREVIOUS = '2026-05-15T10:00:00.000Z';

const baseRow = {
  id: 'apt-1',
  status: 'confirmed',
  userName: 'User One',
  userEmail: 'user@example.com',
  therapistName: 'Therapist',
  therapistEmail: 't@example.com',
  therapistHandle: 'therapist-notion',
  confirmedDateTime: PREVIOUS,
  humanControlEnabled: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockExecuteRaw.mockResolvedValue(undefined);
  mockAuditLog.mockResolvedValue(undefined);
  // The lifecycle service wraps these in fireAndForget which calls .catch —
  // they MUST return a thenable, otherwise the success path crashes
  // independent of what we're trying to assert.
  mockOnConfirmed.mockResolvedValue(undefined);
  mockNotifyConfirmed.mockResolvedValue(undefined);
});

function expectNoSideEffectsFired() {
  expect(mockOnConfirmed).not.toHaveBeenCalled();
  expect(mockNotifyConfirmed).not.toHaveBeenCalled();
  expect(mockNotifyTransition).not.toHaveBeenCalled();
}

function expectNoAuditWrites() {
  // The status_change audit_event row and the conversation_state JSON
  // message should both be skipped on idempotent paths.
  expect(mockAuditLog).not.toHaveBeenCalled();
  expect(mockExecuteRaw).not.toHaveBeenCalled();
}

describe('transitionToConfirmed concurrent reschedule race', () => {
  describe('non-atomic path', () => {
    it('returns idempotent skip when count=0 and re-fetch shows target datetime', async () => {
      // Initial read: row at CONFIRMED@PREVIOUS, our target is TARGET → not idempotent
      mockFindUnique.mockResolvedValueOnce(baseRow);
      // updateMany trips the notAlreadyAtTarget guard (concurrent caller already wrote)
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      // Re-fetch: row now at CONFIRMED@TARGET → idempotent skip
      mockFindUnique.mockResolvedValueOnce({
        status: 'confirmed',
        confirmedDateTime: TARGET,
      });

      const result = await appointmentLifecycleService.transitionToConfirmed({
        appointmentId: 'apt-1',
        confirmedDateTime: TARGET,
        source: 'admin',
        adminId: 'admin-7',
      });

      expect(result).toEqual({
        success: true,
        previousStatus: 'confirmed',
        newStatus: 'confirmed',
        skipped: true,
      });
      expectNoSideEffectsFired();
      expectNoAuditWrites();
    });

    it('throws InvalidTransitionError when count=0 and re-fetch shows a non-target state', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...baseRow, status: 'negotiating', confirmedDateTime: null });
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      // Status drifted to cancelled between read and write → real invalid transition
      mockFindUnique.mockResolvedValueOnce({
        status: 'cancelled',
        confirmedDateTime: null,
      });

      await expect(
        appointmentLifecycleService.transitionToConfirmed({
          appointmentId: 'apt-1',
          confirmedDateTime: TARGET,
          source: 'admin',
          adminId: 'admin-7',
        }),
      ).rejects.toBeInstanceOf(InvalidTransitionError);

      expectNoSideEffectsFired();
    });
  });

  describe('atomic path', () => {
    it('returns idempotent skip when count=0 and re-fetch shows target datetime', async () => {
      mockFindUnique.mockResolvedValueOnce(baseRow);
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockFindUnique.mockResolvedValueOnce({
        status: 'confirmed',
        humanControlEnabled: false,
        confirmedDateTime: TARGET,
      });

      const result = await appointmentLifecycleService.transitionToConfirmed({
        appointmentId: 'apt-1',
        confirmedDateTime: TARGET,
        source: 'admin',
        adminId: 'admin-7',
        atomic: { requireStatuses: ['confirmed', 'negotiating'] },
      });

      expect(result).toEqual({
        success: true,
        previousStatus: 'confirmed',
        newStatus: 'confirmed',
        skipped: true,
      });
      expectNoSideEffectsFired();
      expectNoAuditWrites();
    });

    it('returns atomicSkipped when count=0 and re-fetch shows confirmed at a DIFFERENT datetime', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...baseRow, status: 'negotiating', confirmedDateTime: null });
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      // Concurrent caller confirmed for a different datetime
      mockFindUnique.mockResolvedValueOnce({
        status: 'confirmed',
        humanControlEnabled: false,
        confirmedDateTime: '2026-07-01T10:00:00.000Z',
      });

      const result = await appointmentLifecycleService.transitionToConfirmed({
        appointmentId: 'apt-1',
        confirmedDateTime: TARGET,
        source: 'admin',
        adminId: 'admin-7',
        atomic: { requireStatuses: ['negotiating'] },
      });

      expect(result).toEqual({
        success: false,
        previousStatus: 'negotiating',
        newStatus: 'confirmed',
        atomicSkipped: true,
      });
      expectNoSideEffectsFired();
    });

    it('returns atomicSkipped when humanControlEnabled flipped on between read and write', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...baseRow, status: 'negotiating', confirmedDateTime: null });
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockFindUnique.mockResolvedValueOnce({
        status: 'negotiating',
        humanControlEnabled: true,
        confirmedDateTime: null,
      });

      const result = await appointmentLifecycleService.transitionToConfirmed({
        appointmentId: 'apt-1',
        confirmedDateTime: TARGET,
        source: 'admin',
        adminId: 'admin-7',
        atomic: {
          requireStatuses: ['negotiating'],
          requireHumanControlDisabled: true,
        },
      });

      expect(result.success).toBe(false);
      expect(result.atomicSkipped).toBe(true);
      expectNoSideEffectsFired();
    });
  });

  it('passes the notAlreadyAtTarget guard into updateMany', async () => {
    mockFindUnique.mockResolvedValueOnce({ ...baseRow, status: 'negotiating', confirmedDateTime: null });
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });

    await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      confirmedDateTime: TARGET,
      source: 'admin',
      adminId: 'admin-7',
    });

    // The where clause must include the NOT-already-at-target guard so a
    // concurrent same-datetime confirmation can't double-fire side effects.
    // Pinning this assertion stops a future refactor from quietly removing
    // the guard.
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          NOT: { status: 'confirmed', confirmedDateTime: TARGET },
        }),
      }),
    );
  });
});

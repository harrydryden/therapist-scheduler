/**
 * Tests for the concurrent-reschedule race fix in
 * `appointmentLifecycleService.transitionToConfirmed`.
 *
 * The hardening is in two layers:
 *   1. The Prisma `update` call carries a "NOT (status=CONFIRMED AND
 *      confirmedDateTime = target)" precondition. Two concurrent calls
 *      that both pass the read-time idempotent skip can't both write —
 *      only the first lands; the loser sees Prisma's P2025
 *      (RecordNotFound) and the post-throw re-fetch decides the next
 *      step.
 *   2. The new generation is captured atomically from `update().select`
 *      so notifications use the post-write transitionGeneration. The
 *      previous read-time `+1` had a race that let two concurrent
 *      transitions land on the same generation and dedupe each other's
 *      side-effect rows away.
 *
 * What we're locking down:
 *   - non-atomic path: P2025 + re-fetch shows target state →
 *     { success: true, skipped: true }, no side effects fired
 *   - atomic path: same outcome (was previously atomicSkipped)
 *   - pre-existing behaviour preserved: P2025 + re-fetch shows a
 *     DIFFERENT state → InvalidTransitionError (non-atomic) or
 *     atomicSkipped (atomic)
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../config', () => require('./_global-mocks').configMock());
jest.mock('../utils/redis', () => require('./_global-mocks').redisMock());
jest.mock('../services/audit-event.service', () => ({
  auditEventService: { log: (...a: unknown[]) => mockAuditLog(...a) },
}));
jest.mock('../services/appointment-event.service', () => require('./_global-mocks').appointmentEventMock());
jest.mock('../services/ai-conversation.service', () => require('./_global-mocks').aiConversationMock());
jest.mock('../services/slack-notification.service', () => require('./_global-mocks').slackNotificationMock());

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
const mockAuditLog = jest.fn();

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

import { appointmentLifecycleService } from '../domain/scheduling/lifecycle';
import { InvalidTransitionError } from '../errors';
import { p2025 } from './_global-mocks';

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
  transitionGeneration: 5,
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
    it('returns idempotent skip when update throws P2025 and re-fetch shows target datetime', async () => {
      // Initial read: row at CONFIRMED@PREVIOUS, our target is TARGET → not idempotent
      mockFindUnique.mockResolvedValueOnce(baseRow);
      // update trips the notAlreadyAtTarget guard (concurrent caller already wrote)
      mockUpdate.mockRejectedValueOnce(p2025());
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

    it('throws InvalidTransitionError when update throws P2025 and re-fetch shows a non-target state', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...baseRow, status: 'negotiating', confirmedDateTime: null });
      mockUpdate.mockRejectedValueOnce(p2025());
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
    it('returns idempotent skip when update throws P2025 and re-fetch shows target datetime', async () => {
      mockFindUnique.mockResolvedValueOnce(baseRow);
      mockUpdate.mockRejectedValueOnce(p2025());
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

    it('returns atomicSkipped when update throws P2025 and re-fetch shows confirmed at a DIFFERENT datetime', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...baseRow, status: 'negotiating', confirmedDateTime: null });
      mockUpdate.mockRejectedValueOnce(p2025());
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
      mockUpdate.mockRejectedValueOnce(p2025());
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

  it('passes the notAlreadyAtTarget guard into update', async () => {
    mockFindUnique.mockResolvedValueOnce({ ...baseRow, status: 'negotiating', confirmedDateTime: null });
    mockUpdate.mockResolvedValueOnce({ transitionGeneration: 6 });

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
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          NOT: { status: 'confirmed', confirmedDateTime: TARGET },
        }),
      }),
    );
  });

  it('uses the post-update transitionGeneration for notifications, not the read-time value', async () => {
    // Read: gen=5. The post-update value (atomic from update RETURNING)
    // is 9 — e.g. several concurrent transitions advanced generation
    // before/along with ours. Our notifications must use 9, not 5+1=6.
    mockFindUnique.mockResolvedValueOnce({ ...baseRow, status: 'negotiating', confirmedDateTime: null, transitionGeneration: 5 });
    mockUpdate.mockResolvedValueOnce({ transitionGeneration: 9 });

    await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      confirmedDateTime: TARGET,
      source: 'admin',
      adminId: 'admin-7',
    });

    expect(mockNotifyConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ transitionGeneration: 9 }),
    );
  });
});

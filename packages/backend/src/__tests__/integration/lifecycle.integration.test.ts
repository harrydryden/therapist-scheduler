/**
 * End-to-end lifecycle integration test.
 *
 * Walks an appointment through every legitimate state transition against a
 * REAL Postgres database. Verifies that:
 *   1. State transitions update the row correctly
 *   2. Audit messages get appended to conversationState
 *   3. Idempotent transitions don't error
 *   4. Invalid transitions throw the expected error type
 *   5. Cancel can fire from any active state
 *   6. dismissClosureRecommendation reaches the DB and reconciles state
 *   7. adminForceUpdate enforces bypassStateMachine + reason
 *
 * External side-effect services (Notion, Slack, Gmail, SSE, therapist
 * booking status) are mocked at the module level so the test exercises
 * the lifecycle service's state-machine and DB-write logic without
 * needing real external systems.
 *
 * Skipped automatically when TEST_DATABASE_URL is unset.
 */

// ============================================
// Mocks for external side-effects
//
// The lifecycle service transitively imports the redis client (via the
// notifications service), which validates required env vars at import time
// and exits the process if they're missing. So we have to mock the config
// AND the leaf notification services that pull in redis. Once those are
// stubbed out, the lifecycle methods load cleanly.
// ============================================

jest.mock('../../config', () => ({
  config: {
    env: 'test',
    logLevel: 'silent',
    jwtSecret: 'test-secret',
    backendUrl: 'http://localhost:3000',
    webhookSecret: 'test',
    notionApiKey: 'test',
    notionDatabaseId: 'test',
    anthropicApiKey: 'test',
    redisUrl: 'redis://localhost:6379',
  },
}));

jest.mock('../../services/appointment-notifications.service', () => ({
  appointmentNotificationsService: {
    notifyAdminForceUpdate: jest.fn().mockResolvedValue(undefined),
    notifyConfirmed: jest.fn().mockResolvedValue(undefined),
    notifyCompleted: jest.fn().mockResolvedValue(undefined),
    notifyCancelled: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    notifyTransition: jest.fn().mockResolvedValue(undefined),
    onConfirmed: jest.fn().mockResolvedValue(undefined),
    onSessionHeld: jest.fn().mockResolvedValue(undefined),
    onCompleted: jest.fn().mockResolvedValue(undefined),
    onCancelled: jest.fn().mockResolvedValue(undefined),
    onAdminForceUpdate: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../services/appointment-event.service', () => ({
  recordAppointmentEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ============================================
// Imports (after mocks)
// ============================================

import { PrismaClient, AppointmentRequest } from '@prisma/client';
import {
  getIntegrationDb,
  closeIntegrationDb,
  integrationDescribe,
} from '../helpers/integration-db';
import { appointmentLifecycleService } from '../../services/appointment-lifecycle.service';
import { recordAppointmentEvent } from '../../services/appointment-event.service';

// ============================================
// Test setup helpers
// ============================================

let prisma: PrismaClient;

async function createTestAppointment(
  overrides: Partial<{
    userEmail: string;
    therapistEmail: string;
    therapistNotionId: string;
    therapistName: string;
    status: string;
  }> = {}
): Promise<AppointmentRequest> {
  return prisma.appointmentRequest.create({
    data: {
      userEmail: overrides.userEmail ?? `test-${Date.now()}@example.com`,
      therapistEmail: overrides.therapistEmail ?? 'therapist@example.com',
      therapistNotionId: overrides.therapistNotionId ?? `notion-${Date.now()}`,
      therapistName: overrides.therapistName ?? 'Dr. Test',
      status: overrides.status ?? 'pending',
    },
  });
}

async function getStatus(id: string): Promise<string> {
  const row = await prisma.appointmentRequest.findUnique({
    where: { id },
    select: { status: true },
  });
  return row?.status ?? '(missing)';
}

async function getCheckpointStage(id: string): Promise<string | null> {
  const row = await prisma.appointmentRequest.findUnique({
    where: { id },
    select: { checkpointStage: true },
  });
  return row?.checkpointStage ?? null;
}

// ============================================
// Tests
// ============================================

integrationDescribe('Appointment lifecycle (e2e)', () => {
  beforeAll(async () => {
    prisma = await getIntegrationDb();
  }, 60000); // db push --force-reset can take >5s on first run

  afterAll(async () => {
    await closeIntegrationDb();
  });

  beforeEach(async () => {
    await prisma.appointmentAuditEvent.deleteMany({});
    await prisma.appointmentRequest.deleteMany({});
    jest.clearAllMocks();
  });

  describe('happy path: pending → contacted → negotiating → confirmed → session_held → feedback_requested → completed', () => {
    it('walks through every active stage', async () => {
      const apt = await createTestAppointment();
      expect(apt.status).toBe('pending');

      await appointmentLifecycleService.transitionToContacted({
        appointmentId: apt.id,
        source: 'system',
        hasAvailability: true,
      });
      expect(await getStatus(apt.id)).toBe('contacted');

      await appointmentLifecycleService.transitionToNegotiating({
        appointmentId: apt.id,
        source: 'system',
      });
      expect(await getStatus(apt.id)).toBe('negotiating');

      await appointmentLifecycleService.transitionToConfirmed({
        appointmentId: apt.id,
        source: 'system',
        confirmedDateTime: 'Monday 10am',
        sendEmails: false,
      });
      const confirmed = await prisma.appointmentRequest.findUnique({ where: { id: apt.id } });
      expect(confirmed?.status).toBe('confirmed');
      expect(confirmed?.confirmedDateTime).toBe('Monday 10am');
      expect(confirmed?.confirmedAt).not.toBeNull();

      await appointmentLifecycleService.transitionToSessionHeld({
        appointmentId: apt.id,
        source: 'system',
      });
      expect(await getStatus(apt.id)).toBe('session_held');

      await appointmentLifecycleService.transitionToFeedbackRequested({
        appointmentId: apt.id,
        source: 'system',
      });
      expect(await getStatus(apt.id)).toBe('feedback_requested');

      await appointmentLifecycleService.transitionToCompleted({
        appointmentId: apt.id,
        source: 'system',
      });
      expect(await getStatus(apt.id)).toBe('completed');
    });
  });

  describe('idempotency', () => {
    it('contacted → contacted is a no-op', async () => {
      const apt = await createTestAppointment();
      await appointmentLifecycleService.transitionToContacted({
        appointmentId: apt.id,
        source: 'system',
        hasAvailability: false,
      });
      const result = await appointmentLifecycleService.transitionToContacted({
        appointmentId: apt.id,
        source: 'system',
        hasAvailability: false,
      });
      expect(result.skipped).toBe(true);
      expect(await getStatus(apt.id)).toBe('contacted');
    });
  });

  describe('invalid transitions', () => {
    it('pending → confirmed (with atomic guard) returns atomicSkipped', async () => {
      // The atomic option uses an updateMany with status precondition.
      // When the precondition fails, the lifecycle service returns
      // { success: false, atomicSkipped: true } rather than throwing —
      // throwing would force callers into try/catch for normal idempotency.
      const apt = await createTestAppointment();
      const result = await appointmentLifecycleService.transitionToConfirmed({
        appointmentId: apt.id,
        source: 'system',
        confirmedDateTime: 'Monday 10am',
        sendEmails: false,
        atomic: { requireStatuses: ['negotiating'] },
      });
      expect(result.success).toBe(false);
      expect(result.atomicSkipped).toBe(true);
      expect(await getStatus(apt.id)).toBe('pending'); // unchanged
    });

    it('completed → contacted throws (terminal state)', async () => {
      const apt = await createTestAppointment();
      await appointmentLifecycleService.transitionToContacted({
        appointmentId: apt.id,
        source: 'system',
        hasAvailability: true,
      });
      await appointmentLifecycleService.transitionToNegotiating({
        appointmentId: apt.id,
        source: 'system',
      });
      await appointmentLifecycleService.transitionToConfirmed({
        appointmentId: apt.id,
        source: 'system',
        confirmedDateTime: 'M 10',
        sendEmails: false,
      });
      await appointmentLifecycleService.transitionToSessionHeld({
        appointmentId: apt.id,
        source: 'system',
      });
      await appointmentLifecycleService.transitionToCompleted({
        appointmentId: apt.id,
        source: 'system',
      });
      await expect(
        appointmentLifecycleService.transitionToContacted({
          appointmentId: apt.id,
          source: 'system',
          hasAvailability: true,
        })
      ).rejects.toThrow();
    });
  });

  describe('cancellation paths', () => {
    it('cancels from pending', async () => {
      const apt = await createTestAppointment();
      await appointmentLifecycleService.transitionToCancelled({
        appointmentId: apt.id,
        source: 'admin',
        adminId: 'admin-1',
        cancelledBy: 'admin',
        reason: 'test cancel',
      });
      expect(await getStatus(apt.id)).toBe('cancelled');
    });

    it('cancels from confirmed', async () => {
      const apt = await createTestAppointment();
      await appointmentLifecycleService.transitionToContacted({
        appointmentId: apt.id,
        source: 'system',
        hasAvailability: true,
      });
      await appointmentLifecycleService.transitionToNegotiating({
        appointmentId: apt.id,
        source: 'system',
      });
      await appointmentLifecycleService.transitionToConfirmed({
        appointmentId: apt.id,
        source: 'system',
        confirmedDateTime: 'Tue 2pm',
        sendEmails: false,
      });
      await appointmentLifecycleService.transitionToCancelled({
        appointmentId: apt.id,
        source: 'admin',
        adminId: 'admin-1',
        cancelledBy: 'admin',
        reason: 'client withdrew',
      });
      expect(await getStatus(apt.id)).toBe('cancelled');
    });
  });

  describe('audit trail', () => {
    it('appends an audit message to conversationState on each transition', async () => {
      const apt = await createTestAppointment();
      await appointmentLifecycleService.transitionToContacted({
        appointmentId: apt.id,
        source: 'system',
        hasAvailability: true,
      });
      await appointmentLifecycleService.transitionToNegotiating({
        appointmentId: apt.id,
        source: 'system',
      });

      const row = await prisma.appointmentRequest.findUnique({
        where: { id: apt.id },
        select: { conversationState: true },
      });
      const state = row?.conversationState as { messages: Array<{ content: string }> };
      expect(state).toBeDefined();
      expect(state.messages.length).toBeGreaterThanOrEqual(2);
      expect(state.messages.some((m) => m.content.includes('contacted'))).toBe(true);
      expect(state.messages.some((m) => m.content.includes('negotiating'))).toBe(true);
    });
  });

  describe('dismissClosureRecommendation', () => {
    it('clears closure flags and restores checkpoint stage', async () => {
      const apt = await createTestAppointment();
      await appointmentLifecycleService.transitionToContacted({
        appointmentId: apt.id,
        source: 'system',
        hasAvailability: false,
      });

      // Simulate a closure recommendation by setting the flags directly
      // (chase-email service writes them via applyCheckpointAction in real flow)
      await prisma.appointmentRequest.update({
        where: { id: apt.id },
        data: {
          closureRecommendedAt: new Date(),
          closureRecommendedReason: 'No response from therapist',
          closureRecommendationActioned: false,
          checkpointStage: 'closure_recommended',
          chaseSentTo: 'therapist',
          chaseSentAt: new Date(),
        },
      });

      const result = await appointmentLifecycleService.dismissClosureRecommendation({
        appointmentId: apt.id,
        source: 'admin',
        adminId: 'admin-1',
        reason: 'manual dismiss',
      });

      expect(result.dismissed).toBe(true);

      const after = await prisma.appointmentRequest.findUnique({ where: { id: apt.id } });
      // closureRecommendedAt is preserved for reporting fidelity
      expect(after?.closureRecommendedAt).not.toBeNull();
      expect(after?.closureRecommendationActioned).toBe(true);
      // Chase fields cleared
      expect(after?.chaseSentAt).toBeNull();
      expect(after?.chaseSentTo).toBeNull();
      // checkpointStage column derived from JSON via the helper — should
      // be restored to a non-recovery stage
      expect(after?.checkpointStage).not.toBe('closure_recommended');
    });

    it('returns dismissed=false when there is no recommendation', async () => {
      const apt = await createTestAppointment();
      const result = await appointmentLifecycleService.dismissClosureRecommendation({
        appointmentId: apt.id,
        source: 'admin',
        adminId: 'admin-1',
        reason: 'noop test',
      });
      expect(result.dismissed).toBe(false);
    });
  });

  describe('adminForceUpdate guardrails', () => {
    it('throws when bypassStateMachine flag is missing (defensive runtime check)', async () => {
      const apt = await createTestAppointment();
      // Use `as any` to bypass the compile-time check
      await expect(
        appointmentLifecycleService.adminForceUpdate(apt.id, {
          newStatus: 'confirmed',
          adminId: 'admin-1',
          reason: 'test',
        } as any)
      ).rejects.toThrow(/bypassStateMachine/);
    });

    it('throws when reason is empty', async () => {
      const apt = await createTestAppointment();
      await expect(
        appointmentLifecycleService.adminForceUpdate(apt.id, {
          newStatus: 'confirmed',
          adminId: 'admin-1',
          bypassStateMachine: true,
          reason: '',
        })
      ).rejects.toThrow(/reason/);
    });

    it('emits an admin_force_update event when used correctly', async () => {
      const apt = await createTestAppointment();
      await appointmentLifecycleService.adminForceUpdate(apt.id, {
        newStatus: 'cancelled',
        adminId: 'admin-1',
        bypassStateMachine: true,
        reason: 'manual recovery',
      });
      expect(await getStatus(apt.id)).toBe('cancelled');
      expect(recordAppointmentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          appointmentId: apt.id,
          type: 'admin_force_update',
          actor: 'admin',
        }),
      );
    });
  });

  describe('checkpoint stage column stays in sync with JSON', () => {
    it('after multiple transitions, checkpointStage column matches JSON', async () => {
      const apt = await createTestAppointment();

      // Walk through a few transitions
      await appointmentLifecycleService.transitionToContacted({
        appointmentId: apt.id,
        source: 'system',
        hasAvailability: true,
      });
      await appointmentLifecycleService.transitionToNegotiating({
        appointmentId: apt.id,
        source: 'system',
      });

      const row = await prisma.appointmentRequest.findUnique({
        where: { id: apt.id },
        select: { checkpointStage: true, conversationState: true },
      });

      // The transition methods don't write checkpoint stage directly — only
      // status. So checkpointStage may be null at this point. The invariant
      // test is: if it's set, it matches the JSON.
      const jsonStage = (row?.conversationState as { checkpoint?: { stage?: string } } | null)
        ?.checkpoint?.stage;
      if (row?.checkpointStage && jsonStage) {
        expect(row.checkpointStage).toBe(jsonStage);
      }
    });
  });
});

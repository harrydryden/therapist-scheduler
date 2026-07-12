/**
 * Tests for `runTerminalTransitionTx` — the shared transactional skeleton
 * used by transitionToCompleted and transitionToCancelled.
 *
 * The helper itself owns no database state; it sets up a serialisable
 * transaction, calls back into the test's `fetchAndLock`/`classify`/
 * `buildUpdateData`/`buildAuditPayload`, and orchestrates the row update
 * + status_change audit event. We mock `prisma.$transaction` to invoke
 * the supplied callback with a fake `tx` whose stub methods record
 * exactly what the helper would write.
 *
 * Coverage targets every branch the helper can take:
 *   - row not found → throws AppointmentNotFoundError, no writes
 *   - classify=idempotent → no writes, kind:'idempotent'
 *   - classify=atomicSkipped → no writes, kind:'atomicSkipped'
 *   - classify=proceed → update + audit_event written, kind:'success'
 *   - classify throws → exception bubbles, no writes (would roll back tx)
 *   - actor formatting differs for admin vs agent vs system
 *   - Serializable isolation level + 10s timeout passed through
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Stub the heavy imports that the lifecycle module pulls in at
// module evaluation time (notifications → slack → redis → config). The
// helper under test only touches prisma + the supplied callbacks, so the
// rest of the dependency graph just needs to load without side effects.
jest.mock('../config', () => ({
  config: {
    jwtSecret: 'test-secret',
    backendUrl: 'https://backend.test',
    frontendUrl: 'https://frontend.test',
  },
}));

jest.mock('../utils/redis', () => ({
  redis: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  },
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: jest.fn(),
    notifyAppointmentConfirmed: jest.fn(),
    notifyAppointmentCancelled: jest.fn(),
    notifyAppointmentCompleted: jest.fn(),
  },
}));

jest.mock('../services/appointment-notifications.service', () => ({
  appointmentNotificationsService: {
    notifyConfirmed: jest.fn(),
    notifyCancelled: jest.fn(),
    notifyCompleted: jest.fn(),
  },
}));

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

const mockTx = {
  appointmentRequest: { update: jest.fn() },
  appointmentAuditEvent: { create: jest.fn() },
};

const mockTransaction = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

import { Prisma } from '@prisma/client';
// runTerminalTransitionTx is re-exported by the lifecycle barrel.
// Import from the submodule to keep this test's dep graph narrow —
// avoids transitively loading the heavy transitions/* + service.ts.
import { runTerminalTransitionTx } from '../domain/scheduling/lifecycle/terminal-tx';
import { AppointmentNotFoundError } from '../errors';

beforeEach(() => {
  jest.clearAllMocks();
  // Default $transaction implementation: invoke the callback with our fake tx.
  mockTransaction.mockImplementation(async (callback: (tx: typeof mockTx) => unknown) => {
    return callback(mockTx);
  });
  mockTx.appointmentRequest.update.mockResolvedValue({ id: 'apt-1' });
  mockTx.appointmentAuditEvent.create.mockResolvedValue(undefined);
});

const baseArgs = {
  appointmentId: 'apt-1',
  source: 'admin' as const,
  adminId: 'admin-7',
};

const sampleRow = {
  id: 'apt-1',
  status: 'session_held',
  notes: null as string | null,
  transition_generation: 5,
};

describe('runTerminalTransitionTx', () => {
  it('throws AppointmentNotFoundError when fetchAndLock returns null', async () => {
    await expect(
      runTerminalTransitionTx({
        ...baseArgs,
        fetchAndLock: async () => null,
        classify: () => 'proceed',
        buildUpdateData: () => ({}),
        buildAuditPayload: () => ({}),
      }),
    ).rejects.toBeInstanceOf(AppointmentNotFoundError);

    expect(mockTx.appointmentRequest.update).not.toHaveBeenCalled();
    expect(mockTx.appointmentAuditEvent.create).not.toHaveBeenCalled();
  });

  it('returns idempotent without writing when classify returns "idempotent"', async () => {
    const row = { ...sampleRow, status: 'completed' };
    const outcome = await runTerminalTransitionTx({
      ...baseArgs,
      fetchAndLock: async () => row,
      classify: () => 'idempotent',
      buildUpdateData: () => ({ status: 'completed' }),
      buildAuditPayload: () => ({ foo: 'bar' }),
    });

    expect(outcome.kind).toBe('idempotent');
    expect(outcome.row).toBe(row);
    expect(outcome.previousStatus).toBe('completed');
    expect(mockTx.appointmentRequest.update).not.toHaveBeenCalled();
    expect(mockTx.appointmentAuditEvent.create).not.toHaveBeenCalled();
  });

  it('returns atomicSkipped without writing when classify returns "atomicSkipped"', async () => {
    const outcome = await runTerminalTransitionTx({
      ...baseArgs,
      fetchAndLock: async () => sampleRow,
      classify: () => 'atomicSkipped',
      buildUpdateData: () => ({}),
      buildAuditPayload: () => ({}),
    });

    expect(outcome.kind).toBe('atomicSkipped');
    expect(outcome.previousStatus).toBe('session_held');
    expect(mockTx.appointmentRequest.update).not.toHaveBeenCalled();
    expect(mockTx.appointmentAuditEvent.create).not.toHaveBeenCalled();
  });

  it('writes update + audit_event and returns success when classify returns "proceed"', async () => {
    const updateData = { status: 'completed', notes: 'session done' };
    const auditPayload = { previousStatus: 'session_held', newStatus: 'completed', reason: 'manual' };

    const outcome = await runTerminalTransitionTx({
      ...baseArgs,
      fetchAndLock: async () => sampleRow,
      classify: () => 'proceed',
      buildUpdateData: () => updateData,
      buildAuditPayload: () => auditPayload,
    });

    expect(outcome.kind).toBe('success');
    expect(outcome.row).toBe(sampleRow);
    expect(outcome.previousStatus).toBe('session_held');

    expect(mockTx.appointmentRequest.update).toHaveBeenCalledWith({
      where: { id: 'apt-1' },
      data: updateData,
      select: { id: true },
    });

    expect(mockTx.appointmentAuditEvent.create).toHaveBeenCalledWith({
      data: {
        appointmentRequestId: 'apt-1',
        eventType: 'status_change',
        actor: 'admin:admin-7',
        payload: auditPayload,
      },
    });
  });

  describe('registerEffects hook (register-in-tx)', () => {
    it('calls registerEffects with (tx, row, postUpdateGeneration) after the audit event, on the proceed path', async () => {
      const registerEffects = jest.fn().mockResolvedValue(undefined);
      const callOrder: string[] = [];
      mockTx.appointmentAuditEvent.create.mockImplementation(async () => {
        callOrder.push('audit');
      });
      registerEffects.mockImplementation(async () => {
        callOrder.push('registerEffects');
      });

      await runTerminalTransitionTx({
        ...baseArgs,
        fetchAndLock: async () => sampleRow,
        classify: () => 'proceed',
        buildUpdateData: () => ({}),
        buildAuditPayload: () => ({}),
        registerEffects,
      });

      expect(registerEffects).toHaveBeenCalledWith(mockTx, sampleRow, sampleRow.transition_generation + 1);
      expect(callOrder).toEqual(['audit', 'registerEffects']);
    });

    it('does not call registerEffects on the idempotent or atomicSkipped paths', async () => {
      const registerEffects = jest.fn().mockResolvedValue(undefined);

      await runTerminalTransitionTx({
        ...baseArgs,
        fetchAndLock: async () => sampleRow,
        classify: () => 'idempotent',
        buildUpdateData: () => ({}),
        buildAuditPayload: () => ({}),
        registerEffects,
      });
      await runTerminalTransitionTx({
        ...baseArgs,
        fetchAndLock: async () => sampleRow,
        classify: () => 'atomicSkipped',
        buildUpdateData: () => ({}),
        buildAuditPayload: () => ({}),
        registerEffects,
      });

      expect(registerEffects).not.toHaveBeenCalled();
    });

    it('is optional — proceeds without it exactly as before', async () => {
      await expect(
        runTerminalTransitionTx({
          ...baseArgs,
          fetchAndLock: async () => sampleRow,
          classify: () => 'proceed',
          buildUpdateData: () => ({}),
          buildAuditPayload: () => ({}),
        }),
      ).resolves.toMatchObject({ kind: 'success' });
    });
  });

  it('propagates throws from classify and writes nothing (transaction will roll back)', async () => {
    const boom = new Error('invalid source status');

    await expect(
      runTerminalTransitionTx({
        ...baseArgs,
        fetchAndLock: async () => sampleRow,
        classify: () => {
          throw boom;
        },
        buildUpdateData: () => ({}),
        buildAuditPayload: () => ({}),
      }),
    ).rejects.toBe(boom);

    expect(mockTx.appointmentRequest.update).not.toHaveBeenCalled();
    expect(mockTx.appointmentAuditEvent.create).not.toHaveBeenCalled();
  });

  describe('actor formatting', () => {
    it('formats admin source as admin:<adminId>', async () => {
      await runTerminalTransitionTx({
        ...baseArgs,
        source: 'admin',
        adminId: 'admin-42',
        fetchAndLock: async () => sampleRow,
        classify: () => 'proceed',
        buildUpdateData: () => ({}),
        buildAuditPayload: () => ({}),
      });

      expect(mockTx.appointmentAuditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actor: 'admin:admin-42' }),
        }),
      );
    });

    it('falls back to admin:unknown when adminId is missing', async () => {
      await runTerminalTransitionTx({
        appointmentId: 'apt-1',
        source: 'admin',
        fetchAndLock: async () => sampleRow,
        classify: () => 'proceed',
        buildUpdateData: () => ({}),
        buildAuditPayload: () => ({}),
      });

      expect(mockTx.appointmentAuditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actor: 'admin:unknown' }),
        }),
      );
    });

    it('passes non-admin source through verbatim', async () => {
      for (const source of ['agent', 'system', 'feedback_sync'] as const) {
        mockTx.appointmentAuditEvent.create.mockClear();
        await runTerminalTransitionTx({
          appointmentId: 'apt-1',
          source,
          fetchAndLock: async () => sampleRow,
          classify: () => 'proceed',
          buildUpdateData: () => ({}),
          buildAuditPayload: () => ({}),
        });
        expect(mockTx.appointmentAuditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ actor: source }),
          }),
        );
      }
    });
  });

  it('opens the transaction with Serializable isolation + 10s timeout', async () => {
    await runTerminalTransitionTx({
      ...baseArgs,
      fetchAndLock: async () => sampleRow,
      classify: () => 'proceed',
      buildUpdateData: () => ({}),
      buildAuditPayload: () => ({}),
    });

    // The helper's contract: serializable + 10s timeout. Pinning these here
    // means a future change that loosens isolation or shrinks the timeout
    // (which would weaken the FOR UPDATE row-lock guarantee or cause more
    // tx-aborts under contention) shows up as a test failure rather than a
    // silent regression.
    expect(mockTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
      }),
    );
  });
});

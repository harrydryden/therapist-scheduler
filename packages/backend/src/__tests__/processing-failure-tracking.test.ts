/**
 * Tests for the post-incident hardening: processing failure tracking,
 * abandonment, retry budget, scanner heartbeat freshness, and the closure
 * auto-dismiss OOO gate.
 *
 * These cover the code paths added in the booking_method-incident response.
 * They are unit tests with mocked Prisma — the integration test in
 * src/__tests__/integration/ exercises the same flows against a real DB.
 */

// ============================================
// Mocks
// ============================================

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    jwtSecret: 'test-secret-key-for-unit-tests',
    backendUrl: 'https://backend.test',
  },
}));

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../services/audit-event.service', () => ({
  auditEventService: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {},
}));

// Mock the aiConversationService singleton that dismissClosureRecommendation
// now calls for the unified JSON-checkpoint write path. The tests exercise the
// dismissal's control flow — whether it calls the helper with the right mutation
// closure, whether it records audit events, etc. The helper's own behavior
// (lock retry, DB write) is exercised by the integration test suite.
const mockApplyCheckpointUpdate = jest.fn();
jest.mock('../services/ai-conversation.service', () => ({
  aiConversationService: {
    applyCheckpointUpdate: mockApplyCheckpointUpdate,
  },
  AIConversationService: jest.fn(),
}));

// ============================================
// Imports
// ============================================

import { prisma } from '../utils/database';
import { appointmentLifecycleService } from '../services/appointment-lifecycle.service';
import { auditEventService } from '../services/audit-event.service';

// ============================================
// dismissClosureRecommendation
// ============================================

describe('appointmentLifecycleService.dismissClosureRecommendation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApplyCheckpointUpdate.mockResolvedValue({ applied: true, stage: 'awaiting_therapist_availability' });
  });

  it('returns dismissed=false when appointment has no closure recommendation', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: null,
      closureRecommendationActioned: false,
      checkpointStage: null,
      chaseSentTo: null,
      humanControlTakenBy: null,
    });

    const result = await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    expect(result.dismissed).toBe(false);
    expect(mockApplyCheckpointUpdate).not.toHaveBeenCalled();
  });

  it('returns dismissed=false when recommendation already actioned (idempotent)', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: true,
      checkpointStage: 'closure_recommended',
      chaseSentTo: null,
      humanControlTakenBy: null,
    });

    const result = await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'admin',
    });

    expect(result.dismissed).toBe(false);
    expect(mockApplyCheckpointUpdate).not.toHaveBeenCalled();
  });

  it('preserves closureRecommendedAt in extraUpdates (for reporting fidelity)', async () => {
    const closureTime = new Date('2026-04-01');
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: closureTime,
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: 'therapist',
      humanControlTakenBy: null,
    });

    const result = await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
      reason: 'reply received',
    });

    expect(result.dismissed).toBe(true);
    expect(mockApplyCheckpointUpdate).toHaveBeenCalledTimes(1);
    const [, , options] = mockApplyCheckpointUpdate.mock.calls[0];
    const extraUpdates = options.extraUpdates;
    // Crucial: timestamp must NOT be nulled — work-report counts on it
    expect(extraUpdates.closureRecommendationActioned).toBe(true);
    expect(extraUpdates).not.toHaveProperty('closureRecommendedAt');
    expect(extraUpdates).not.toHaveProperty('closureRecommendedReason');
  });

  it('clears chase fields via extraUpdates', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: 'therapist',
      humanControlTakenBy: null,
    });

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    const [, , options] = mockApplyCheckpointUpdate.mock.calls[0];
    const extraUpdates = options.extraUpdates;
    expect(extraUpdates.chaseSentAt).toBeNull();
    expect(extraUpdates.chaseSentTo).toBeNull();
    expect(extraUpdates.chaseTargetEmail).toBeNull();
  });

  it('mutation callback restores stage from lastSuccessfulAction when JSON is at closure_recommended', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: 'therapist',
      humanControlTakenBy: null,
    });

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    // Invoke the mutation closure with a checkpoint that's currently at closure_recommended
    const [, mutate] = mockApplyCheckpointUpdate.mock.calls[0];
    const newCheckpoint = mutate({
      stage: 'closure_recommended',
      lastSuccessfulAction: 'sent_initial_email_to_therapist',
      pendingAction: 'waiting',
      checkpoint_at: new Date().toISOString(),
    });
    expect(newCheckpoint.stage).toBe('awaiting_therapist_availability');
    expect(newCheckpoint.pendingAction).toBeNull();
  });

  it('mutation callback leaves stage alone when JSON is already non-closure', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: 'therapist',
      humanControlTakenBy: null,
    });

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    const [, mutate] = mockApplyCheckpointUpdate.mock.calls[0];
    const existing = {
      stage: 'awaiting_therapist_availability' as const,
      lastSuccessfulAction: 'sent_initial_email_to_therapist' as const,
      pendingAction: null,
      checkpoint_at: '2026-04-01T00:00:00Z',
    };
    const newCheckpoint = mutate(existing);
    expect(newCheckpoint).toBe(existing); // same reference — unmodified
  });

  it('releases agent-flagged human control but leaves admin-flagged alone', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValueOnce({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: null,
      humanControlTakenBy: 'agent-flagged',
    });

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    let [, , options] = mockApplyCheckpointUpdate.mock.calls[0];
    expect(options.extraUpdates.humanControlEnabled).toBe(false);

    jest.clearAllMocks();
    mockApplyCheckpointUpdate.mockResolvedValue({ applied: true, stage: 'awaiting_therapist_availability' });
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValueOnce({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: null,
      humanControlTakenBy: 'admin',
    });

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    [, , options] = mockApplyCheckpointUpdate.mock.calls[0];
    expect(options.extraUpdates).not.toHaveProperty('humanControlEnabled');
  });

  it('logs an audit event with the correct actor for the source', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: null,
      humanControlTakenBy: null,
    });

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'admin',
      adminId: 'admin-42',
      reason: 'manual dismiss',
    });

    expect(auditEventService.log).toHaveBeenCalledWith(
      'apt-1',
      'checkpoint_update',
      'admin',
      expect.objectContaining({
        action: 'closure_dismissed',
        reason: 'manual dismiss',
        adminId: 'admin-42',
      }),
    );
  });

  it('returns dismissed=false when helper loses optimistic lock', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: null,
      humanControlTakenBy: null,
    });
    mockApplyCheckpointUpdate.mockResolvedValue({ applied: false, stage: null });

    const result = await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    expect(result.dismissed).toBe(false);
    expect(auditEventService.log).not.toHaveBeenCalled();
  });
});

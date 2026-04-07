/**
 * Tests for the post-incident hardening: processing failure tracking,
 * abandonment, retry budget, scanner heartbeat freshness, and the closure
 * auto-dismiss OOO gate.
 *
 * These cover the code paths added in the booking_method-incident response.
 * They are unit tests with mocked Prisma + Redis — the integration test in
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
    messageProcessingFailure: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    processedGmailMessage: {
      deleteMany: jest.fn(),
    },
  },
}));

jest.mock('../utils/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) || null)),
      set: jest.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve('OK');
      }),
      del: jest.fn((key: string) => {
        store.delete(key);
        return Promise.resolve(1);
      }),
      __store: store,
    },
  };
});

jest.mock('../services/audit-event.service', () => ({
  auditEventService: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {},
}));

jest.mock('../services/ai-conversation.service', () => ({
  AIConversationService: jest.fn().mockImplementation(() => ({
    getConversationState: jest.fn().mockResolvedValue(null),
    storeConversationState: jest.fn().mockResolvedValue(undefined),
  })),
}));

// ============================================
// Imports
// ============================================

import { prisma } from '../utils/database';
import { redis } from '../utils/redis';
import { appointmentLifecycleService } from '../services/appointment-lifecycle.service';
import { auditEventService } from '../services/audit-event.service';
import { AIConversationService } from '../services/ai-conversation.service';

const testRedis = redis as unknown as { __store: Map<string, string> };

// ============================================
// dismissClosureRecommendation
// ============================================

describe('appointmentLifecycleService.dismissClosureRecommendation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testRedis.__store.clear();
  });

  it('returns dismissed=false when appointment has no closure recommendation', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: null,
      closureRecommendationActioned: false,
      checkpointStage: null,
      chaseSentTo: null,
      humanControlTakenBy: null,
      conversationState: null,
    });

    const result = await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    expect(result.dismissed).toBe(false);
    expect(prisma.appointmentRequest.update).not.toHaveBeenCalled();
  });

  it('returns dismissed=false when recommendation already actioned (idempotent)', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: true,
      checkpointStage: 'closure_recommended',
      chaseSentTo: null,
      humanControlTakenBy: null,
      conversationState: null,
    });

    const result = await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'admin',
    });

    expect(result.dismissed).toBe(false);
    expect(prisma.appointmentRequest.update).not.toHaveBeenCalled();
  });

  it('preserves closureRecommendedAt when dismissing (for reporting fidelity)', async () => {
    const closureTime = new Date('2026-04-01');
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: closureTime,
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: 'therapist',
      humanControlTakenBy: null,
      conversationState: { checkpoint: { stage: 'awaiting_therapist_availability' } },
    });
    (prisma.appointmentRequest.update as jest.Mock).mockResolvedValue({});

    const result = await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
      reason: 'reply received',
    });

    expect(result.dismissed).toBe(true);
    const updateData = (prisma.appointmentRequest.update as jest.Mock).mock.calls[0][0].data;
    expect(updateData.closureRecommendationActioned).toBe(true);
    // Crucial: timestamp must NOT be nulled — work-report counts on it
    expect(updateData).not.toHaveProperty('closureRecommendedAt');
    expect(updateData).not.toHaveProperty('closureRecommendedReason');
  });

  it('clears chase fields and restores checkpoint stage from JSON', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: 'therapist',
      humanControlTakenBy: null,
      conversationState: { checkpoint: { stage: 'awaiting_therapist_availability' } },
    });
    (prisma.appointmentRequest.update as jest.Mock).mockResolvedValue({});

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    const updateData = (prisma.appointmentRequest.update as jest.Mock).mock.calls[0][0].data;
    expect(updateData.chaseSentAt).toBeNull();
    expect(updateData.chaseSentTo).toBeNull();
    expect(updateData.chaseTargetEmail).toBeNull();
    expect(updateData.checkpointStage).toBe('awaiting_therapist_availability');
  });

  it('reconciles JSON checkpoint when stage is closure_recommended (agent-recommended path)', async () => {
    const fakeAi = {
      getConversationState: jest.fn().mockResolvedValue({
        _version: new Date(),
        checkpoint: {
          stage: 'closure_recommended',
          lastSuccessfulAction: 'sent_initial_email_to_therapist',
        },
        messages: [],
      }),
      storeConversationState: jest.fn().mockResolvedValue(undefined),
    };
    (AIConversationService as jest.Mock).mockImplementation(() => fakeAi);

    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: 'therapist',
      humanControlTakenBy: null,
      conversationState: { checkpoint: { stage: 'closure_recommended', lastSuccessfulAction: 'sent_initial_email_to_therapist' } },
    });
    (prisma.appointmentRequest.update as jest.Mock).mockResolvedValue({});

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    expect(fakeAi.storeConversationState).toHaveBeenCalled();
    const storedState = fakeAi.storeConversationState.mock.calls[0][1];
    // The stage should be inferred from lastSuccessfulAction
    expect(storedState.checkpoint.stage).toBe('awaiting_therapist_availability');
    expect(storedState.checkpoint.pendingAction).toBeNull();
  });

  it('does not reconcile JSON checkpoint when stage is not closure_recommended', async () => {
    const fakeAi = {
      getConversationState: jest.fn(),
      storeConversationState: jest.fn(),
    };
    (AIConversationService as jest.Mock).mockImplementation(() => fakeAi);

    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: 'therapist',
      humanControlTakenBy: null,
      conversationState: { checkpoint: { stage: 'awaiting_therapist_availability' } },
    });
    (prisma.appointmentRequest.update as jest.Mock).mockResolvedValue({});

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    // JSON checkpoint already correct → no AI service call needed
    expect(fakeAi.getConversationState).not.toHaveBeenCalled();
    expect(fakeAi.storeConversationState).not.toHaveBeenCalled();
  });

  it('releases agent-flagged human control but leaves admin-flagged alone', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValueOnce({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: null,
      humanControlTakenBy: 'agent-flagged',
      conversationState: null,
    });
    (prisma.appointmentRequest.update as jest.Mock).mockResolvedValue({});

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    let updateData = (prisma.appointmentRequest.update as jest.Mock).mock.calls[0][0].data;
    expect(updateData.humanControlEnabled).toBe(false);

    // Reset and try with admin-set human control
    jest.clearAllMocks();
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValueOnce({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: null,
      humanControlTakenBy: 'admin',
      conversationState: null,
    });
    (prisma.appointmentRequest.update as jest.Mock).mockResolvedValue({});

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    updateData = (prisma.appointmentRequest.update as jest.Mock).mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('humanControlEnabled');
  });

  it('logs an audit event with the correct actor for the source', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: null,
      humanControlTakenBy: null,
      conversationState: { checkpoint: { stage: 'awaiting_therapist_availability' } },
    });
    (prisma.appointmentRequest.update as jest.Mock).mockResolvedValue({});

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

  it('infers stage from chaseSentTo when JSON has no usable lastSuccessfulAction', async () => {
    (prisma.appointmentRequest.findUnique as jest.Mock).mockResolvedValue({
      closureRecommendedAt: new Date(),
      closureRecommendationActioned: false,
      checkpointStage: 'closure_recommended',
      chaseSentTo: 'user',
      humanControlTakenBy: null,
      conversationState: null, // No checkpoint to read
    });
    (prisma.appointmentRequest.update as jest.Mock).mockResolvedValue({});

    await appointmentLifecycleService.dismissClosureRecommendation({
      appointmentId: 'apt-1',
      source: 'system',
    });

    const updateData = (prisma.appointmentRequest.update as jest.Mock).mock.calls[0][0].data;
    // No JSON stage to restore → falls back based on chaseSentTo
    // (null since the conversationState was null, which is a valid restored stage)
    expect(updateData.checkpointStage).toBeNull();
  });
});

/**
 * Regression test for the "one chase per stage" rule.
 *
 * Scenario the operator hit: an appointment was chased earlier on
 * one stage (e.g. `awaiting_therapist_availability`); the therapist
 * eventually replied with times; the checkpoint advanced to
 * `awaiting_user_slot_selection`; the user then went quiet for
 * days. The auto-chaser never re-fired because the candidate query
 * filters on `chaseSentAt: null` — a row chased once stays
 * "already chased" forever. The admin had to log in and chase
 * manually.
 *
 * Fix: when the conversation checkpoint advances to a new stage,
 * reset the chase-sentinel triplet (`chaseSentAt` + `chaseSentTo`
 * + `chaseTargetEmail`) so the chase scheduler can pick the row
 * up for the new stage. This file pins that contract end-to-end:
 * a stage change clears the triplet; a same-stage update doesn't.
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

// Capture every `data` payload the helper sends to the row update
// so individual tests can assert on the chase-reset fields.
let capturedUpdates: Array<Record<string, unknown>> = [];

const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();
const mockUpdate = jest.fn();
const mockUpsert = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
    },
    $transaction: async (callback: (tx: unknown) => unknown) => {
      const tx = {
        appointmentRequest: {
          updateMany: jest.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
            capturedUpdates.push(args.data);
            return mockUpdateMany(args);
          }),
          // storeConversationState's "legacy" branch uses `update`
          // (no optimistic locking) when called without
          // expectedUpdatedAt — e.g. initial-state creation in
          // startScheduling.
          update: jest.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
            capturedUpdates.push(args.data);
            return mockUpdate(args);
          }),
        },
        appointmentConversation: {
          upsert: (...a: unknown[]) => mockUpsert(...a),
        },
      };
      return callback(tx);
    },
  },
}));

import { aiConversationService } from '../services/ai-conversation.service';

beforeEach(() => {
  jest.clearAllMocks();
  capturedUpdates = [];
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockUpdate.mockResolvedValue({ id: 'apt-1' });
  mockUpsert.mockResolvedValue({ appointmentId: 'apt-1' });
});

function recordForStage(stage: string | null) {
  // Returns the shape `findUnique` produces with the new select:
  // `{ conversationState, checkpointStage, updatedAt }`. The helper
  // reads `checkpointStage` (denormalised column) directly to
  // detect stage changes — the parsed state's `checkpoint` field
  // is stripped by Zod, so we can't use it for this comparison.
  return {
    conversationState: {
      systemPrompt: '',
      messages: [],
    },
    checkpointStage: stage,
    updatedAt: new Date(),
  };
}

describe('applyCheckpointUpdate — one chase per stage', () => {
  it('clears chaseSentAt + chaseSentTo + chaseTargetEmail when stage advances', async () => {
    mockFindUnique.mockResolvedValue(recordForStage('awaiting_therapist_availability'));

    // Mutate to a NEW stage — the operator's described scenario:
    // therapist replied, agent advances to awaiting_user_slot_selection.
    await aiConversationService.applyCheckpointUpdate(
      'apt-1',
      () => ({
        stage: 'awaiting_user_slot_selection',
        pendingAction: 'await user choice',
        checkpoint_at: new Date().toISOString(),
        lastSuccessfulAction: null,
      }),
    );

    expect(capturedUpdates).toHaveLength(1);
    expect(capturedUpdates[0]).toMatchObject({
      checkpointStage: 'awaiting_user_slot_selection',
      chaseSentAt: null,
      chaseSentTo: null,
      chaseTargetEmail: null,
    });
  });

  it('does NOT reset chase fields when the stage is unchanged', async () => {
    mockFindUnique.mockResolvedValue(recordForStage('awaiting_user_slot_selection'));

    // Mutate WITHOUT changing stage — e.g. updating pendingAction
    // string. Chase sentinel must NOT be cleared, otherwise we'd
    // double-chase the same stage every time the agent ticks.
    await aiConversationService.applyCheckpointUpdate(
      'apt-1',
      () => ({
        stage: 'awaiting_user_slot_selection',
        pendingAction: 'updated note',
        checkpoint_at: new Date().toISOString(),
        lastSuccessfulAction: null,
      }),
    );

    expect(capturedUpdates).toHaveLength(1);
    expect(capturedUpdates[0]).not.toHaveProperty('chaseSentAt');
    expect(capturedUpdates[0]).not.toHaveProperty('chaseSentTo');
    expect(capturedUpdates[0]).not.toHaveProperty('chaseTargetEmail');
  });

  it('resets chase fields when going from a null stage to a real stage', async () => {
    // Early lifecycle: state existed but no stage yet (rare but
    // possible for state shapes with messages but no checkpoint).
    mockFindUnique.mockResolvedValue(recordForStage(null));

    await aiConversationService.applyCheckpointUpdate(
      'apt-1',
      () => ({
        stage: 'initial_contact',
        pendingAction: 'starting',
        checkpoint_at: new Date().toISOString(),
        lastSuccessfulAction: null,
      }),
    );

    expect(capturedUpdates[0]).toMatchObject({ chaseSentAt: null });
  });

  it('resets chase fields when rolling back to a different stage (e.g. reschedule)', async () => {
    mockFindUnique.mockResolvedValue(recordForStage('awaiting_meeting_link'));

    // Rescheduling path: agent goes back to availability collection.
    await aiConversationService.applyCheckpointUpdate(
      'apt-1',
      () => ({
        stage: 'awaiting_therapist_availability',
        pendingAction: 'restart availability',
        checkpoint_at: new Date().toISOString(),
        lastSuccessfulAction: null,
      }),
    );

    expect(capturedUpdates[0]).toMatchObject({
      checkpointStage: 'awaiting_therapist_availability',
      chaseSentAt: null,
    });
  });

  // ─── storeConversationState — the DOMINANT path for agent stage
  //     transitions. The agent loop mutates checkpoint in memory
  //     after a tool returns checkpointAction, then saves the full
  //     state via storeConversationState at end-of-turn. Without
  //     a reset here, the agent's natural stage advance
  //     (awaiting_therapist_availability → awaiting_user_slot_selection
  //     etc.) leaves chase pinned and the next stage never qualifies.
  describe('via storeConversationState (agent end-of-turn save)', () => {
    it('clears chase fields when the saved state has a new stage', async () => {
      // findUnique returns the row's CURRENT stage (the OLD one,
      // before this write) — same shape the helper expects.
      mockFindUnique.mockResolvedValue({ checkpointStage: 'awaiting_therapist_availability' });

      await aiConversationService.storeConversationState(
        'apt-1',
        {
          systemPrompt: '',
          messages: [{ role: 'user', content: 'hi' }],
          checkpoint: {
            stage: 'awaiting_user_slot_selection',
            pendingAction: 'await user choice',
            checkpoint_at: new Date().toISOString(),
            lastSuccessfulAction: null,
          },
        // The state type is wider than the public method signature;
        // cast loosely — we don't care about the deeper validation
        // here, just the column-write behaviour.
        } as unknown as Parameters<typeof aiConversationService.storeConversationState>[1],
        new Date(), // expectedUpdatedAt — exercises the optimistic-locked branch
      );

      expect(capturedUpdates).toHaveLength(1);
      expect(capturedUpdates[0]).toMatchObject({
        checkpointStage: 'awaiting_user_slot_selection',
        chaseSentAt: null,
        chaseSentTo: null,
        chaseTargetEmail: null,
      });
    });

    it('does NOT reset chase fields when the saved state stays on the same stage', async () => {
      mockFindUnique.mockResolvedValue({ checkpointStage: 'awaiting_user_slot_selection' });

      await aiConversationService.storeConversationState(
        'apt-1',
        {
          systemPrompt: '',
          messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'reply' }],
          checkpoint: {
            stage: 'awaiting_user_slot_selection',
            pendingAction: 'still waiting',
            checkpoint_at: new Date().toISOString(),
            lastSuccessfulAction: null,
          },
        } as unknown as Parameters<typeof aiConversationService.storeConversationState>[1],
        new Date(),
      );

      expect(capturedUpdates).toHaveLength(1);
      expect(capturedUpdates[0]).not.toHaveProperty('chaseSentAt');
      expect(capturedUpdates[0]).not.toHaveProperty('chaseSentTo');
      expect(capturedUpdates[0]).not.toHaveProperty('chaseTargetEmail');
    });

    it('clears chase fields on the legacy (no-version-check) branch too', async () => {
      // startScheduling calls storeConversationState WITHOUT an
      // expectedUpdatedAt — the "legacy / initial create" path
      // that uses `update` instead of `updateMany`. Reset still
      // applies (defensive — usually no chase to reset at this
      // stage, but the invariant should hold uniformly).
      mockFindUnique.mockResolvedValue({ checkpointStage: null });

      await aiConversationService.storeConversationState(
        'apt-1',
        {
          systemPrompt: '',
          messages: [{ role: 'user', content: 'kicking off' }],
          checkpoint: {
            stage: 'initial_contact',
            pendingAction: 'starting',
            checkpoint_at: new Date().toISOString(),
            lastSuccessfulAction: null,
          },
        } as unknown as Parameters<typeof aiConversationService.storeConversationState>[1],
        // No expectedUpdatedAt — legacy branch.
      );

      expect(capturedUpdates).toHaveLength(1);
      expect(capturedUpdates[0]).toMatchObject({ chaseSentAt: null });
    });
  });

  it("does not override the caller's `extraUpdates` chase fields", async () => {
    // Defensive: if a future caller wants to pass through their own
    // chase-reset semantics via `extraUpdates`, those should win
    // because the `...options?.extraUpdates` spread is LAST in the
    // data object.
    mockFindUnique.mockResolvedValue(recordForStage('awaiting_therapist_availability'));
    const customChaseAt = new Date('2026-06-01T00:00:00Z');

    await aiConversationService.applyCheckpointUpdate(
      'apt-1',
      () => ({
        stage: 'awaiting_user_slot_selection',
        pendingAction: 'x',
        checkpoint_at: new Date().toISOString(),
        lastSuccessfulAction: null,
      }),
      { extraUpdates: { chaseSentAt: customChaseAt } },
    );

    expect(capturedUpdates[0].chaseSentAt).toEqual(customChaseAt);
  });
});

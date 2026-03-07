/**
 * Tests for conversation checkpoint and recovery system
 * Covers: stage transitions, checkpoint creation/updating, recovery detection, metrics,
 * chase/closure lifecycle stages, and end-to-end lifecycle coherence
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  createCheckpoint,
  updateCheckpoint,
  isValidTransition,
  stageFromAction,
  markAsStalled,
  incrementRecoveryAttempts,
  needsRecovery,
  getStageDescription,
  getValidActionsForStage,
  getRecoveryMessage,
  getAdminSummary,
  calculateMetrics,
  parseCheckpoint,
  STAGE_COMPLETION_PERCENTAGE,
  type ConversationStage,
  type ConversationAction,
  type ConversationCheckpoint,
} from '../utils/conversation-checkpoint';

// ============================================
// All defined stages and actions for exhaustive checks
// ============================================

const ALL_STAGES: ConversationStage[] = [
  'initial_contact',
  'awaiting_therapist_availability',
  'awaiting_user_slot_selection',
  'awaiting_therapist_confirmation',
  'awaiting_meeting_link',
  'confirmed',
  'rescheduling',
  'cancelled',
  'stalled',
  'chased',
  'closure_recommended',
];

const ALL_ACTIONS: ConversationAction[] = [
  'sent_initial_email_to_therapist',
  'sent_initial_email_to_user',
  'received_therapist_availability',
  'sent_availability_to_user',
  'received_user_slot_selection',
  'sent_confirmation_request_to_therapist',
  'received_therapist_confirmation',
  'sent_final_confirmations',
  'sent_meeting_link_check',
  'sent_feedback_form',
  'received_cancellation_request',
  'processed_cancellation',
  'received_reschedule_request',
  'processed_reschedule',
  'sent_chase_followup',
  'closure_recommended_to_admin',
];

// ============================================
// createCheckpoint
// ============================================

describe('createCheckpoint', () => {
  it('creates a checkpoint with required fields', () => {
    const cp = createCheckpoint('initial_contact', 'sent_initial_email_to_therapist');
    expect(cp.stage).toBe('initial_contact');
    expect(cp.lastSuccessfulAction).toBe('sent_initial_email_to_therapist');
    expect(cp.checkpoint_at).toBeDefined();
    expect(new Date(cp.checkpoint_at).getTime()).not.toBeNaN();
  });

  it('includes optional pending action', () => {
    const cp = createCheckpoint('awaiting_therapist_availability', null, 'Waiting for therapist response');
    expect(cp.pendingAction).toBe('Waiting for therapist response');
  });

  it('includes optional context', () => {
    const cp = createCheckpoint('awaiting_user_slot_selection', null, null, {
      userSelectedSlot: 'Monday 10am',
    });
    expect(cp.context?.userSelectedSlot).toBe('Monday 10am');
  });

  it('creates checkpoint for chase stage', () => {
    const cp = createCheckpoint('chased', 'sent_chase_followup');
    expect(cp.stage).toBe('chased');
    expect(cp.lastSuccessfulAction).toBe('sent_chase_followup');
  });

  it('creates checkpoint for closure_recommended stage', () => {
    const cp = createCheckpoint('closure_recommended', 'closure_recommended_to_admin');
    expect(cp.stage).toBe('closure_recommended');
    expect(cp.lastSuccessfulAction).toBe('closure_recommended_to_admin');
  });
});

// ============================================
// isValidTransition
// ============================================

describe('isValidTransition', () => {
  // Forward flow transitions
  it('allows initial_contact -> awaiting_therapist_availability', () => {
    expect(isValidTransition('initial_contact', 'awaiting_therapist_availability')).toBe(true);
  });

  it('allows initial_contact -> awaiting_user_slot_selection', () => {
    expect(isValidTransition('initial_contact', 'awaiting_user_slot_selection')).toBe(true);
  });

  it('allows initial_contact -> cancelled', () => {
    expect(isValidTransition('initial_contact', 'cancelled')).toBe(true);
  });

  it('allows awaiting_therapist_confirmation -> confirmed', () => {
    expect(isValidTransition('awaiting_therapist_confirmation', 'confirmed')).toBe(true);
  });

  it('allows confirmed -> rescheduling', () => {
    expect(isValidTransition('confirmed', 'rescheduling')).toBe(true);
  });

  it('allows confirmed -> cancelled', () => {
    expect(isValidTransition('confirmed', 'cancelled')).toBe(true);
  });

  // Terminal state: cancelled
  it('disallows cancelled -> anything (terminal state)', () => {
    expect(isValidTransition('cancelled', 'initial_contact')).toBe(false);
    expect(isValidTransition('cancelled', 'confirmed')).toBe(false);
    expect(isValidTransition('cancelled', 'awaiting_user_slot_selection')).toBe(false);
    expect(isValidTransition('cancelled', 'chased')).toBe(false);
    expect(isValidTransition('cancelled', 'closure_recommended')).toBe(false);
  });

  // Stage skipping
  it('disallows initial_contact -> confirmed (skip stages)', () => {
    expect(isValidTransition('initial_contact', 'confirmed')).toBe(false);
  });

  // Stall transitions
  it('allows any non-terminal active state -> stalled', () => {
    expect(isValidTransition('initial_contact', 'stalled')).toBe(true);
    expect(isValidTransition('awaiting_therapist_availability', 'stalled')).toBe(true);
    expect(isValidTransition('awaiting_user_slot_selection', 'stalled')).toBe(true);
    expect(isValidTransition('awaiting_meeting_link', 'stalled')).toBe(true);
    expect(isValidTransition('rescheduling', 'stalled')).toBe(true);
  });

  it('allows stalled -> recovery stages', () => {
    expect(isValidTransition('stalled', 'awaiting_therapist_availability')).toBe(true);
    expect(isValidTransition('stalled', 'awaiting_user_slot_selection')).toBe(true);
    expect(isValidTransition('stalled', 'awaiting_therapist_confirmation')).toBe(true);
    expect(isValidTransition('stalled', 'cancelled')).toBe(true);
  });

  // Chase transitions
  it('allows any non-terminal active state -> chased', () => {
    expect(isValidTransition('initial_contact', 'chased')).toBe(true);
    expect(isValidTransition('awaiting_therapist_availability', 'chased')).toBe(true);
    expect(isValidTransition('awaiting_user_slot_selection', 'chased')).toBe(true);
    expect(isValidTransition('awaiting_therapist_confirmation', 'chased')).toBe(true);
    expect(isValidTransition('awaiting_meeting_link', 'chased')).toBe(true);
    expect(isValidTransition('rescheduling', 'chased')).toBe(true);
    expect(isValidTransition('stalled', 'chased')).toBe(true);
  });

  it('disallows confirmed -> chased (confirmed is progressing)', () => {
    expect(isValidTransition('confirmed', 'chased')).toBe(false);
  });

  it('disallows cancelled -> chased (terminal)', () => {
    expect(isValidTransition('cancelled', 'chased')).toBe(false);
  });

  // Chased → next states
  it('allows chased -> reactivation stages on response', () => {
    expect(isValidTransition('chased', 'awaiting_therapist_availability')).toBe(true);
    expect(isValidTransition('chased', 'awaiting_user_slot_selection')).toBe(true);
    expect(isValidTransition('chased', 'awaiting_therapist_confirmation')).toBe(true);
    expect(isValidTransition('chased', 'confirmed')).toBe(true);
  });

  it('allows chased -> closure_recommended when no response', () => {
    expect(isValidTransition('chased', 'closure_recommended')).toBe(true);
  });

  it('allows chased -> cancelled', () => {
    expect(isValidTransition('chased', 'cancelled')).toBe(true);
  });

  // Closure recommended → next states
  it('allows closure_recommended -> cancelled (admin accepts)', () => {
    expect(isValidTransition('closure_recommended', 'cancelled')).toBe(true);
  });

  it('allows closure_recommended -> reactivation stages (admin dismisses)', () => {
    expect(isValidTransition('closure_recommended', 'awaiting_therapist_availability')).toBe(true);
    expect(isValidTransition('closure_recommended', 'awaiting_user_slot_selection')).toBe(true);
    expect(isValidTransition('closure_recommended', 'awaiting_therapist_confirmation')).toBe(true);
  });

  it('allows closure_recommended -> chased (new chase cycle after dismiss)', () => {
    expect(isValidTransition('closure_recommended', 'chased')).toBe(true);
  });
});

// ============================================
// stageFromAction
// ============================================

describe('stageFromAction', () => {
  it('maps sent_initial_email_to_therapist -> awaiting_therapist_availability', () => {
    expect(stageFromAction('sent_initial_email_to_therapist')).toBe('awaiting_therapist_availability');
  });

  it('maps sent_initial_email_to_user -> awaiting_user_slot_selection', () => {
    expect(stageFromAction('sent_initial_email_to_user')).toBe('awaiting_user_slot_selection');
  });

  it('maps received_user_slot_selection -> awaiting_therapist_confirmation', () => {
    expect(stageFromAction('received_user_slot_selection')).toBe('awaiting_therapist_confirmation');
  });

  it('maps sent_final_confirmations -> confirmed', () => {
    expect(stageFromAction('sent_final_confirmations')).toBe('confirmed');
  });

  it('maps received_cancellation_request -> cancelled', () => {
    expect(stageFromAction('received_cancellation_request')).toBe('cancelled');
  });

  it('maps received_reschedule_request -> rescheduling', () => {
    expect(stageFromAction('received_reschedule_request')).toBe('rescheduling');
  });

  it('maps sent_chase_followup -> chased', () => {
    expect(stageFromAction('sent_chase_followup')).toBe('chased');
  });

  it('maps closure_recommended_to_admin -> closure_recommended', () => {
    expect(stageFromAction('closure_recommended_to_admin')).toBe('closure_recommended');
  });

  it('every action maps to a valid stage', () => {
    for (const action of ALL_ACTIONS) {
      const stage = stageFromAction(action);
      expect(ALL_STAGES).toContain(stage);
    }
  });
});

// ============================================
// updateCheckpoint
// ============================================

describe('updateCheckpoint', () => {
  it('creates new checkpoint from null', () => {
    const cp = updateCheckpoint(null, 'sent_initial_email_to_therapist');
    expect(cp.stage).toBe('awaiting_therapist_availability');
    expect(cp.lastSuccessfulAction).toBe('sent_initial_email_to_therapist');
  });

  it('transitions stage based on action', () => {
    const current = createCheckpoint('awaiting_therapist_availability', 'sent_initial_email_to_therapist');
    const updated = updateCheckpoint(current, 'received_therapist_availability');
    expect(updated.stage).toBe('awaiting_user_slot_selection');
  });

  it('merges context from previous checkpoint', () => {
    const current = createCheckpoint('awaiting_user_slot_selection', null, null, {
      userSelectedSlot: 'Monday 10am',
    });
    const updated = updateCheckpoint(current, 'received_user_slot_selection', null, {
      lastEmailSentTo: 'therapist',
    });
    expect(updated.context?.userSelectedSlot).toBe('Monday 10am');
    expect(updated.context?.lastEmailSentTo).toBe('therapist');
  });

  it('transitions to chased via sent_chase_followup', () => {
    const current = createCheckpoint('awaiting_therapist_availability', 'sent_initial_email_to_therapist');
    const updated = updateCheckpoint(current, 'sent_chase_followup');
    expect(updated.stage).toBe('chased');
  });

  it('transitions to closure_recommended via closure_recommended_to_admin', () => {
    const current = createCheckpoint('chased', 'sent_chase_followup');
    const updated = updateCheckpoint(current, 'closure_recommended_to_admin');
    expect(updated.stage).toBe('closure_recommended');
  });
});

// ============================================
// markAsStalled
// ============================================

describe('markAsStalled', () => {
  it('changes stage to stalled', () => {
    const current = createCheckpoint('awaiting_therapist_availability', null);
    const stalled = markAsStalled(current);
    expect(stalled.stage).toBe('stalled');
  });

  it('sets stalled_since timestamp', () => {
    const current = createCheckpoint('awaiting_user_slot_selection', null);
    const stalled = markAsStalled(current);
    expect(stalled.stalled_since).toBeDefined();
    expect(new Date(stalled.stalled_since!).getTime()).not.toBeNaN();
  });

  it('resets recovery_attempts to 0', () => {
    const current = createCheckpoint('awaiting_user_slot_selection', null);
    const stalled = markAsStalled(current);
    expect(stalled.recovery_attempts).toBe(0);
  });
});

// ============================================
// incrementRecoveryAttempts
// ============================================

describe('incrementRecoveryAttempts', () => {
  it('increments from 0', () => {
    const cp = createCheckpoint('stalled', null);
    const incremented = incrementRecoveryAttempts(cp);
    expect(incremented.recovery_attempts).toBe(1);
  });

  it('increments from existing count', () => {
    const cp = { ...createCheckpoint('stalled', null), recovery_attempts: 3 };
    const incremented = incrementRecoveryAttempts(cp);
    expect(incremented.recovery_attempts).toBe(4);
  });
});

// ============================================
// needsRecovery
// ============================================

describe('needsRecovery', () => {
  it('returns true when checkpoint is older than threshold', () => {
    const oldCheckpoint: ConversationCheckpoint = {
      stage: 'awaiting_therapist_availability',
      lastSuccessfulAction: null,
      pendingAction: null,
      checkpoint_at: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(), // 72h ago
    };
    expect(needsRecovery(oldCheckpoint, 48)).toBe(true);
  });

  it('returns false when checkpoint is recent', () => {
    const recentCheckpoint: ConversationCheckpoint = {
      stage: 'awaiting_therapist_availability',
      lastSuccessfulAction: null,
      pendingAction: null,
      checkpoint_at: new Date().toISOString(), // Now
    };
    expect(needsRecovery(recentCheckpoint, 48)).toBe(false);
  });

  it('returns false for confirmed stage (terminal)', () => {
    const confirmedCheckpoint: ConversationCheckpoint = {
      stage: 'confirmed',
      lastSuccessfulAction: null,
      pendingAction: null,
      checkpoint_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
    };
    expect(needsRecovery(confirmedCheckpoint)).toBe(false);
  });

  it('returns false for cancelled stage (terminal)', () => {
    const cancelledCheckpoint: ConversationCheckpoint = {
      stage: 'cancelled',
      lastSuccessfulAction: null,
      pendingAction: null,
      checkpoint_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
    };
    expect(needsRecovery(cancelledCheckpoint)).toBe(false);
  });

  it('returns false for chased stage (chase sent, awaiting response)', () => {
    const chasedCheckpoint: ConversationCheckpoint = {
      stage: 'chased',
      lastSuccessfulAction: 'sent_chase_followup',
      pendingAction: null,
      checkpoint_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
    };
    expect(needsRecovery(chasedCheckpoint)).toBe(false);
  });

  it('returns false for closure_recommended stage (admin action needed)', () => {
    const closureCheckpoint: ConversationCheckpoint = {
      stage: 'closure_recommended',
      lastSuccessfulAction: 'closure_recommended_to_admin',
      pendingAction: null,
      checkpoint_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
    };
    expect(needsRecovery(closureCheckpoint)).toBe(false);
  });
});

// ============================================
// Stage metadata completeness
// ============================================

describe('stage metadata', () => {
  it('has descriptions, actions, and recovery messages for every stage', () => {
    for (const stage of ALL_STAGES) {
      expect(getStageDescription(stage).length).toBeGreaterThan(0);
      expect(getValidActionsForStage(stage).length).toBeGreaterThan(0);
    }
  });

  it('defaults to initial_contact for undefined stage', () => {
    expect(getStageDescription(undefined)).toContain('Initial');
    expect(getValidActionsForStage(undefined)).toContain('Send initial email');
  });

  it('returns empty recovery messages for terminal/non-actionable stages', () => {
    expect(getRecoveryMessage('confirmed')).toBe('');
    expect(getRecoveryMessage('cancelled')).toBe('');
    expect(getRecoveryMessage('chased')).toBe('');
    expect(getRecoveryMessage('closure_recommended')).toBe('');
  });

  it('returns non-empty recovery messages for active stages', () => {
    expect(getRecoveryMessage('awaiting_therapist_availability').length).toBeGreaterThan(0);
    expect(getRecoveryMessage('awaiting_user_slot_selection').length).toBeGreaterThan(0);
    expect(getRecoveryMessage('stalled').length).toBeGreaterThan(0);
  });
});

// ============================================
// getAdminSummary
// ============================================

describe('getAdminSummary', () => {
  it('includes stage, action, stalled info, and recovery attempts', () => {
    let cp = markAsStalled(createCheckpoint('awaiting_therapist_availability', 'sent_initial_email_to_therapist'));
    cp = incrementRecoveryAttempts(cp);
    cp = incrementRecoveryAttempts(cp);
    const summary = getAdminSummary(cp);
    expect(summary).toContain('Current Stage');
    expect(summary).toContain('Last Action');
    expect(summary).toContain('Stalled Since');
    expect(summary).toContain('Recovery Attempts');
    expect(summary).toContain('2');
  });
});

// ============================================
// parseCheckpoint
// ============================================

describe('parseCheckpoint', () => {
  it('extracts checkpoint from conversation state', () => {
    const cp = createCheckpoint('confirmed', 'sent_final_confirmations');
    const result = parseCheckpoint({ checkpoint: cp });
    expect(result).toEqual(cp);
  });

  it('returns null for null state', () => {
    expect(parseCheckpoint(null)).toBeNull();
  });

  it('returns null when no checkpoint in state', () => {
    expect(parseCheckpoint({})).toBeNull();
  });
});

// ============================================
// calculateMetrics
// ============================================

describe('calculateMetrics', () => {
  it('calculates completion percentage', () => {
    const cp = createCheckpoint('confirmed', 'sent_final_confirmations');
    const metrics = calculateMetrics(cp, new Date(Date.now() - 24 * 60 * 60 * 1000));
    expect(metrics.completionPercentage).toBe(100);
  });

  it('shows 0% for cancelled', () => {
    const cp = createCheckpoint('cancelled', 'processed_cancellation');
    const metrics = calculateMetrics(cp, new Date());
    expect(metrics.completionPercentage).toBe(0);
  });

  it('shows 0% for chased (non-progressing)', () => {
    const cp = createCheckpoint('chased', 'sent_chase_followup');
    const metrics = calculateMetrics(cp, new Date());
    expect(metrics.completionPercentage).toBe(0);
  });

  it('shows 0% for closure_recommended', () => {
    const cp = createCheckpoint('closure_recommended', 'closure_recommended_to_admin');
    const metrics = calculateMetrics(cp, new Date());
    expect(metrics.completionPercentage).toBe(0);
  });

  it('calculates total time', () => {
    const cp = createCheckpoint('awaiting_user_slot_selection', null);
    const createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
    const metrics = calculateMetrics(cp, createdAt);
    expect(metrics.totalTimeHours).toBeGreaterThanOrEqual(47);
    expect(metrics.totalTimeHours).toBeLessThanOrEqual(49);
  });

  it('detects stalled conversations', () => {
    const cp = markAsStalled(createCheckpoint('awaiting_therapist_availability', null));
    const metrics = calculateMetrics(cp, new Date());
    expect(metrics.isStalled).toBe(true);
  });

  it('tracks recovery attempts', () => {
    let cp = markAsStalled(createCheckpoint('awaiting_therapist_availability', null));
    cp = incrementRecoveryAttempts(cp);
    cp = incrementRecoveryAttempts(cp);
    const metrics = calculateMetrics(cp, new Date());
    expect(metrics.recoveryAttempts).toBe(2);
  });
});

// ============================================
// STAGE_COMPLETION_PERCENTAGE
// ============================================

describe('STAGE_COMPLETION_PERCENTAGE', () => {
  it('has 100% for confirmed', () => {
    expect(STAGE_COMPLETION_PERCENTAGE.confirmed).toBe(100);
  });

  it('has 0% for cancelled', () => {
    expect(STAGE_COMPLETION_PERCENTAGE.cancelled).toBe(0);
  });

  it('has 0% for stalled, chased, and closure_recommended', () => {
    expect(STAGE_COMPLETION_PERCENTAGE.stalled).toBe(0);
    expect(STAGE_COMPLETION_PERCENTAGE.chased).toBe(0);
    expect(STAGE_COMPLETION_PERCENTAGE.closure_recommended).toBe(0);
  });

  it('has increasing percentages through the happy path', () => {
    expect(STAGE_COMPLETION_PERCENTAGE.initial_contact).toBeLessThan(
      STAGE_COMPLETION_PERCENTAGE.awaiting_therapist_availability
    );
    expect(STAGE_COMPLETION_PERCENTAGE.awaiting_therapist_availability).toBeLessThan(
      STAGE_COMPLETION_PERCENTAGE.awaiting_user_slot_selection
    );
    expect(STAGE_COMPLETION_PERCENTAGE.awaiting_user_slot_selection).toBeLessThan(
      STAGE_COMPLETION_PERCENTAGE.awaiting_therapist_confirmation
    );
    expect(STAGE_COMPLETION_PERCENTAGE.awaiting_therapist_confirmation).toBeLessThan(
      STAGE_COMPLETION_PERCENTAGE.awaiting_meeting_link
    );
    expect(STAGE_COMPLETION_PERCENTAGE.awaiting_meeting_link).toBeLessThan(
      STAGE_COMPLETION_PERCENTAGE.confirmed
    );
  });

  it('has a defined percentage for every stage', () => {
    for (const stage of ALL_STAGES) {
      expect(typeof STAGE_COMPLETION_PERCENTAGE[stage]).toBe('number');
    }
  });
});

// ============================================
// End-to-end lifecycle coherence
// ============================================

describe('Lifecycle coherence', () => {
  describe('every non-terminal stage has a path to a terminal state', () => {
    const terminalStages: ConversationStage[] = ['confirmed', 'cancelled'];

    /**
     * BFS to find if there's a path from a given stage to any terminal stage
     * via VALID_TRANSITIONS
     */
    function canReachTerminal(startStage: ConversationStage): boolean {
      const visited = new Set<ConversationStage>();
      const queue: ConversationStage[] = [startStage];

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (terminalStages.includes(current)) return true;
        if (visited.has(current)) continue;
        visited.add(current);

        // Get all valid next stages
        for (const nextStage of ALL_STAGES) {
          if (isValidTransition(current, nextStage) && !visited.has(nextStage)) {
            queue.push(nextStage);
          }
        }
      }

      return false;
    }

    for (const stage of ALL_STAGES) {
      if (terminalStages.includes(stage)) continue;
      it(`${stage} can reach a terminal state`, () => {
        expect(canReachTerminal(stage)).toBe(true);
      });
    }
  });

  describe('happy path: initial_contact → confirmed', () => {
    it('walks through the full happy path via actions', () => {
      let cp = updateCheckpoint(null, 'sent_initial_email_to_therapist');
      expect(cp.stage).toBe('awaiting_therapist_availability');

      cp = updateCheckpoint(cp, 'received_therapist_availability');
      expect(cp.stage).toBe('awaiting_user_slot_selection');

      cp = updateCheckpoint(cp, 'received_user_slot_selection');
      expect(cp.stage).toBe('awaiting_therapist_confirmation');

      cp = updateCheckpoint(cp, 'received_therapist_confirmation');
      expect(cp.stage).toBe('awaiting_meeting_link');

      cp = updateCheckpoint(cp, 'sent_final_confirmations');
      expect(cp.stage).toBe('confirmed');
    });
  });

  describe('stale → chase → closure_recommended → cancelled path', () => {
    it('walks through the full escalation path', () => {
      // Start at a waiting stage
      let cp = createCheckpoint('awaiting_therapist_availability', 'sent_initial_email_to_therapist');

      // Stall detection marks it as stalled
      cp = markAsStalled(cp);
      expect(cp.stage).toBe('stalled');
      expect(isValidTransition('awaiting_therapist_availability', 'stalled')).toBe(true);

      // Chase follow-up sent
      cp = updateCheckpoint(cp, 'sent_chase_followup');
      expect(cp.stage).toBe('chased');
      expect(isValidTransition('stalled', 'chased')).toBe(true);

      // No response - closure recommended
      cp = updateCheckpoint(cp, 'closure_recommended_to_admin');
      expect(cp.stage).toBe('closure_recommended');
      expect(isValidTransition('chased', 'closure_recommended')).toBe(true);

      // Admin cancels
      expect(isValidTransition('closure_recommended', 'cancelled')).toBe(true);
    });
  });

  describe('chased → reactivation on response', () => {
    it('allows reactivation to all appropriate active stages', () => {
      expect(isValidTransition('chased', 'awaiting_therapist_availability')).toBe(true);
      expect(isValidTransition('chased', 'awaiting_user_slot_selection')).toBe(true);
      expect(isValidTransition('chased', 'awaiting_therapist_confirmation')).toBe(true);
      expect(isValidTransition('chased', 'confirmed')).toBe(true);
    });
  });

  describe('closure_recommended → dismiss → new chase cycle', () => {
    it('allows transition back to chased after admin dismiss', () => {
      expect(isValidTransition('closure_recommended', 'chased')).toBe(true);
    });

    it('allows transition to reactivation stages after dismiss', () => {
      expect(isValidTransition('closure_recommended', 'awaiting_therapist_availability')).toBe(true);
      expect(isValidTransition('closure_recommended', 'awaiting_user_slot_selection')).toBe(true);
      expect(isValidTransition('closure_recommended', 'awaiting_therapist_confirmation')).toBe(true);
    });
  });

  describe('rescheduling includes chase path', () => {
    it('allows rescheduling -> stalled -> chased -> closure_recommended', () => {
      expect(isValidTransition('rescheduling', 'stalled')).toBe(true);
      expect(isValidTransition('rescheduling', 'chased')).toBe(true);
      expect(isValidTransition('stalled', 'chased')).toBe(true);
      expect(isValidTransition('chased', 'closure_recommended')).toBe(true);
    });
  });

  describe('cancellation is reachable from every non-terminal stage', () => {
    const nonTerminal: ConversationStage[] = ALL_STAGES.filter(
      s => s !== 'confirmed' && s !== 'cancelled'
    );

    for (const stage of nonTerminal) {
      it(`${stage} can reach cancelled (directly or via chain)`, () => {
        // Direct cancellation or via valid transition chain
        const canCancel = isValidTransition(stage, 'cancelled');
        if (!canCancel) {
          // For stages that can't directly cancel, verify they can reach a stage that can
          let reachable = false;
          for (const intermediate of ALL_STAGES) {
            if (isValidTransition(stage, intermediate) && isValidTransition(intermediate, 'cancelled')) {
              reachable = true;
              break;
            }
          }
          expect(reachable).toBe(true);
        } else {
          expect(canCancel).toBe(true);
        }
      });
    }
  });
});

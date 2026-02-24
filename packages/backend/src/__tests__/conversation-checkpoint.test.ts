/**
 * Tests for conversation checkpoint and recovery system
 * Covers: stage transitions, checkpoint creation/updating, recovery detection, metrics
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
});

describe('isValidTransition', () => {
  it('allows initial_contact -> awaiting_therapist_availability', () => {
    expect(isValidTransition('initial_contact', 'awaiting_therapist_availability')).toBe(true);
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

  it('disallows cancelled -> anything (terminal state)', () => {
    expect(isValidTransition('cancelled', 'initial_contact')).toBe(false);
    expect(isValidTransition('cancelled', 'confirmed')).toBe(false);
    expect(isValidTransition('cancelled', 'awaiting_user_slot_selection')).toBe(false);
  });

  it('disallows initial_contact -> confirmed (skip stages)', () => {
    expect(isValidTransition('initial_contact', 'confirmed')).toBe(false);
  });

  it('allows any non-terminal state -> stalled', () => {
    expect(isValidTransition('initial_contact', 'stalled')).toBe(true);
    expect(isValidTransition('awaiting_therapist_availability', 'stalled')).toBe(true);
    expect(isValidTransition('awaiting_user_slot_selection', 'stalled')).toBe(true);
    expect(isValidTransition('awaiting_meeting_link', 'stalled')).toBe(true);
  });

  it('allows stalled -> recovery stages', () => {
    expect(isValidTransition('stalled', 'awaiting_therapist_availability')).toBe(true);
    expect(isValidTransition('stalled', 'cancelled')).toBe(true);
  });
});

describe('stageFromAction', () => {
  it('maps sent_initial_email_to_therapist -> awaiting_therapist_availability', () => {
    expect(stageFromAction('sent_initial_email_to_therapist')).toBe('awaiting_therapist_availability');
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
});

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
});

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
});

describe('getStageDescription', () => {
  it('returns description for known stages', () => {
    expect(getStageDescription('confirmed')).toContain('complete');
    expect(getStageDescription('cancelled')).toContain('cancelled');
    expect(getStageDescription('stalled')).toContain('stalled');
  });

  it('returns initial_contact description for undefined', () => {
    expect(getStageDescription(undefined)).toContain('Initial');
  });
});

describe('getValidActionsForStage', () => {
  it('returns actions as formatted list', () => {
    const actions = getValidActionsForStage('awaiting_user_slot_selection');
    expect(actions).toContain('- ');
    expect(actions).toContain('Wait for user');
  });

  it('returns initial_contact actions for undefined', () => {
    const actions = getValidActionsForStage(undefined);
    expect(actions).toContain('Send initial email');
  });
});

describe('getRecoveryMessage', () => {
  it('returns non-empty message for active stages', () => {
    expect(getRecoveryMessage('awaiting_therapist_availability').length).toBeGreaterThan(0);
    expect(getRecoveryMessage('awaiting_user_slot_selection').length).toBeGreaterThan(0);
    expect(getRecoveryMessage('stalled').length).toBeGreaterThan(0);
  });

  it('returns empty string for terminal stages', () => {
    expect(getRecoveryMessage('confirmed')).toBe('');
    expect(getRecoveryMessage('cancelled')).toBe('');
  });
});

describe('getAdminSummary', () => {
  it('includes current stage', () => {
    const cp = createCheckpoint('awaiting_therapist_confirmation', 'sent_confirmation_request_to_therapist');
    const summary = getAdminSummary(cp);
    expect(summary).toContain('Current Stage');
  });

  it('includes last action', () => {
    const cp = createCheckpoint('awaiting_therapist_confirmation', 'sent_confirmation_request_to_therapist');
    const summary = getAdminSummary(cp);
    expect(summary).toContain('Last Action');
  });

  it('includes stalled info when stalled', () => {
    const cp = markAsStalled(createCheckpoint('awaiting_therapist_availability', null));
    const summary = getAdminSummary(cp);
    expect(summary).toContain('Stalled Since');
  });

  it('includes recovery attempts', () => {
    let cp = markAsStalled(createCheckpoint('awaiting_therapist_availability', null));
    cp = incrementRecoveryAttempts(cp);
    cp = incrementRecoveryAttempts(cp);
    const summary = getAdminSummary(cp);
    expect(summary).toContain('Recovery Attempts');
    expect(summary).toContain('2');
  });
});

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

describe('STAGE_COMPLETION_PERCENTAGE', () => {
  it('has 100% for confirmed', () => {
    expect(STAGE_COMPLETION_PERCENTAGE.confirmed).toBe(100);
  });

  it('has 0% for cancelled', () => {
    expect(STAGE_COMPLETION_PERCENTAGE.cancelled).toBe(0);
  });

  it('has increasing percentages through the flow', () => {
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
});

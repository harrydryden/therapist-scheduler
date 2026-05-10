/**
 * Tests for the lifecycle-path/meta side of the thread lifecycle:
 *   - Conversation meta extraction (`extractConversationMeta`)
 *   - Chase stages and recovery system interaction
 *   - End-to-end lifecycle path simulations
 *   - Feedback dead-end auto-completion eligibility rules
 *
 * Sibling file `thread-chase-eligibility.test.ts` covers the chase/
 * closure side: chase target determination, regression guards, chase
 * eligibility, closure recommendation eligibility.
 *
 * Both files were split out of the original 945-line
 * `thread-lifecycle-chase.test.ts` for navigability. Test contents
 * are unchanged.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { extractConversationMeta } from '../utils/conversation-meta';
import {
  createCheckpoint,
  updateCheckpoint,
  isValidTransition,
  stageFromAction,
  needsRecovery,
  type ConversationStage,
  type ConversationCheckpoint,
} from '../services/conversation-checkpoint.service';

describe('Feedback auto-completion eligibility rules', () => {
  const CLOSURE_HOURS = 48;

  function isFeedbackAutoCompleteEligible(appointment: {
    status: string;
    feedbackReminderSentAt: Date | null;
  }): boolean {
    const threshold = new Date(Date.now() - CLOSURE_HOURS * 60 * 60 * 1000);

    return (
      appointment.status === 'feedback_requested' &&
      appointment.feedbackReminderSentAt !== null &&
      appointment.feedbackReminderSentAt.getTime() > 0 && // Exclude sentinel
      appointment.feedbackReminderSentAt < threshold
    );
  }

  it('is eligible when reminder sent long ago with no feedback', () => {
    expect(isFeedbackAutoCompleteEligible({
      status: 'feedback_requested',
      feedbackReminderSentAt: new Date(Date.now() - 60 * 60 * 60 * 1000),
    })).toBe(true);
  });

  it('is not eligible when reminder was sent recently', () => {
    expect(isFeedbackAutoCompleteEligible({
      status: 'feedback_requested',
      feedbackReminderSentAt: new Date(),
    })).toBe(false);
  });

  it('is not eligible when no reminder was sent', () => {
    expect(isFeedbackAutoCompleteEligible({
      status: 'feedback_requested',
      feedbackReminderSentAt: null,
    })).toBe(false);
  });

  it('is not eligible for non-feedback_requested status', () => {
    expect(isFeedbackAutoCompleteEligible({
      status: 'confirmed',
      feedbackReminderSentAt: new Date(Date.now() - 60 * 60 * 60 * 1000),
    })).toBe(false);
  });

  it('excludes sentinel (epoch) from eligibility', () => {
    expect(isFeedbackAutoCompleteEligible({
      status: 'feedback_requested',
      feedbackReminderSentAt: new Date(0),
    })).toBe(false);
  });
});

// ============================================
// Conversation meta extraction
// ============================================

describe('extractConversationMeta', () => {
  it('extracts checkpointStage from conversation state JSON', () => {
    const state = JSON.stringify({
      messages: [{ role: 'user', content: 'hello' }],
      checkpoint: { stage: 'awaiting_therapist_availability' },
    });
    const meta = extractConversationMeta(state);
    expect(meta.checkpointStage).toBe('awaiting_therapist_availability');
    expect(meta.messageCount).toBe(1);
  });

  it('extracts chased stage', () => {
    const state = JSON.stringify({
      messages: [],
      checkpoint: { stage: 'chased' },
    });
    expect(extractConversationMeta(state).checkpointStage).toBe('chased');
  });

  it('extracts closure_recommended stage', () => {
    const state = JSON.stringify({
      messages: [],
      checkpoint: { stage: 'closure_recommended' },
    });
    expect(extractConversationMeta(state).checkpointStage).toBe('closure_recommended');
  });

  it('returns null checkpointStage when no checkpoint in state', () => {
    const state = JSON.stringify({ messages: [] });
    expect(extractConversationMeta(state).checkpointStage).toBeNull();
  });

  it('returns null checkpointStage for null input', () => {
    expect(extractConversationMeta(null).checkpointStage).toBeNull();
  });

  it('handles object input (not just string)', () => {
    const state = {
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      checkpoint: { stage: 'confirmed' },
    };
    const meta = extractConversationMeta(state as Record<string, unknown>);
    expect(meta.checkpointStage).toBe('confirmed');
    expect(meta.messageCount).toBe(2);
  });

  it('handles malformed JSON gracefully', () => {
    const meta = extractConversationMeta('not valid json {{{');
    expect(meta.checkpointStage).toBeNull();
    expect(meta.messageCount).toBe(0);
  });
});

// ============================================
// Chase stage interaction with needsRecovery
// ============================================

describe('Chase stages and recovery system interaction', () => {
  it('chased stage does not trigger recovery (chase already sent)', () => {
    const cp: ConversationCheckpoint = {
      stage: 'chased',
      lastSuccessfulAction: 'sent_chase_followup',
      pendingAction: null,
      checkpoint_at: new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString(),
    };
    expect(needsRecovery(cp, 48)).toBe(false);
  });

  it('closure_recommended stage does not trigger recovery (admin action needed)', () => {
    const cp: ConversationCheckpoint = {
      stage: 'closure_recommended',
      lastSuccessfulAction: 'closure_recommended_to_admin',
      pendingAction: null,
      checkpoint_at: new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString(),
    };
    expect(needsRecovery(cp, 48)).toBe(false);
  });

  it('stalled stage still triggers recovery if old enough', () => {
    const cp: ConversationCheckpoint = {
      stage: 'stalled',
      lastSuccessfulAction: null,
      pendingAction: null,
      checkpoint_at: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
    };
    expect(needsRecovery(cp, 48)).toBe(true);
  });
});

// ============================================
// Full lifecycle path simulations
// ============================================

describe('Full lifecycle path simulations', () => {
  it('happy path: initial → contacted → confirmed (no stalls)', () => {
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

    expect(needsRecovery(cp)).toBe(false);
  });

  it('stale → chase → response → confirmed', () => {
    // Start at awaiting therapist availability
    let cp = updateCheckpoint(null, 'sent_initial_email_to_therapist');
    expect(cp.stage).toBe('awaiting_therapist_availability');

    // Chase sent
    cp = updateCheckpoint(cp, 'sent_chase_followup');
    expect(cp.stage).toBe('chased');

    // Therapist responds (agent processes and moves to next stage)
    cp = updateCheckpoint(cp, 'received_therapist_availability');
    expect(cp.stage).toBe('awaiting_user_slot_selection');

    // User selects, therapist confirms
    cp = updateCheckpoint(cp, 'received_user_slot_selection');
    cp = updateCheckpoint(cp, 'received_therapist_confirmation');
    cp = updateCheckpoint(cp, 'sent_final_confirmations');
    expect(cp.stage).toBe('confirmed');
  });

  it('stale → chase → no response → closure → admin cancels', () => {
    let cp = updateCheckpoint(null, 'sent_initial_email_to_therapist');
    cp = updateCheckpoint(cp, 'sent_chase_followup');
    expect(cp.stage).toBe('chased');

    // No response → closure recommended
    cp = updateCheckpoint(cp, 'closure_recommended_to_admin');
    expect(cp.stage).toBe('closure_recommended');

    // Admin cancels
    expect(isValidTransition('closure_recommended', 'cancelled')).toBe(true);
  });

  it('stale → chase → no response → closure → admin dismisses → new chase cycle', () => {
    let cp = updateCheckpoint(null, 'sent_initial_email_to_therapist');
    cp = updateCheckpoint(cp, 'sent_chase_followup');
    cp = updateCheckpoint(cp, 'closure_recommended_to_admin');
    expect(cp.stage).toBe('closure_recommended');

    // Admin dismisses → resets to an earlier stage, then gets chased again
    expect(isValidTransition('closure_recommended', 'awaiting_therapist_availability')).toBe(true);
    expect(isValidTransition('closure_recommended', 'chased')).toBe(true);
  });

  it('rescheduling → stale → chase → closure → cancelled', () => {
    // After confirmed, reschedule starts
    let cp = createCheckpoint('rescheduling', 'received_reschedule_request');

    // Stalls
    expect(isValidTransition('rescheduling', 'stalled')).toBe(true);
    expect(isValidTransition('rescheduling', 'chased')).toBe(true);

    // Chase sent directly from rescheduling
    cp = updateCheckpoint(cp, 'sent_chase_followup');
    expect(cp.stage).toBe('chased');

    // No response → closure
    cp = updateCheckpoint(cp, 'closure_recommended_to_admin');
    expect(cp.stage).toBe('closure_recommended');

    // Admin cancels
    expect(isValidTransition('closure_recommended', 'cancelled')).toBe(true);
  });

  it('cancellation is always reachable from active states', () => {
    const activeStages: ConversationStage[] = [
      'initial_contact',
      'awaiting_therapist_availability',
      'awaiting_user_slot_selection',
      'awaiting_therapist_confirmation',
      'awaiting_meeting_link',
      'rescheduling',
      'stalled',
      'chased',
      'closure_recommended',
    ];

    for (const stage of activeStages) {
      // Either direct cancellation or via chain to closure_recommended/cancelled
      const direct = isValidTransition(stage, 'cancelled');
      if (!direct) {
        // Must be reachable via intermediate stage
        const viaChased = isValidTransition(stage, 'chased') &&
          isValidTransition('chased', 'cancelled');
        const viaClosure = isValidTransition(stage, 'closure_recommended') &&
          isValidTransition('closure_recommended', 'cancelled');
        const viaStalled = isValidTransition(stage, 'stalled') &&
          isValidTransition('stalled', 'cancelled');
        expect(viaChased || viaClosure || viaStalled).toBe(true);
      }
    }
  });
});

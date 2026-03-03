/**
 * Tests for the thread lifecycle chase/closure/feedback-completion system.
 *
 * Verifies:
 * - Chase target determination logic (who to chase based on checkpoint stage)
 * - Sentinel pattern for crash-safe duplicate prevention
 * - Closure recommendation eligibility
 * - Feedback dead-end auto-completion eligibility
 * - Conversation meta extraction (denormalized checkpointStage)
 * - End-to-end lifecycle paths through chase/closure states
 *
 * Note: The stale-check service methods are tightly coupled to Prisma/Gmail/Redis.
 * These tests verify the deterministic logic and eligibility rules rather than
 * the full integration (which requires the running system). The conversation
 * checkpoint tests (conversation-checkpoint.test.ts) cover the state machine
 * transitions exhaustively.
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
} from '../utils/conversation-checkpoint';

// ============================================
// Chase target determination logic
// ============================================

describe('Chase target determination', () => {
  /**
   * Mirrors the logic in StaleCheckService.determineChaseTarget().
   * Extracted here so the rules can be tested without Prisma/service dependencies.
   */
  function determineChaseTarget(appointment: {
    checkpointStage: string | null;
    userEmail: string;
    therapistEmail: string;
    gmailThreadId: string | null;
    therapistGmailThreadId: string | null;
    conversationState: unknown;
  }): { target: 'user' | 'therapist'; email: string; threadId: string | null } | null {
    const stage = appointment.checkpointStage;

    // Stages where we're waiting on the therapist
    if (
      stage === 'awaiting_therapist_availability' ||
      stage === 'awaiting_therapist_confirmation' ||
      stage === 'awaiting_meeting_link'
    ) {
      return {
        target: 'therapist',
        email: appointment.therapistEmail,
        threadId: appointment.therapistGmailThreadId,
      };
    }

    // Stages where we're waiting on the user
    if (stage === 'awaiting_user_slot_selection') {
      return {
        target: 'user',
        email: appointment.userEmail,
        threadId: appointment.gmailThreadId,
      };
    }

    // For initial_contact, stalled, or no checkpoint, infer from context
    if (stage === 'initial_contact' || stage === 'stalled' || !stage) {
      const state = appointment.conversationState as { checkpoint?: { context?: { lastEmailSentTo?: string } } } | null;
      const lastEmailTo = state?.checkpoint?.context?.lastEmailSentTo;

      if (lastEmailTo === 'therapist') {
        return {
          target: 'therapist',
          email: appointment.therapistEmail,
          threadId: appointment.therapistGmailThreadId,
        };
      }

      if (lastEmailTo === 'user') {
        return {
          target: 'user',
          email: appointment.userEmail,
          threadId: appointment.gmailThreadId,
        };
      }

      // Default: if therapist thread exists, chase therapist
      if (appointment.therapistGmailThreadId) {
        return {
          target: 'therapist',
          email: appointment.therapistEmail,
          threadId: appointment.therapistGmailThreadId,
        };
      }

      // If only user thread, chase user
      if (appointment.gmailThreadId) {
        return {
          target: 'user',
          email: appointment.userEmail,
          threadId: appointment.gmailThreadId,
        };
      }
    }

    return null;
  }

  const baseAppointment = {
    userEmail: 'user@example.com',
    therapistEmail: 'therapist@example.com',
    gmailThreadId: 'thread-user-123',
    therapistGmailThreadId: 'thread-therapist-456',
    conversationState: null,
  };

  describe('explicit checkpoint stage targeting', () => {
    it('chases therapist when awaiting_therapist_availability', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: 'awaiting_therapist_availability',
      });
      expect(result).toEqual({
        target: 'therapist',
        email: 'therapist@example.com',
        threadId: 'thread-therapist-456',
      });
    });

    it('chases therapist when awaiting_therapist_confirmation', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: 'awaiting_therapist_confirmation',
      });
      expect(result).toEqual({
        target: 'therapist',
        email: 'therapist@example.com',
        threadId: 'thread-therapist-456',
      });
    });

    it('chases therapist when awaiting_meeting_link', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: 'awaiting_meeting_link',
      });
      expect(result).toEqual({
        target: 'therapist',
        email: 'therapist@example.com',
        threadId: 'thread-therapist-456',
      });
    });

    it('chases user when awaiting_user_slot_selection', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: 'awaiting_user_slot_selection',
      });
      expect(result).toEqual({
        target: 'user',
        email: 'user@example.com',
        threadId: 'thread-user-123',
      });
    });
  });

  describe('inference for ambiguous stages', () => {
    it('infers therapist from lastEmailSentTo context when stage is initial_contact', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: 'initial_contact',
        conversationState: {
          checkpoint: { context: { lastEmailSentTo: 'therapist' } },
        },
      });
      expect(result?.target).toBe('therapist');
    });

    it('infers user from lastEmailSentTo context when stage is stalled', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: 'stalled',
        conversationState: {
          checkpoint: { context: { lastEmailSentTo: 'user' } },
        },
      });
      expect(result?.target).toBe('user');
    });

    it('infers from lastEmailSentTo when checkpointStage is null', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: null,
        conversationState: {
          checkpoint: { context: { lastEmailSentTo: 'therapist' } },
        },
      });
      expect(result?.target).toBe('therapist');
    });

    it('defaults to therapist when therapist thread exists and no context', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: null,
        conversationState: null,
      });
      expect(result?.target).toBe('therapist');
      expect(result?.threadId).toBe('thread-therapist-456');
    });

    it('defaults to user when only user thread exists', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: null,
        therapistGmailThreadId: null,
        conversationState: null,
      });
      expect(result?.target).toBe('user');
      expect(result?.threadId).toBe('thread-user-123');
    });

    it('returns null when no threads exist and no context', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: null,
        gmailThreadId: null,
        therapistGmailThreadId: null,
        conversationState: null,
      });
      expect(result).toBeNull();
    });
  });

  describe('non-chaseable stages', () => {
    it('returns null for confirmed stage', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: 'confirmed',
      });
      expect(result).toBeNull();
    });

    it('returns null for cancelled stage', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: 'cancelled',
      });
      expect(result).toBeNull();
    });

    it('returns null for chased stage (already chased)', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: 'chased',
      });
      expect(result).toBeNull();
    });

    it('returns null for closure_recommended stage', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: 'closure_recommended',
      });
      expect(result).toBeNull();
    });

    it('returns null for rescheduling stage', () => {
      const result = determineChaseTarget({
        ...baseAppointment,
        checkpointStage: 'rescheduling',
      });
      expect(result).toBeNull();
    });
  });
});

// ============================================
// Sentinel pattern validation
// ============================================

describe('Sentinel pattern', () => {
  it('epoch date is distinguishable from null', () => {
    const epoch = new Date(0);
    expect(epoch.getTime()).toBe(0);
    expect(epoch).not.toBeNull();
  });

  it('epoch date is distinguishable from actual timestamps', () => {
    const epoch = new Date(0);
    const now = new Date();
    expect(now.getTime()).toBeGreaterThan(epoch.getTime());
  });

  it('gt: new Date(0) excludes both null and epoch sentinel', () => {
    // Simulates the Prisma query: chaseSentAt: { gt: new Date(0) }
    const sentinel = new Date(0);
    const actual = new Date('2025-01-15T10:00:00Z');

    // null case: would not match gt condition (null is excluded by Prisma)
    // sentinel case: gt(0) means > 0, so epoch (0) is excluded
    expect(actual.getTime()).toBeGreaterThan(sentinel.getTime());
    expect(sentinel.getTime()).not.toBeGreaterThan(sentinel.getTime());
  });

  it('sentinel → actual timestamp is a valid progression', () => {
    // Sequence: null → epoch(0) → actual timestamp
    const steps = [null, new Date(0), new Date()];
    expect(steps[0]).toBeNull();
    expect(steps[1]!.getTime()).toBe(0);
    expect(steps[2]!.getTime()).toBeGreaterThan(0);
  });
});

// ============================================
// Chase eligibility rules
// ============================================

describe('Chase eligibility rules', () => {
  const CHASE_AFTER_HOURS = 72;

  function isChaseEligible(appointment: {
    status: string;
    lastActivityAt: Date;
    chaseSentAt: Date | null;
    humanControlEnabled: boolean;
    closureRecommendedAt: Date | null;
  }): boolean {
    const activeStatuses = ['pending', 'contacted', 'negotiating'];
    const chaseThreshold = new Date(Date.now() - CHASE_AFTER_HOURS * 60 * 60 * 1000);

    return (
      activeStatuses.includes(appointment.status) &&
      appointment.lastActivityAt < chaseThreshold &&
      appointment.chaseSentAt === null &&
      !appointment.humanControlEnabled &&
      appointment.closureRecommendedAt === null
    );
  }

  it('is eligible when stale and never chased', () => {
    expect(isChaseEligible({
      status: 'contacted',
      lastActivityAt: new Date(Date.now() - 80 * 60 * 60 * 1000),
      chaseSentAt: null,
      humanControlEnabled: false,
      closureRecommendedAt: null,
    })).toBe(true);
  });

  it('is not eligible when recently active', () => {
    expect(isChaseEligible({
      status: 'contacted',
      lastActivityAt: new Date(),
      chaseSentAt: null,
      humanControlEnabled: false,
      closureRecommendedAt: null,
    })).toBe(false);
  });

  it('is not eligible when already chased', () => {
    expect(isChaseEligible({
      status: 'contacted',
      lastActivityAt: new Date(Date.now() - 80 * 60 * 60 * 1000),
      chaseSentAt: new Date(),
      humanControlEnabled: false,
      closureRecommendedAt: null,
    })).toBe(false);
  });

  it('is not eligible when under human control', () => {
    expect(isChaseEligible({
      status: 'contacted',
      lastActivityAt: new Date(Date.now() - 80 * 60 * 60 * 1000),
      chaseSentAt: null,
      humanControlEnabled: true,
      closureRecommendedAt: null,
    })).toBe(false);
  });

  it('is not eligible when already recommended for closure', () => {
    expect(isChaseEligible({
      status: 'contacted',
      lastActivityAt: new Date(Date.now() - 80 * 60 * 60 * 1000),
      chaseSentAt: null,
      humanControlEnabled: false,
      closureRecommendedAt: new Date(),
    })).toBe(false);
  });

  it('is not eligible for confirmed status', () => {
    expect(isChaseEligible({
      status: 'confirmed',
      lastActivityAt: new Date(Date.now() - 80 * 60 * 60 * 1000),
      chaseSentAt: null,
      humanControlEnabled: false,
      closureRecommendedAt: null,
    })).toBe(false);
  });

  it('is not eligible for cancelled status', () => {
    expect(isChaseEligible({
      status: 'cancelled',
      lastActivityAt: new Date(Date.now() - 80 * 60 * 60 * 1000),
      chaseSentAt: null,
      humanControlEnabled: false,
      closureRecommendedAt: null,
    })).toBe(false);
  });

  it('is not eligible when sentinel is set (in-flight send)', () => {
    // The sentinel (epoch) is not null, so chaseSentAt !== null
    expect(isChaseEligible({
      status: 'contacted',
      lastActivityAt: new Date(Date.now() - 80 * 60 * 60 * 1000),
      chaseSentAt: new Date(0), // Sentinel
      humanControlEnabled: false,
      closureRecommendedAt: null,
    })).toBe(false);
  });
});

// ============================================
// Closure recommendation eligibility rules
// ============================================

describe('Closure recommendation eligibility rules', () => {
  const CLOSURE_HOURS = 48;

  function isClosureEligible(appointment: {
    status: string;
    chaseSentAt: Date | null;
    closureRecommendedAt: Date | null;
    lastActivityAt: Date;
  }): boolean {
    const activeStatuses = ['pending', 'contacted', 'negotiating'];
    const closureThreshold = new Date(Date.now() - CLOSURE_HOURS * 60 * 60 * 1000);

    return (
      activeStatuses.includes(appointment.status) &&
      appointment.chaseSentAt !== null &&
      appointment.chaseSentAt.getTime() > 0 && // Exclude sentinel
      appointment.chaseSentAt < closureThreshold &&
      appointment.closureRecommendedAt === null &&
      appointment.lastActivityAt < closureThreshold
    );
  }

  it('is eligible when chase sent long ago with no response', () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 60 * 1000);
    expect(isClosureEligible({
      status: 'contacted',
      chaseSentAt: longAgo,
      closureRecommendedAt: null,
      lastActivityAt: longAgo,
    })).toBe(true);
  });

  it('is not eligible when chase was sent recently', () => {
    expect(isClosureEligible({
      status: 'contacted',
      chaseSentAt: new Date(),
      closureRecommendedAt: null,
      lastActivityAt: new Date(Date.now() - 60 * 60 * 60 * 1000),
    })).toBe(false);
  });

  it('is not eligible when no chase was sent', () => {
    expect(isClosureEligible({
      status: 'contacted',
      chaseSentAt: null,
      closureRecommendedAt: null,
      lastActivityAt: new Date(Date.now() - 60 * 60 * 60 * 1000),
    })).toBe(false);
  });

  it('is not eligible when closure already recommended', () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 60 * 1000);
    expect(isClosureEligible({
      status: 'contacted',
      chaseSentAt: longAgo,
      closureRecommendedAt: longAgo,
      lastActivityAt: longAgo,
    })).toBe(false);
  });

  it('is not eligible when activity happened after chase (response received)', () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 60 * 1000);
    expect(isClosureEligible({
      status: 'contacted',
      chaseSentAt: longAgo,
      closureRecommendedAt: null,
      lastActivityAt: new Date(), // Recent activity = response received
    })).toBe(false);
  });

  it('excludes sentinel (epoch) from eligibility', () => {
    expect(isClosureEligible({
      status: 'contacted',
      chaseSentAt: new Date(0), // Sentinel
      closureRecommendedAt: null,
      lastActivityAt: new Date(Date.now() - 60 * 60 * 60 * 1000),
    })).toBe(false);
  });
});

// ============================================
// Feedback auto-completion eligibility rules
// ============================================

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

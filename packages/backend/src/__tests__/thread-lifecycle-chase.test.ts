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
  wouldRegress,
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
// Stage regression prevention (wouldRegress)
// ============================================

describe('wouldRegress - checkpoint stage regression detection', () => {
  describe('normal booking flow regressions', () => {
    it('detects regression from awaiting_user_slot_selection to awaiting_therapist_availability', () => {
      // This is the specific bug: courtesy email to therapist after forwarding
      // availability to user should not regress the stage
      expect(wouldRegress('awaiting_user_slot_selection', 'awaiting_therapist_availability')).toBe(true);
    });

    it('detects regression from awaiting_therapist_confirmation to awaiting_therapist_availability', () => {
      expect(wouldRegress('awaiting_therapist_confirmation', 'awaiting_therapist_availability')).toBe(true);
    });

    it('detects regression from awaiting_meeting_link to awaiting_user_slot_selection', () => {
      expect(wouldRegress('awaiting_meeting_link', 'awaiting_user_slot_selection')).toBe(true);
    });

    it('detects regression from confirmed to any earlier stage', () => {
      expect(wouldRegress('confirmed', 'awaiting_therapist_availability')).toBe(true);
      expect(wouldRegress('confirmed', 'awaiting_user_slot_selection')).toBe(true);
      expect(wouldRegress('confirmed', 'awaiting_meeting_link')).toBe(true);
    });
  });

  describe('valid forward progressions', () => {
    it('allows progression from initial_contact to awaiting_therapist_availability', () => {
      expect(wouldRegress('initial_contact', 'awaiting_therapist_availability')).toBe(false);
    });

    it('allows progression from awaiting_therapist_availability to awaiting_user_slot_selection', () => {
      expect(wouldRegress('awaiting_therapist_availability', 'awaiting_user_slot_selection')).toBe(false);
    });

    it('allows same-stage transitions', () => {
      expect(wouldRegress('awaiting_user_slot_selection', 'awaiting_user_slot_selection')).toBe(false);
    });
  });

  describe('non-linear states', () => {
    it('never blocks transitions from stalled', () => {
      expect(wouldRegress('stalled', 'awaiting_therapist_availability')).toBe(false);
      expect(wouldRegress('stalled', 'initial_contact')).toBe(false);
    });

    it('never blocks transitions from chased', () => {
      expect(wouldRegress('chased', 'awaiting_therapist_availability')).toBe(false);
      expect(wouldRegress('chased', 'awaiting_user_slot_selection')).toBe(false);
    });

    it('never blocks transitions from rescheduling', () => {
      expect(wouldRegress('rescheduling', 'awaiting_therapist_availability')).toBe(false);
      expect(wouldRegress('rescheduling', 'awaiting_user_slot_selection')).toBe(false);
    });

    it('never blocks transitions to non-linear states', () => {
      expect(wouldRegress('awaiting_user_slot_selection', 'stalled')).toBe(false);
      expect(wouldRegress('awaiting_user_slot_selection', 'chased')).toBe(false);
      expect(wouldRegress('confirmed', 'rescheduling')).toBe(false);
    });

    it('always blocks transitions from cancelled (terminal)', () => {
      expect(wouldRegress('cancelled', 'initial_contact')).toBe(true);
      expect(wouldRegress('cancelled', 'awaiting_therapist_availability')).toBe(true);
    });
  });
});

// ============================================
// Chase target with courtesy email scenario
// ============================================

describe('Chase target after courtesy email (regression bug scenario)', () => {
  /**
   * Reproduces the bug where sending a courtesy email to the therapist
   * ("Thanks, I've forwarded your dates") after forwarding availability
   * to the user would regress the stage from awaiting_user_slot_selection
   * back to awaiting_therapist_availability, causing the chaser to chase
   * the therapist instead of the user.
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

    if (stage === 'awaiting_user_slot_selection') {
      return {
        target: 'user',
        email: appointment.userEmail,
        threadId: appointment.gmailThreadId,
      };
    }

    if (stage === 'initial_contact' || stage === 'stalled' || !stage) {
      const state = appointment.conversationState as { checkpoint?: { context?: { lastEmailSentTo?: string } } } | null;
      const lastEmailTo = state?.checkpoint?.context?.lastEmailSentTo;

      if (lastEmailTo === 'therapist') {
        return { target: 'therapist', email: appointment.therapistEmail, threadId: appointment.therapistGmailThreadId };
      }
      if (lastEmailTo === 'user') {
        return { target: 'user', email: appointment.userEmail, threadId: appointment.gmailThreadId };
      }
      if (appointment.therapistGmailThreadId) {
        return { target: 'therapist', email: appointment.therapistEmail, threadId: appointment.therapistGmailThreadId };
      }
      if (appointment.gmailThreadId) {
        return { target: 'user', email: appointment.userEmail, threadId: appointment.gmailThreadId };
      }
    }

    return null;
  }

  it('chases the user (not therapist) when stage is correctly preserved at awaiting_user_slot_selection', () => {
    // Scenario: Therapist (Karin) provided dates, system forwarded to user (Calvin),
    // then sent a courtesy email back to therapist. With the regression fix,
    // the stage should remain at awaiting_user_slot_selection.

    // Simulate the checkpoint progression WITH regression prevention:
    // 1. Initial email to therapist
    let cp = updateCheckpoint(null, 'sent_initial_email_to_therapist', null, { lastEmailSentTo: 'therapist' });
    expect(cp.stage).toBe('awaiting_therapist_availability');

    // 2. Therapist provides availability → send to user
    cp = updateCheckpoint(cp, 'sent_availability_to_user', null, { lastEmailSentTo: 'user' });
    expect(cp.stage).toBe('awaiting_user_slot_selection');

    // 3. Courtesy email to therapist — WITH regression prevention, stage stays
    const courtesyEmailStage = stageFromAction('sent_initial_email_to_therapist');
    expect(wouldRegress(cp.stage, courtesyEmailStage)).toBe(true);
    // So we only update the context, not the stage:
    cp = { ...cp, context: { ...cp.context, lastEmailSentTo: 'therapist' } };
    expect(cp.stage).toBe('awaiting_user_slot_selection'); // Stage preserved!

    // 4. Chase should target the USER (Calvin), not the therapist (Karin)
    const result = determineChaseTarget({
      checkpointStage: cp.stage,
      userEmail: 'calvin@example.com',
      therapistEmail: 'karin@example.com',
      gmailThreadId: 'thread-client',
      therapistGmailThreadId: 'thread-therapist',
      conversationState: { checkpoint: cp },
    });

    expect(result).toEqual({
      target: 'user',
      email: 'calvin@example.com',
      threadId: 'thread-client',
    });
  });

  it('WITHOUT regression prevention, chaser would incorrectly target the therapist', () => {
    // This demonstrates the bug BEFORE the fix

    // 1. Initial email to therapist
    let cp = updateCheckpoint(null, 'sent_initial_email_to_therapist', null, { lastEmailSentTo: 'therapist' });

    // 2. Send availability to user
    cp = updateCheckpoint(cp, 'sent_availability_to_user', null, { lastEmailSentTo: 'user' });
    expect(cp.stage).toBe('awaiting_user_slot_selection');

    // 3. Courtesy email to therapist — WITHOUT regression prevention, stage regresses
    cp = updateCheckpoint(cp, 'sent_initial_email_to_therapist', null, { lastEmailSentTo: 'therapist' });
    expect(cp.stage).toBe('awaiting_therapist_availability'); // BUG: stage regressed!

    // 4. Chase would incorrectly target the therapist
    const result = determineChaseTarget({
      checkpointStage: cp.stage,
      userEmail: 'calvin@example.com',
      therapistEmail: 'karin@example.com',
      gmailThreadId: 'thread-client',
      therapistGmailThreadId: 'thread-therapist',
      conversationState: { checkpoint: cp },
    });

    expect(result?.target).toBe('therapist'); // Wrong! Should be 'user'
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

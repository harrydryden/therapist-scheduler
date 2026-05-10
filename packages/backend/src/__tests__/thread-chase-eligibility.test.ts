/**
 * Tests for the chase/closure side of the thread lifecycle:
 *   - Chase target determination (who to chase based on checkpoint stage)
 *   - Checkpoint stage regression guard (`wouldRegress`)
 *   - Chase target after a courtesy email (regression-bug scenario)
 *   - Chase eligibility rules
 *   - Closure recommendation eligibility rules
 *
 * Sibling file `thread-lifecycle-paths.test.ts` covers the path-and-meta
 * side: extractConversationMeta, full lifecycle path simulations, the
 * recovery system interaction, and feedback auto-completion eligibility.
 *
 * Both files were split out of the original 945-line
 * `thread-lifecycle-chase.test.ts` for navigability — the underlying
 * concerns are tightly related but the file size made it slow to
 * locate any individual case. Test contents are unchanged.
 *
 * Note: The stale-check service methods are tightly coupled to
 * Prisma/Gmail/Redis. These tests verify the deterministic logic and
 * eligibility rules rather than the full integration. The conversation
 * checkpoint tests (conversation-checkpoint.test.ts) cover the state
 * machine transitions exhaustively.
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
} from '../services/conversation-checkpoint.service';

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


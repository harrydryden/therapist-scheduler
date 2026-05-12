/**
 * Unit tests for the stage-group predicates extracted in the
 * consolidation refactor. Two responsibilities:
 *
 *   1. Membership: the four sets contain exactly the stages the system
 *      depends on. A rename or typo would change auto-unfreeze, chase
 *      routing, or tool-surface gating — pin them here.
 *   2. Widening: the predicate helpers accept the `string | null` shape
 *      that comes out of Prisma's checkpointStage column. Each predicate
 *      must handle null/undefined safely and not throw on arbitrary
 *      strings.
 */

import {
  PRE_SLOT_STAGES,
  POST_CONFIRM_STAGES,
  THERAPIST_PENDING_STAGES,
  USER_PENDING_STAGES,
  isPreSlot,
  isPostConfirm,
  isTherapistPending,
  isUserPending,
} from '../services/stage-groups';
import type { ConversationStage } from '@therapist-scheduler/shared';

describe('stage-group membership', () => {
  it('PRE_SLOT_STAGES contains the three stages where no slot has been agreed', () => {
    expect(PRE_SLOT_STAGES.has('initial_contact')).toBe(true);
    expect(PRE_SLOT_STAGES.has('awaiting_therapist_availability')).toBe(true);
    expect(PRE_SLOT_STAGES.has('awaiting_user_slot_selection')).toBe(true);
    expect(PRE_SLOT_STAGES.has('confirmed')).toBe(false);
    expect(PRE_SLOT_STAGES.has('cancelled')).toBe(false);
  });

  it('POST_CONFIRM_STAGES covers confirmed and the awaiting-meeting-link window', () => {
    expect(POST_CONFIRM_STAGES.has('confirmed')).toBe(true);
    expect(POST_CONFIRM_STAGES.has('awaiting_meeting_link')).toBe(true);
    expect(POST_CONFIRM_STAGES.has('rescheduling')).toBe(false);
    expect(POST_CONFIRM_STAGES.has('initial_contact')).toBe(false);
  });

  it('THERAPIST_PENDING_STAGES gates auto-unfreeze (the #213 fix)', () => {
    expect(THERAPIST_PENDING_STAGES.has('awaiting_therapist_availability')).toBe(true);
    expect(THERAPIST_PENDING_STAGES.has('awaiting_therapist_confirmation')).toBe(true);
    expect(THERAPIST_PENDING_STAGES.has('awaiting_meeting_link')).toBe(true);
    // User-pending and confirmed stages are explicitly OUT — auto-unfreeze
    // is meant to fire for genuinely-stale user-pending conversations.
    expect(THERAPIST_PENDING_STAGES.has('awaiting_user_slot_selection')).toBe(false);
    expect(THERAPIST_PENDING_STAGES.has('confirmed')).toBe(false);
  });

  it('USER_PENDING_STAGES is currently the single awaiting_user_slot_selection stage', () => {
    expect(USER_PENDING_STAGES.has('awaiting_user_slot_selection')).toBe(true);
    expect(USER_PENDING_STAGES.size).toBe(1);
  });
});

describe('stage-group predicates', () => {
  const stages: ConversationStage[] = [
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

  it('isPreSlot agrees with PRE_SLOT_STAGES across every stage', () => {
    for (const s of stages) {
      expect(isPreSlot(s)).toBe(PRE_SLOT_STAGES.has(s));
    }
  });

  it('isPostConfirm agrees with POST_CONFIRM_STAGES across every stage', () => {
    for (const s of stages) {
      expect(isPostConfirm(s)).toBe(POST_CONFIRM_STAGES.has(s));
    }
  });

  it('isTherapistPending agrees with THERAPIST_PENDING_STAGES across every stage', () => {
    for (const s of stages) {
      expect(isTherapistPending(s)).toBe(THERAPIST_PENDING_STAGES.has(s));
    }
  });

  it('isUserPending agrees with USER_PENDING_STAGES across every stage', () => {
    for (const s of stages) {
      expect(isUserPending(s)).toBe(USER_PENDING_STAGES.has(s));
    }
  });

  it('all predicates return false for null', () => {
    expect(isPreSlot(null)).toBe(false);
    expect(isPostConfirm(null)).toBe(false);
    expect(isTherapistPending(null)).toBe(false);
    expect(isUserPending(null)).toBe(false);
  });

  it('all predicates return false for undefined', () => {
    expect(isPreSlot(undefined)).toBe(false);
    expect(isPostConfirm(undefined)).toBe(false);
    expect(isTherapistPending(undefined)).toBe(false);
    expect(isUserPending(undefined)).toBe(false);
  });

  it('all predicates return false for arbitrary strings that are not stages', () => {
    // The widening cast inside the predicate means a non-stage string
    // doesn't crash; it just isn't in the set. This is how the predicates
    // tolerate the Prisma `String?` column shape.
    expect(isPreSlot('not_a_stage')).toBe(false);
    expect(isPostConfirm('garbage')).toBe(false);
    expect(isTherapistPending('')).toBe(false);
    expect(isUserPending('AWAITING_USER_SLOT_SELECTION')).toBe(false); // case-sensitive
  });
});

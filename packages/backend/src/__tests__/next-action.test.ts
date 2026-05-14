/**
 * Unit tests for the operator-facing "Next action" derivation.
 *
 * The string this function produces shows up on every dashboard row
 * AND on the appointment detail panel — getting the precedence wrong
 * or the wording inconsistent confuses operators in the worst way
 * (they trust the table but act on stale info from the detail).
 *
 * Every branch of `deriveNextAction` is exercised at least once.
 * Branch precedence is pinned by the "precedence" describe block.
 */

import { deriveNextAction, type NextActionInput } from '../utils/next-action';

// Minimal input — overlay individual fields per test to exercise
// one branch at a time without repeating the shape.
function input(overrides: Partial<NextActionInput> = {}): NextActionInput {
  return {
    status: 'negotiating',
    humanControlEnabled: false,
    chaseSentAt: null,
    chaseSentTo: null,
    closureRecommendedAt: null,
    closureRecommendationActioned: false,
    confirmedDateTime: null,
    checkpointStage: null,
    pendingAction: null,
    ...overrides,
  };
}

describe('deriveNextAction', () => {
  describe('terminal statuses', () => {
    it('returns the cancelled string for cancelled appointments', () => {
      expect(deriveNextAction(input({ status: 'cancelled' }))).toBe(
        'Cancelled — no action',
      );
    });

    it('confirmed + datetime present', () => {
      expect(
        deriveNextAction(
          input({ status: 'confirmed', confirmedDateTime: '2026-06-01T10:00:00Z' }),
        ),
      ).toBe('Session booked — awaiting session date');
    });

    it('confirmed without datetime falls back to a different string', () => {
      expect(deriveNextAction(input({ status: 'confirmed' }))).toBe(
        'Confirmed — awaiting session date',
      );
    });
  });

  describe('admin-required states', () => {
    it('closure recommended (unactioned) wins over everything else', () => {
      expect(
        deriveNextAction(
          input({
            closureRecommendedAt: new Date(),
            closureRecommendationActioned: false,
            chaseSentAt: new Date(),
            humanControlEnabled: true,
            checkpointStage: 'awaiting_user_slot_selection',
          }),
        ),
      ).toBe('Review closure recommendation');
    });

    it('closure recommended but ACTIONED no longer matches', () => {
      expect(
        deriveNextAction(
          input({
            closureRecommendedAt: new Date(),
            closureRecommendationActioned: true,
            checkpointStage: 'awaiting_user_slot_selection',
          }),
        ),
      ).toBe('Awaiting client slot choice');
    });

    it('human control beats waiting states', () => {
      expect(
        deriveNextAction(
          input({
            humanControlEnabled: true,
            chaseSentAt: new Date(),
            checkpointStage: 'awaiting_user_slot_selection',
          }),
        ),
      ).toBe('Reply manually or release control');
    });
  });

  describe('waiting-on-external states', () => {
    it('chase sent — embeds target', () => {
      expect(
        deriveNextAction(input({ chaseSentAt: new Date(), chaseSentTo: 'therapist' })),
      ).toBe('Awaiting reply after chase to therapist');
    });

    it('chase sent without target uses fallback', () => {
      expect(deriveNextAction(input({ chaseSentAt: new Date() }))).toBe(
        'Awaiting reply after chase to recipient',
      );
    });

    it('pendingAction override beats the stage default', () => {
      expect(
        deriveNextAction(
          input({
            checkpointStage: 'awaiting_user_slot_selection',
            pendingAction: 'Custom: do the thing',
          }),
        ),
      ).toBe('Custom: do the thing');
    });
  });

  describe('stage-derived defaults', () => {
    it.each([
      ['initial_contact', 'Awaiting initial outreach'],
      ['awaiting_therapist_availability', 'Awaiting therapist availability'],
      ['awaiting_user_slot_selection', 'Awaiting client slot choice'],
      ['awaiting_therapist_confirmation', 'Awaiting therapist confirmation'],
      ['awaiting_meeting_link', 'Awaiting meeting link from therapist'],
      ['rescheduling', 'Rescheduling in progress'],
      ['stalled', 'Stalled — manual nudge needed'],
      ['chased', 'Awaiting reply after chase'],
      ['closure_recommended', 'Review closure recommendation'],
    ])('stage=%s → %s', (stage, expected) => {
      expect(deriveNextAction(input({ checkpointStage: stage }))).toBe(expected);
    });
  });

  describe('fallback', () => {
    it('no stage, no signals → awaiting next message', () => {
      expect(deriveNextAction(input())).toBe('Awaiting next message');
    });

    it('unknown stage falls back to the same string', () => {
      expect(
        deriveNextAction(input({ checkpointStage: 'made_up_stage_name' })),
      ).toBe('Awaiting next message');
    });
  });

  describe('precedence', () => {
    // Pin the documented precedence:
    //   cancelled > confirmed > closure_recommended > human_control >
    //   chase_sent > pendingAction > stage_default > fallback
    it('cancelled beats everything', () => {
      expect(
        deriveNextAction(
          input({
            status: 'cancelled',
            closureRecommendedAt: new Date(),
            humanControlEnabled: true,
            chaseSentAt: new Date(),
            checkpointStage: 'awaiting_user_slot_selection',
          }),
        ),
      ).toBe('Cancelled — no action');
    });

    it('confirmed beats admin-required', () => {
      expect(
        deriveNextAction(
          input({
            status: 'confirmed',
            confirmedDateTime: '2026-06-01T10:00:00Z',
            closureRecommendedAt: new Date(),
            humanControlEnabled: true,
          }),
        ),
      ).toBe('Session booked — awaiting session date');
    });
  });
});

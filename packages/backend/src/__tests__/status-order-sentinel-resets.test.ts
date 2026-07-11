/**
 * Pins the backward sentinel-reset matrix in computeBackwardSentinelResets.
 *
 * The one that bit in production: restoring completed → feedback_requested
 * previously reset NOTHING (the feedback reset used a strict `<` on the
 * target index), so the row kept its months-old feedbackReminderSentAt and
 * the feedback dead-end auto-completer (chase-email.service) re-completed
 * it on the very next stale-check tick — making a manual restore appear to
 * "flip itself back to completed" within the hour.
 */

import { computeBackwardSentinelResets } from '../domain/scheduling/lifecycle/status-order';

describe('computeBackwardSentinelResets', () => {
  it('completed → feedback_requested clears the reminder sentinel only (restore path)', () => {
    const { updates, reset } = computeBackwardSentinelResets('completed', 'feedback_requested');
    expect(reset).toBe(true);
    expect(updates).toEqual({ feedbackReminderSentAt: null });
    // feedbackFormSentAt survives: the form genuinely was sent, and clearing
    // the reminder alone restarts the reminder → grace → auto-complete cycle.
    expect(updates).not.toHaveProperty('feedbackFormSentAt');
  });

  it('feedback_requested → session_held clears both feedback sentinels (re-request walk-back)', () => {
    const { updates, reset } = computeBackwardSentinelResets('feedback_requested', 'session_held');
    expect(reset).toBe(true);
    expect(updates).toEqual({ feedbackFormSentAt: null, feedbackReminderSentAt: null });
  });

  it('completed → session_held clears both feedback sentinels', () => {
    const { updates } = computeBackwardSentinelResets('completed', 'session_held');
    expect(updates).toEqual({ feedbackFormSentAt: null, feedbackReminderSentAt: null });
  });

  it('completed → confirmed clears feedback AND post-confirmation sentinels', () => {
    const { updates, reset } = computeBackwardSentinelResets('completed', 'confirmed');
    expect(reset).toBe(true);
    expect(updates).toEqual({
      meetingLinkCheckSentAt: null,
      reminderSentAt: null,
      feedbackFormSentAt: null,
      feedbackReminderSentAt: null,
    });
  });

  it('forward moves reset nothing', () => {
    expect(computeBackwardSentinelResets('session_held', 'feedback_requested')).toEqual({
      updates: {},
      reset: false,
    });
    expect(computeBackwardSentinelResets('feedback_requested', 'completed')).toEqual({
      updates: {},
      reset: false,
    });
  });

  it('same-status moves reset nothing', () => {
    expect(computeBackwardSentinelResets('feedback_requested', 'feedback_requested')).toEqual({
      updates: {},
      reset: false,
    });
  });
});

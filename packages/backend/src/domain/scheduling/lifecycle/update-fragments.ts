/**
 * Reusable partial-update fragments spread into transition data shapes.
 *
 * Kept in their own module so the constants don't drift if a transition
 * implementation needs to clear them in an edge case — there's exactly
 * one definition for each.
 */

/**
 * Standard "clear any in-progress reschedule" partial. Spread into update
 * data on every transition that supersedes an active reschedule:
 * confirmed (with new datetime), completed, cancelled, and adminForceUpdate
 * when moving to a terminal state or setting a new datetime.
 */
export const CLEAR_RESCHEDULING_STATE = {
  reschedulingInProgress: false,
  reschedulingInitiatedBy: null,
} as const;

/**
 * Reset all four post-booking follow-up sentinels. Used by transitionToConfirmed
 * when rescheduling (the new session needs its own meeting-link check, reminder,
 * feedback form, feedback reminder).
 */
export const RESET_ALL_FOLLOWUP_SENTINELS = {
  meetingLinkCheckSentAt: null,
  reminderSentAt: null,
  feedbackFormSentAt: null,
  feedbackReminderSentAt: null,
} as const;

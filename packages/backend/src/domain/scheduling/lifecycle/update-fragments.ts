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

/**
 * Clear all human-control state. Spread into update data on terminal
 * transitions where the appointment is being moved to a state in which
 * "who has the helm" is no longer meaningful.
 *
 * Currently applied by `transitionToCancelled`:
 *   - The admin almost always takes human control to perform a manual
 *     cancellation (the patch route requires it as a guard). Leaving
 *     `humanControlEnabled` true post-cancel inflates the Human Control
 *     dashboard tile with a permanently-cancelled appointment and is
 *     visually confusing — there's no agent to release control TO,
 *     since the appointment is terminal.
 *   - Clearing all four fields (not just `humanControlEnabled`) so the
 *     row's "ghost" attribution doesn't survive past the transition.
 *
 * NOT applied by `transitionToCompleted` for now — operators usually
 * don't take human control to complete an appointment (it auto-
 * progresses), so the field is naturally false. A future change could
 * apply this uniformly across terminal transitions.
 */
export const CLEAR_HUMAN_CONTROL_STATE = {
  humanControlEnabled: false,
  humanControlTakenBy: null,
  humanControlTakenAt: null,
  humanControlReason: null,
} as const;

/**
 * Clear the chase-sentinel triplet. Spread into update data when an
 * appointment crosses a checkpoint-stage boundary so the chase
 * scheduler can fire one chase per stage rather than one per
 * appointment lifetime. See `chaseResetIfStageChanged` below for the
 * rule, and `services/chase-email.service.ts` candidate query for
 * what this enables.
 *
 * Applied by the two writers of `appointmentRequest.checkpointStage`:
 *   - `aiConversationService.applyCheckpointUpdate` (chase-send,
 *     closure-recommend, closure-dismiss)
 *   - `aiConversationService.storeConversationState` (agent
 *     end-of-turn save — the dominant path)
 *
 * Both writers MUST stay in lock-step on this invariant. Defining
 * the field set + the trigger rule here is the lock-step mechanism.
 */
export const CLEAR_CHASE_STATE = {
  chaseSentAt: null,
  chaseSentTo: null,
  chaseTargetEmail: null,
} as const;

/**
 * The "one chase per checkpoint stage" rule. Returns `CLEAR_CHASE_STATE`
 * when the conversation FSM is crossing into a new stage, otherwise an
 * empty object that's safe to spread.
 *
 * Encapsulating the rule (not just the constant) so a future change
 * to "what counts as a stage change" — e.g. allowing only forward
 * transitions to reset, or carving out rescheduling — lands in ONE
 * place rather than getting tweaked inconsistently across both
 * column writers.
 */
export function chaseResetIfStageChanged(
  oldStage: string | null,
  newStage: string | null,
): typeof CLEAR_CHASE_STATE | Record<string, never> {
  return oldStage === newStage ? {} : CLEAR_CHASE_STATE;
}

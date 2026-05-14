/**
 * Derive the operator-facing "Next action" string for an appointment.
 *
 * Single source of truth for what the admin should do (or wait for)
 * next. Used by:
 *   - the dashboard list endpoint (one line per row)
 *   - the appointment detail endpoint (banner under the stage label)
 *
 * Wording rules:
 *   - **Short and imperative.** The string sits in a narrow column.
 *     Aim for ≤ 40 chars where possible.
 *   - **Action verb first when the admin is the one acting**
 *     ("Review closure recommendation", "Take over or release").
 *   - **"Awaiting" prefix when the system is the one waiting**
 *     ("Awaiting therapist availability", "Awaiting client choice").
 *   - **Precedence**: terminal state → admin-required → waiting on
 *     external party → stage-derived → fallback. Earlier branches
 *     are higher-signal so they win over generic stage strings.
 */

import type { ConversationStage } from '../services/conversation-checkpoint.service';

export interface NextActionInput {
  status: string;
  humanControlEnabled: boolean;
  chaseSentAt: Date | string | null;
  chaseSentTo: string | null;
  closureRecommendedAt: Date | string | null;
  closureRecommendationActioned: boolean;
  confirmedDateTime: string | null;
  checkpointStage: ConversationStage | string | null;
  /** Optional override: when the conversation checkpoint carries an
   *  explicit `pendingAction` it wins over the stage-derived default. */
  pendingAction?: string | null;
}

/**
 * Per-stage default for the "what are we waiting on" case.
 * Short and consistent in voice — every entry starts with a verb
 * (mostly "Awaiting", occasionally an imperative for admin-action
 * states like `stalled` and `closure_recommended`).
 */
const STAGE_NEXT_ACTIONS: Record<string, string> = {
  initial_contact: 'Awaiting initial outreach',
  awaiting_therapist_availability: 'Awaiting therapist availability',
  awaiting_user_slot_selection: 'Awaiting client slot choice',
  awaiting_therapist_confirmation: 'Awaiting therapist confirmation',
  awaiting_meeting_link: 'Awaiting meeting link from therapist',
  rescheduling: 'Rescheduling in progress',
  stalled: 'Stalled — manual nudge needed',
  chased: 'Awaiting reply after chase',
  closure_recommended: 'Review closure recommendation',
};

export function deriveNextAction(input: NextActionInput): string {
  // Terminal state — nothing for the admin to do.
  if (input.status === 'cancelled') {
    return 'Cancelled — no action';
  }

  // Booked and committed — wait for the session itself.
  if (input.status === 'confirmed') {
    return input.confirmedDateTime
      ? 'Session booked — awaiting session date'
      : 'Confirmed — awaiting session date';
  }

  // Admin-required states (highest priority, in order):

  // Agent has flagged this for closure and the admin hasn't acted
  // on the recommendation yet. The most urgent thing the admin
  // can see.
  if (input.closureRecommendedAt && !input.closureRecommendationActioned) {
    return 'Review closure recommendation';
  }

  // Admin took over. The agent is paused until they either reply
  // manually or release control.
  if (input.humanControlEnabled) {
    return 'Reply manually or release control';
  }

  // Waiting-on-external states:

  // A chase has been sent; we're waiting on the recipient.
  if (input.chaseSentAt) {
    const target = input.chaseSentTo || 'recipient';
    return `Awaiting reply after chase to ${target}`;
  }

  // Checkpoint-level pendingAction override beats the stage default.
  if (input.pendingAction) {
    return String(input.pendingAction);
  }

  // Stage-derived default.
  if (input.checkpointStage && STAGE_NEXT_ACTIONS[input.checkpointStage]) {
    return STAGE_NEXT_ACTIONS[input.checkpointStage];
  }

  // Fallback: brand-new appointment with no stage yet, or an
  // unknown stage. "Awaiting next message" matches the system's
  // passive default state.
  return 'Awaiting next message';
}

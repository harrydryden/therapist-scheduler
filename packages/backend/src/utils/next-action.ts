/**
 * Derive the operator-facing "Next action" string for an appointment.
 *
 * Single source of truth for what the admin should do (or wait for)
 * next. Used by:
 *   - the dashboard list endpoint (one line per row)
 *   - the appointment detail endpoint (banner under the stage label)
 *
 * Wording rules:
 *   - **Carry both party and context** when waiting on someone.
 *     "Awaiting reply from user on availability shared" tells the
 *     operator at a glance who we're waiting on AND what they were
 *     asked for, so they don't need to open the detail panel.
 *   - **Action verb first when the admin is the one acting**
 *     ("Review closure recommendation", "Reply manually or release
 *     control").
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
  /**
   * Who the agent most recently emailed on this thread — pulled
   * from `conversation_state.checkpoint.context.lastEmailSentTo`.
   * When the checkpoint stage is null (admin-created appointment
   * where the agent has yet to advance the FSM, etc.) this drives
   * the "Awaiting reply from user/therapist" fallback so the
   * operator sees who we're waiting on rather than the generic
   * "Awaiting next message".
   */
  lastEmailSentTo?: 'user' | 'therapist' | null;
  /**
   * Role of the most recent message in the conversation log
   * (from `lastMessagePreview.role`). Used as a secondary signal
   * when `lastEmailSentTo` isn't available — `'agent'` implies
   * we sent the last thing and are awaiting a reply; `'inbound'`
   * implies a reply has landed and the agent should process it.
   */
  lastMessageRole?: 'agent' | 'inbound' | 'admin' | string | null;
}

/**
 * Per-stage default for the "what are we waiting on" case.
 *
 * Canonical, finite set: one label per `ConversationStage`. Wording is
 * "Awaiting {object} from {party}" — object-first so the dashboard cell
 * answers "what are we waiting for" at a glance without an "on X"
 * suffix. Admin-action stages (`stalled`, `closure_recommended`) use
 * imperative form because the admin is the one expected to act.
 *
 * `confirmed` / `cancelled` map to empty strings because the terminal
 * branches at the top of `deriveNextAction` already handle them — the
 * stage-derived branch never sees them. The keys are present to keep
 * the `Record<ConversationStage, ...>` exhaustive: adding a new stage
 * to the enum will fail compilation here until it's mapped, blocking
 * the "silently falls through to fallback" failure mode.
 *
 * For nuanced sub-states the canonical labels don't cover (e.g.
 * "request more availability after first slots didn't work"), the
 * agent sets `checkpoint.pendingAction` — the override branch below
 * surfaces it directly. Keeping the stage labels canonical avoids
 * dashboard drift; one-off phrasings live in `pendingAction`.
 */
const STAGE_NEXT_ACTIONS: Record<ConversationStage, string> = {
  // Canonical first move for initial_contact: the agent emails the
  // therapist with the user's request. The "to therapist" suffix
  // is correct for the typical (and overwhelmingly common) flow and
  // matches the party-aware shape of every other stage label. Edge
  // cases (admin-initiated user-first flows) are rare and the row
  // moves out of initial_contact as soon as the agent acts.
  initial_contact: 'Awaiting initial outreach to therapist',
  awaiting_therapist_availability: 'Awaiting availability from therapist',
  awaiting_user_slot_selection: 'Awaiting time/date selection from user',
  awaiting_therapist_confirmation: 'Awaiting confirmation from therapist',
  awaiting_meeting_link: 'Awaiting meeting link from therapist',
  rescheduling: 'Rescheduling — awaiting new availability',
  stalled: 'Stalled — manual nudge needed',
  chased: 'Awaiting reply after chase',
  closure_recommended: 'Review closure recommendation',
  // Terminal stages — unreachable here (handled by `status` branches
  // at the top of `deriveNextAction`). Present for exhaustiveness only.
  confirmed: '',
  cancelled: '',
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
  //
  // `checkpointStage` is typed as `ConversationStage | string | null`
  // because the value originates from a denormalised DB column. The
  // `as ConversationStage` here narrows for the lookup; if the row
  // carries a stage value outside the enum (legacy / hand-edited / a
  // stage that was renamed without a migration), the lookup returns
  // undefined and the `&&` falls through to the heuristic — the same
  // behaviour as the prior loose-typed map.
  const stageLabel = input.checkpointStage
    ? STAGE_NEXT_ACTIONS[input.checkpointStage as ConversationStage]
    : undefined;
  if (stageLabel) {
    return stageLabel;
  }

  // No checkpoint stage — fall back to message-direction inference.
  // Covers legacy rows pre-instrumentation and any future path that
  // somehow persists messages without advancing the checkpoint. New
  // rows pick up the `initial_contact` schema default and the agent
  // tool-loop bootstraps a checkpoint on entry, so this branch
  // shouldn't fire for fresh appointments — it's the safety net.
  //
  // The wording mirrors `awaiting_user_slot_selection` /
  // `awaiting_therapist_availability` on purpose — when `lastEmailSentTo`
  // is set without a stage, the most common reason at the negotiation
  // phase is exactly that:
  //   - we last emailed the user → typically we shared availability
  //   - we last emailed the therapist → typically we asked them for it
  // It's a heuristic (~80% correct based on typical flow) — wrong
  // when the agent sent a clarifying question instead of a slot
  // share, or when the row's true state is `awaiting_therapist_confirmation`.
  // The dashboard cell is read with that grain of salt; the detail
  // panel still shows the underlying signals if an operator needs
  // to disambiguate.
  if (input.lastEmailSentTo === 'user') {
    return 'Awaiting time/date selection from user';
  }
  if (input.lastEmailSentTo === 'therapist') {
    return 'Awaiting availability from therapist';
  }
  if (input.lastMessageRole === 'agent') {
    // Agent sent something out but we don't know to whom — likely
    // an older row written before lastEmailSentTo was captured. We
    // can't responsibly guess at the party here.
    return 'Awaiting reply';
  }
  if (input.lastMessageRole === 'inbound') {
    // A reply has landed but the agent hasn't responded yet —
    // either it's still processing or it bailed mid-loop.
    return 'Agent processing inbound message';
  }

  // True fallback: no messages, no signals. Brand-new appointment
  // or empty conversation state. Matches the stage-derived
  // initial_contact label so the same row reads consistently whether
  // the row has stage='initial_contact' or no stage at all (legacy /
  // mid-bootstrap).
  return 'Awaiting initial outreach to therapist';
}

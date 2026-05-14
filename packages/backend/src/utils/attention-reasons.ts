/**
 * Translate a `ConversationHealth` result into the human-readable
 * "Why is this appointment in Needs Attention?" reasons surfaced
 * on the detail panel.
 *
 * The health service already produces a `HealthFactor[]` with
 * `name`, `value`, `threshold`, `description`. That's accurate but
 * operator-hostile — it describes WHAT the system noticed without
 * telling the admin WHY they should care or WHAT to do.
 *
 * This module bridges that gap. Each red factor becomes an
 * AttentionReason with:
 *   - `title`   — short, scannable, drives the visual hierarchy
 *   - `detail`  — one-line elaboration (threshold, value, etc.)
 *   - `suggestion` — concrete next step
 *
 * Only RED factors produce reasons. Yellow factors are warnings,
 * not actionable triage signals — surfacing them here would dilute
 * the banner and train admins to ignore it.
 */

import type {
  ConversationHealth,
  HealthFactor,
} from '../services/conversation-health.service';

export interface AttentionReason {
  /** Stable machine identifier — useful for tests + future analytics. */
  kind:
    | 'inactivity'
    | 'stall'
    | 'thread_divergence'
    | 'tool_failure'
    | 'human_control'
    | 'closure_recommended';
  /** Short scannable headline. */
  title: string;
  /** One-line elaboration (e.g. threshold breached). */
  detail: string;
  /** Concrete next step the admin can take. */
  suggestion: string;
}

interface AttentionReasonInput {
  health: ConversationHealth | null;
  closureRecommendedAt: Date | string | null;
  closureRecommendedReason: string | null;
  closureRecommendationActioned: boolean;
}

/**
 * Map a `HealthFactor.name` (set inside the health service) to an
 * AttentionReason. Returns `null` if the factor isn't recognised or
 * isn't red — defensive against future health factors landing here
 * without a corresponding triage hint.
 */
function factorToReason(factor: HealthFactor): AttentionReason | null {
  if (factor.status !== 'red') return null;

  // Factor names come from conversation-health.service.ts. Keeping
  // them as string literals here (rather than re-exporting an enum)
  // avoids a service ↔ util coupling; the worst case is "factor lands
  // in NO triage hint" which our tests catch via exhaustive coverage.
  switch (factor.name) {
    case 'Inactivity':
      return {
        kind: 'inactivity',
        title: 'Inactive for too long',
        detail: `No activity in ${factor.value}${factor.threshold ? ` (threshold ${factor.threshold})` : ''}.`,
        suggestion: 'Send a manual nudge, or cancel if the client has gone silent.',
      };
    case 'Progress':
      return {
        kind: 'stall',
        title: 'Conversation stalled',
        detail: `Messages arriving but no tool execution in ${factor.value}${factor.threshold ? ` (threshold ${factor.threshold})` : ''}.`,
        suggestion: 'Open the thread — the agent may be stuck on a missing input. Reply manually if needed.',
      };
    case 'Thread Integrity':
      return {
        kind: 'thread_divergence',
        title: 'Thread divergence',
        detail: 'The Gmail thread split. Replies may be landing on the wrong message.',
        suggestion: 'Investigate the split thread and acknowledge once routing is corrected.',
      };
    case 'Tool Execution':
      return {
        kind: 'tool_failure',
        title: 'Last tool execution failed',
        detail: factor.value || 'A scheduled action failed to complete.',
        suggestion: 'Check the logs for the failing tool — the agent will not retry automatically.',
      };
    case 'Automation':
      return {
        kind: 'human_control',
        title: 'Human control active',
        detail: 'An admin took over and the agent is paused.',
        suggestion: 'Reply manually or release control to let the agent resume.',
      };
    default:
      return null;
  }
}

/**
 * Produce the ordered list of reasons this appointment is flagged.
 * Ordering reflects triage urgency:
 *   1. `closure_recommended` — explicit ask for admin action
 *   2. `thread_divergence` — data correctness; affects routing
 *   3. `tool_failure` — automation is broken
 *   4. `stall` — agent stuck, may need a nudge
 *   5. `inactivity` — passive, fixable later
 *   6. `human_control` — informational; admin already knows
 */
const KIND_PRIORITY: Record<AttentionReason['kind'], number> = {
  closure_recommended: 0,
  thread_divergence: 1,
  tool_failure: 2,
  stall: 3,
  inactivity: 4,
  human_control: 5,
};

export function deriveAttentionReasons(
  input: AttentionReasonInput,
): AttentionReason[] {
  const reasons: AttentionReason[] = [];

  // Closure recommendation isn't a HealthFactor — it's a separate
  // signal from the agent flagging the conversation for admin
  // action. Surface it first since it's the most explicit "do
  // something" prompt the agent can produce.
  if (input.closureRecommendedAt && !input.closureRecommendationActioned) {
    reasons.push({
      kind: 'closure_recommended',
      title: 'Closure recommended by agent',
      detail: input.closureRecommendedReason
        ? `Reason: "${truncate(input.closureRecommendedReason, 200)}"`
        : 'The agent flagged this for admin review.',
      suggestion: 'Review the recommendation and either confirm closure or dismiss to resume.',
    });
  }

  // Health factors → reasons. Skip when health is missing
  // (e.g. terminal status — no monitoring).
  if (input.health) {
    for (const factor of input.health.factors) {
      const reason = factorToReason(factor);
      if (reason) reasons.push(reason);
    }
  }

  reasons.sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
  return reasons;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

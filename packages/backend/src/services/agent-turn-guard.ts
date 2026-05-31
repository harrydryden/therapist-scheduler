/**
 * Per-turn tool-call guard shared by the booking (`runToolLoop`) and
 * availability (`runAvailabilityToolLoop`) agent loops.
 *
 * Both loops gate each tool call through the SAME two runaway circuits:
 *
 *   - a per-turn tool BUDGET — the number of state-changing tool calls one
 *     inbound trigger may make; and
 *   - a SAME-HASH guard — identical `(name, input)` repeated within one turn:
 *     the 1st executes, the 2nd is short-circuited with a "try something
 *     else" directive, the Nth aborts the turn.
 *
 * The decision arithmetic is intricate — pure tools are exempt from the
 * budget (but not the same-hash guard), the 2nd-occurrence skip still spends
 * a budget slot for state-changing tools, and the budget/abort flags must
 * trip exactly once — and it was previously copied verbatim into both loops,
 * where it had drifted once already. This class owns the turn-scoped counters
 * and returns a decision; each loop keeps its OWN recording (the booking loop
 * writes an `auditEventService` row, the availability loop — which has no
 * appointment-scoped audit table — structured-logs the bucket) and its own
 * execute path. Only the genuinely-identical decision logic is consolidated.
 *
 * Pure tools (`PURE_TOOLS`, e.g. `resolve_local_time`) are exempt from the
 * budget but NOT from the same-hash guard — see `core/agent/tools/pure-tools`.
 */

import { PURE_TOOLS } from '../core/agent/tools/pure-tools';
import {
  buildBudgetExhaustedMessage,
  buildSameHashAbortMessage,
  buildSameHashBlockedMessage,
  computeTurnHash,
} from './tool-loop-helpers';

/** Why a tool call was skipped — used by callers for audit/log attribution. */
export type ToolSkipBucket =
  | 'turn_budget_exhausted'
  | 'same_hash_aborted'
  | 'same_hash_blocked';

export type ToolCallDecision =
  | { kind: 'execute' }
  | {
      kind: 'skip';
      /** The tool_result content the loop feeds back to Claude. */
      content: string;
      bucket: ToolSkipBucket;
      /** Occurrences of this (name,input) hash so far this turn. 0 for the
       *  budget bucket (the hash isn't computed when the budget trips first). */
      seenCount: number;
    };

export interface ToolTurnGuardLimits {
  /** Max state-changing tool calls per turn (TURN_TOOL_BUDGET). */
  budget: number;
  /** Identical (name,input) occurrences that abort the turn (SAME_HASH_TURN_ABORT). */
  sameHashAbortLimit: number;
}

/**
 * Stateful, turn-scoped. Construct one per `runToolLoop` /
 * `runAvailabilityToolLoop` invocation; the counters cumulate across
 * iterations within that invocation and are discarded when it returns.
 */
export class ToolTurnGuard {
  private stateChangingCalls = 0;
  private readonly turnHashCounts = new Map<string, number>();
  private tripped = { budgetExhausted: false, sameHashAborted: false };

  constructor(private readonly limits: ToolTurnGuardLimits) {}

  /** True once a budget-exhausted skip has been returned this turn. */
  get budgetExhausted(): boolean {
    return this.tripped.budgetExhausted;
  }

  /** True once a same-hash abort has been returned this turn. */
  get sameHashAborted(): boolean {
    return this.tripped.sameHashAborted;
  }

  /** State-changing (non-pure) tool calls counted so far this turn. */
  get toolsThisTurn(): number {
    return this.stateChangingCalls;
  }

  /**
   * Decide whether a tool call should execute or be skipped, mutating the
   * turn-scoped counters as a side effect. Mirrors the per-call gate that
   * used to live inline in both loops, exactly.
   */
  evaluate(toolName: string, input: unknown): ToolCallDecision {
    const isPure = PURE_TOOLS.has(toolName);

    // Budget guard. Pure tools (resolve_local_time) are exempt — the prompt
    // mandates calling one before every record_availability_window, so
    // counting them doubles the budget pressure on multi-date replies.
    if (!isPure && this.stateChangingCalls >= this.limits.budget) {
      this.tripped.budgetExhausted = true;
      return {
        kind: 'skip',
        content: buildBudgetExhaustedMessage(toolName, this.limits.budget),
        bucket: 'turn_budget_exhausted',
        seenCount: 0,
      };
    }

    // Same-hash guard. 1st executes; 2nd is short-circuited with a directive;
    // the abort-limit-th aborts the turn.
    const turnHash = computeTurnHash(toolName, input);
    const seenCount = (this.turnHashCounts.get(turnHash) ?? 0) + 1;
    this.turnHashCounts.set(turnHash, seenCount);

    if (seenCount >= this.limits.sameHashAbortLimit) {
      this.tripped.sameHashAborted = true;
      return {
        kind: 'skip',
        content: buildSameHashAbortMessage(toolName, seenCount),
        bucket: 'same_hash_aborted',
        seenCount,
      };
    }

    if (seenCount > 1) {
      // 2nd occurrence: skip with directive. Still costs a budget slot for
      // state-changing tools (a tool_use block was emitted and answered);
      // pure tools don't tick the budget — a repeat is just wasted compute.
      if (!isPure) this.stateChangingCalls++;
      return {
        kind: 'skip',
        content: buildSameHashBlockedMessage(toolName),
        bucket: 'same_hash_blocked',
        seenCount,
      };
    }

    // First occurrence — execute. Increment before the caller runs the tool
    // so a thrown exception still counts against the budget.
    if (!isPure) this.stateChangingCalls++;
    return { kind: 'execute' };
  }
}

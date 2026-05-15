/**
 * Pure tools — tools that have no side effects, do no DB writes,
 * send no emails, and don't advance any checkpoint.
 *
 * The agent framework treats these specially in two places:
 *
 *   1. `dispatch.ts` skips the atomic human-control gate + the
 *      idempotency mark + the per-appointment ceiling counter +
 *      the success-audit event. Pure tools must remain callable
 *      while a human has taken control (the agent will read them
 *      to reason; humans only block side effects).
 *
 *   2. `services/agent-tool-loop.ts` skips the turn budget
 *      increment + the budget-exhausted short-circuit. The
 *      prompt mandates calling `resolve_local_time` BEFORE every
 *      `record_availability_window`; counting both doubles the
 *      budget pressure on multi-date therapist replies. Excluding
 *      pure tools gates the budget on state-changing calls only.
 *
 * Same-hash guards still apply to pure tools — repeated identical
 * calls are wasted compute, and the loop catches them.
 *
 * Centralised here so the two layers agree about which tools are
 * pure. The bypass invariants in (1) and (2) are pinned by tests
 * in `__tests__/ai-tool-executor.test.ts` (for dispatch) and the
 * agent-tool-loop budget tests (for the loop) — both import this
 * set.
 */

export const PURE_TOOLS: ReadonlySet<string> = new Set(['resolve_local_time']);

/** Convenience predicate. Returns true for tool names in `PURE_TOOLS`. */
export function isPureTool(name: string): boolean {
  return PURE_TOOLS.has(name);
}

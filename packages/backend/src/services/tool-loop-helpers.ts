/**
 * Pure helpers used by the booking and availability tool loops.
 *
 * Kept in their own file so the unit tests can exercise them without
 * dragging in the loop's anthropic + prisma + settings module graph
 * (same rationale as tools-for-stage.ts). Zero side-effect imports.
 */

/**
 * Stable per-turn hash for de-duplicating identical tool calls within
 * one runToolLoop invocation. Turn-local (in-memory map), so no SHA
 * needed — string equality on (name, input) is enough. Decoupled from
 * the executor's persistent SHA hash that spans turns via Redis, so
 * the two checks compose cleanly.
 */
export function computeTurnHash(toolName: string, input: unknown): string {
  return `${toolName}:${JSON.stringify(input)}`;
}

/**
 * Build the tool_result text shown to Claude for a skipped tool call.
 *
 * The previous "Tool X skipped: idempotent" wording was easy for the
 * model to misread as a failure and retry — which then incremented the
 * per-appointment tool counter on every retry (#207). The new wording
 * names the outcome and tells the model what to do next, so it stops
 * looping on the same hash.
 */
export function buildSkipMessage(toolName: string, skipReason?: string): string {
  if (skipReason === 'idempotent') {
    return `Tool ${toolName} was already completed earlier in this conversation. This is not an error — continue with the next step in the workflow, or call flag_for_human_review if there is nothing more to do.`;
  }
  if (skipReason === 'human_control') {
    return `Tool ${toolName} was not executed because this conversation is now under human control. Stop responding; an admin will take over.`;
  }
  return `Tool ${toolName} skipped: ${skipReason ?? 'unknown reason'}`;
}

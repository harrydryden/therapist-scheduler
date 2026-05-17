/**
 * Pure helpers used by the booking and availability tool loops.
 *
 * Kept in their own file so the unit tests can exercise them without
 * dragging in the loop's anthropic + prisma + settings module graph
 * (same rationale as tools-for-stage.ts). The only import is the
 * Anthropic SDK's type namespace — `import type` so no runtime
 * side-effects come along.
 */

import type Anthropic from '@anthropic-ai/sdk';

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

// ─── Response parsing ───────────────────────────────────────────────

export interface ParsedClaudeResponse {
  toolCalls: Anthropic.ToolUseBlock[];
  /** Concatenated text from all TextBlock children, joined with '\n'.
   *  Empty string when the response has no text blocks. */
  assistantText: string;
}

/**
 * Split a Claude response into its tool-use blocks and concatenated
 * assistant text. Both loops parse responses identically; centralising
 * the filter calls here removes one of the recurring duplications and
 * keeps the type narrowing in one place.
 */
export function parseClaudeResponse(
  response: Anthropic.Message,
): ParsedClaudeResponse {
  const toolCalls = response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  );
  return {
    toolCalls,
    assistantText: textBlocks.map((b) => b.text).join('\n'),
  };
}

// ─── Turn-guard message builders ────────────────────────────────────
//
// Each builder produces the exact tool_result `content` or admin
// `messages.push` body string that one of the two loops emits when a
// per-turn guard fires. The strings used to live inline in both loops
// and drifted silently once; centralising them here means a wording
// change touches one place and the unit tests pin the contract.

export function buildBudgetExhaustedMessage(
  toolName: string,
  budget: number,
): string {
  return `Tool ${toolName} not executed: turn tool budget exhausted (${budget} calls). The conversation is being paused for admin review.`;
}

export function buildSameHashAbortMessage(
  toolName: string,
  seenCount: number,
): string {
  return `Tool ${toolName} attempted ${seenCount} times with identical arguments in this turn — aborting to prevent a loop. An admin will review.`;
}

export function buildSameHashBlockedMessage(toolName: string): string {
  return `Tool ${toolName} with these exact arguments was already attempted earlier in this turn. Try a different approach, change the arguments, or call flag_for_human_review.`;
}

export function buildTurnBreakerReason(
  cause: 'budget' | 'same_hash',
  limits: { budget: number; sameHashAbortLimit: number },
): string {
  if (cause === 'budget') {
    return `Turn tool budget exhausted (${limits.budget} tool calls in one inbound trigger). Agent paused for admin review.`;
  }
  return `Same tool called ${limits.sameHashAbortLimit}+ times with identical arguments in one turn — agent thrashing on a duplicate call. Paused for review.`;
}

export function buildErrorBreakerAdminMessage(totalToolErrors: number): string {
  return `[System: ${totalToolErrors} tool failures in this turn — pausing for admin review.]`;
}

export function buildErrorBreakerFlagReason(totalToolErrors: number): string {
  return `Tool error circuit breaker tripped (${totalToolErrors} failures in one turn). Agent paused for review.`;
}

export function buildMaxIterationsAdminMessage(maxIterations: number): string {
  return `[System: Hit the ${maxIterations}-iteration ceiling with the agent still working — pausing for admin review.]`;
}

export function buildMaxIterationsFlagReason(maxIterations: number): string {
  return `Tool loop hit the ${maxIterations}-iteration ceiling with the agent still working (not a natural completion). Agent paused for review.`;
}

// ─── Message round-trip ─────────────────────────────────────────────

/**
 * Append one Claude round-trip (assistant response + user-side tool
 * results) to the message history for the next iteration. Returns a
 * new array; the loops treat `messagesForClaude` immutably so callers
 * can rely on referential equality of the input slice.
 */
export function appendToolRoundTrip(
  messages: Anthropic.MessageParam[],
  response: Anthropic.Message,
  toolResults: Anthropic.ToolResultBlockParam[],
): Anthropic.MessageParam[] {
  return [
    ...messages,
    { role: 'assistant' as const, content: response.content },
    { role: 'user' as const, content: toolResults },
  ];
}

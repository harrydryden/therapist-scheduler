/**
 * Agent Tool Loop
 *
 * Extracted from justin-time.service.ts where the same ~130-line tool loop
 * was duplicated between startScheduling() and processEmailReply(). Both
 * methods follow the identical pattern:
 *
 *   1. Call Claude API with messages + tools
 *   2. Extract tool calls and text from response
 *   3. Execute each tool call, collecting results
 *   4. Update checkpoint state based on tool results
 *   5. Handle flag_for_human_review by stopping the loop
 *   6. Feed tool results back to Claude and repeat (up to MAX_TOOL_ITERATIONS)
 *
 * The only differences were:
 *   - processEmailReply checkpoints state to DB before side-effecting tools
 *   - Log message context strings ("startScheduling" vs "processEmailReply")
 *
 * This module parameterizes those differences and provides one reusable loop.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropicClient } from '../utils/anthropic-client';
import { CLAUDE_MODELS, MODEL_CONFIG } from '../config/models';
import { logger } from '../utils/logger';
import { resilientCall } from '../utils/resilient-call';
import { circuitBreakerRegistry, CIRCUIT_BREAKER_CONFIGS } from '../utils/circuit-breaker';
import {
  type ConversationCheckpoint,
  type ConversationAction,
  type ConversationStage,
  createCheckpoint,
  updateCheckpoint,
  stageFromAction,
  wouldRegress,
} from '../services/conversation-checkpoint.service';
import { truncateMessageContent } from './ai-conversation.service';
import { auditEventService } from './audit-event.service';
import { getSettingValue } from './settings.service';
import { getToolsForStage } from './tools-for-stage';
// The per-turn budget + same-hash decision logic is shared with the
// availability loop via ToolTurnGuard. It owns the PURE_TOOLS budget
// exemption + the message builders, so neither is referenced directly here
// any more.
import { ToolTurnGuard } from './agent-turn-guard';
import { getDailyTokenBudgetStatus, recordTokenUsage } from './agent-token-budget';
import {
  appendToolRoundTrip,
  buildErrorBreakerAdminMessage,
  buildErrorBreakerFlagReason,
  buildMaxIterationsAdminMessage,
  buildMaxIterationsFlagReason,
  buildSkipMessage,
  buildTurnBreakerReason,
  parseClaudeResponse,
} from './tool-loop-helpers';
import type { ToolExecutionResult, SchedulingContext } from './scheduling-context.service';
import type { ConversationState } from '../types';
import {
  availabilityTools,
  AVAILABILITY_SIDE_EFFECT_TOOLS,
  AVAILABILITY_TERMINAL_TOOLS,
} from '../domain/scheduling/availability/agent/tools';
import { schedulingTools } from '../domain/scheduling/agent/tools-schema';

/** Maximum number of Claude round-trips per inbound trigger. The real
 *  bound on side effects is TURN_TOOL_BUDGET (state-changing calls per
 *  turn) — this cap only bounds Claude API spend within one inbound. Set
 *  to 8 (was 5) after operators saw the iteration ceiling trip on
 *  legitimate workflows where the therapist replied with many distinct
 *  availability windows: each window consumes a slot, and the agent had
 *  no spare iteration to emit the text-only "done" response that signals
 *  natural completion. The 12-call budget, same-hash guard (3), and
 *  error breaker (3) remain as the actual runaway safety nets — none
 *  depend on this constant. */
const MAX_TOOL_ITERATIONS = 8;

/** Cumulative tool-call failures within a single runToolLoop invocation
 *  that trip the error circuit breaker. Three failures in one turn is the
 *  agent thrashing on a real problem (validation errors, transient outages,
 *  prompt-injection driving impossible tool calls). Better to escalate
 *  than keep retrying. */
const TURN_ERROR_LIMIT = 3;

/** Maximum tool-call attempts across a single runToolLoop invocation.
 *  Closes the "MAX_TOOL_ITERATIONS × N tool_use blocks per iteration"
 *  amplification that lets one inbound trigger push 30+ calls into the
 *  per-appointment lifecycle counter. Generous enough for a realistic turn — e.g.
 *  remember + record_availability_window + send_email + record_booking_link
 *  + a follow-up email — but well below any plausible legitimate need.
 *
 *  Sized at 12 (was 8) to accommodate therapist replies that list many
 *  one-off availability windows in a single message — each window is one
 *  `record_availability_window` call, and operators reported the prior
 *  budget tripping on ~5-date replies once `resolve_local_time` calls
 *  were also counted. With pure tools now exempt (ToolTurnGuard consults
 *  `PURE_TOOLS`) the budget gates ~12 state-changing calls per turn.
 *  Loop-style runaway is still caught by the SAME_HASH_TURN_ABORT
 *  guard, not by this budget. */
const TURN_TOOL_BUDGET = 12;

/** Number of times the same (toolName, input) hash can appear within one
 *  runToolLoop invocation before the loop aborts. 1st: executes. 2nd:
 *  short-circuited with a directive telling the model to try something
 *  else or call flag_for_human_review. 3rd: loop aborts and escalates.
 *  Catches the dominant cause of ceiling trips — idempotent retries and
 *  injection-driven repeated calls. */
const SAME_HASH_TURN_ABORT = 3;

const claudeCircuitBreaker = circuitBreakerRegistry.getOrCreate(CIRCUIT_BREAKER_CONFIGS.CLAUDE_API);

// Pure helpers (buildSkipMessage, parseClaudeResponse, the breaker-message
// builders, and appendToolRoundTrip) live in tool-loop-helpers.ts; the
// per-turn budget + same-hash decision lives in agent-turn-guard.ts. Both
// are unit-tested without dragging in the loop's anthropic + prisma +
// settings module graph.

/**
 * Return a copy of `messages` whose final content block carries a prompt
 * cache breakpoint. The loops resend the whole history on every iteration
 * of a turn (plus one more assistant/tool-result round-trip each time), so
 * caching up to the latest message lets iteration N+1 read everything
 * iteration N sent — the ~50KB thread context included — at ~0.1x.
 *
 * Applied to a per-request copy: `messagesForClaude` itself never carries
 * a breakpoint, so a request has at most two (this one + the system
 * block's) against the API's limit of four, however many iterations run.
 */
function withTrailingCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === 'string'
      ? last.content
        ? [{ type: 'text', text: last.content }]
        : []
      : [...last.content];
  const tail = blocks[blocks.length - 1];
  if (!tail) return messages;
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam;
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

/**
 * Shared Anthropic call shape used by both tool loops. Centralises model
 * selection, max_tokens, prompt caching, token accounting and circuit-
 * breaker config so changing any of them is a one-line edit. Stays in this
 * module (not in tool-loop-helpers) because it imports anthropic +
 * circuit-breaker — the helpers file is deliberately import-free of
 * runtime side-effects so its tests stay fast.
 *
 * Prompt caching: `cache_control` on the single system block caches the
 * tool definitions AND the system prompt (tools render before system in
 * the request prefix); both are fixed for the length of a turn. The
 * trailing message breakpoint (above) caches the growing history.
 */
async function callAgentClaude(args: {
  systemPrompt: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  context: string;
  traceId: string;
  maxTokens?: number;
}): Promise<Anthropic.Message> {
  const response = await resilientCall(
    () =>
      anthropicClient.messages.create(
        {
          model: CLAUDE_MODELS.AGENT,
          max_tokens: args.maxTokens ?? MODEL_CONFIG.agent.maxTokens,
          system: [{ type: 'text', text: args.systemPrompt, cache_control: { type: 'ephemeral' } }],
          tools: args.tools,
          messages: withTrailingCacheBreakpoint(args.messages),
        },
        { timeout: MODEL_CONFIG.agent.requestTimeoutMs },
      ),
    { context: args.context, traceId: args.traceId, circuitBreaker: claudeCircuitBreaker },
  );
  await recordTokenUsage(response.usage, { traceId: args.traceId, context: args.context });
  return response;
}

/** Token usage summed over one loop invocation (logged when the turn ends). */
export interface TurnTokenUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

function emptyTurnUsage(): TurnTokenUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

function addTurnUsage(total: TurnTokenUsage, usage: Anthropic.Usage | null | undefined): void {
  total.calls++;
  if (!usage) return;
  total.inputTokens += usage.input_tokens ?? 0;
  total.outputTokens += usage.output_tokens ?? 0;
  total.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
  total.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
}

/**
 * Why a turn was escalated before any of its tool calls could run:
 *   - token_budget: the daily token budget is exhausted (Claude not called)
 *   - truncated: the response stopped on `max_tokens` twice — its tool
 *     calls may be cut off mid-argument, so none of them run
 *   - refusal: Claude declined (stop_reason 'refusal')
 *   - empty_response: no text and no tool calls, with nothing done this turn
 */
type ResponseGuardBucket = 'token_budget' | 'truncated' | 'refusal' | 'empty_response';

type GuardedResponse =
  | { kind: 'response'; response: Anthropic.Message }
  | { kind: 'escalate'; bucket: ResponseGuardBucket; reason: string };

/**
 * One Claude round-trip for a loop iteration, with the response-level
 * guards both loops share. Only a response that is safe to act on comes
 * back as `kind: 'response'`:
 *
 *   - budget exhausted → escalate WITHOUT calling Claude;
 *   - `max_tokens` → never act on the truncated response (a cut-off
 *     tool_use can still parse, e.g. an email body ending mid-sentence);
 *     re-ask once with the larger cap, and escalate if that is cut off too;
 *   - `refusal` → escalate (a refusal is not a finished turn).
 */
async function requestAgentResponse(
  args: Parameters<typeof callAgentClaude>[0],
  usage: TurnTokenUsage,
  turn: { nothingDoneYet: boolean },
): Promise<GuardedResponse> {
  const budget = await getDailyTokenBudgetStatus();
  if (budget.exhausted) {
    logger.warn(
      { traceId: args.traceId, used: budget.used, budget: budget.budget },
      `${args.context} - daily token budget exhausted; not calling Claude`,
    );
    return {
      kind: 'escalate',
      bucket: 'token_budget',
      // Stable text (no running count) so repeat alerts dedup on reason.
      reason: `Daily Claude token budget exhausted (${budget.budget} tokens per UTC day). Agent paused without calling Claude; raise agent.dailyTokenBudget or wait for the midnight UTC reset, then release.`,
    };
  }

  let response = await callAgentClaude(args);
  addTurnUsage(usage, response.usage);

  if (response.stop_reason === 'max_tokens') {
    const retryCap = MODEL_CONFIG.agent.maxTokensOnTruncation ?? (args.maxTokens ?? MODEL_CONFIG.agent.maxTokens) * 2;
    logger.warn(
      { traceId: args.traceId, maxTokens: args.maxTokens ?? MODEL_CONFIG.agent.maxTokens, retryCap },
      `${args.context} - Claude response hit max_tokens; discarding it and retrying once with a larger cap`,
    );
    response = await callAgentClaude({ ...args, maxTokens: retryCap });
    addTurnUsage(usage, response.usage);
    if (response.stop_reason === 'max_tokens') {
      return {
        kind: 'escalate',
        bucket: 'truncated',
        reason: `Claude's response was cut off at the output-token limit twice (${retryCap} tokens), so none of its tool calls were run. Agent paused for review.`,
      };
    }
  }

  if (response.stop_reason === 'refusal') {
    return {
      kind: 'escalate',
      bucket: 'refusal',
      reason: 'Claude declined to respond to this conversation (stop_reason: refusal). Nothing was sent. Agent paused for review.',
    };
  }

  // Neither text nor tool calls. Only an escalation while nothing has been
  // achieved this turn: after successful tool calls an empty end_turn just
  // means Claude had nothing to add.
  const { toolCalls, assistantText } = parseClaudeResponse(response);
  if (turn.nothingDoneYet && toolCalls.length === 0 && assistantText.trim() === '') {
    return {
      kind: 'escalate',
      bucket: 'empty_response',
      reason: `Claude returned an empty response (no text, no tool calls; stop_reason: ${response.stop_reason}) and nothing was done this turn. Agent paused for review.`,
    };
  }

  return { kind: 'response', response };
}

/** Tools whose execution produces external side effects (DB mutations, emails).
 *  checkpointBeforeSideEffects() is called before these to ensure conversation state
 *  is persisted, so a crash mid-execution doesn't lose prior agent work. */
const SIDE_EFFECT_TOOLS = new Set([
  'send_email',
  'mark_scheduling_complete',
  'flag_for_human_review',
  'recommend_cancel_match',
  'cancel_appointment',
  'initiate_reschedule',
  'update_therapist_availability',
  'record_booking_link',
  'issue_voucher_code',
]);

// Stage-gated tool surface lives in tools-for-stage.ts to keep the matrix
// a pure function — easier to unit-test without dragging in the loop's
// anthropic + prisma + settings module graph.

export interface ExecutedTool {
  toolName: string;
  emailSentTo?: 'user' | 'therapist';
  timestamp: string;
}

export interface ToolLoopCallbacks {
  /** Execute a single tool call. Provided by JustinTimeService. */
  executeToolCall: (toolCall: Anthropic.ToolUseBlock, context: SchedulingContext) => Promise<ToolExecutionResult>;
  /** Optional: checkpoint state before side-effecting tools (used by processEmailReply) */
  checkpointBeforeSideEffects?: () => Promise<void>;
  /** Optional: server-side escalation when the loop detects a runaway
   *  condition (e.g. TURN_ERROR_LIMIT tripped) without the agent having
   *  called flag_for_human_review itself. Implementations should flip
   *  humanControlEnabled on the appointment so subsequent inbound mail
   *  doesn't resume the loop. */
  flagForHumanReview?: (reason: string) => Promise<void>;
}

export interface ToolLoopResult {
  /** Number of loop iterations completed */
  iterations: number;
  /** Total tool errors encountered */
  totalToolErrors: number;
  /** Tools that were successfully executed (for compensation tracking) */
  executedTools: ExecutedTool[];
  /** Whether the loop was terminated by flag_for_human_review */
  flaggedForHumanReview: boolean;
  /** Whether max iterations were hit */
  hitMaxIterations: boolean;
  /** Claude token usage summed over the turn's calls */
  usage: TurnTokenUsage;
}

/**
 * Run the Claude tool loop.
 *
 * Calls Claude with the given messages and tools, executes tool calls,
 * feeds results back to Claude, and repeats until Claude stops calling tools
 * or we hit MAX_TOOL_ITERATIONS.
 *
 * @param systemPrompt - The system prompt for Claude
 * @param messages - Initial messages for Claude
 * @param conversationState - Mutable state object (messages are appended in-place)
 * @param context - Scheduling context
 * @param callbacks - Tool execution and checkpoint callbacks
 * @param traceId - Trace ID for log correlation
 * @param logContext - Context string for log messages (e.g., "startScheduling")
 * @returns Final messagesForClaude array (for callers that need it) and loop result
 */

/**
 * Shared escalation orchestration for both loops' safety circuits (turn
 * budget/same-hash breaker, tool-error breaker, iteration ceiling). Each
 * circuit differs only in its trigger condition and the reason/message
 * text it builds (see tool-loop-helpers.ts's build* functions) — the
 * "log + push an admin message + best-effort flagForHumanReview" sequence
 * that follows was previously copy-pasted three times per loop, twice
 * over (once per loop), and had already drifted in wording once.
 *
 * Lives here (not in tool-loop-helpers.ts) because it calls `logger`,
 * and tool-loop-helpers.ts is deliberately logger-free so its own unit
 * tests don't need to mock the config/logger module graph.
 */
async function escalateToHumanReview(args: {
  traceId: string;
  idFields: Record<string, unknown>;
  logContext: string;
  logMessage: string;
  logExtra?: Record<string, unknown>;
  adminMessageContent: string;
  flagReason: string;
  flagForHumanReview?: (reason: string) => Promise<void>;
  pushAdminMessage: (content: string) => void;
}): Promise<void> {
  logger.warn(
    { traceId: args.traceId, ...args.idFields, ...args.logExtra },
    `${args.logContext} - ${args.logMessage}`,
  );
  args.pushAdminMessage(args.adminMessageContent);
  if (args.flagForHumanReview) {
    try {
      await args.flagForHumanReview(args.flagReason);
    } catch (flagErr) {
      logger.error(
        { traceId: args.traceId, ...args.idFields, err: flagErr },
        `${args.logContext} - Failed to flag for human review`,
      );
    }
  }
}

export async function runToolLoop(
  systemPrompt: string,
  initialMessages: Anthropic.MessageParam[],
  conversationState: ConversationState,
  context: SchedulingContext,
  callbacks: ToolLoopCallbacks,
  traceId: string,
  logContext: string,
): Promise<{ messages: Anthropic.MessageParam[]; result: ToolLoopResult }> {
  // Bootstrap checkpoint when entering the loop without one.
  //
  // `justin-time.service.ts` initialises checkpoint for first-contact
  // runs, but inbound-reply runs load whatever's in conversationState —
  // legacy rows pre-instrumentation, or rows where a prior iteration
  // returned text-only with no tool call (no checkpointAction → no
  // stage write at line ~654 below). Without this guard, the loop's
  // end-of-turn `storeConversationState` writes a null `checkpoint.stage`
  // back to the denormalised column, which trumps the schema default
  // and re-surfaces the "Awaiting next message" fallback on the
  // dashboard. Setting the floor here keeps the column non-null even
  // if no tool fires this turn.
  //
  // This is only a floor. processEmailReply seeds a checkpoint-less
  // state from the row's checkpointStage column before calling in, and
  // parseConversationState preserves the stored checkpoint (it used to
  // strip it, which made this bootstrap reset EVERY reply turn to
  // initial_contact).
  if (!conversationState.checkpoint) {
    conversationState.checkpoint = createCheckpoint('initial_contact', null);
  }

  let messagesForClaude = [...initialMessages];
  let iteration = 0;
  let totalToolErrors = 0;
  const executedTools: ExecutedTool[] = [];
  let flaggedForHumanReview = false;
  const usage = emptyTurnUsage();
  const pushAdminMessage = (content: string) =>
    conversationState.messages.push({ role: 'admin' as const, content });

  // Per-turn budget + same-hash gate. Scoped to this runToolLoop invocation
  // (counters cumulate across iterations, reset per invocation). The decision
  // arithmetic is shared with the availability loop via ToolTurnGuard.
  const turnGuard = new ToolTurnGuard({
    budget: TURN_TOOL_BUDGET,
    sameHashAbortLimit: SAME_HASH_TURN_ABORT,
  });

  // Set to true when the loop exits because Claude returned no tool calls
  // (the canonical "I'm done" signal). Used to distinguish a natural finish
  // from an iteration-cap exhaustion in the post-loop block — iteration may
  // legitimately equal MAX_TOOL_ITERATIONS on the last natural-exit
  // iteration, but only the cap-exhaustion case should escalate.
  let loopFinishedNaturally = false;

  // Read the stage-gate setting once per invocation. The tool surface is
  // still re-derived per iteration (since the checkpoint can advance
  // mid-loop), but the on/off switch is stable within a single inbound.
  // Falls open to false on settings failure — narrower is the behaviour
  // change, full surface is the safe default.
  let stageGatedToolsEnabled = false;
  try {
    stageGatedToolsEnabled = await getSettingValue<boolean>('agent.stageGatedTools');
  } catch (err) {
    logger.warn(
      { err, traceId, appointmentRequestId: context.appointmentRequestId },
      `${logContext} - Failed to read agent.stageGatedTools setting; defaulting to full tool surface`,
    );
  }

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    logger.debug(
      { traceId, appointmentRequestId: context.appointmentRequestId, iteration },
      `${logContext} - Claude API call iteration`
    );

    // Re-derive the tool surface every iteration: the checkpoint can
    // advance during the loop (e.g. send_email → awaiting_user_slot_selection)
    // and a narrower tool set may apply to the next Claude call.
    const tools = stageGatedToolsEnabled
      ? getToolsForStage(
          conversationState.checkpoint?.stage as ConversationStage | undefined,
          schedulingTools,
        )
      : schedulingTools;

    const guarded = await requestAgentResponse(
      { systemPrompt, tools, messages: messagesForClaude, context: logContext, traceId },
      usage,
      { nothingDoneYet: executedTools.length === 0 },
    );
    if (guarded.kind === 'escalate') {
      await escalateToHumanReview({
        traceId,
        idFields: { appointmentRequestId: context.appointmentRequestId },
        logContext,
        logMessage: `Response guard tripped (${guarded.bucket}) — ${guarded.reason}`,
        logExtra: { iteration, bucket: guarded.bucket },
        adminMessageContent: `[System: ${guarded.reason}]`,
        flagReason: guarded.reason,
        flagForHumanReview: callbacks.flagForHumanReview,
        pushAdminMessage,
      });
      flaggedForHumanReview = true;
      break;
    }
    const response = guarded.response;

    const { toolCalls, assistantText } = parseClaudeResponse(response);

    // Save assistant response to conversation state
    if (assistantText) {
      conversationState.messages.push({
        role: 'assistant',
        content: truncateMessageContent(assistantText),
      });
    }

    // If no tool calls, Claude is done
    if (toolCalls.length === 0) {
      logger.info(
        { traceId, appointmentRequestId: context.appointmentRequestId, iterations: iteration },
        `${logContext} - Claude finished responding (no more tool calls)`
      );
      loopFinishedNaturally = true;
      break;
    }

    // Checkpoint before side-effecting tools (if callback provided)
    const hasSideEffects = toolCalls.some(tc => SIDE_EFFECT_TOOLS.has(tc.name));
    if (hasSideEffects && callbacks.checkpointBeforeSideEffects) {
      await callbacks.checkpointBeforeSideEffects();
    }

    // Execute tools and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let stopLoop = false;

    for (const toolCall of toolCalls) {
      let toolResult: string;
      let isError = false;

      // Per-turn budget + same-hash gate (shared with the availability loop
      // via ToolTurnGuard). On a skip we still push one tool_result per
      // tool_use block (Anthropic requires one result per use) and audit the
      // short-circuit by bucket — the executor never sees the block, so the
      // audit row is the only post-incident signal that a call was
      // suppressed. The budget/abort trips are escalated after the for-loop.
      const decision = turnGuard.evaluate(toolCall.name, toolCall.input);
      if (decision.kind === 'skip') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: decision.content,
          is_error: false,
        });
        auditEventService.logToolExecuted(context.appointmentRequestId, {
          traceId,
          toolName: toolCall.name,
          result: 'skipped',
          bucket: decision.bucket,
        });
        continue;
      }

      const result = await callbacks.executeToolCall(toolCall, context);

      if (result.success) {
        if (result.skipped) {
          toolResult = buildSkipMessage(result.toolName, result.skipReason);
        } else {
          toolResult = result.resultMessage || `Tool ${result.toolName} executed successfully.`;

          executedTools.push({
            toolName: result.toolName,
            emailSentTo: result.emailSentTo,
            timestamp: new Date().toISOString(),
          });

          // Merge response tracking into conversation state (therapist email timing).
          // This is done here instead of inside sendEmail to avoid a mid-loop state
          // save that would invalidate the optimistic lock version.
          if (result.responseTracking) {
            conversationState.responseTracking = {
              ...conversationState.responseTracking,
              ...result.responseTracking,
            };
          }

          // Update checkpoint after successful tool execution.
          //   - checkpointAction set: standard stage/action update
          //     (with the wouldRegress guard).
          //   - checkpointAction undefined + email sent (the
          //     `purpose: 'acknowledge'` path): stage stays put, but
          //     `lastEmailSentTo` context is still recorded so the
          //     chase-fallback inference path knows who we last
          //     reached out to.
          if (result.checkpointAction) {
            // Explicit annotation: the runToolLoop entry-side bootstrap
            // mutates `conversationState.checkpoint`, which knocks TS's
            // narrowing here back to implicit `any` (TS7022) without it.
            const currentCheckpoint: ConversationCheckpoint | undefined =
              conversationState.checkpoint;
            const newStage = stageFromAction(result.checkpointAction);

            // Block send_email from accidentally regressing the stage
            // (e.g. a courtesy "thanks, I've forwarded your dates"
            // email to the therapist after the slot was offered to the
            // user would otherwise flip the stage backward and mis-
            // route the chaser to the therapist). The exemption below
            // covers the legitimate counter-case: when the agent
            // declares `purpose: 'request_more_availability'` the
            // regression IS the intent (user rejected, going back to
            // the therapist for more slots).
            //
            // `purpose: 'acknowledge'` doesn't reach this branch
            // because the handler returns checkpointAction=undefined
            // for it — the courtesy-reply path is handled by the
            // sibling `else if` block below.
            const isIntentionalRegression =
              result.emailPurpose === 'request_more_availability';
            const isRegression = !isIntentionalRegression &&
              currentCheckpoint &&
              result.toolName === 'send_email' &&
              wouldRegress(currentCheckpoint.stage as ConversationStage, newStage);

            if (isRegression) {
              // Don't change the stage, but still update lastEmailSentTo context
              // so the fallback chase logic has accurate tracking
              if (result.emailSentTo) {
                conversationState.checkpoint = {
                  ...currentCheckpoint!,
                  context: {
                    ...currentCheckpoint!.context,
                    lastEmailSentTo: result.emailSentTo,
                  },
                };
              }

              logger.info(
                {
                  traceId,
                  appointmentRequestId: context.appointmentRequestId,
                  currentStage: currentCheckpoint!.stage,
                  blockedStage: newStage,
                  action: result.checkpointAction,
                  emailSentTo: result.emailSentTo,
                },
                `${logContext} - Blocked checkpoint regression from send_email, updated context only`
              );
            } else {
              const updatedCheckpoint = updateCheckpoint(
                currentCheckpoint || null,
                result.checkpointAction,
                null,
                result.emailSentTo ? { lastEmailSentTo: result.emailSentTo } : undefined
              );
              conversationState.checkpoint = updatedCheckpoint;

              logger.info(
                {
                  traceId,
                  appointmentRequestId: context.appointmentRequestId,
                  action: result.checkpointAction,
                  newStage: updatedCheckpoint.stage,
                },
                `${logContext} - Checkpoint updated after tool execution`
              );
            }
          } else if (
            // No checkpoint action but an email was sent — the
            // `purpose: 'acknowledge'` path. Record the recipient on
            // the existing checkpoint's context so the chase-fallback
            // inference (determineChaseTarget's initial_contact /
            // stalled branch) and the dashboard's "last emailed"
            // labels stay accurate. Stage left untouched.
            result.emailSentTo &&
            conversationState.checkpoint
          ) {
            conversationState.checkpoint = {
              ...conversationState.checkpoint,
              context: {
                ...conversationState.checkpoint.context,
                lastEmailSentTo: result.emailSentTo,
              },
            };
          }
        }

        // Tools that enable human control stop the loop to prevent
        // the agent from taking further actions on a paused conversation.
        if ((toolCall.name === 'flag_for_human_review' || toolCall.name === 'recommend_cancel_match') && !result.skipped) {
          const reason = toolCall.name === 'recommend_cancel_match'
            ? 'Agent recommended cancelling match — stopping tool loop'
            : 'Agent flagged for human review — stopping tool loop';
          logger.info(
            { traceId, appointmentRequestId: context.appointmentRequestId },
            `${logContext} - ${reason}`
          );
          conversationState.messages.push({
            role: 'admin' as const,
            content: toolCall.name === 'recommend_cancel_match'
              ? '[System: Match cancellation recommended. Agent processing paused pending admin review.]'
              : '[System: Conversation flagged for human review. Agent processing paused.]',
          });
          flaggedForHumanReview = true;
          stopLoop = true;
          break;
        }

        // An ADMIN (not the agent) enabled human control mid-turn: dispatch's
        // atomic gate (dispatch.ts) skips the tool with skipReason:
        // 'human_control'. Without this break the loop keeps calling Claude
        // for the rest of the turn's iteration budget and appends its
        // would-be replies into the thread the admin just took over.
        // Deliberately does NOT set flaggedForHumanReview or call
        // callbacks.flagForHumanReview — human control is already enabled
        // by the admin; re-flagging would overwrite their takeover record.
        if (result.skipped && result.skipReason === 'human_control') {
          logger.info(
            { traceId, appointmentRequestId: context.appointmentRequestId },
            `${logContext} - Human control enabled mid-turn — stopping tool loop`
          );
          stopLoop = true;
          break;
        }
      } else {
        toolResult = `Error: ${result.error}`;
        isError = true;
        totalToolErrors++;
        logger.error(
          { traceId, tool: result.toolName, error: result.error },
          `${logContext} - Tool execution failed`
        );
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: toolResult,
        is_error: isError,
      });
    }

    // Turn-level circuit breakers: budget exhaustion or same-hash abort.
    // Both trip after the inner for-loop so all tool_results for this
    // iteration are collected (Anthropic requires one result per use)
    // before the while loop exits without feeding them back to Claude.
    if (!stopLoop && !flaggedForHumanReview && (turnGuard.budgetExhausted || turnGuard.sameHashAborted)) {
      const reason = buildTurnBreakerReason(
        turnGuard.budgetExhausted ? 'budget' : 'same_hash',
        { budget: TURN_TOOL_BUDGET, sameHashAbortLimit: SAME_HASH_TURN_ABORT },
      );
      await escalateToHumanReview({
        traceId,
        idFields: { appointmentRequestId: context.appointmentRequestId },
        logContext,
        logMessage: `Turn-level circuit breaker tripped — ${reason}`,
        logExtra: {
          toolsThisTurn: turnGuard.toolsThisTurn,
          iteration,
          budgetExhausted: turnGuard.budgetExhausted,
          sameHashAborted: turnGuard.sameHashAborted,
          bucket: turnGuard.budgetExhausted ? 'turn_budget_exhausted' : 'same_hash_aborted',
        },
        adminMessageContent: `[System: ${reason}]`,
        flagReason: reason,
        flagForHumanReview: callbacks.flagForHumanReview,
        pushAdminMessage,
      });
      flaggedForHumanReview = true;
      stopLoop = true;
    }

    // Error circuit breaker: TURN_ERROR_LIMIT failures within a single
    // runToolLoop invocation indicates the agent is thrashing — either a
    // genuinely broken tool, an impossible request, or prompt-injection
    // pushing impossible inputs. Escalate to human control rather than
    // continue iterating and burning the per-appointment tool ceiling.
    // Checked after the inner for-loop so all tool_results from this
    // iteration are still collected for logging, then the while loop
    // exits without sending them back to Claude (same pattern as
    // flag_for_human_review).
    if (!stopLoop && !flaggedForHumanReview && totalToolErrors >= TURN_ERROR_LIMIT) {
      await escalateToHumanReview({
        traceId,
        idFields: { appointmentRequestId: context.appointmentRequestId },
        logContext,
        logMessage: 'Tool error circuit breaker tripped — stopping loop and flagging for review',
        logExtra: { totalToolErrors, limit: TURN_ERROR_LIMIT, iteration, bucket: 'error' },
        adminMessageContent: buildErrorBreakerAdminMessage(totalToolErrors),
        flagReason: buildErrorBreakerFlagReason(totalToolErrors),
        flagForHumanReview: callbacks.flagForHumanReview,
        pushAdminMessage,
      });
      flaggedForHumanReview = true;
      stopLoop = true;
    }

    if (stopLoop) {
      break;
    }

    // Feed tool results back to Claude for the next iteration
    messagesForClaude = appendToolRoundTrip(messagesForClaude, response, toolResults);

    logger.info(
      { traceId, appointmentRequestId: context.appointmentRequestId, toolCount: toolCalls.length, iteration },
      `${logContext} - Tools executed, continuing conversation with results`
    );
  }

  // Iteration-ceiling escalation. Mirrors the budget / same-hash / error-
  // breaker blocks inside the while-loop: log + admin message + flag for
  // human review. Only fires when the cap was reached with the agent still
  // working (toolCalls on the last iteration); a natural finish on
  // iteration MAX is NOT a runaway and should not escalate. Without this
  // the loop just exited silently and the user saw whatever mid-thought
  // Claude managed to emit before iterations ran out.
  if (
    iteration >= MAX_TOOL_ITERATIONS &&
    !flaggedForHumanReview &&
    !loopFinishedNaturally
  ) {
    const reason = buildMaxIterationsFlagReason(MAX_TOOL_ITERATIONS);
    await escalateToHumanReview({
      traceId,
      idFields: { appointmentRequestId: context.appointmentRequestId },
      logContext,
      logMessage: 'Max tool iterations reached without natural completion — flagging for review',
      logExtra: { iterations: iteration, bucket: 'max_iterations' },
      adminMessageContent: buildMaxIterationsAdminMessage(MAX_TOOL_ITERATIONS),
      flagReason: reason,
      flagForHumanReview: callbacks.flagForHumanReview,
      pushAdminMessage,
    });
    flaggedForHumanReview = true;
  }

  logger.info(
    { traceId, appointmentRequestId: context.appointmentRequestId, iterations: iteration, usage },
    `${logContext} - turn token usage`,
  );

  return {
    messages: messagesForClaude,
    result: {
      iterations: iteration,
      totalToolErrors,
      executedTools,
      flaggedForHumanReview,
      hitMaxIterations: iteration >= MAX_TOOL_ITERATIONS,
      usage,
    },
  };
}

// ─── Availability-Collection Agent Loop ─────────────────────────────────────
//
// Parallel to runToolLoop but for the slim availability-collection agent.
// Sibling rather than generalisation: the booking loop has scheduling-FSM
// regression checks and a richer side-effect surface (emails, lifecycle
// transitions) that don't apply here. Keeping them as two focused
// functions is easier to reason about than one branching generalisation.
// Both share callAgentClaude / requestAgentResponse, so prompt caching,
// token accounting and the stop_reason guards are identical.

/** Context for the availability-collection agent. Slim by design: no
 *  client counterpart exists, so no userName / userEmail. */
export interface AvailabilityAgentContext {
  /** TherapistConversation.id. The conversation row is the canonical
   *  state container — same role as appointmentRequestId for the
   *  booking agent. */
  conversationId: string;
  therapistId: string;
  therapistName: string;
  therapistEmail: string;
  therapistCountry: string;
  /** Why this conversation exists; drives prompt phrasing. */
  kind: 'onboarding' | 'nudge_reply';
}

export interface AvailabilityToolLoopCallbacks {
  executeToolCall: (
    toolCall: Anthropic.ToolUseBlock,
    context: AvailabilityAgentContext,
  ) => Promise<ToolExecutionResult>;
  /** Checkpoint conversationState to the DB before any side-effecting
   *  tool runs. Same role as in runToolLoop — protects against losing
   *  the agent's prior work if a write crashes mid-execution. */
  checkpointBeforeSideEffects?: () => Promise<void>;
  /** Server-side escalation when the loop trips its error circuit
   *  breaker. Flips humanControlEnabled on the TherapistConversation so
   *  later inbound mail doesn't resume the loop. */
  flagForHumanReview?: (reason: string) => Promise<void>;
}

export interface AvailabilityToolLoopResult {
  iterations: number;
  totalToolErrors: number;
  executedTools: ExecutedTool[];
  /** True if flag_for_human_review fired — agent paused for admin. */
  flaggedForHumanReview: boolean;
  /** True if mark_complete fired — conversation reached natural end. */
  markedComplete: boolean;
  hitMaxIterations: boolean;
  /** Claude token usage summed over the turn's calls */
  usage: TurnTokenUsage;
}

/**
 * Minimal mutable state passed into the availability loop. The loop
 * appends assistant messages to `messages` in-place so the orchestrator
 * can persist the final state without us needing to return the array.
 * Mirrors the booking loop's relationship with ConversationState.
 */
export interface AvailabilityConversationState {
  messages: Array<{ role: 'user' | 'assistant' | 'admin'; content: string }>;
}

/**
 * Run the availability-collection tool loop.
 *
 * Iterates up to MAX_TOOL_ITERATIONS, calling Claude with the supplied
 * messages plus the static `availabilityTools` set. Stops early on
 * mark_complete or flag_for_human_review (both terminal for the
 * conversation), or when Claude returns no further tool calls.
 *
 * `conversationState.messages` is mutated in place as assistant turns
 * accumulate; the orchestrator persists it after the loop returns.
 */
export async function runAvailabilityToolLoop(
  systemPrompt: string,
  initialMessages: Anthropic.MessageParam[],
  conversationState: AvailabilityConversationState,
  context: AvailabilityAgentContext,
  callbacks: AvailabilityToolLoopCallbacks,
  traceId: string,
  logContext: string,
): Promise<{ messages: Anthropic.MessageParam[]; result: AvailabilityToolLoopResult }> {
  let messagesForClaude = [...initialMessages];
  let iteration = 0;
  let totalToolErrors = 0;
  const executedTools: ExecutedTool[] = [];
  let flaggedForHumanReview = false;
  let markedComplete = false;
  const usage = emptyTurnUsage();
  const pushAdminMessage = (content: string) =>
    conversationState.messages.push({ role: 'admin' as const, content });

  // Per-turn budget + same-hash gate, shared with the booking loop via
  // ToolTurnGuard. Scoped to this runAvailabilityToolLoop invocation.
  const turnGuard = new ToolTurnGuard({
    budget: TURN_TOOL_BUDGET,
    sameHashAbortLimit: SAME_HASH_TURN_ABORT,
  });

  // Mirrors the booking loop: true when Claude returns no tool calls (the
  // canonical "I'm done" signal), distinguishing a natural finish from
  // iteration-cap exhaustion in the post-loop block.
  let loopFinishedNaturally = false;

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    logger.debug(
      { traceId, conversationId: context.conversationId, iteration },
      `${logContext} - availability agent Claude API call iteration`,
    );

    const guarded = await requestAgentResponse(
      { systemPrompt, tools: availabilityTools, messages: messagesForClaude, context: logContext, traceId },
      usage,
      { nothingDoneYet: executedTools.length === 0 },
    );
    if (guarded.kind === 'escalate') {
      await escalateToHumanReview({
        traceId,
        idFields: { conversationId: context.conversationId },
        logContext,
        logMessage: `availability response guard tripped (${guarded.bucket}) — ${guarded.reason}`,
        logExtra: { iteration, bucket: guarded.bucket },
        adminMessageContent: `[System: ${guarded.reason}]`,
        flagReason: guarded.reason,
        flagForHumanReview: callbacks.flagForHumanReview,
        pushAdminMessage,
      });
      flaggedForHumanReview = true;
      break;
    }
    const response = guarded.response;

    const { toolCalls, assistantText } = parseClaudeResponse(response);

    if (assistantText) {
      conversationState.messages.push({
        role: 'assistant',
        content: truncateMessageContent(assistantText),
      });
    }

    if (toolCalls.length === 0) {
      logger.info(
        { traceId, conversationId: context.conversationId, iterations: iteration },
        `${logContext} - availability agent finished responding (no more tool calls)`,
      );
      loopFinishedNaturally = true;
      break;
    }

    const hasSideEffects = toolCalls.some((tc) => AVAILABILITY_SIDE_EFFECT_TOOLS.has(tc.name));
    if (hasSideEffects && callbacks.checkpointBeforeSideEffects) {
      await callbacks.checkpointBeforeSideEffects();
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let stopLoop = false;

    for (const toolCall of toolCalls) {
      let toolResult: string;
      let isError = false;

      // Per-turn budget + same-hash gate (shared with the booking loop via
      // ToolTurnGuard). The booking loop records skips via auditEventService;
      // this loop has no appointment-scoped audit table (it runs on
      // TherapistConversation), so it surfaces the bucket through structured
      // logging instead — same searchable signal, no schema lift. Levels are
      // preserved per bucket: warn for budget/abort, info for the soft 2nd-
      // occurrence block.
      const decision = turnGuard.evaluate(toolCall.name, toolCall.input);
      if (decision.kind === 'skip') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: decision.content,
          is_error: false,
        });
        if (decision.bucket === 'turn_budget_exhausted') {
          logger.warn(
            { traceId, conversationId: context.conversationId, toolName: toolCall.name, bucket: decision.bucket },
            `${logContext} - availability turn budget exhausted on tool ${toolCall.name}`,
          );
        } else if (decision.bucket === 'same_hash_aborted') {
          logger.warn(
            { traceId, conversationId: context.conversationId, toolName: toolCall.name, seenCount: decision.seenCount, bucket: decision.bucket },
            `${logContext} - availability same-hash abort on tool ${toolCall.name}`,
          );
        } else {
          logger.info(
            { traceId, conversationId: context.conversationId, toolName: toolCall.name, seenCount: decision.seenCount, bucket: decision.bucket },
            `${logContext} - availability same-hash 2nd-occurrence skip on tool ${toolCall.name}`,
          );
        }
        continue;
      }

      const result = await callbacks.executeToolCall(toolCall, context);

      if (result.success) {
        if (result.skipped) {
          toolResult = buildSkipMessage(result.toolName, result.skipReason);
        } else {
          toolResult = result.resultMessage || `Tool ${result.toolName} executed successfully.`;
          executedTools.push({
            toolName: result.toolName,
            emailSentTo: result.emailSentTo,
            timestamp: new Date().toISOString(),
          });
        }

        if (!result.skipped && AVAILABILITY_TERMINAL_TOOLS.has(toolCall.name)) {
          if (toolCall.name === 'flag_for_human_review') {
            flaggedForHumanReview = true;
            conversationState.messages.push({
              role: 'admin',
              content: '[System: Conversation flagged for human review. Agent processing paused.]',
            });
          } else if (toolCall.name === 'mark_complete') {
            markedComplete = true;
            conversationState.messages.push({
              role: 'admin',
              content: '[System: Availability-collection conversation marked complete by agent.]',
            });
          }
          logger.info(
            { traceId, conversationId: context.conversationId, tool: toolCall.name },
            `${logContext} - terminal tool fired, stopping availability loop`,
          );
          stopLoop = true;
        }
      } else {
        toolResult = `Error: ${result.error}`;
        isError = true;
        totalToolErrors++;
        logger.error(
          { traceId, tool: result.toolName, error: result.error },
          `${logContext} - availability tool execution failed`,
        );
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: toolResult,
        is_error: isError,
      });

      if (stopLoop) break;
    }

    // Turn-level circuit breakers (budget / same-hash). Mirror the booking
    // loop and fire before the error breaker so the right cause is logged.
    if (!stopLoop && !flaggedForHumanReview && !markedComplete && (turnGuard.budgetExhausted || turnGuard.sameHashAborted)) {
      const reason = buildTurnBreakerReason(
        turnGuard.budgetExhausted ? 'budget' : 'same_hash',
        { budget: TURN_TOOL_BUDGET, sameHashAbortLimit: SAME_HASH_TURN_ABORT },
      );
      await escalateToHumanReview({
        traceId,
        idFields: { conversationId: context.conversationId },
        logContext,
        logMessage: `availability turn-level circuit breaker tripped — ${reason}`,
        logExtra: {
          toolsThisTurn: turnGuard.toolsThisTurn,
          iteration,
          budgetExhausted: turnGuard.budgetExhausted,
          sameHashAborted: turnGuard.sameHashAborted,
        },
        adminMessageContent: `[System: ${reason}]`,
        flagReason: reason,
        flagForHumanReview: callbacks.flagForHumanReview,
        pushAdminMessage,
      });
      flaggedForHumanReview = true;
      stopLoop = true;
    }

    // Error circuit breaker — mirrors the booking loop. TURN_ERROR_LIMIT
    // failures in one runAvailabilityToolLoop invocation means the agent
    // is thrashing; escalate to human control rather than continue.
    if (!stopLoop && !flaggedForHumanReview && !markedComplete && totalToolErrors >= TURN_ERROR_LIMIT) {
      await escalateToHumanReview({
        traceId,
        idFields: { conversationId: context.conversationId },
        logContext,
        logMessage: 'availability tool error circuit breaker tripped — stopping loop and flagging for review',
        logExtra: { totalToolErrors, limit: TURN_ERROR_LIMIT, iteration, bucket: 'error' },
        adminMessageContent: buildErrorBreakerAdminMessage(totalToolErrors),
        flagReason: buildErrorBreakerFlagReason(totalToolErrors),
        flagForHumanReview: callbacks.flagForHumanReview,
        pushAdminMessage,
      });
      flaggedForHumanReview = true;
      stopLoop = true;
    }

    if (stopLoop) break;

    messagesForClaude = appendToolRoundTrip(messagesForClaude, response, toolResults);

    logger.info(
      {
        traceId,
        conversationId: context.conversationId,
        toolCount: toolCalls.length,
        iteration,
      },
      `${logContext} - availability tools executed, continuing`,
    );
  }

  // Iteration-ceiling escalation. Mirrors the booking loop: a cap hit
  // with the agent still working is a runaway and should flag for review;
  // a natural finish on the last iteration is not. `markedComplete` is the
  // availability loop's equivalent terminal-tool signal — also exempt.
  if (
    iteration >= MAX_TOOL_ITERATIONS &&
    !flaggedForHumanReview &&
    !markedComplete &&
    !loopFinishedNaturally
  ) {
    const reason = buildMaxIterationsFlagReason(MAX_TOOL_ITERATIONS);
    await escalateToHumanReview({
      traceId,
      idFields: { conversationId: context.conversationId },
      logContext,
      logMessage: 'availability agent hit max tool iterations without natural completion — flagging for review',
      logExtra: { iterations: iteration, bucket: 'max_iterations' },
      adminMessageContent: buildMaxIterationsAdminMessage(MAX_TOOL_ITERATIONS),
      flagReason: reason,
      flagForHumanReview: callbacks.flagForHumanReview,
      pushAdminMessage,
    });
    flaggedForHumanReview = true;
  }

  logger.info(
    { traceId, conversationId: context.conversationId, iterations: iteration, usage },
    `${logContext} - availability turn token usage`,
  );

  return {
    messages: messagesForClaude,
    result: {
      iterations: iteration,
      totalToolErrors,
      executedTools,
      flaggedForHumanReview,
      markedComplete,
      hitMaxIterations: iteration >= MAX_TOOL_ITERATIONS,
      usage,
    },
  };
}

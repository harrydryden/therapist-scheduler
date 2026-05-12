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
  updateCheckpoint,
  stageFromAction,
  wouldRegress,
} from '../services/conversation-checkpoint.service';
import { truncateMessageContent } from './ai-conversation.service';
import { auditEventService } from './audit-event.service';
import { getSettingValue } from './settings.service';
import { getToolsForStage } from './tools-for-stage';
import { buildSkipMessage, computeTurnHash } from './tool-loop-helpers';
import type { ToolExecutionResult, SchedulingContext } from './scheduling-context.service';
import type { ConversationState } from '../types';
import {
  availabilityTools,
  AVAILABILITY_SIDE_EFFECT_TOOLS,
  AVAILABILITY_TERMINAL_TOOLS,
} from './availability-tools';

const MAX_TOOL_ITERATIONS = 5;

/** Cumulative tool-call failures within a single runToolLoop invocation
 *  that trip the error circuit breaker. Three failures in one turn is the
 *  agent thrashing on a real problem (validation errors, transient outages,
 *  prompt-injection driving impossible tool calls). Better to escalate
 *  than keep retrying. */
const TURN_ERROR_LIMIT = 3;

/** Maximum tool-call attempts across a single runToolLoop invocation.
 *  Closes the "5 iterations × N tool_use blocks per iteration" amplification
 *  that lets one inbound trigger push 30+ calls into the per-appointment
 *  lifecycle counter. Generous enough for a realistic turn — e.g.
 *  remember + record_availability_window + send_email + record_booking_link
 *  + a follow-up email — but well below any plausible legitimate need. */
const TURN_TOOL_BUDGET = 8;

/** Number of times the same (toolName, input) hash can appear within one
 *  runToolLoop invocation before the loop aborts. 1st: executes. 2nd:
 *  short-circuited with a directive telling the model to try something
 *  else or call flag_for_human_review. 3rd: loop aborts and escalates.
 *  Catches the dominant cause of ceiling trips — idempotent retries and
 *  injection-driven repeated calls. */
const SAME_HASH_TURN_ABORT = 3;

const claudeCircuitBreaker = circuitBreakerRegistry.getOrCreate(CIRCUIT_BREAKER_CONFIGS.CLAUDE_API);

// Pure helpers (computeTurnHash, buildSkipMessage) live in
// tool-loop-helpers.ts so they can be unit-tested without dragging in
// the loop's anthropic + prisma + settings module graph.

/** Scheduling tools definition — passed to Claude */
export const schedulingTools: Anthropic.Tool[] = [
  {
    name: 'send_email',
    description: 'Send an email to a recipient',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address',
        },
        subject: {
          type: 'string',
          description: 'Email subject line. MUST include "Spill" somewhere in the subject (e.g., "Spill Therapy - Scheduling your session").',
        },
        body: {
          type: 'string',
          description: 'Email body content (plain text). IMPORTANT: Do NOT insert line breaks within paragraphs - only use blank lines between paragraphs. Let the email client handle text wrapping. Each paragraph should be a single continuous line of text.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'update_therapist_availability',
    description: 'Save therapist availability to the database for future bookings. Use this when a therapist provides their general availability for the first time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        availability: {
          type: 'object',
          description: 'Availability by day of week. Keys are day names (Monday, Tuesday, etc.), values are time ranges like "09:00-12:00, 14:00-17:00"',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['availability'],
    },
  },
  {
    name: 'mark_scheduling_complete',
    description: 'Mark the scheduling as complete and send final confirmation emails to both parties. Use this AFTER the therapist confirms they will send the meeting link.',
    input_schema: {
      type: 'object' as const,
      properties: {
        confirmed_datetime: {
          type: 'string',
          description: 'The confirmed appointment date and time (e.g., "Monday 3rd February at 10:00am")',
        },
        notes: {
          type: 'string',
          description: 'Any additional notes about the booking',
        },
      },
      required: ['confirmed_datetime'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel the appointment when either the client or therapist indicates they want to cancel or can no longer proceed. This frees up the therapist for other bookings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'The reason for cancellation (e.g., "Client requested cancellation", "Therapist unavailable")',
        },
        cancelled_by: {
          type: 'string',
          enum: ['client', 'therapist'],
          description: 'Who initiated the cancellation',
        },
      },
      required: ['reason', 'cancelled_by'],
    },
  },
  {
    name: 'recommend_cancel_match',
    description: 'Recommend cancelling this match to the admin when the user has declined the therapist (e.g. due to availability issues, preference, or any other reason they do not want to proceed). This sends an alert to the admin so they can cancel the match and free up the therapist for other users. Use this instead of cancel_appointment when the user indicates they do not want to work with this therapist but has not explicitly asked to cancel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'The reason the user has declined the match (e.g., "User declined due to therapist availability not matching their schedule")',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'issue_voucher_code',
    description: 'Issue a new session voucher code for a user who does not have one. Use this when a user contacts you saying they need a session code to book. The voucher code and booking link will be generated for the provided email address. Share the display code and booking URL with the user in your reply.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email: {
          type: 'string',
          description: 'The email address of the user to issue the voucher to',
        },
      },
      required: ['email'],
    },
  },
  {
    name: 'initiate_reschedule',
    description: 'Signal that a reschedule is needed for a confirmed appointment. Call this BEFORE sending any emails when either the client or therapist requests a time change. This clears the current confirmed date so the system knows rescheduling is in progress. Do NOT call this for non-rescheduling requests like missing meeting links, session questions, or general acknowledgments.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'Brief reason for the reschedule (e.g., "Client requested to move to a different day", "Therapist no longer available at confirmed time")',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'flag_for_human_review',
    description: 'Flag this conversation for human review when you are uncertain how to proceed, the situation is unusual, or you need guidance. This enables human control mode so an admin can review and respond. Use this proactively when unsure rather than guessing or stalling.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'Clear explanation of why you are flagging this for review and what you are uncertain about',
        },
        suggested_action: {
          type: 'string',
          description: 'Your best guess at what the next action should be (optional - helps the admin understand your thinking)',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'remember',
    description:
      'Record an observation about this conversation that you would want a colleague taking it over to know. Use sparingly: only for things that are NOT already obvious from the message log and are NOT scheduling primitives like proposed times or blockers (those are auto-extracted). Good examples: a stated communication preference ("user prefers single-line emails"), a recurring constraint ("therapist responds before 10am UK"), situational context ("user mentioned a job interview Friday"), or an explicit decision ("agreed to switch to weekly Mondays"). The system retains up to 20 notes per conversation and evicts the oldest. Re-call this tool with a corrected note if a previous one is wrong or stale — duplicate text on the same conversation is silently deduped. Do NOT include therapy-clinical content; this is for scheduling continuity only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        note: {
          type: 'string',
          description: 'The observation to retain. One sentence is ideal. Maximum 280 characters.',
        },
        category: {
          type: 'string',
          enum: ['preference', 'constraint', 'context', 'decision'],
          description: 'preference = stated style or preference; constraint = recurring fixed obligation; context = situational background; decision = an agreement made.',
        },
      },
      required: ['note', 'category'],
    },
  },
  {
    name: 'record_booking_link',
    description:
      "Record the therapist's direct booking link (Calendly, Acuity, YouCanBook.me, SavvyCal, or any other scheduling-tool URL) when they share one during the conversation. Use this whenever they mention a link like 'You can book me at calendly.com/...', 'My scheduling page is https://...', or similar. The link is the richest form of availability we can capture — once it's on file, future bookings will see it automatically. Always overwrites the existing link if there is one (most recent intent wins). After capturing the link, still forward it to the client (per the booking-link workflow above) so they can use it directly.",
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description:
            'The full booking-link URL exactly as the therapist shared it, including the scheme (https://). The executor stores it verbatim and validates it is a parseable URL.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'record_availability_window',
    description:
      'Record an episodic / one-off availability window that someone mentioned in conversation, alongside the therapist\'s recurring base schedule. Use this when you see relative or partial availability phrasings like "I can do Mondays for the next two weeks", "I\'m free this Friday afternoon", "I\'m out the week of the 15th", or "after the school holidays I\'ll have more time". Resolve the relative phrasing to absolute ISO 8601 timestamps yourself using today\'s date — the system stores what you submit verbatim, so the meaning won\'t drift if the conversation continues for days. Past windows are filtered out automatically when the prompt is rebuilt; do NOT submit windows whose endsAt is already in the past. Use status="available" for offered slots and status="unavailable" for explicit blocks/holidays. ROUTING: source="therapist" windows are stored on the therapist\'s permanent record so future bookings see them too; source="user" windows are scoped to THIS booking only (a user\'s "I\'m out next week" doesn\'t apply to other bookings).',
    input_schema: {
      type: 'object' as const,
      properties: {
        starts_at: {
          type: 'string',
          description: 'Absolute start of the window in ISO 8601 with offset, e.g. "2026-02-03T10:00:00+00:00". Compute this from the relative phrasing using today\'s date.',
        },
        ends_at: {
          type: 'string',
          description: 'Absolute end of the window in ISO 8601 with offset. Must be strictly after starts_at and not entirely in the past.',
        },
        status: {
          type: 'string',
          enum: ['available', 'unavailable'],
          description: 'available = an open slot the therapist (or user) offered; unavailable = an explicit block / holiday / out-of-office.',
        },
        source: {
          type: 'string',
          enum: ['therapist', 'user'],
          description: 'Who said it. Usually \'therapist\', but the user can also note their own absences.',
        },
        quote: {
          type: 'string',
          description: 'The original phrase from the email, verbatim. Helps later turns and admins verify your date resolution. Maximum 280 characters.',
        },
      },
      required: ['starts_at', 'ends_at', 'status', 'source', 'quote'],
    },
  },
];

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
export async function runToolLoop(
  systemPrompt: string,
  initialMessages: Anthropic.MessageParam[],
  conversationState: ConversationState,
  context: SchedulingContext,
  callbacks: ToolLoopCallbacks,
  traceId: string,
  logContext: string,
): Promise<{ messages: Anthropic.MessageParam[]; result: ToolLoopResult }> {
  let messagesForClaude = [...initialMessages];
  let iteration = 0;
  let totalToolErrors = 0;
  const executedTools: ExecutedTool[] = [];
  let flaggedForHumanReview = false;

  // Turn-scope counters for the budget + same-hash guards. Both live in
  // this closure so they cumulate across iterations within one runToolLoop
  // invocation but reset cleanly per invocation.
  let toolsThisTurn = 0;
  const turnHashCounts = new Map<string, number>();
  let budgetExhausted = false;
  let sameHashAborted = false;

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

    const response = await resilientCall(
      () => anthropicClient.messages.create({
        model: CLAUDE_MODELS.AGENT,
        max_tokens: MODEL_CONFIG.agent.maxTokens,
        system: systemPrompt,
        tools,
        messages: messagesForClaude,
      }),
      { context: logContext, traceId, circuitBreaker: claudeCircuitBreaker }
    );

    // Extract tool calls and text
    const toolCalls = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    );
    const assistantText = textBlocks.map((b) => b.text).join('\n');

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

      // Turn budget guard. Once exhausted, push a synthetic result for
      // every remaining tool_use block in this iteration (Anthropic
      // requires one result per use) but do not execute. The trip is
      // flagged after the for-loop completes.
      if (toolsThisTurn >= TURN_TOOL_BUDGET) {
        budgetExhausted = true;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: `Tool ${toolCall.name} not executed: turn tool budget exhausted (${TURN_TOOL_BUDGET} calls). The conversation is being paused for admin review.`,
          is_error: false,
        });
        // Audit the short-circuit. The executor never sees this tool_use
        // block, so without this the only signal that something was
        // suppressed lives in the assistant message; the audit log lets a
        // post-incident triage break "51/50" down by bucket.
        auditEventService.logToolExecuted(context.appointmentRequestId, {
          traceId,
          toolName: toolCall.name,
          result: 'skipped',
          bucket: 'turn_budget_exhausted',
        });
        continue;
      }

      // Same-hash-in-turn guard. 1st occurrence executes; 2nd is
      // short-circuited with a directive (model gets one chance to
      // pivot); SAME_HASH_TURN_ABORT-th aborts the loop entirely.
      const turnHash = computeTurnHash(toolCall.name, toolCall.input);
      const seenCount = (turnHashCounts.get(turnHash) ?? 0) + 1;
      turnHashCounts.set(turnHash, seenCount);

      if (seenCount >= SAME_HASH_TURN_ABORT) {
        sameHashAborted = true;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: `Tool ${toolCall.name} attempted ${seenCount} times with identical arguments in this turn — aborting to prevent a loop. An admin will review.`,
          is_error: false,
        });
        auditEventService.logToolExecuted(context.appointmentRequestId, {
          traceId,
          toolName: toolCall.name,
          result: 'skipped',
          bucket: 'same_hash_aborted',
        });
        continue;
      }

      if (seenCount > 1) {
        // 2nd occurrence: skip with directive, still costs a budget slot
        // (a tool_use block was emitted and answered).
        toolsThisTurn++;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: `Tool ${toolCall.name} with these exact arguments was already attempted earlier in this turn. Try a different approach, change the arguments, or call flag_for_human_review.`,
          is_error: false,
        });
        auditEventService.logToolExecuted(context.appointmentRequestId, {
          traceId,
          toolName: toolCall.name,
          result: 'skipped',
          bucket: 'same_hash_blocked',
        });
        continue;
      }

      // First occurrence — execute. Increment before the call so a thrown
      // exception still counts against the budget.
      toolsThisTurn++;
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

          // Update checkpoint after successful tool execution
          if (result.checkpointAction) {
            const currentCheckpoint = conversationState.checkpoint;
            const newStage = stageFromAction(result.checkpointAction);

            // Prevent send_email from regressing the checkpoint stage.
            // The send_email tool always maps to one of two early-stage actions
            // (sent_initial_email_to_therapist → awaiting_therapist_availability,
            //  sent_availability_to_user → awaiting_user_slot_selection).
            // This is correct for initial emails, but courtesy/follow-up emails
            // (e.g., "Thanks, I've forwarded your dates to the client") should
            // NOT reset the stage backward. Without this guard, a follow-up email
            // to the therapist after forwarding availability to the user would
            // regress the stage from awaiting_user_slot_selection back to
            // awaiting_therapist_availability, causing the chaser to chase the
            // wrong party.
            const isRegression = currentCheckpoint &&
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
    if (!stopLoop && !flaggedForHumanReview && (budgetExhausted || sameHashAborted)) {
      const reason = budgetExhausted
        ? `Turn tool budget exhausted (${TURN_TOOL_BUDGET} tool calls in one inbound trigger). Agent paused for admin review.`
        : `Same tool called ${SAME_HASH_TURN_ABORT}+ times with identical arguments in one turn — agent thrashing on a duplicate call. Paused for review.`;
      logger.warn(
        {
          traceId,
          appointmentRequestId: context.appointmentRequestId,
          toolsThisTurn,
          iteration,
          budgetExhausted,
          sameHashAborted,
          bucket: budgetExhausted ? 'turn_budget_exhausted' : 'same_hash_aborted',
        },
        `${logContext} - Turn-level circuit breaker tripped — ${reason}`,
      );
      conversationState.messages.push({
        role: 'admin' as const,
        content: `[System: ${reason}]`,
      });
      if (callbacks.flagForHumanReview) {
        try {
          await callbacks.flagForHumanReview(reason);
        } catch (flagErr) {
          logger.error(
            { traceId, appointmentRequestId: context.appointmentRequestId, err: flagErr },
            `${logContext} - Failed to flag for human review at turn-level breaker`,
          );
        }
      }
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
      logger.warn(
        {
          traceId,
          appointmentRequestId: context.appointmentRequestId,
          totalToolErrors,
          limit: TURN_ERROR_LIMIT,
          iteration,
          bucket: 'error',
        },
        `${logContext} - Tool error circuit breaker tripped — stopping loop and flagging for review`,
      );
      conversationState.messages.push({
        role: 'admin' as const,
        content: `[System: ${totalToolErrors} tool failures in this turn — pausing for admin review.]`,
      });
      if (callbacks.flagForHumanReview) {
        try {
          await callbacks.flagForHumanReview(
            `Tool error circuit breaker tripped (${totalToolErrors} failures in one turn). Agent paused for review.`,
          );
        } catch (flagErr) {
          logger.error(
            { traceId, appointmentRequestId: context.appointmentRequestId, err: flagErr },
            `${logContext} - Failed to flag for human review at circuit breaker`,
          );
        }
      }
      flaggedForHumanReview = true;
      stopLoop = true;
    }

    if (stopLoop) {
      break;
    }

    // Feed tool results back to Claude for the next iteration
    messagesForClaude = [
      ...messagesForClaude,
      { role: 'assistant' as const, content: response.content },
      { role: 'user' as const, content: toolResults },
    ];

    logger.info(
      { traceId, appointmentRequestId: context.appointmentRequestId, toolCount: toolCalls.length, iteration },
      `${logContext} - Tools executed, continuing conversation with results`
    );
  }

  if (iteration >= MAX_TOOL_ITERATIONS && !flaggedForHumanReview) {
    logger.warn(
      { traceId, appointmentRequestId: context.appointmentRequestId, iterations: iteration },
      `${logContext} - Hit max tool iterations — conversation may be incomplete`
    );
  }

  return {
    messages: messagesForClaude,
    result: {
      iterations: iteration,
      totalToolErrors,
      executedTools,
      flaggedForHumanReview,
      hitMaxIterations: iteration >= MAX_TOOL_ITERATIONS,
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
// Adds prompt caching that the booking loop doesn't currently use — the
// system prompt + tool definitions are stable across a conversation, so
// caching them at the last system block cuts cost on every iteration
// after the first.

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

  // Turn-scope counters for the budget + same-hash guards (mirrors the
  // booking loop). Closure-scoped so they cumulate across iterations
  // within one runAvailabilityToolLoop invocation and reset per invocation.
  let toolsThisTurn = 0;
  const turnHashCounts = new Map<string, number>();
  let budgetExhausted = false;
  let sameHashAborted = false;

  // cache_control on the system block caches both tool definitions and
  // system prompt (tools render before system in the request prefix).
  // Both are stable for the lifetime of one conversation, so every
  // iteration after the first reads from the cache at ~0.1x cost.
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
  ];

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    logger.debug(
      { traceId, conversationId: context.conversationId, iteration },
      `${logContext} - availability agent Claude API call iteration`,
    );

    const response = await resilientCall(
      () =>
        anthropicClient.messages.create({
          model: CLAUDE_MODELS.AGENT,
          max_tokens: MODEL_CONFIG.agent.maxTokens,
          system: systemBlocks,
          tools: availabilityTools,
          messages: messagesForClaude,
        }),
      { context: logContext, traceId, circuitBreaker: claudeCircuitBreaker },
    );

    const toolCalls = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );
    const assistantText = textBlocks.map((b) => b.text).join('\n');

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

      // Turn budget guard (mirrors booking loop). The booking loop writes
      // an audit event via auditEventService.logToolExecuted; the
      // availability loop has no equivalent table (audit events are
      // appointment-scoped, this loop runs on TherapistConversation), so
      // we surface the bucket through structured logging instead. Same
      // searchable signal in logs without a schema lift.
      if (toolsThisTurn >= TURN_TOOL_BUDGET) {
        budgetExhausted = true;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: `Tool ${toolCall.name} not executed: turn tool budget exhausted (${TURN_TOOL_BUDGET} calls). The conversation is being paused for admin review.`,
          is_error: false,
        });
        logger.warn(
          {
            traceId,
            conversationId: context.conversationId,
            toolName: toolCall.name,
            bucket: 'turn_budget_exhausted',
          },
          `${logContext} - availability turn budget exhausted on tool ${toolCall.name}`,
        );
        continue;
      }

      // Same-hash-in-turn guard (mirrors booking loop).
      const turnHash = computeTurnHash(toolCall.name, toolCall.input);
      const seenCount = (turnHashCounts.get(turnHash) ?? 0) + 1;
      turnHashCounts.set(turnHash, seenCount);

      if (seenCount >= SAME_HASH_TURN_ABORT) {
        sameHashAborted = true;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: `Tool ${toolCall.name} attempted ${seenCount} times with identical arguments in this turn — aborting to prevent a loop. An admin will review.`,
          is_error: false,
        });
        logger.warn(
          {
            traceId,
            conversationId: context.conversationId,
            toolName: toolCall.name,
            seenCount,
            bucket: 'same_hash_aborted',
          },
          `${logContext} - availability same-hash abort on tool ${toolCall.name}`,
        );
        continue;
      }

      if (seenCount > 1) {
        toolsThisTurn++;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: `Tool ${toolCall.name} with these exact arguments was already attempted earlier in this turn. Try a different approach, change the arguments, or call flag_for_human_review.`,
          is_error: false,
        });
        logger.info(
          {
            traceId,
            conversationId: context.conversationId,
            toolName: toolCall.name,
            seenCount,
            bucket: 'same_hash_blocked',
          },
          `${logContext} - availability same-hash 2nd-occurrence skip on tool ${toolCall.name}`,
        );
        continue;
      }

      toolsThisTurn++;
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
    if (!stopLoop && !flaggedForHumanReview && !markedComplete && (budgetExhausted || sameHashAborted)) {
      const reason = budgetExhausted
        ? `Turn tool budget exhausted (${TURN_TOOL_BUDGET} tool calls in one inbound trigger). Agent paused for admin review.`
        : `Same tool called ${SAME_HASH_TURN_ABORT}+ times with identical arguments in one turn — agent thrashing on a duplicate call. Paused for review.`;
      logger.warn(
        {
          traceId,
          conversationId: context.conversationId,
          toolsThisTurn,
          iteration,
          budgetExhausted,
          sameHashAborted,
        },
        `${logContext} - availability turn-level circuit breaker tripped — ${reason}`,
      );
      conversationState.messages.push({
        role: 'admin' as const,
        content: `[System: ${reason}]`,
      });
      if (callbacks.flagForHumanReview) {
        try {
          await callbacks.flagForHumanReview(reason);
        } catch (flagErr) {
          logger.error(
            { traceId, conversationId: context.conversationId, err: flagErr },
            `${logContext} - Failed to flag for human review at turn-level breaker`,
          );
        }
      }
      flaggedForHumanReview = true;
      stopLoop = true;
    }

    // Error circuit breaker — mirrors the booking loop. TURN_ERROR_LIMIT
    // failures in one runAvailabilityToolLoop invocation means the agent
    // is thrashing; escalate to human control rather than continue.
    if (!stopLoop && !flaggedForHumanReview && !markedComplete && totalToolErrors >= TURN_ERROR_LIMIT) {
      logger.warn(
        {
          traceId,
          conversationId: context.conversationId,
          totalToolErrors,
          limit: TURN_ERROR_LIMIT,
          iteration,
          bucket: 'error',
        },
        `${logContext} - availability tool error circuit breaker tripped — stopping loop and flagging for review`,
      );
      conversationState.messages.push({
        role: 'admin' as const,
        content: `[System: ${totalToolErrors} tool failures in this turn — pausing for admin review.]`,
      });
      if (callbacks.flagForHumanReview) {
        try {
          await callbacks.flagForHumanReview(
            `Tool error circuit breaker tripped (${totalToolErrors} failures in one turn). Agent paused for review.`,
          );
        } catch (flagErr) {
          logger.error(
            { traceId, conversationId: context.conversationId, err: flagErr },
            `${logContext} - Failed to flag for human review at circuit breaker`,
          );
        }
      }
      flaggedForHumanReview = true;
      stopLoop = true;
    }

    if (stopLoop) break;

    messagesForClaude = [
      ...messagesForClaude,
      { role: 'assistant' as const, content: response.content },
      { role: 'user' as const, content: toolResults },
    ];

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

  if (iteration >= MAX_TOOL_ITERATIONS && !flaggedForHumanReview && !markedComplete) {
    logger.warn(
      { traceId, conversationId: context.conversationId, iterations: iteration },
      `${logContext} - availability agent hit max tool iterations`,
    );
  }

  return {
    messages: messagesForClaude,
    result: {
      iterations: iteration,
      totalToolErrors,
      executedTools,
      flaggedForHumanReview,
      markedComplete,
      hitMaxIterations: iteration >= MAX_TOOL_ITERATIONS,
    },
  };
}

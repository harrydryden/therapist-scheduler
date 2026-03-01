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
  updateCheckpoint,
} from '../utils/conversation-checkpoint';
import type { ToolExecutionResult, SchedulingContext } from './justin-time.service';
import type { ConversationState } from '../types';

const MAX_TOOL_ITERATIONS = 5;

const claudeCircuitBreaker = circuitBreakerRegistry.getOrCreate(CIRCUIT_BREAKER_CONFIGS.CLAUDE_API);

/**
 * Truncate message content to prevent state size bombs.
 */
function truncateMessageContent(content: string): string {
  // Import dynamically would create a circular dep, so inline the constant
  const MAX_MESSAGE_LENGTH = 50000;
  const TRUNCATION_SUFFIX = '\n\n[Content truncated due to length]';

  if (content.length <= MAX_MESSAGE_LENGTH) {
    return content;
  }

  const truncatedLength = MAX_MESSAGE_LENGTH - TRUNCATION_SUFFIX.length;
  const truncated = content.slice(0, truncatedLength) + TRUNCATION_SUFFIX;

  logger.warn(
    { originalLength: content.length, truncatedLength: MAX_MESSAGE_LENGTH },
    'Message content truncated to prevent state size bomb'
  );

  return truncated;
}

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
];

/** Tools whose execution produces external side effects */
const SIDE_EFFECT_TOOLS = new Set(['send_email', 'mark_scheduling_complete', 'flag_for_human_review']);

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

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;
    logger.debug(
      { traceId, appointmentRequestId: context.appointmentRequestId, iteration },
      `${logContext} - Claude API call iteration`
    );

    const response = await resilientCall(
      () => anthropicClient.messages.create({
        model: CLAUDE_MODELS.AGENT,
        max_tokens: MODEL_CONFIG.agent.maxTokens,
        system: systemPrompt,
        tools: schedulingTools,
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

      const result = await callbacks.executeToolCall(toolCall, context);

      if (result.success) {
        if (result.skipped) {
          toolResult = `Tool ${result.toolName} skipped: ${result.skipReason}`;
        } else {
          toolResult = `Tool ${result.toolName} executed successfully.`;

          executedTools.push({
            toolName: result.toolName,
            emailSentTo: result.emailSentTo,
            timestamp: new Date().toISOString(),
          });

          // Update checkpoint after successful tool execution
          if (result.checkpointAction) {
            const currentCheckpoint = conversationState.checkpoint;
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

        // flag_for_human_review stops the loop
        if (toolCall.name === 'flag_for_human_review' && !result.skipped) {
          logger.info(
            { traceId, appointmentRequestId: context.appointmentRequestId },
            `${logContext} - Agent flagged for human review — stopping tool loop`
          );
          conversationState.messages.push({
            role: 'admin' as const,
            content: '[System: Conversation flagged for human review. Agent processing paused.]',
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

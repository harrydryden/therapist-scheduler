/**
 * Tool dispatcher for the availability-collection agent.
 *
 * Parallel to ai-tool-executor.service.ts but for the slim
 * 4-tool surface of the availability agent (record_availability_window,
 * remember, mark_complete, flag_for_human_review). Phase 2 has no
 * external side effects (no emails, no Slack, no lifecycle transitions)
 * — every tool either writes to a JSON column on TherapistConversation
 * or on the Therapist row. The booking executor's heavier mechanism
 * (atomic human-control updateMany, per-appointment tool ceiling,
 * audit-event service) is deliberately deferred:
 *
 *   - Atomic human-control check: phase 2 has no irreversible side
 *     effects, so the (small) race window between the read here and
 *     a concurrent human-control flip is benign. Phase 3 (which wires
 *     the email tool) should add the atomic check.
 *   - Audit events: AppointmentAuditEvent is FK'd to AppointmentRequest;
 *     extending it to also reference TherapistConversation is a schema
 *     change worth its own PR.
 *   - Per-conversation tool ceiling: the per-turn MAX_TOOL_ITERATIONS
 *     cap already bounds runaway within a turn; cross-turn ceiling
 *     can be added later if abuse patterns emerge.
 *
 * Idempotency uses the same Redis-backed pattern as the booking
 * executor, with a distinct key prefix so the two namespaces can't
 * collide even if the same toolName and input were ever to hash the
 * same (they wouldn't, because conversationId is in the hash).
 */

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';
import { prisma } from '../utils/database';
import { redis } from '../utils/redis';
import { TOOL_EXECUTION } from '../constants';
import {
  availabilityRecordWindowInputSchema,
  availabilityMarkCompleteInputSchema,
  flagForHumanReviewInputSchema,
  rememberInputSchema,
} from '../schemas/tool-inputs';
import { addUpcomingAvailability } from './therapist-availability.service';
import { addConversationNote } from './therapist-conversation-memory.service';
import type { ToolExecutionResult } from './scheduling-context.service';
import type { AvailabilityAgentContext } from './agent-tool-loop';

// Distinct prefix from the booking executor's idempotency namespace
// (TOOL_EXECUTION.PREFIX, used in ai-tool-executor.service.ts). Same
// TTL — the practical window for duplicate tool calls is the same.
const AVAILABILITY_TOOL_PREFIX = `${TOOL_EXECUTION.PREFIX}avail:`;
const AVAILABILITY_TOOL_TTL_SECONDS = TOOL_EXECUTION.TTL_SECONDS;

function hashToolCall(conversationId: string, toolName: string, input: unknown): string {
  const data = JSON.stringify({ conversationId, toolName, input });
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
}

async function wasToolExecuted(hash: string): Promise<boolean> {
  try {
    const result = await redis.get(`${AVAILABILITY_TOOL_PREFIX}${hash}`);
    return result !== null;
  } catch (err) {
    // Redis flap shouldn't paralyse the agent — allow re-execution. The
    // tool handlers themselves are individually idempotent (window
    // dedup by content hash; remember dedup by note hash; mark_complete
    // and flag_for_human_review use updateMany with status predicates).
    logger.warn({ err, hash }, 'availability-tool-executor: redis unavailable for idempotency check');
    return false;
  }
}

async function markToolExecuted(hash: string, traceId: string): Promise<void> {
  try {
    await redis.set(
      `${AVAILABILITY_TOOL_PREFIX}${hash}`,
      traceId,
      'EX',
      AVAILABILITY_TOOL_TTL_SECONDS,
    );
  } catch (err) {
    logger.warn(
      { err, hash, traceId },
      'availability-tool-executor: failed to mark tool executed — idempotency may not hold',
    );
  }
}

export class AvailabilityToolExecutorService {
  private traceId: string;

  constructor(traceId?: string) {
    this.traceId = traceId || 'availability-tool-executor';
  }

  /**
   * Dispatch a Claude tool call to the matching handler.
   *
   * Preflight (in order):
   *   1. Read the conversation row. Missing → error result.
   *   2. Skip if humanControlEnabled is true (admin has taken over).
   *   3. Skip if status is not 'active' (completed / superseded /
   *      abandoned — agent shouldn't act on terminal rows).
   *   4. Idempotency check via Redis hash. Already-seen → skip.
   *
   * On a successful, non-skipped execution we mark the hash so a
   * retry of the same call within the TTL is a no-op.
   */
  async executeToolCall(
    toolCall: Anthropic.ToolUseBlock,
    context: AvailabilityAgentContext,
  ): Promise<ToolExecutionResult> {
    const { name, input } = toolCall;

    const convo = await prisma.therapistConversation.findUnique({
      where: { id: context.conversationId },
      select: { humanControlEnabled: true, status: true },
    });
    if (!convo) {
      logger.warn(
        { traceId: this.traceId, conversationId: context.conversationId, tool: name },
        'availability-tool-executor: conversation row not found',
      );
      return {
        success: false,
        toolName: name,
        error: `Conversation ${context.conversationId} not found`,
      };
    }
    if (convo.humanControlEnabled) {
      logger.info(
        { traceId: this.traceId, conversationId: context.conversationId, tool: name },
        'availability-tool-executor: skipping — human control enabled',
      );
      return { success: true, toolName: name, skipped: true, skipReason: 'human_control' };
    }
    if (convo.status !== 'active') {
      logger.info(
        { traceId: this.traceId, conversationId: context.conversationId, tool: name, status: convo.status },
        'availability-tool-executor: skipping — conversation no longer active',
      );
      return {
        success: true,
        toolName: name,
        skipped: true,
        skipReason: 'conversation_inactive',
      };
    }

    // Bump lastActivityAt so stale-check scans don't reap an actively
    // working conversation. Best-effort; non-atomic — see file header.
    await prisma.therapistConversation.update({
      where: { id: context.conversationId },
      data: { lastActivityAt: new Date() },
      select: { id: true },
    });

    const hash = hashToolCall(context.conversationId, name, input);
    if (await wasToolExecuted(hash)) {
      logger.info(
        { traceId: this.traceId, conversationId: context.conversationId, tool: name },
        'availability-tool-executor: skipping — duplicate tool call within TTL',
      );
      return { success: true, toolName: name, skipped: true, skipReason: 'idempotent' };
    }

    let result: ToolExecutionResult;
    try {
      switch (name) {
        case 'record_availability_window':
          result = await this.recordAvailabilityWindow(input, context);
          break;
        case 'remember':
          result = await this.remember(input, context);
          break;
        case 'mark_complete':
          result = await this.markComplete(input, context);
          break;
        case 'flag_for_human_review':
          result = await this.flagForHumanReview(input, context);
          break;
        default:
          result = {
            success: false,
            toolName: name,
            error: `Unknown tool: ${name}`,
          };
      }
    } catch (err) {
      logger.error(
        { traceId: this.traceId, conversationId: context.conversationId, tool: name, err },
        'availability-tool-executor: handler threw',
      );
      result = {
        success: false,
        toolName: name,
        error: err instanceof Error ? err.message : 'unknown error',
      };
    }

    if (result.success && !result.skipped) {
      await markToolExecuted(hash, this.traceId);
    }

    return result;
  }

  // ─── Tool handlers ──────────────────────────────────────────────────

  /**
   * Record a one-off availability window on the therapist row.
   *
   * Source is hardcoded to 'therapist' — this agent only ever talks to
   * the therapist, so the model is never asked to declare it. Also
   * enforces "not entirely in the past": the agent occasionally resolves
   * a relative phrase ("Friday afternoon") to the wrong Friday and a
   * fully-past window would only add noise, so we reject it here with a
   * specific error message the model can react to.
   */
  private async recordAvailabilityWindow(
    rawInput: unknown,
    context: AvailabilityAgentContext,
  ): Promise<ToolExecutionResult> {
    const parsed = availabilityRecordWindowInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        success: false,
        toolName: 'record_availability_window',
        error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      };
    }
    const { starts_at, ends_at, status, quote } = parsed.data;

    const startMs = Date.parse(starts_at);
    const endMs = Date.parse(ends_at);
    if (endMs <= startMs) {
      return {
        success: false,
        toolName: 'record_availability_window',
        error: 'ends_at must be strictly after starts_at',
      };
    }
    if (endMs <= Date.now()) {
      return {
        success: false,
        toolName: 'record_availability_window',
        error:
          'window has already passed (ends_at is in the past). Re-check today\'s date and try again with a future window.',
      };
    }

    const writeResult = await addUpcomingAvailability(context.therapistId, {
      startsAt: starts_at,
      endsAt: ends_at,
      status,
      source: 'therapist',
      quote,
    });

    return {
      success: true,
      toolName: 'record_availability_window',
      resultMessage: writeResult.added
        ? `Recorded ${status} window ${starts_at} → ${ends_at}.`
        : `Window already recorded (deduplicated).`,
    };
  }

  private async remember(
    rawInput: unknown,
    context: AvailabilityAgentContext,
  ): Promise<ToolExecutionResult> {
    const parsed = rememberInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        success: false,
        toolName: 'remember',
        error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      };
    }
    const { note, category } = parsed.data;
    const writeResult = await addConversationNote(context.conversationId, category, note);
    return {
      success: true,
      toolName: 'remember',
      resultMessage: writeResult.added
        ? `Note recorded (category: ${category}).`
        : `Note already present (deduplicated).`,
    };
  }

  /**
   * Mark the conversation as complete. Uses updateMany with a status
   * predicate so a concurrent supersession or admin abandonment doesn't
   * get clobbered: if status is anything other than 'active' the update
   * is a no-op and we return a skip, which the agent treats as success.
   */
  private async markComplete(
    rawInput: unknown,
    context: AvailabilityAgentContext,
  ): Promise<ToolExecutionResult> {
    const parsed = availabilityMarkCompleteInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        success: false,
        toolName: 'mark_complete',
        error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      };
    }
    const { summary } = parsed.data;

    const updated = await prisma.therapistConversation.updateMany({
      where: { id: context.conversationId, status: 'active' },
      data: {
        status: 'completed',
        completedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      return {
        success: true,
        toolName: 'mark_complete',
        skipped: true,
        skipReason: 'conversation_inactive',
      };
    }

    logger.info(
      { traceId: this.traceId, conversationId: context.conversationId, summary },
      'availability-tool-executor: conversation marked complete',
    );

    return {
      success: true,
      toolName: 'mark_complete',
      resultMessage: `Conversation marked complete. Summary: ${summary}`,
    };
  }

  /**
   * Pause automation on this conversation pending admin review.
   * Same updateMany-with-predicate pattern as mark_complete so a
   * race with supersession or completion is a no-op rather than a
   * silent stomp.
   */
  private async flagForHumanReview(
    rawInput: unknown,
    context: AvailabilityAgentContext,
  ): Promise<ToolExecutionResult> {
    const parsed = flagForHumanReviewInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        success: false,
        toolName: 'flag_for_human_review',
        error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      };
    }
    const { reason, suggested_action } = parsed.data;
    const fullReason = suggested_action
      ? `${reason}\n\nSuggested action: ${suggested_action}`
      : reason;

    const updated = await prisma.therapistConversation.updateMany({
      where: { id: context.conversationId, status: 'active' },
      data: {
        humanControlEnabled: true,
        humanControlTakenBy: 'agent_self_flag',
        humanControlTakenAt: new Date(),
        humanControlReason: fullReason,
      },
    });

    if (updated.count === 0) {
      return {
        success: true,
        toolName: 'flag_for_human_review',
        skipped: true,
        skipReason: 'conversation_inactive',
      };
    }

    logger.warn(
      { traceId: this.traceId, conversationId: context.conversationId, reason },
      'availability-tool-executor: agent flagged conversation for human review',
    );

    return {
      success: true,
      toolName: 'flag_for_human_review',
      resultMessage: `Flagged for human review: ${reason}`,
    };
  }
}

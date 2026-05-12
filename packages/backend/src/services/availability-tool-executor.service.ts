/**
 * Tool dispatcher for the availability-collection agent.
 *
 * Parallel to ai-tool-executor.service.ts but scoped to the agent's
 * narrow surface (send_email, record_availability_window,
 * record_booking_link, remember, mark_complete, flag_for_human_review).
 * All six tools route to methods on this class; pre-flight checks
 * happen once at the top of executeToolCall so each handler can focus
 * on its specific work.
 *
 * Pre-flight is ATOMIC: a single `updateMany` against
 * therapist_conversations with `id = X, status = 'active',
 * humanControlEnabled = false` as predicate and `lastActivityAt +
 * lastToolExecutedAt` as data fields. If 0 rows match, no tool call
 * proceeds — same TOCTOU-safe pattern that ai-tool-executor.service.ts
 * uses on appointment_requests. A follow-up findUnique disambiguates
 * the failure for logging only; it doesn't gate execution.
 *
 * What's still deferred (intentionally, not oversights):
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
  availabilitySendEmailInputSchema,
  flagForHumanReviewInputSchema,
  recordBookingLinkInputSchema,
  rememberInputSchema,
} from '../schemas/tool-inputs';
import { addUpcomingAvailability, recordTherapistBookingLink } from './therapist-availability.service';
import { addConversationNote } from './therapist-conversation-memory.service';
import { emailProcessingService } from './email-processing.service';
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
   * Pre-flight is one atomic step: an `updateMany` against the
   * conversation row keyed on `id + status='active' +
   * humanControlEnabled=false`. If 0 rows match, the tool call is
   * skipped — no other code path reaches the handler. We then do a
   * (non-atomic) findUnique purely to disambiguate WHY the gate
   * failed, so the returned skipReason and the log line are accurate.
   *
   * After the gate passes:
   *   - Redis hash dedup. Same toolName + input on the same
   *     conversation within the TTL → silent skip.
   *   - Dispatch to the handler.
   *   - Mark hash on success (non-skip) so a retry no-ops.
   */
  async executeToolCall(
    toolCall: Anthropic.ToolUseBlock,
    context: AvailabilityAgentContext,
  ): Promise<ToolExecutionResult> {
    const { name, input } = toolCall;

    // Atomic gate. updateMany returns count=0 when ANY predicate fails
    // (row missing, status≠active, or humanControl=true). One round-trip,
    // no TOCTOU window. The lastActivityAt + lastToolExecutedAt bumps
    // double as the gate's "data" payload.
    const lockResult = await prisma.therapistConversation.updateMany({
      where: {
        id: context.conversationId,
        status: 'active',
        humanControlEnabled: false,
      },
      data: {
        lastActivityAt: new Date(),
        lastToolExecutedAt: new Date(),
      },
    });

    if (lockResult.count === 0) {
      // Gate failed. Read the row once to disambiguate for logging +
      // skipReason. The read is non-atomic, but the GATE was atomic —
      // we're just labelling the failure, not gating on this read.
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
        case 'send_email':
          result = await this.sendEmail(input, context);
          break;
        case 'record_availability_window':
          result = await this.recordAvailabilityWindow(input, context);
          break;
        case 'record_booking_link':
          result = await this.recordBookingLink(input, context);
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

  // ─── send_email handler ─────────────────────────────────────────────

  /**
   * Send an outbound email to the therapist.
   *
   * Recipient is hardcoded to `context.therapistEmail` — the agent
   * never supplies a `to` field. This is the load-bearing safety
   * guarantee for the tool: even if the model is prompt-injected
   * with "email this address instead", the executor ignores any
   * recipient hint and always sends to the therapist on this
   * conversation.
   *
   * Subject normalisation: "Spill" prefix is added if absent, mirroring
   * the booking agent's pattern.
   *
   * Thread continuity: on first successful send, the returned Gmail
   * thread ID and message ID are stashed back onto the conversation
   * row (atomic conditional update — only sets if currently NULL).
   * Subsequent sends reuse the stored threadId.
   */
  private async sendEmail(
    rawInput: unknown,
    context: AvailabilityAgentContext,
  ): Promise<ToolExecutionResult> {
    const parsed = availabilitySendEmailInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        success: false,
        toolName: 'send_email',
        error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      };
    }

    const subject = parsed.data.subject.toLowerCase().includes('spill')
      ? parsed.data.subject
      : `Spill - ${parsed.data.subject}`;
    const body = parsed.data.body;

    // Reuse the existing thread ID if we already have one (continuation
    // turns); first send leaves this null so a new thread is opened.
    const row = await prisma.therapistConversation.findUnique({
      where: { id: context.conversationId },
      select: { gmailThreadId: true },
    });
    const existingThreadId = row?.gmailThreadId || undefined;

    let result: { threadId: string; messageId: string };
    try {
      result = await emailProcessingService.sendEmail({
        to: context.therapistEmail,
        subject,
        body,
        threadId: existingThreadId,
      });
    } catch (err) {
      logger.error(
        { traceId: this.traceId, conversationId: context.conversationId, err },
        'availability-tool-executor: outbound email failed',
      );
      return {
        success: false,
        toolName: 'send_email',
        error: err instanceof Error ? err.message : 'email send failed',
      };
    }

    logger.info(
      {
        traceId: this.traceId,
        conversationId: context.conversationId,
        to: context.therapistEmail,
        threadId: result.threadId,
        messageId: result.messageId,
        reused: !!existingThreadId,
      },
      'availability-tool-executor: email sent',
    );

    // First send: persist thread + initial message ID. Atomic
    // conditional update so a concurrent send (unlikely, but) doesn't
    // race two different thread IDs into the same row.
    if (!existingThreadId && result.threadId) {
      await prisma.therapistConversation.updateMany({
        where: { id: context.conversationId, gmailThreadId: null },
        data: {
          gmailThreadId: result.threadId,
          initialMessageId: result.messageId,
        },
      });
    }

    return {
      success: true,
      toolName: 'send_email',
      resultMessage: `Email sent to ${context.therapistEmail} (thread ${result.threadId}).`,
    };
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

  /**
   * Store the therapist's booking link on Therapist.bookingLink.
   *
   * Always overwrites — most recent share wins, matching how the booking
   * agent already treats freshly-shared links as authoritative over the
   * existing record. Admin can still edit via the therapist UI; the
   * executor doesn't try to reconcile when a different link is on file.
   *
   * Validation is URL-only (Zod's `.url()`). No domain allowlist:
   * therapists use Calendly, Acuity, YouCanBook.me, SavvyCal, custom
   * Cal.com instances, and various other tools — a strict list would
   * produce false negatives.
   */
  private async recordBookingLink(
    rawInput: unknown,
    context: AvailabilityAgentContext,
  ): Promise<ToolExecutionResult> {
    const parsed = recordBookingLinkInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        success: false,
        toolName: 'record_booking_link',
        error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      };
    }

    const { url } = parsed.data;

    // Delegate to the shared writer so the booking agent's
    // record_booking_link tool (added in the one-source-of-truth
    // follow-up) routes through the same primary-key-scoped update.
    await recordTherapistBookingLink(context.therapistId, url);

    return {
      success: true,
      toolName: 'record_booking_link',
      resultMessage: `Booking link recorded: ${url}`,
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
  /** Public entry point for the availability tool loop to escalate
   *  runaway conditions (e.g. error circuit breaker tripped) without the
   *  agent having called flag_for_human_review itself. Routes through
   *  the same private method so behaviour stays in lockstep with the
   *  tool path. */
  async flagForHumanReviewFromLoop(
    context: AvailabilityAgentContext,
    reason: string,
  ): Promise<void> {
    await this.flagForHumanReview({ reason }, context);
  }

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

/**
 * Tool-call dispatcher for the booking agent.
 *
 * Each tool the agent can call is implemented as a free function
 * under `handlers/`. This module is the orchestrator that:
 *
 *   1. Bypasses the side-effect gate for pure read-only tools
 *      (`resolve_local_time`). They mustn't be denied when human
 *      control is on, and the idempotency layer would return
 *      `{skipped:true}` (no resolved value) on every subsequent
 *      call with the same input — leaving the model with nothing
 *      to use.
 *
 *   2. Runs an atomic `humanControlEnabled: false` updateMany.
 *      Prevents the TOCTOU race where a human flips control on
 *      between the agent's decision to call a tool and the actual
 *      side effect.
 *
 *   3. Enforces the per-appointment lifetime ceiling
 *      (`PER_APPOINTMENT_LIMIT`). Cross-turn drift backstop —
 *      ~50 successful state-changing tool calls is unambiguously
 *      anomalous. Reaching the ceiling flips to human review.
 *
 *   4. Checks Redis-backed idempotency on the (appointmentId,
 *      toolName, input) hash. Prevents duplicate emails / double
 *      confirmations / voucher re-issues on retries within the
 *      same turn.
 *
 *   5. Dispatches to the per-tool handler.
 *
 *   6. On success: marks the idempotency key, increments the
 *      counter (only successful calls advance it), audits.
 *
 *   7. On error: catches, audits the failure, records
 *      `lastToolExecutionFailed` for admin visibility, returns a
 *      structured failure result so the agent loop can react.
 *
 * Side note on the class: `AIToolExecutorService` is preserved as
 * a thin wrapper for backward compatibility — callers still do
 * `new AIToolExecutorService(traceId)` + `.executeToolCall(...)` /
 * `.flagForHumanReviewFromLoop(...)`. The class holds only the
 * traceId; methods delegate to the free functions below.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/database';
import { auditEventService } from '../../../services/audit-event.service';
import { TOOL_EXECUTION } from '../../../constants';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../services/scheduling-context.service';
import {
  incrementAppointmentToolCount,
  peekAppointmentToolCount,
} from '../../../services/appointment-tool-counter';
import {
  hashToolCall,
  markToolExecuted,
  wasToolExecuted,
} from '../../../core/agent/tools/idempotency';
import { isPureTool } from './pure-tools';
import { handleResolveLocalTime } from './handlers/resolve-local-time';
import { handleSendEmail } from './handlers/send-email';
import { handleUpdateTherapistAvailability } from './handlers/update-therapist-availability';
import { handleMarkSchedulingComplete } from './handlers/mark-scheduling-complete';
import { handleCancelAppointment } from './handlers/cancel-appointment';
import { handleInitiateReschedule } from './handlers/initiate-reschedule';
import {
  flagForHumanReview,
  handleFlagForHumanReview,
  handleRecommendCancelMatch,
} from './handlers/human-control';
import { handleIssueVoucherCode } from './handlers/issue-voucher-code';
import { handleRemember } from './handlers/remember';
import { handleRecordAvailabilityWindow } from './handlers/record-availability-window';
import { handleRecordBookingLink } from './handlers/record-booking-link';
import { handleRecordUserTimezone } from './handlers/record-user-timezone';
import { handleRecordTherapistTimezone } from './handlers/record-therapist-timezone';

const PER_APPOINTMENT_LIMIT = TOOL_EXECUTION.PER_APPOINTMENT_LIMIT;

export async function executeToolCall(
  toolCall: Anthropic.ToolUseBlock,
  context: SchedulingContext,
  traceId: string,
): Promise<ToolExecutionResult> {
  const { name, input } = toolCall;

  // ─── PURE TOOLS BYPASS THE GATE ───────────────────────────────
  // The PURE_TOOLS set is also consumed by the agent-tool-loop's
  // turn-budget exclusion — see `core/agent/tools/pure-tools.ts`
  // for the contract. Single source of truth so the two layers
  // can't drift on which tools are pure.
  if (isPureTool(name)) {
    return handleResolveLocalTime(input);
  }

  // ─── STEP 1: ATOMIC HUMAN-CONTROL GATE ────────────────────────
  // Atomic updateMany that only succeeds if humanControlEnabled is
  // false. Prevents tool execution if human control was enabled
  // between the model's decision and the side effect.
  const lockResult = await prisma.appointmentRequest.updateMany({
    where: {
      id: context.appointmentRequestId,
      humanControlEnabled: false,
    },
    data: {
      lastToolExecutedAt: new Date(),
    },
  });

  if (lockResult.count === 0) {
    logger.info(
      { traceId, tool: name, appointmentRequestId: context.appointmentRequestId },
      'Skipping tool execution - human control enabled or appointment not found',
    );
    auditEventService.logToolExecuted(context.appointmentRequestId, {
      traceId,
      toolName: name,
      result: 'skipped',
      skipReason: 'human_control',
      bucket: 'human_control_skip',
    });
    return { success: true, toolName: name, skipped: true, skipReason: 'human_control' };
  }

  // ─── STEP 2: PER-APPOINTMENT LIFETIME CEILING ─────────────────
  // Pre-flight peek (does NOT increment) — the increment happens
  // in the success path so the counter measures completed tool
  // calls rather than attempts. Cross-turn drift backstop;
  // turn-level breakers in the agent loop handle the same-turn
  // case.
  const appointmentToolCount = await peekAppointmentToolCount(context.appointmentRequestId);
  if (appointmentToolCount >= PER_APPOINTMENT_LIMIT) {
    logger.warn(
      {
        traceId,
        tool: name,
        appointmentRequestId: context.appointmentRequestId,
        count: appointmentToolCount,
        limit: PER_APPOINTMENT_LIMIT,
      },
      'Per-appointment tool ceiling reached — flagging for human review',
    );
    try {
      await flagForHumanReview(
        context,
        {
          reason:
            `Tool execution ceiling reached (${appointmentToolCount}/${PER_APPOINTMENT_LIMIT} successful tool calls). ` +
            `The agent has performed an unusually high number of state-changing actions on this conversation; ` +
            `pausing automation pending admin review.`,
        },
        traceId,
      );
    } catch (flagErr) {
      // If flagging itself fails, log and proceed with the skip —
      // the appointment will still be paused on the next iteration
      // because we return skipped here.
      logger.error(
        { traceId, err: flagErr, appointmentRequestId: context.appointmentRequestId },
        'Failed to flag appointment for review at tool ceiling',
      );
    }
    auditEventService.logToolExecuted(context.appointmentRequestId, {
      traceId,
      toolName: name,
      result: 'skipped',
      skipReason: 'human_control',
      bucket: 'lifecycle_ceiling_skip',
    });
    return { success: true, toolName: name, skipped: true, skipReason: 'human_control' };
  }

  // ─── STEP 3: IDEMPOTENCY CHECK ────────────────────────────────
  const toolHash = hashToolCall(context.appointmentRequestId, name, input);
  if (await wasToolExecuted(toolHash)) {
    logger.info(
      { traceId, tool: name, appointmentRequestId: context.appointmentRequestId, toolHash },
      'Skipping tool execution - already executed (idempotent)',
    );
    auditEventService.logToolExecuted(context.appointmentRequestId, {
      traceId,
      toolName: name,
      result: 'skipped',
      skipReason: 'idempotent',
      bucket: 'idempotent_skip',
    });
    return { success: true, toolName: name, skipped: true, skipReason: 'idempotent' };
  }

  logger.info({ traceId, tool: name, input }, 'Executing tool call');

  // ─── STEP 4: DISPATCH ─────────────────────────────────────────
  let finalResult: ToolExecutionResult;
  try {
    finalResult = await dispatchTool(name, input, context, traceId);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ traceId, tool: name, error: errorMsg }, 'Tool execution failed');

    auditEventService.logToolFailed(context.appointmentRequestId, {
      traceId,
      toolName: name,
      input: input as Record<string, unknown>,
      result: 'failed',
      error: errorMsg,
      bucket: 'error',
    });

    await prisma.appointmentRequest.update({
      where: { id: context.appointmentRequestId },
      data: {
        lastToolExecutionFailed: true,
        lastToolFailureReason: errorMsg.slice(0, 500),
      },
      select: { id: true },
    });

    return { success: false, toolName: name, error: errorMsg };
  }

  // Validation-level failures from handlers come back as
  // `{success: false, ...}` without throwing. Don't audit-success
  // them, don't bump the counter, don't mark idempotent — let the
  // agent see the error and retry with corrected input.
  if (!finalResult.success) {
    return finalResult;
  }

  // ─── STEP 5: POST-SUCCESS BOOKKEEPING ─────────────────────────
  // Informational tools (`remember`, `record_availability_window`,
  // `record_booking_link`, `record_user_timezone`,
  // `record_therapist_timezone`, `issue_voucher_code`) opt out via
  // `bypassPostSuccessBookkeeping`. They have their own at-the-
  // storage-layer dedup, may legitimately run many times across a
  // long conversation, and would otherwise push working appointments
  // into the per-appointment lifetime ceiling prematurely.
  //
  // This preserves the pre-Phase-2c behaviour where those tools
  // early-returned from the dispatch switch, bypassing the post-
  // switch bookkeeping block. See the `bypassPostSuccessBookkeeping`
  // docstring on ToolExecutionResult for the full rationale.
  if (finalResult.bypassPostSuccessBookkeeping) {
    return finalResult;
  }

  await markToolExecuted(toolHash, traceId);
  logger.debug(
    { traceId, tool: name, toolHash },
    'Tool execution marked as complete (idempotency recorded)',
  );

  // Only successful, non-skipped, non-bypassed calls advance the
  // counter. Idempotent replays, human-control skips, failures,
  // and informational tools do not inflate it.
  await incrementAppointmentToolCount(context.appointmentRequestId);

  auditEventService.logToolExecuted(context.appointmentRequestId, {
    traceId,
    toolName: name,
    input: input as Record<string, unknown>,
    result: 'success',
    bucket: 'executed',
  });

  return finalResult;
}

/**
 * Per-tool dispatch. Each branch validates with its own Zod schema
 * (inside the handler) and returns a `ToolExecutionResult` plus an
 * optional `checkpointAction` for the agent loop to advance the
 * conversation FSM.
 *
 * Unknown tools return a structured error (so the agent can re-
 * prompt) rather than throwing.
 */
async function dispatchTool(
  name: string,
  input: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<ToolExecutionResult> {
  switch (name) {
    case 'send_email': {
      const outcome = await handleSendEmail(input, context, traceId);
      return {
        ...outcome.result,
        checkpointAction: outcome.checkpointAction,
        emailSentTo: outcome.emailSentTo,
        emailPurpose: outcome.purpose,
      };
    }
    case 'update_therapist_availability': {
      const outcome = await handleUpdateTherapistAvailability(input, context, traceId);
      return { ...outcome.result, checkpointAction: outcome.checkpointAction };
    }
    case 'mark_scheduling_complete': {
      const outcome = await handleMarkSchedulingComplete(input, context, traceId);
      return { ...outcome.result, checkpointAction: outcome.checkpointAction };
    }
    case 'cancel_appointment': {
      const outcome = await handleCancelAppointment(input, context, traceId);
      return { ...outcome.result, checkpointAction: outcome.checkpointAction };
    }
    case 'initiate_reschedule': {
      const outcome = await handleInitiateReschedule(input, context, traceId);
      return { ...outcome.result, checkpointAction: outcome.checkpointAction };
    }
    case 'recommend_cancel_match': {
      const outcome = await handleRecommendCancelMatch(input, context, traceId);
      return { ...outcome.result, checkpointAction: outcome.checkpointAction };
    }
    case 'issue_voucher_code':
      return handleIssueVoucherCode(input, context, traceId);
    case 'flag_for_human_review':
      return handleFlagForHumanReview(input, context, traceId);
    case 'remember':
      return handleRemember(input, context);
    case 'record_availability_window':
      return handleRecordAvailabilityWindow(input, context, traceId);
    case 'record_booking_link':
      return handleRecordBookingLink(input, context);
    case 'record_user_timezone':
      return handleRecordUserTimezone(input, context, traceId);
    case 'record_therapist_timezone':
      return handleRecordTherapistTimezone(input, context, traceId);
    default:
      logger.error({ traceId, tool: name }, 'Unknown tool attempted');
      return { success: false, toolName: name, error: `Unknown tool: ${name}` };
  }
}

/**
 * Thin class wrapping a traceId. Preserved for backward
 * compatibility with `new AIToolExecutorService(traceId)` callers
 * (justin-time.service + the unit test). Methods delegate to the
 * free functions above.
 */
export class AIToolExecutorService {
  private traceId: string;

  constructor(traceId?: string) {
    this.traceId = traceId || 'ai-tool-executor';
  }

  async executeToolCall(
    toolCall: Anthropic.ToolUseBlock,
    context: SchedulingContext,
  ): Promise<ToolExecutionResult> {
    return executeToolCall(toolCall, context, this.traceId);
  }

  /**
   * Public entry point for the tool loop to escalate runaway
   * conditions (e.g. error circuit breaker tripped) without the
   * agent having called flag_for_human_review itself.
   */
  async flagForHumanReviewFromLoop(
    context: SchedulingContext,
    reason: string,
  ): Promise<void> {
    await flagForHumanReview(context, { reason }, this.traceId);
  }
}

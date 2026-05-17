/**
 * Human-control flags + Slack notifications.
 *
 * Two related tools live here:
 *   - `flag_for_human_review` — agent admits uncertainty; flip
 *     humanControlEnabled, capture the reason, and Slack-alert.
 *   - `recommend_cancel_match` — agent recommends the admin cancel
 *     the match (user has declined the therapist); same human-
 *     control flip but with closure-recommendation fields set so
 *     the admin /action-closure endpoint can pick it up, plus a
 *     more specific Slack notification.
 *
 * `flagForHumanReview` is also exposed for the tool loop to call
 * directly (via `flagForHumanReviewFromLoop` on the executor) when
 * the runaway-loop circuit breaker trips without the agent
 * explicitly calling the tool. Same side effects either way.
 */

import { logger } from '../../../../utils/logger';
import { prisma } from '../../../../utils/database';
import { auditEventService } from '../../../../services/audit-event.service';
import { slackNotificationService } from '../../../../services/slack-notification.service';
import { recommendCancelMatchInputSchema } from '../../../../schemas/tool-inputs';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

// ─── flag_for_human_review ──────────────────────────────────────────

export async function handleFlagForHumanReview(
  rawInput: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<ToolExecutionResult> {
  const flagInput = rawInput as { reason: string; suggested_action?: string };
  if (!flagInput.reason) {
    return { success: false, toolName: 'flag_for_human_review', error: 'flag_for_human_review requires a reason' };
  }
  await flagForHumanReview(context, {
    reason: flagInput.reason,
    suggested_action: flagInput.suggested_action,
  }, traceId);
  // No checkpoint action — human review is a pause, not a progression.
  return { success: true, toolName: 'flag_for_human_review' };
}

/**
 * Public entry point exported for the tool-loop's runaway-loop
 * breaker. Mirrors the side effects of the user-facing tool:
 * humanControlEnabled, audit event, Slack alert.
 */
export async function flagForHumanReview(
  context: SchedulingContext,
  params: { reason: string; suggested_action?: string },
  traceId: string,
): Promise<void> {
  logger.info(
    {
      traceId,
      appointmentRequestId: context.appointmentRequestId,
      reason: params.reason,
      suggestedAction: params.suggested_action,
    },
    'Agent flagging appointment for human review',
  );

  const controlReason = params.suggested_action
    ? `Agent uncertain: ${params.reason}\n\nSuggested action: ${params.suggested_action}`
    : `Agent uncertain: ${params.reason}`;

  await prisma.appointmentRequest.update({
    where: { id: context.appointmentRequestId },
    data: {
      humanControlEnabled: true,
      humanControlTakenBy: 'agent-flagged',
      humanControlTakenAt: new Date(),
      humanControlReason: controlReason,
    },
    select: { id: true },
  });

  logger.info(
    { traceId, appointmentRequestId: context.appointmentRequestId },
    'Human control enabled - appointment flagged for review',
  );

  auditEventService.log(context.appointmentRequestId, 'human_control', 'agent', {
    enabled: true,
    reason: controlReason,
  });

  await slackNotificationService.notifyHumanReviewFlagged({
    appointmentId: context.appointmentRequestId,
    therapistName: context.therapistName,
    reason: params.reason,
  });
}

// ─── recommend_cancel_match ─────────────────────────────────────────

export interface RecommendCancelMatchOutcome {
  result: ToolExecutionResult;
  checkpointAction?: 'recommended_cancel_match';
}

export async function handleRecommendCancelMatch(
  rawInput: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<RecommendCancelMatchOutcome> {
  const parsed = recommendCancelMatchInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const errorMsg = `Invalid recommend_cancel_match input: ${parsed.error.message}`;
    logger.error({ traceId, errors: parsed.error.errors }, 'Invalid recommend_cancel_match input');
    return { result: { success: false, toolName: 'recommend_cancel_match', error: errorMsg } };
  }
  await recommendCancelMatch(context, parsed.data.reason, traceId);
  return {
    result: { success: true, toolName: 'recommend_cancel_match' },
    checkpointAction: 'recommended_cancel_match',
  };
}

async function recommendCancelMatch(
  context: SchedulingContext,
  reason: string,
  traceId: string,
): Promise<void> {
  logger.info(
    {
      traceId,
      appointmentRequestId: context.appointmentRequestId,
      reason,
    },
    'Agent recommending match cancellation',
  );

  // Enable human control and set closure recommendation fields so the
  // admin can action this via the existing /action-closure endpoint.
  await prisma.appointmentRequest.update({
    where: { id: context.appointmentRequestId },
    data: {
      humanControlEnabled: true,
      humanControlTakenBy: 'agent-flagged',
      humanControlTakenAt: new Date(),
      humanControlReason: `Cancel match recommended: ${reason}`,
      closureRecommendedAt: new Date(),
      closureRecommendedReason: `Match cancellation recommended: ${reason}`,
      closureRecommendationActioned: false,
    },
    select: { id: true },
  });

  auditEventService.log(context.appointmentRequestId, 'human_control', 'agent', {
    enabled: true,
    reason: `Cancel match recommended: ${reason}`,
  });

  await slackNotificationService.notifyCancelMatchRecommended({
    appointmentId: context.appointmentRequestId,
    userName: context.userName,
    therapistName: context.therapistName,
    reason,
  });
}

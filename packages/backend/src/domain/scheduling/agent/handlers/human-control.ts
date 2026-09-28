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
 * explicitly calling the tool. Same side effects either way —
 * including the holding reply to whoever wrote in (see
 * `sendHoldingReply`) and the (appointment, reason)-deduplicated
 * Slack alert (admin-notification.service).
 */

import { logger } from '../../../../utils/logger';
import { prisma } from '../../../../utils/database';
import { cacheManager } from '../../../../utils/redis';
import { firstName } from '../../../../utils/first-name';
import { auditEventService } from '../../../../services/audit-event.service';
import { slackNotificationService } from '../../../../services/slack-notification.service';
import { adminNotificationService } from '../../../../services/admin-notification.service';
import { aiConversationService } from '../../../../services/ai-conversation.service';
import { getSettingValue } from '../../../../services/settings.service';
import { recommendCancelMatchInputSchema } from '../../../../schemas/tool-inputs';
import { sendAppointmentEmail } from '../send';
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

  // Before the flip, not after: the reply goes out through the agent's
  // normal outbound path, whose atomic re-check refuses to send once human
  // control is on. If an admin already holds control, that same check
  // suppresses it.
  await sendHoldingReply(context, traceId);

  // Atomic: only take the flag if human control isn't already enabled.
  // This is also reachable from the tool loop's runaway-loop circuit
  // breaker (flagForHumanReviewFromLoop), which can fire after an admin
  // has already taken control mid-turn — an unconditional update would
  // overwrite the admin's humanControlTakenBy/TakenAt/Reason with
  // 'agent-flagged' metadata and fire a spurious Slack alert on an
  // appointment already under human review.
  const flipped = await prisma.appointmentRequest.updateMany({
    where: { id: context.appointmentRequestId, humanControlEnabled: false },
    data: {
      humanControlEnabled: true,
      humanControlTakenBy: 'agent-flagged',
      humanControlTakenAt: new Date(),
      humanControlReason: controlReason,
    },
  });

  if (flipped.count === 0) {
    logger.info(
      { traceId, appointmentRequestId: context.appointmentRequestId },
      'flagForHumanReview: human control already enabled — preserving existing takeover record',
    );
    return;
  }

  logger.info(
    { traceId, appointmentRequestId: context.appointmentRequestId },
    'Human control enabled - appointment flagged for review',
  );

  auditEventService.log(context.appointmentRequestId, 'human_control', 'agent', {
    enabled: true,
    reason: controlReason,
  });

  await adminNotificationService.notifyHumanReviewFlagged({
    appointmentId: context.appointmentRequestId,
    therapistName: context.therapistName,
    reason: params.reason,
  });
}

/** How long the one-per-escalation holding-reply marker is kept. */
const HOLDING_REPLY_MARKER_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * When a turn escalates to human review, the client or therapist whose
 * email triggered it used to hear nothing until an admin picked it up —
 * possibly days. Send them a brief holding reply instead, behind
 * `agent.holdingReplyOnEscalation` (default on).
 *
 * Only for a verified sender (never an 'unknown' one, never the kickoff
 * turn, which has no sender). At most once per escalation: a Redis marker
 * keyed on the appointment and the turn (the inbound email), so a guard
 * that re-trips on every remaining tool call, or a redelivery of the same
 * email, doesn't send it again. Best-effort — never throws, never blocks
 * the escalation itself.
 */
async function sendHoldingReply(context: SchedulingContext, traceId: string): Promise<void> {
  const sender = context.inboundSender;
  if ((sender !== 'user' && sender !== 'therapist') || !context.turnId) return;

  try {
    if ((await getSettingValue<boolean>('agent.holdingReplyOnEscalation')) !== true) return;

    const marker = await cacheManager.setNX(
      `agent:holding-reply:${context.appointmentRequestId}:${context.turnId}`,
      traceId,
      HOLDING_REPLY_MARKER_TTL_SECONDS,
    );
    if (marker !== 'OK') return;

    const to = sender === 'user' ? context.userEmail : context.therapistEmail;
    const name = sender === 'user' ? context.userName : context.therapistName;
    const agentFirstName = firstName(await getSettingValue<string>('agent.fromName'));
    const delivery = await sendAppointmentEmail(
      {
        to,
        subject: 'Thanks for your message',
        body:
          `Hi ${name},\n\n` +
          `Thanks for your message. I've passed it to a colleague, who will pick this up and get back to you shortly.\n\n` +
          `Best wishes,\n${agentFirstName}`,
      },
      context.appointmentRequestId,
      traceId,
    );
    logger.info(
      { traceId, appointmentRequestId: context.appointmentRequestId, recipient: sender, delivery: delivery.status },
      'Holding reply on escalation',
    );
    if (delivery.status === 'sent' || delivery.status === 'queued') {
      // So the agent (and the admin) can see it after release.
      await aiConversationService.appendConversationMessage(context.appointmentRequestId, {
        role: 'admin',
        content: `[System: holding reply sent to the ${sender === 'user' ? 'client' : 'therapist'} — "a colleague will pick this up".]`,
      });
    }
  } catch (err) {
    logger.warn(
      { traceId, appointmentRequestId: context.appointmentRequestId, err },
      'Holding reply on escalation failed (non-fatal)',
    );
  }
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

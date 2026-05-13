/**
 * Dismiss a pending closure recommendation and reset chase state so the
 * conversation can resume. Used by both the admin "Dismiss" action and
 * the automated path that fires when an incoming reply arrives on a
 * closure-recommended thread (the recommendation is stale by definition
 * once the other party responds).
 *
 * This is NOT a state-machine status transition — closure flags live
 * alongside `status` rather than within it, so we don't go through
 * transitionSideEffectsService.
 *
 * Two paths can set closure_recommended, and they handle the JSON
 * checkpoint differently — both must be reconciled here:
 *
 *   1. Chase-recommended (chase-email.service.ts): writes only the
 *      denormalized DB column `checkpointStage = 'closure_recommended'`.
 *      The JSON `conversationState.checkpoint.stage` is left unchanged.
 *
 *   2. Agent-recommended (recommend_cancel_match tool →
 *      agent-tool-loop): routes through `updateCheckpoint`, which
 *      writes BOTH the JSON and (via storeConversationState's
 *      extractConversationMeta) the DB column.
 *
 * In path 2, leaving the JSON wedged at `closure_recommended` would
 * cause the system prompt to tell the agent "wait for admin action"
 * forever — even after we clear the DB column, the next agent save
 * would re-derive the column from the JSON and undo our dismissal.
 * So we reconcile the JSON checkpoint via aiConversationService (with
 * optimistic locking) when it's stuck in the closure stage, restoring
 * it to whatever stage `lastSuccessfulAction` maps to (or a sensible
 * default).
 *
 * Reporting fidelity: we DO NOT null `closureRecommendedAt` /
 * `closureRecommendedReason`. Those are historical records used by
 * work-report and the daily Slack summary. Instead we set
 * `closureRecommendationActioned = true` (mirroring the admin
 * "cancel" path) and rely on chase-email's filter to use that flag
 * for gating.
 *
 * Idempotent: returns { dismissed: false } when there's nothing to
 * dismiss.
 */

import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import {
  aiConversationService,
  inferRestoredStage,
} from '../../../services/ai-conversation.service';
import type { BaseTransitionParams } from './types';

export async function dismissClosureRecommendation(
  params: BaseTransitionParams,
): Promise<{ dismissed: boolean; previousStage?: string; restoredStage?: string | null }> {
  const { appointmentId, source, reason } = params;

  const appointment = await prisma.appointmentRequest.findUnique({
    where: { id: appointmentId },
    select: {
      closureRecommendedAt: true,
      closureRecommendationActioned: true,
      checkpointStage: true,
      chaseSentTo: true,
      humanControlTakenBy: true,
    },
  });

  if (!appointment || !appointment.closureRecommendedAt || appointment.closureRecommendationActioned) {
    return { dismissed: false };
  }

  const previousStage = appointment.checkpointStage || 'closure_recommended';

  // Atomic: reconcile JSON checkpoint + derive column + clear closure/chase fields.
  // The JSON checkpoint is the source of truth — we mutate it in the callback
  // and the helper derives the column from the result. We preserve
  // closureRecommendedAt and closureRecommendedReason for historical reporting
  // (work-report counts per period); the actionable signal is
  // closureRecommendationActioned.
  const result = await aiConversationService.applyCheckpointUpdate(
    appointmentId,
    (current) => {
      // Only rewrite the JSON checkpoint if it was actually at closure_recommended
      // (the chase-recommended path leaves the JSON at the underlying stage).
      // For everything else, keep the checkpoint as-is and let the helper
      // derive the column from it.
      if (current?.stage === 'closure_recommended') {
        const restoredStage = inferRestoredStage(current, appointment.chaseSentTo);
        return {
          ...current,
          stage: restoredStage,
          pendingAction: null,
          checkpoint_at: new Date().toISOString(),
        };
      }
      return current ?? {
        stage: inferRestoredStage(null, appointment.chaseSentTo),
        lastSuccessfulAction: null,
        pendingAction: null,
        checkpoint_at: new Date().toISOString(),
      };
    },
    {
      extraUpdates: {
        closureRecommendationActioned: true,
        chaseSentAt: null,
        chaseSentTo: null,
        chaseTargetEmail: null,
        // Release agent-flagged human control so the agent can resume processing.
        // Admin-set human control is left alone — the admin opted in explicitly.
        ...(appointment.humanControlTakenBy === 'agent-flagged' && {
          humanControlEnabled: false,
        }),
      },
    },
  );

  if (!result.applied) {
    logger.warn(
      { appointmentId, source, reason },
      'Closure dismissal lost optimistic lock after retries',
    );
    return { dismissed: false };
  }

  logger.info(
    { appointmentId, source, reason, restoredStage: result.stage },
    'Closure recommendation dismissed',
  );

  // Audit event + Slack notification are emitted by the caller via
  // recordAppointmentEvent (the auto-dismiss path uses
  // 'closure_dismissed_auto', the admin manual path uses 'closure_dismissed').
  // Returning previousStage so the caller has it for the audit payload.
  return { dismissed: true, previousStage, restoredStage: result.stage };
}

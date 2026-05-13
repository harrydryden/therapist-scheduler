/**
 * Side-effect dispatch helpers shared by every transition.
 *
 * The lifecycle's transitions don't await Slack / email / sync work —
 * they fire it as a background task at the end of the transition so the
 * caller's `await` resolves the moment the row is committed. These helpers
 * package three patterns used across all transition files:
 *
 *   - `fireAndForget` — log any rejected promise so a future change that
 *     introduces an uncaught throw doesn't surface as an
 *     unhandledRejection. Belt-and-braces around dispatchers that already
 *     have their own internal try/catches (transition-side-effects.service,
 *     appointment-notifications.service).
 *
 *   - `notifyTransition` — thin wrapper that hands the SSE / dashboard
 *     fan-out to transitionSideEffectsService. Kept here so the dependency
 *     stays in one place; if SSE moves, every transition picks it up via
 *     this helper without per-call changes.
 *
 *   - `catchUpSessionHeldEffects` — handles the case where a transition
 *     advances PAST `confirmed` directly to `feedback_requested` or
 *     `completed`, skipping `session_held`. Currently a no-op
 *     (onSessionHeld has no side effects post-Notion-retirement) but
 *     kept as the dispatch site so adding future session-held effects
 *     only requires touching one place.
 */

import { logger } from '../../../utils/logger';
import { transitionSideEffectsService } from '../../../services/transition-side-effects.service';
import { APPOINTMENT_STATUS, type AppointmentStatus } from '../../../constants';
import type { TransitionResult, TransitionSource } from './types';

export function fireAndForget(
  promise: Promise<unknown>,
  appointmentId: string,
  label: string,
): void {
  promise.catch((err) => {
    logger.error({ err, appointmentId, label }, 'Lifecycle fire-and-forget dispatch failed');
  });
}

export function notifyTransition(
  result: TransitionResult,
  appointmentId: string,
  source: TransitionSource,
): void {
  transitionSideEffectsService.notifyTransition(result, appointmentId, source);
}

export async function catchUpSessionHeldEffects(
  previousStatus: AppointmentStatus,
  args: { appointmentId: string; source: TransitionSource; adminId?: string; userEmail: string },
): Promise<void> {
  if (previousStatus !== APPOINTMENT_STATUS.CONFIRMED) return;
  await transitionSideEffectsService.onSessionHeld(args);
}

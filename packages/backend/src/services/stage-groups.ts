/**
 * Named groupings of conversation stages used across the system.
 *
 * Several services need to ask the same kinds of questions about a stage:
 *   - "Is the slot still in flight?" (pre-slot stages)
 *   - "Is the booking locked in?" (post-confirm stages)
 *   - "Are we waiting on the therapist?" (therapist-pending stages)
 *   - "Are we waiting on the user?" (user-pending stages)
 *
 * Before this module these sets lived inline in tools-for-stage.ts (#212),
 * therapist-booking-status.service.ts (#213), and chase-email.service.ts
 * (pre-existing) — typed inconsistently (Set<string> vs Set<ConversationStage>)
 * and with overlapping membership that drifted between PRs. Consolidating
 * here means a stage rename in @therapist-scheduler/shared lights up every
 * call site at compile time, and the membership choices live in one
 * reviewable place.
 *
 * All sets are typed Set<ConversationStage> for compile-time safety; the
 * .has() check accepts the broader string type at call sites (e.g.
 * `THERAPIST_PENDING_STAGES.has(checkpointStage)` where checkpointStage
 * comes from a Prisma `String?` column).
 */

import type { ConversationStage } from '@therapist-scheduler/shared';

/**
 * Stages where no slot has been agreed yet. Tools that operate on a
 * scheduled slot (mark_scheduling_complete, initiate_reschedule) are
 * nonsensical in these states.
 *
 * Used by tools-for-stage.ts to narrow the booking agent's tool surface.
 */
export const PRE_SLOT_STAGES: ReadonlySet<ConversationStage> = new Set([
  'initial_contact',
  'awaiting_therapist_availability',
  'awaiting_user_slot_selection',
]);

/**
 * Stages where the slot is locked in. Tools that collect availability
 * (update_therapist_availability, record_availability_window,
 * record_booking_link) are past their relevance.
 *
 * Used by tools-for-stage.ts to narrow the booking agent's tool surface.
 */
export const POST_CONFIRM_STAGES: ReadonlySet<ConversationStage> = new Set([
  'confirmed',
  'awaiting_meeting_link',
]);

/**
 * Stages where the next action sits with the therapist. Auto-unfreeze
 * must not fire while a conversation is in one of these — the
 * conversation may look dormant on lastActivityAt alone but we're still
 * expecting a reply from the frozen therapist; unfreezing prematurely
 * lets the booking layer accept a second appointment.
 *
 * Used by therapist-booking-status.service.ts (auto-unfreeze gate) and
 * chase-email.service.ts (chase routing).
 */
export const THERAPIST_PENDING_STAGES: ReadonlySet<ConversationStage> = new Set([
  'awaiting_therapist_availability',
  'awaiting_therapist_confirmation',
  'awaiting_meeting_link',
]);

/**
 * Stages where the next action sits with the user. The user, not the
 * therapist, owes us the next reply.
 *
 * Used by chase-email.service.ts (chase routing). Kept narrow on purpose:
 * `initial_contact` and `rescheduling` are ambiguous and handled
 * case-by-case at the call site.
 */
export const USER_PENDING_STAGES: ReadonlySet<ConversationStage> = new Set([
  'awaiting_user_slot_selection',
]);

// ─── Predicates for widened (string|null) inputs ──────────────────────────
//
// The Sets above are typed Set<ConversationStage>, so `.has()` only accepts
// ConversationStage values. That's right for callers that have a typed
// stage (e.g. tools-for-stage.ts) but wrong for callers reading
// `appointment.checkpointStage` from Prisma, which is `string | null`.
// Each predicate handles the null/widening once so the call sites don't
// need to repeat the cast.

export function isPreSlot(stage: string | null | undefined): boolean {
  return stage != null && PRE_SLOT_STAGES.has(stage as ConversationStage);
}

export function isPostConfirm(stage: string | null | undefined): boolean {
  return stage != null && POST_CONFIRM_STAGES.has(stage as ConversationStage);
}

export function isTherapistPending(stage: string | null | undefined): boolean {
  return stage != null && THERAPIST_PENDING_STAGES.has(stage as ConversationStage);
}

export function isUserPending(stage: string | null | undefined): boolean {
  return stage != null && USER_PENDING_STAGES.has(stage as ConversationStage);
}

/**
 * Stage-gated tool surface for the booking agent.
 *
 * Reduces the chance the agent emits a wrong-stage tool call by narrowing
 * the tool list to the subset that makes sense at the current conversation
 * stage. Conservative on purpose: only excludes tools that are unambiguously
 * nonsensical given what we know about the appointment state. Stages where
 * the right tool set is ambiguous (rescheduling, stalled, chased,
 * awaiting_therapist_confirmation) keep the full surface.
 *
 * Gated behind `agent.stageGatedTools` (see setting-definitions.ts), default
 * false, so it can roll out gradually and be flipped back if a legitimate
 * path gets blocked. Re-evaluated per iteration in the tool loop since the
 * checkpoint can advance during a runToolLoop invocation.
 *
 * Lives in its own module rather than alongside the loop so the matrix is a
 * pure, dependency-free function — easy to unit-test without dragging in
 * the anthropic client + prisma + settings stack.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ConversationStage } from '@therapist-scheduler/shared';
import { PRE_SLOT_STAGES, POST_CONFIRM_STAGES } from './stage-groups';

const PRE_SLOT_DISALLOWED = new Set<string>([
  'mark_scheduling_complete',
  'initiate_reschedule',
]);

const POST_CONFIRM_DISALLOWED = new Set<string>([
  'update_therapist_availability',
  'record_availability_window',
  'record_booking_link',
]);

/** Return the subset of `tools` allowed at the given stage. When stage is
 *  unknown or no rule applies, returns the full set unchanged. */
export function getToolsForStage(
  stage: ConversationStage | undefined,
  tools: Anthropic.Tool[],
): Anthropic.Tool[] {
  if (!stage) return tools;

  const disallowed = new Set<string>();
  if (PRE_SLOT_STAGES.has(stage)) {
    for (const t of PRE_SLOT_DISALLOWED) disallowed.add(t);
  }
  if (POST_CONFIRM_STAGES.has(stage)) {
    for (const t of POST_CONFIRM_DISALLOWED) disallowed.add(t);
  }

  return disallowed.size === 0 ? tools : tools.filter((t) => !disallowed.has(t.name));
}

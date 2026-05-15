import { ConversationStage, STAGE_DESCRIPTIONS } from '../services/conversation-checkpoint.service';
import { PRE_BOOKING_STATUSES } from '../constants';
import { deriveNextAction } from './next-action';

interface SummaryAppointment {
  status: string;
  humanControlEnabled: boolean;
  humanControlTakenBy: string | null;
  isStale: boolean;
  lastActivityAt: Date | string;
  chaseSentAt: Date | string | null;
  chaseSentTo: string | null;
  closureRecommendedAt: Date | string | null;
  closureRecommendedReason: string | null;
  closureRecommendationActioned: boolean;
  confirmedDateTime: string | null;
  messageCount: number;
}

import type { AttentionReason } from '@therapist-scheduler/shared';

export interface AppointmentSummaryResult {
  stage: string;
  nextAction: string;
  keyFacts: string[];
  messageCount: number;
  lastActivityAt: string | null;
  flags: string[];
  /**
   * Triage reasons for the "Needs Attention" banner. Populated by the
   * detail endpoint via `deriveAttentionReasons`; defaults to `[]`
   * here so the field is always present (the summary util doesn't
   * have the health-factor inputs in scope, by design — keeping it
   * free of the health service import).
   */
  attentionReasons: AttentionReason[];
}

// Next-action strings moved to `utils/next-action.ts` and shared
// with the dashboard list endpoint (single source of truth — the
// list row and the detail panel must never disagree about what
// the admin should do next).

/**
 * Parse raw conversation state JSON once, without Zod validation.
 * Used only for extracting checkpoint/facts which live outside the Zod schema.
 */
export function parseRawConversationState(
  conversationState: unknown,
): Record<string, unknown> | null {
  if (!conversationState) return null;
  try {
    return typeof conversationState === 'string'
      ? JSON.parse(conversationState)
      : (conversationState as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Derive messageCount from rawState messages when the denormalized column is missing.
 */
function resolveMessageCount(
  rawState: Record<string, unknown> | null,
  appointment: SummaryAppointment,
): number {
  if (typeof appointment.messageCount === 'number') return appointment.messageCount;
  const messages = rawState?.messages as unknown[] | undefined;
  return Array.isArray(messages) ? messages.length : 0;
}

export function buildAppointmentSummary(
  rawState: Record<string, unknown> | null,
  appointment: SummaryAppointment,
): AppointmentSummaryResult {
  const checkpoint = rawState?.checkpoint as Record<string, unknown> | undefined;
  const facts = rawState?.facts as Record<string, unknown> | undefined;

  // Stage description
  const checkpointStage = checkpoint?.stage as ConversationStage | undefined;
  let stage: string;
  if (appointment.status === 'cancelled') {
    stage = 'Cancelled';
  } else if (appointment.status === 'confirmed') {
    stage = 'Confirmed';
  } else if (checkpointStage && STAGE_DESCRIPTIONS[checkpointStage]) {
    stage = STAGE_DESCRIPTIONS[checkpointStage];
  } else {
    stage = appointment.status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Extract the same fallback signals the dashboard list endpoint
  // surfaces: `lastEmailSentTo` (from checkpoint.context) and the
  // normalised role of the most recent message. Without these the
  // detail panel falls through to the generic "Awaiting initial
  // outreach" wording while the dashboard row right above it shows
  // "Awaiting reply from user" — the two views drifted before the
  // explicit pass-through.
  const context = checkpoint?.context as { lastEmailSentTo?: unknown } | undefined;
  const rawLastEmailSentTo =
    context?.lastEmailSentTo === 'user' || context?.lastEmailSentTo === 'therapist'
      ? context.lastEmailSentTo
      : null;

  // Normalise the raw `messages[-1].role` to the same enum the
  // dashboard uses (`'agent' | 'inbound' | 'admin'`). `'assistant'`
  // maps to `'agent'`; explicit `'admin'` stays; anything else
  // (typically `'user'`) maps to `'inbound'`. Mirrors the logic in
  // `buildLastMessagePreview` so the two callers never drift.
  const messages = Array.isArray(rawState?.messages)
    ? (rawState!.messages as Array<{ role?: unknown }>)
    : [];
  const rawLastRole = typeof messages[messages.length - 1]?.role === 'string'
    ? (messages[messages.length - 1].role as string)
    : null;
  const normalisedLastRole: 'agent' | 'inbound' | 'admin' | null = rawLastRole === null
    ? null
    : rawLastRole === 'assistant'
      ? 'agent'
      : rawLastRole === 'admin'
        ? 'admin'
        : 'inbound';

  // Next action — delegated to the shared util so the dashboard
  // list row and this detail summary stay in lockstep.
  const nextAction = deriveNextAction({
    status: appointment.status,
    humanControlEnabled: appointment.humanControlEnabled,
    chaseSentAt: appointment.chaseSentAt,
    chaseSentTo: appointment.chaseSentTo,
    closureRecommendedAt: appointment.closureRecommendedAt,
    closureRecommendationActioned: appointment.closureRecommendationActioned,
    confirmedDateTime: appointment.confirmedDateTime,
    checkpointStage: checkpointStage ?? null,
    pendingAction: checkpoint?.pendingAction ? String(checkpoint.pendingAction) : null,
    lastEmailSentTo: rawLastEmailSentTo,
    lastMessageRole: normalisedLastRole,
  });

  // Key facts from conversation facts
  const keyFacts: string[] = [];
  if (facts) {
    const proposedTimes = facts.proposedTimes as string[] | undefined;
    if (proposedTimes?.length) {
      keyFacts.push(`Times proposed: ${proposedTimes.slice(-3).join(', ')}`);
    }
    if (facts.selectedTime) {
      keyFacts.push(`Client selected: ${facts.selectedTime}`);
    }
    if (facts.confirmedTime) {
      keyFacts.push(`Confirmed: ${facts.confirmedTime}`);
    }
    const blockers = facts.blockers as string[] | undefined;
    if (blockers?.length) {
      keyFacts.push(`Blockers: ${blockers.join(', ')}`);
    }
    const specialNotes = facts.specialNotes as string[] | undefined;
    if (specialNotes?.length) {
      keyFacts.push(...specialNotes.slice(-2));
    }
  }

  // Last activity — send raw ISO timestamp, let client compute relative time
  let lastActivityAt: string | null = null;
  if (appointment.lastActivityAt) {
    const d = new Date(appointment.lastActivityAt);
    if (!isNaN(d.getTime())) {
      lastActivityAt = d.toISOString();
    }
  }

  // Flags
  const flags: string[] = [];
  const preBookingStatuses: readonly string[] = PRE_BOOKING_STATUSES;
  if (appointment.isStale && preBookingStatuses.includes(appointment.status)) flags.push('stale');
  if (appointment.humanControlEnabled) flags.push('human_control');
  if (appointment.chaseSentAt) flags.push('chased');
  if (appointment.closureRecommendedAt && !appointment.closureRecommendationActioned) {
    flags.push('closure_recommended');
  }

  return {
    stage,
    nextAction,
    keyFacts,
    messageCount: resolveMessageCount(rawState, appointment),
    lastActivityAt,
    flags,
    // Caller is expected to overwrite this in the detail route via
    // `deriveAttentionReasons`. The summary builder itself doesn't
    // have the health-factor inputs in scope.
    attentionReasons: [],
  };
}

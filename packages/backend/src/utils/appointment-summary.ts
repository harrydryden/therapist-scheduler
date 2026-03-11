import { ConversationStage, STAGE_DESCRIPTIONS } from './conversation-checkpoint';

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

export interface AppointmentSummaryResult {
  stage: string;
  nextAction: string;
  keyFacts: string[];
  messageCount: number;
  lastActivityAt: string | null;
  flags: string[];
}

const STAGE_NEXT_ACTIONS: Record<string, string> = {
  initial_contact: 'Waiting for initial emails to be sent.',
  awaiting_therapist_availability: 'Waiting for therapist to reply with available times.',
  awaiting_user_slot_selection: 'Waiting for client to pick a time slot.',
  awaiting_therapist_confirmation: 'Waiting for therapist to confirm the selected slot.',
  awaiting_meeting_link: 'Waiting for therapist to share a meeting link.',
  rescheduling: 'Rescheduling in progress — waiting for new times.',
  stalled: 'Conversation stalled. May need manual intervention.',
  chased: 'Follow-up chase sent. Awaiting response.',
  closure_recommended: 'Recommended for closure. Admin action needed.',
};

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

  // Next action
  let nextAction: string;
  if (appointment.status === 'cancelled') {
    nextAction = 'No action needed — appointment cancelled.';
  } else if (appointment.status === 'confirmed') {
    nextAction = appointment.confirmedDateTime
      ? `Session scheduled for ${appointment.confirmedDateTime}. Awaiting session completion.`
      : 'Session confirmed. Awaiting session completion.';
  } else if (appointment.closureRecommendedAt && !appointment.closureRecommendationActioned) {
    nextAction = 'Admin action needed: cancel or dismiss closure recommendation.';
  } else if (appointment.chaseSentAt) {
    nextAction = `Chase sent to ${appointment.chaseSentTo || 'unknown'}. Awaiting response.`;
  } else if (appointment.humanControlEnabled) {
    nextAction = `Human control active (${appointment.humanControlTakenBy || 'unknown'}). Agent paused.`;
  } else if (checkpoint?.pendingAction) {
    nextAction = String(checkpoint.pendingAction);
  } else if (checkpointStage) {
    nextAction = STAGE_NEXT_ACTIONS[checkpointStage] || 'Waiting for next message.';
  } else {
    nextAction = 'Waiting for next message.';
  }

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
  if (appointment.isStale) flags.push('stale');
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
  };
}

/**
 * Conversation Checkpoint & Recovery System
 *
 * Provides structured tracking of booking conversation stages:
 * - Enables automatic recovery after stalls
 * - Provides clear context for admin handoff
 * - Enables metrics on where bookings drop off
 */

import { logger } from './logger';

/**
 * Conversation stages in the booking flow
 */
export type ConversationStage =
  | 'initial_contact'           // First email sent
  | 'awaiting_therapist_availability' // Waiting for therapist to provide slots
  | 'awaiting_user_slot_selection'    // User has slots, waiting for selection
  | 'awaiting_therapist_confirmation' // User selected, waiting for therapist
  | 'awaiting_meeting_link'     // Confirmed, waiting for therapist to send link
  | 'confirmed'                 // Booking complete
  | 'rescheduling'              // Rescheduling in progress
  | 'cancelled'                 // Cancelled
  | 'stalled';                  // No progress for extended period

/**
 * Actions that can be taken in the conversation
 */
export type ConversationAction =
  | 'sent_initial_email_to_therapist'
  | 'sent_initial_email_to_user'
  | 'received_therapist_availability'
  | 'sent_availability_to_user'
  | 'received_user_slot_selection'
  | 'sent_confirmation_request_to_therapist'
  | 'received_therapist_confirmation'
  | 'sent_final_confirmations'
  | 'sent_meeting_link_check'
  | 'sent_feedback_form'
  | 'received_cancellation_request'
  | 'processed_cancellation'
  | 'received_reschedule_request'
  | 'processed_reschedule';

/**
 * Checkpoint data structure
 */
export interface ConversationCheckpoint {
  stage: ConversationStage;
  lastSuccessfulAction: ConversationAction | null;
  pendingAction: string | null;       // What we're waiting for
  checkpoint_at: string;              // ISO timestamp
  stalled_since?: string;             // ISO timestamp if stalled
  recovery_attempts?: number;         // How many times we've tried to recover
  context?: {                         // Additional context for recovery
    userSelectedSlot?: string;
    therapistLastResponse?: string;
    lastEmailSentTo?: 'user' | 'therapist';
    lastEmailSubject?: string;
  };
}

/**
 * Stage transition rules - what stages can transition to what
 */
const VALID_TRANSITIONS: Record<ConversationStage, ConversationStage[]> = {
  initial_contact: ['awaiting_therapist_availability', 'awaiting_user_slot_selection', 'cancelled', 'stalled'],
  awaiting_therapist_availability: ['awaiting_user_slot_selection', 'cancelled', 'stalled'],
  awaiting_user_slot_selection: ['awaiting_therapist_confirmation', 'cancelled', 'stalled', 'rescheduling'],
  awaiting_therapist_confirmation: ['awaiting_user_slot_selection', 'awaiting_meeting_link', 'confirmed', 'cancelled', 'stalled'],
  awaiting_meeting_link: ['confirmed', 'rescheduling', 'cancelled', 'stalled'],
  confirmed: ['rescheduling', 'cancelled'],
  rescheduling: ['awaiting_user_slot_selection', 'awaiting_therapist_confirmation', 'confirmed', 'cancelled', 'stalled'],
  cancelled: [], // Terminal state
  stalled: ['awaiting_therapist_availability', 'awaiting_user_slot_selection', 'awaiting_therapist_confirmation', 'cancelled'],
};

/**
 * Human-readable descriptions for each stage
 */
const STAGE_DESCRIPTIONS: Record<ConversationStage, string> = {
  initial_contact: 'Initial contact made',
  awaiting_therapist_availability: 'Waiting for therapist to provide availability',
  awaiting_user_slot_selection: 'Waiting for user to select a time slot',
  awaiting_therapist_confirmation: 'Waiting for therapist to confirm the selected slot',
  awaiting_meeting_link: 'Booking confirmed, waiting for therapist to send meeting link',
  confirmed: 'Booking complete',
  rescheduling: 'Rescheduling in progress',
  cancelled: 'Booking cancelled',
  stalled: 'Conversation has stalled - needs attention',
};

/**
 * Recovery messages for each stage
 */
const RECOVERY_MESSAGES: Record<ConversationStage, string> = {
  initial_contact: "I wanted to follow up on your booking request. Are you still interested in scheduling a session?",
  awaiting_therapist_availability: "I'm following up on availability. Could you please share your available times for sessions?",
  awaiting_user_slot_selection: "I wanted to check if you've had a chance to look at the available times. Would any of these work for you?",
  awaiting_therapist_confirmation: "I'm following up on the time slot selection. Could you please confirm if this time works for you?",
  awaiting_meeting_link: "Just checking in - have you received the meeting link from your therapist?",
  confirmed: '', // No recovery needed
  rescheduling: "I'm following up on the rescheduling request. Do you have a new preferred time?",
  cancelled: '', // No recovery needed
  stalled: "I noticed our conversation stalled. Would you still like help scheduling your session?",
};

/**
 * Create a new checkpoint
 */
export function createCheckpoint(
  stage: ConversationStage,
  action: ConversationAction | null,
  pendingAction: string | null = null,
  context?: ConversationCheckpoint['context']
): ConversationCheckpoint {
  return {
    stage,
    lastSuccessfulAction: action,
    pendingAction,
    checkpoint_at: new Date().toISOString(),
    context,
  };
}

/**
 * Parse checkpoint from conversation state
 */
export function parseCheckpoint(
  conversationState: { checkpoint?: ConversationCheckpoint } | null
): ConversationCheckpoint | null {
  if (!conversationState || !conversationState.checkpoint) {
    return null;
  }
  return conversationState.checkpoint;
}

/**
 * Determine stage from action
 */
export function stageFromAction(action: ConversationAction): ConversationStage {
  const actionToStage: Record<ConversationAction, ConversationStage> = {
    sent_initial_email_to_therapist: 'awaiting_therapist_availability',
    sent_initial_email_to_user: 'awaiting_user_slot_selection',
    received_therapist_availability: 'awaiting_user_slot_selection',
    sent_availability_to_user: 'awaiting_user_slot_selection',
    received_user_slot_selection: 'awaiting_therapist_confirmation',
    sent_confirmation_request_to_therapist: 'awaiting_therapist_confirmation',
    received_therapist_confirmation: 'awaiting_meeting_link',
    sent_final_confirmations: 'confirmed',
    sent_meeting_link_check: 'confirmed',
    sent_feedback_form: 'confirmed',
    received_cancellation_request: 'cancelled',
    processed_cancellation: 'cancelled',
    received_reschedule_request: 'rescheduling',
    processed_reschedule: 'awaiting_user_slot_selection',
  };

  return actionToStage[action] || 'initial_contact';
}

/**
 * Validate a stage transition
 */
export function isValidTransition(
  currentStage: ConversationStage,
  newStage: ConversationStage
): boolean {
  const validNextStages = VALID_TRANSITIONS[currentStage];
  return validNextStages.includes(newStage);
}

/**
 * Update checkpoint with new action
 */
export function updateCheckpoint(
  current: ConversationCheckpoint | null,
  action: ConversationAction,
  pendingAction: string | null = null,
  context?: ConversationCheckpoint['context']
): ConversationCheckpoint {
  const newStage = stageFromAction(action);

  // Log invalid transitions but allow them (for recovery scenarios)
  if (current && !isValidTransition(current.stage, newStage)) {
    logger.warn(
      {
        currentStage: current.stage,
        newStage,
        action,
      },
      'Unexpected stage transition - may indicate recovery or edge case'
    );
  }

  return {
    stage: newStage,
    lastSuccessfulAction: action,
    pendingAction,
    checkpoint_at: new Date().toISOString(),
    context: {
      ...current?.context,
      ...context,
    },
  };
}

/**
 * Mark a conversation as stalled
 */
export function markAsStalled(current: ConversationCheckpoint): ConversationCheckpoint {
  return {
    ...current,
    stage: 'stalled',
    stalled_since: new Date().toISOString(),
    recovery_attempts: 0,
  };
}

/**
 * Increment recovery attempts
 */
export function incrementRecoveryAttempts(current: ConversationCheckpoint): ConversationCheckpoint {
  return {
    ...current,
    recovery_attempts: (current.recovery_attempts || 0) + 1,
  };
}

/**
 * Get human-readable stage description
 */
export function getStageDescription(stage: ConversationStage | undefined): string {
  if (!stage) return STAGE_DESCRIPTIONS.initial_contact;
  return STAGE_DESCRIPTIONS[stage];
}

/**
 * Valid actions for each stage - guidance for Claude
 */
const VALID_ACTIONS_PER_STAGE: Record<ConversationStage, string[]> = {
  initial_contact: [
    'Send initial email to therapist (if no availability on file)',
    'Send initial email to user with availability options (if availability on file)',
  ],
  awaiting_therapist_availability: [
    'Wait for therapist response',
    'After receiving availability, send options to user',
    'Use update_therapist_availability if therapist provides recurring schedule',
  ],
  awaiting_user_slot_selection: [
    'Wait for user to select a time',
    'Clarify options if user has questions',
    'After user selects, send confirmation request to therapist',
  ],
  awaiting_therapist_confirmation: [
    'Wait for therapist to confirm the selected slot',
    'If confirmed, use mark_scheduling_complete with the confirmed datetime',
    'If slot unavailable, go back to user with alternatives',
  ],
  awaiting_meeting_link: [
    'Wait for therapist to send meeting link',
    'Respond to any questions from either party',
  ],
  confirmed: [
    'Handle any post-booking questions',
    'If reschedule requested, facilitate finding new time',
    'If cancellation requested, use cancel_appointment',
  ],
  rescheduling: [
    'Coordinate new time between both parties',
    'Once agreed, use mark_scheduling_complete with new datetime',
  ],
  cancelled: [
    'No further action needed - booking is cancelled',
  ],
  stalled: [
    'Send follow-up message to re-engage',
    'Consider flagging for human review if no response',
  ],
};

/**
 * Get valid actions for a stage
 */
export function getValidActionsForStage(stage: ConversationStage | undefined): string {
  if (!stage) return VALID_ACTIONS_PER_STAGE.initial_contact.map(a => `- ${a}`).join('\n');
  return VALID_ACTIONS_PER_STAGE[stage].map(a => `- ${a}`).join('\n');
}

/**
 * Get recovery message for a stage
 */
export function getRecoveryMessage(stage: ConversationStage): string {
  return RECOVERY_MESSAGES[stage];
}

/**
 * Check if a conversation needs recovery
 */
export function needsRecovery(
  checkpoint: ConversationCheckpoint,
  staleThresholdHours: number = 48
): boolean {
  if (checkpoint.stage === 'confirmed' || checkpoint.stage === 'cancelled') {
    return false;
  }

  const checkpointTime = new Date(checkpoint.checkpoint_at).getTime();
  const now = Date.now();
  const hoursSinceCheckpoint = (now - checkpointTime) / (1000 * 60 * 60);

  return hoursSinceCheckpoint >= staleThresholdHours;
}

/**
 * Get admin handoff summary
 */
export function getAdminSummary(checkpoint: ConversationCheckpoint): string {
  const parts: string[] = [];

  parts.push(`**Current Stage:** ${STAGE_DESCRIPTIONS[checkpoint.stage]}`);

  if (checkpoint.lastSuccessfulAction) {
    parts.push(`**Last Action:** ${checkpoint.lastSuccessfulAction.replace(/_/g, ' ')}`);
  }

  if (checkpoint.pendingAction) {
    parts.push(`**Waiting For:** ${checkpoint.pendingAction}`);
  }

  if (checkpoint.stalled_since) {
    const stalledDate = new Date(checkpoint.stalled_since);
    parts.push(`**Stalled Since:** ${stalledDate.toLocaleDateString()}`);
  }

  if (checkpoint.recovery_attempts && checkpoint.recovery_attempts > 0) {
    parts.push(`**Recovery Attempts:** ${checkpoint.recovery_attempts}`);
  }

  if (checkpoint.context?.userSelectedSlot) {
    parts.push(`**User Selected:** ${checkpoint.context.userSelectedSlot}`);
  }

  return parts.join('\n');
}

/**
 * Calculate metrics about conversation progress
 */
export interface ConversationMetrics {
  stage: ConversationStage;
  totalTimeHours: number;
  timeInCurrentStageHours: number;
  isStalled: boolean;
  recoveryAttempts: number;
  completionPercentage: number;
}

export const STAGE_COMPLETION_PERCENTAGE: Record<ConversationStage, number> = {
  initial_contact: 10,
  awaiting_therapist_availability: 20,
  awaiting_user_slot_selection: 40,
  awaiting_therapist_confirmation: 60,
  awaiting_meeting_link: 80,
  confirmed: 100,
  rescheduling: 50,
  cancelled: 0,
  stalled: 0,
};

export function calculateMetrics(
  checkpoint: ConversationCheckpoint,
  createdAt: Date
): ConversationMetrics {
  const now = Date.now();
  const checkpointTime = new Date(checkpoint.checkpoint_at).getTime();
  const createdTime = createdAt.getTime();

  return {
    stage: checkpoint.stage,
    totalTimeHours: (now - createdTime) / (1000 * 60 * 60),
    timeInCurrentStageHours: (now - checkpointTime) / (1000 * 60 * 60),
    isStalled: checkpoint.stage === 'stalled' || !!checkpoint.stalled_since,
    recoveryAttempts: checkpoint.recovery_attempts || 0,
    completionPercentage: STAGE_COMPLETION_PERCENTAGE[checkpoint.stage],
  };
}

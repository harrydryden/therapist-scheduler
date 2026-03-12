/**
 * Conversation Checkpoint & Recovery System
 *
 * Provides structured tracking of booking conversation stages:
 * - Enables automatic recovery after stalls
 * - Provides clear context for admin handoff
 * - Enables metrics on where bookings drop off
 */

import { logger } from './logger';
import type { ConversationStage } from '@therapist-scheduler/shared';

// Re-export for consumers
export type { ConversationStage };

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
  | 'processed_reschedule'
  | 'sent_chase_followup'
  | 'closure_recommended_to_admin'
  | 'recommended_cancel_match';

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
  initial_contact: ['awaiting_therapist_availability', 'awaiting_user_slot_selection', 'cancelled', 'stalled', 'chased', 'closure_recommended'],
  awaiting_therapist_availability: ['awaiting_user_slot_selection', 'cancelled', 'stalled', 'chased', 'closure_recommended'],
  awaiting_user_slot_selection: ['awaiting_therapist_confirmation', 'cancelled', 'stalled', 'rescheduling', 'chased', 'closure_recommended'],
  awaiting_therapist_confirmation: ['awaiting_user_slot_selection', 'awaiting_meeting_link', 'confirmed', 'cancelled', 'stalled', 'chased', 'closure_recommended'],
  awaiting_meeting_link: ['confirmed', 'rescheduling', 'cancelled', 'stalled', 'chased'],
  confirmed: ['rescheduling', 'cancelled'],
  rescheduling: ['awaiting_user_slot_selection', 'awaiting_therapist_confirmation', 'confirmed', 'cancelled', 'stalled', 'chased'],
  cancelled: [], // Terminal state
  stalled: ['awaiting_therapist_availability', 'awaiting_user_slot_selection', 'awaiting_therapist_confirmation', 'cancelled', 'chased'],
  chased: ['awaiting_therapist_availability', 'awaiting_user_slot_selection', 'awaiting_therapist_confirmation', 'confirmed', 'cancelled', 'closure_recommended'], // Chase can reactivate or lead to closure
  closure_recommended: ['cancelled', 'awaiting_therapist_availability', 'awaiting_user_slot_selection', 'awaiting_therapist_confirmation', 'chased'], // Admin can cancel, reactivate, or new chase cycle after dismiss
};

/**
 * Human-readable descriptions for each stage
 */
export const STAGE_DESCRIPTIONS: Record<ConversationStage, string> = {
  initial_contact: 'Initial contact made',
  awaiting_therapist_availability: 'Waiting for therapist to provide availability',
  awaiting_user_slot_selection: 'Waiting for user to select a time slot',
  awaiting_therapist_confirmation: 'Waiting for therapist to confirm the selected slot',
  awaiting_meeting_link: 'Booking confirmed, waiting for therapist to send meeting link',
  confirmed: 'Booking complete',
  rescheduling: 'Rescheduling in progress',
  cancelled: 'Booking cancelled',
  stalled: 'Conversation has stalled - needs attention',
  chased: 'Chase follow-up sent, awaiting response',
  closure_recommended: 'Recommended for closure - admin action needed',
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
  chased: '', // Chase already sent - waiting for response
  closure_recommended: '', // Admin action needed - no automated message
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
    sent_chase_followup: 'chased',
    closure_recommended_to_admin: 'closure_recommended',
    recommended_cancel_match: 'closure_recommended',
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
  chased: [
    'Awaiting response to chase follow-up email',
    'If response received, resume normal flow',
    'If no response, system will recommend closure',
  ],
  closure_recommended: [
    'Admin should review and cancel appointment',
    'Or admin can take control and manually re-engage',
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
  if (
    checkpoint.stage === 'confirmed' ||
    checkpoint.stage === 'cancelled' ||
    checkpoint.stage === 'chased' ||
    checkpoint.stage === 'closure_recommended'
  ) {
    return false;
  }

  const checkpointTime = new Date(checkpoint.checkpoint_at).getTime();
  const now = Date.now();
  const hoursSinceCheckpoint = (now - checkpointTime) / (1000 * 60 * 60);

  return hoursSinceCheckpoint >= staleThresholdHours;
}

/**
 * Stage progression order for the normal booking flow.
 * Used to prevent send_email from regressing the checkpoint stage
 * when sending courtesy/follow-up emails (e.g., confirming to the therapist
 * that availability was forwarded to the user).
 */
const STAGE_PROGRESS_ORDER: Record<ConversationStage, number> = {
  initial_contact: 0,
  awaiting_therapist_availability: 1,
  awaiting_user_slot_selection: 2,
  awaiting_therapist_confirmation: 3,
  awaiting_meeting_link: 4,
  confirmed: 5,
  // Non-linear states — can transition to any stage, so never block
  stalled: -1,
  chased: -1,
  closure_recommended: -1,
  rescheduling: -1,
  cancelled: 99, // Terminal
};

/**
 * Check if transitioning from currentStage to newStage would regress
 * the booking flow. Used by the tool loop to prevent send_email from
 * accidentally resetting the conversation stage backward when sending
 * courtesy or follow-up emails.
 *
 * Example: After forwarding therapist availability to the user (stage =
 * awaiting_user_slot_selection), sending a "thanks, I've forwarded your
 * dates" email to the therapist should NOT regress the stage back to
 * awaiting_therapist_availability.
 */
export function wouldRegress(
  currentStage: ConversationStage,
  newStage: ConversationStage
): boolean {
  const currentOrder = STAGE_PROGRESS_ORDER[currentStage];
  const newOrder = STAGE_PROGRESS_ORDER[newStage];

  // Non-linear states can transition to anything
  if (currentOrder < 0) return false;

  // Terminal state can't be regressed from
  if (currentOrder === 99) return true;

  // Transitions to non-linear states are never regressions
  if (newOrder < 0) return false;

  // It's a regression if the new stage is behind the current stage
  return newOrder < currentOrder;
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
  chased: 0,
  closure_recommended: 0,
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

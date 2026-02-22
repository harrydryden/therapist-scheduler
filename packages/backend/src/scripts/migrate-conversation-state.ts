/**
 * Migration Script: Add checkpoint and facts to existing conversation states
 *
 * This script migrates existing live threads to use the new OpenClaw-inspired
 * checkpoint stages and conversation facts extraction.
 *
 * Run with: npx ts-node src/scripts/migrate-conversation-state.ts
 * Or via npm script: npm run migrate:conversation-state
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import {
  type ConversationCheckpoint,
  type ConversationStage,
  createCheckpoint,
} from '../utils/conversation-checkpoint';
import {
  type ConversationFacts,
  extractFacts,
} from '../utils/conversation-facts';
import { parseConversationState } from '../utils/json-parser';

/**
 * Infer the conversation stage from appointment status and conversation history
 */
function inferStageFromStatus(
  status: string,
  hasTherapistAvailability: boolean,
  messageCount: number
): ConversationStage {
  switch (status) {
    case 'confirmed':
      return 'confirmed';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
      // New appointment, hasn't started yet
      return 'initial_contact';
    case 'contacted':
      // Contacted but waiting - depends on availability
      if (hasTherapistAvailability) {
        return 'awaiting_user_slot_selection';
      }
      return 'awaiting_therapist_availability';
    case 'negotiating':
      // Active negotiation - likely awaiting confirmation
      return 'awaiting_therapist_confirmation';
    default:
      // Unknown status - default to initial
      return 'initial_contact';
  }
}

/**
 * Infer pending action from stage
 */
function inferPendingAction(stage: ConversationStage): string | null {
  switch (stage) {
    case 'awaiting_therapist_availability':
      return 'Waiting for therapist to provide availability';
    case 'awaiting_user_slot_selection':
      return 'Waiting for user to select a time slot';
    case 'awaiting_therapist_confirmation':
      return 'Waiting for therapist to confirm the selected slot';
    case 'awaiting_meeting_link':
      return 'Waiting for therapist to send meeting link';
    default:
      return null;
  }
}

async function migrateConversationStates() {
  logger.info('Starting conversation state migration...');

  // Get all active appointments (not cancelled/confirmed more than 7 days ago)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const appointments = await prisma.appointmentRequest.findMany({
    where: {
      OR: [
        { status: { in: ['pending', 'contacted', 'negotiating'] } },
        {
          status: 'confirmed',
          confirmedAt: { gte: sevenDaysAgo },
        },
      ],
      conversationState: { not: null },
    },
    select: {
      id: true,
      status: true,
      therapistEmail: true,
      userEmail: true,
      therapistAvailability: true,
      conversationState: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  logger.info({ count: appointments.length }, 'Found appointments to migrate');

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const appointment of appointments) {
    try {
      // Parse existing conversation state
      const state = parseConversationState(appointment.conversationState);
      if (!state) {
        logger.warn({ appointmentId: appointment.id }, 'Could not parse conversation state - skipping');
        skipped++;
        continue;
      }

      // Check if already migrated
      if ((state as any).checkpoint && (state as any).facts) {
        logger.debug({ appointmentId: appointment.id }, 'Already migrated - skipping');
        skipped++;
        continue;
      }

      // Infer stage from status
      const hasAvailability = !!(appointment.therapistAvailability &&
        (appointment.therapistAvailability as any).slots?.length > 0);
      const messageCount = state.messages?.length || 0;
      const stage = inferStageFromStatus(appointment.status, hasAvailability, messageCount);

      // Create checkpoint
      const checkpoint: ConversationCheckpoint = createCheckpoint(
        stage,
        null, // We don't know the last action
        inferPendingAction(stage)
      );

      // Extract facts from existing messages
      const messages = state.messages || [];
      const facts: ConversationFacts = extractFacts(
        messages,
        appointment.therapistEmail,
        appointment.userEmail
      );

      // Update conversation state with checkpoint and facts
      const updatedState = {
        ...state,
        checkpoint,
        facts,
      };

      // Store updated state (cast to satisfy Prisma's JSON type)
      await prisma.appointmentRequest.update({
        where: { id: appointment.id },
        data: {
          conversationState: updatedState as object,
        },
      });

      logger.info(
        {
          appointmentId: appointment.id,
          stage,
          factsCount: {
            proposedTimes: facts.proposedTimes.length,
            selectedTime: !!facts.selectedTime,
            confirmedTime: !!facts.confirmedTime,
          },
        },
        'Migrated conversation state'
      );

      migrated++;
    } catch (err) {
      logger.error(
        { err, appointmentId: appointment.id },
        'Failed to migrate conversation state'
      );
      errors++;
    }
  }

  logger.info(
    { migrated, skipped, errors, total: appointments.length },
    'Migration complete'
  );

  return { migrated, skipped, errors };
}

// Run if executed directly
if (require.main === module) {
  migrateConversationStates()
    .then((result) => {
      console.log('Migration complete:', result);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

export { migrateConversationStates };

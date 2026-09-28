/**
 * Migration Script: Add checkpoint and facts to existing conversation states
 *
 * This script migrates existing live threads to use the new OpenClaw-inspired
 * checkpoint stages and conversation facts extraction.
 *
 * Run with: npx ts-node src/scripts/migrate-conversation-state.ts
 * Or via npm script: npm run migrate:conversation-state
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import {
  type ConversationCheckpoint,
  type ConversationStage,
  createCheckpoint,
} from '../services/conversation-checkpoint.service';
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
    case 'session_held':
    case 'feedback_requested':
    case 'completed':
      return 'confirmed';
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
      // Prisma's nullable JSON column needs `Prisma.DbNull` to express
      // "DB NULL" rather than the JSON value `null`.
      conversationState: { not: Prisma.DbNull },
    },
    select: {
      id: true,
      status: true,
      therapistEmail: true,
      userEmail: true,
      therapistAvailability: true,
      conversationState: true,
      conversationVersion: true,
      createdAt: true,
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

      // Check if already fully migrated (has both checkpoint and facts).
      // parseConversationState now preserves both fields (it used to
      // strip them, so every run re-"migrated" every row and overwrote
      // the agent's real checkpoint with an inferred one).
      const hasCheckpoint = !!state.checkpoint?.stage;
      const hasFacts = !!state.facts?.updatedAt;
      if (hasCheckpoint && hasFacts) {
        logger.debug({ appointmentId: appointment.id }, 'Already migrated - skipping');
        skipped++;
        continue;
      }

      // Infer stage from status
      const hasAvailability = !!(appointment.therapistAvailability &&
        (appointment.therapistAvailability as any).slots?.length > 0);
      const messageCount = state.messages?.length || 0;
      const stage = inferStageFromStatus(appointment.status, hasAvailability, messageCount);

      // Keep a checkpoint / facts the row already has — only fill in
      // what's missing. Inferring over a real checkpoint would regress
      // the stage the agent recorded.
      const checkpoint: ConversationCheckpoint = state.checkpoint ?? createCheckpoint(
        stage,
        null, // We don't know the last action
        inferPendingAction(stage)
      );

      // Extract facts from existing messages
      const messages = state.messages || [];
      const facts: ConversationFacts = state.facts ?? extractFacts(
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

      // Store updated state and sync denormalized columns.
      // Phase 3a dual-write: mirror conversationState to
      // appointment_conversations so a re-run of this script doesn't
      // diverge from the new sibling table. Written as a JSON object
      // (never a JSON string — see serialiseConversationState).
      const stateJson = JSON.parse(JSON.stringify(updatedState)) as Prisma.InputJsonObject;
      // Denormalise the checkpoint timestamp alongside stage — both
      // columns are kept in lock-step by storeConversationState /
      // applyCheckpointUpdate in normal operation; the one-shot
      // migration writes the column directly so this script's output
      // matches what the runtime writers would produce.
      const parsedCheckpointAt = Date.parse(checkpoint.checkpoint_at);
      const checkpointAt = Number.isFinite(parsedCheckpointAt) ? new Date(parsedCheckpointAt) : null;

      // CAS on conversationVersion like every other conversation-state
      // writer, so running this against a live database can't clobber a
      // concurrent agent / admin write. A lost race skips the row; a
      // re-run picks it up.
      const applied = await prisma.$transaction(async (tx) => {
        const result = await tx.appointmentRequest.updateMany({
          where: { id: appointment.id, conversationVersion: appointment.conversationVersion },
          data: {
            conversationState: stateJson,
            conversationVersion: { increment: 1 },
            messageCount: messageCount,
            checkpointStage: checkpoint.stage,
            checkpointAt,
          },
        });
        if (result.count === 0) return false;
        await tx.appointmentConversation.upsert({
          where: { appointmentId: appointment.id },
          create: { appointmentId: appointment.id, conversationState: stateJson },
          update: { conversationState: stateJson },
        });
        return true;
      });

      if (!applied) {
        logger.warn(
          { appointmentId: appointment.id },
          'Conversation state changed concurrently - skipping (re-run to migrate)'
        );
        skipped++;
        continue;
      }

      logger.info(
        {
          appointmentId: appointment.id,
          stage: checkpoint.stage,
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

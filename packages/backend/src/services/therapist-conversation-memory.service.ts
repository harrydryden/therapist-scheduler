/**
 * Agent thread memory for the availability-collection agent.
 *
 * Same shape contract as agent-memory.service.ts (Layer B) — notes
 * curated by the agent via the `remember` tool, capped per conversation
 * with FIFO eviction, formatted back into the prompt on the next turn.
 * The difference is the row this writes to: `TherapistConversation`,
 * not `AppointmentRequest`. The booking-side `availabilityWindows`
 * sub-array isn't needed here because per-therapist windows live on
 * `Therapist.upcomingAvailability` (see therapist-availability.service)
 * — keeping each store responsible for one shape simplifies reads.
 *
 * Refactored: the pure list-manipulation pieces live in
 * `agent-notes-store.ts`, shared with the booking-side store. This
 * file retains the conversation-specific DB I/O.
 *
 * STRICT PER-CONVERSATION SCOPING: read/write only via `findUnique` /
 * `update` keyed on TherapistConversation.id. No findFirst, no lookup
 * by therapist or thread id. Notes for conversation A cannot leak into
 * a read for conversation B.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import {
  type AgentNoteCategory,
  type AgentMemoryNote,
  parseNotes,
  appendNoteToList,
  formatNotesForPrompt,
} from './agent-notes-store';

// Re-exported so callers don't need to import from two places to render
// memory for the prompt — same renderer works on either entity's notes.
export { formatNotesForPrompt as formatMemoryForPrompt } from './agent-notes-store';

/**
 * Slim memory shape — just notes. The booking-side AgentThreadMemory
 * also carries availabilityWindows; here the windows live on the
 * therapist row instead, so we only persist notes.
 */
export interface TherapistConversationMemory {
  notes: AgentMemoryNote[];
}

const EMPTY_MEMORY: TherapistConversationMemory = { notes: [] };

/**
 * Defensive parser — corrupted memory shouldn't crash the agent loop.
 * Delegates entry-level validation to the shared `parseNotes`; we
 * just unwrap the optional `notes` field from the JSON blob.
 */
function parseMemory(raw: unknown): TherapistConversationMemory {
  if (!raw || typeof raw !== 'object') return EMPTY_MEMORY;
  const obj = raw as { notes?: unknown };
  return { notes: parseNotes(obj.notes) };
}

/**
 * Read notes for this conversation. Returns empty memory when the row
 * doesn't exist; never falls back to a broader query.
 */
export async function getConversationMemory(
  conversationId: string,
): Promise<TherapistConversationMemory> {
  const row = await prisma.therapistConversation.findUnique({
    where: { id: conversationId },
    select: { memory: true },
  });
  if (!row) return EMPTY_MEMORY;
  return parseMemory(row.memory);
}

export interface AddNoteResult {
  added: boolean;
  memory: TherapistConversationMemory;
  noteId: string;
}

/**
 * Append a note to this conversation's memory. Same idempotency
 * + FIFO eviction contract as agent-memory.service.ts's addNote;
 * the shared `appendNoteToList` enforces both.
 */
export async function addConversationNote(
  conversationId: string,
  category: AgentNoteCategory,
  rawText: string,
): Promise<AddNoteResult> {
  const current = await getConversationMemory(conversationId);
  const result = appendNoteToList(current.notes, category, rawText);

  if (!result.added) {
    logger.debug(
      { conversationId, noteId: result.noteId, category },
      'therapist-conversation-memory: note already present, skipping (idempotent)',
    );
    return { added: false, memory: current, noteId: result.noteId };
  }

  const updated: TherapistConversationMemory = { notes: result.notes };

  await prisma.therapistConversation.update({
    where: { id: conversationId },
    data: { memory: updated as unknown as object },
    select: { id: true },
  });

  logger.info(
    { conversationId, noteId: result.noteId, category, totalNotes: updated.notes.length },
    'therapist-conversation-memory: note added',
  );

  return { added: true, memory: updated, noteId: result.noteId };
}

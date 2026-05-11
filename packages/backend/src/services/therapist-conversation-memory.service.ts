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
 * STRICT PER-CONVERSATION SCOPING: read/write only via `findUnique` /
 * `update` keyed on TherapistConversation.id. No findFirst, no lookup
 * by therapist or thread id. Notes for conversation A cannot leak into
 * a read for conversation B.
 */

import crypto from 'crypto';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import type { AgentNoteCategory, AgentMemoryNote } from './agent-memory.service';
import { MAX_NOTES_PER_THREAD, MAX_NOTE_LENGTH } from './agent-memory.service';
// Re-exported so callers don't need to import from two places to render
// memory for the prompt — same renderer works on either entity's notes.
export { formatMemoryForPrompt } from './agent-memory.service';

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
 * Hash a note's text + category. Same algorithm as agent-memory so a
 * note moved between agents would have a stable id; not used for
 * cross-row dedup (each row is independent) but matters for log
 * correlation if we ever migrate notes between rows.
 */
function noteId(text: string, category: AgentNoteCategory): string {
  return crypto
    .createHash('sha256')
    .update(`${category}:${text.trim().toLowerCase()}`)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Defensive parser — corrupted memory shouldn't crash the agent loop.
 * Drops malformed entries; returns empty memory on a totally bad shape.
 */
function parseMemory(raw: unknown): TherapistConversationMemory {
  if (!raw || typeof raw !== 'object') return EMPTY_MEMORY;
  const obj = raw as { notes?: unknown };
  const notes: AgentMemoryNote[] = [];
  if (Array.isArray(obj.notes)) {
    for (const item of obj.notes) {
      if (!item || typeof item !== 'object') continue;
      const n = item as Partial<AgentMemoryNote>;
      if (
        typeof n.id !== 'string' ||
        typeof n.text !== 'string' ||
        typeof n.createdAt !== 'string'
      )
        continue;
      if (
        n.category !== 'preference' &&
        n.category !== 'constraint' &&
        n.category !== 'context' &&
        n.category !== 'decision'
      )
        continue;
      notes.push({ id: n.id, category: n.category, text: n.text, createdAt: n.createdAt });
    }
  }
  return { notes };
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
 * + FIFO eviction contract as agent-memory.service.ts's addNote.
 */
export async function addConversationNote(
  conversationId: string,
  category: AgentNoteCategory,
  rawText: string,
): Promise<AddNoteResult> {
  const text = rawText.trim().slice(0, MAX_NOTE_LENGTH);
  const id = noteId(text, category);

  const current = await getConversationMemory(conversationId);

  if (current.notes.some((n) => n.id === id)) {
    logger.debug(
      { conversationId, noteId: id, category },
      'therapist-conversation-memory: note already present, skipping (idempotent)',
    );
    return { added: false, memory: current, noteId: id };
  }

  const next: AgentMemoryNote = {
    id,
    category,
    text,
    createdAt: new Date().toISOString(),
  };

  const trimmed = current.notes.slice(-(MAX_NOTES_PER_THREAD - 1));
  const updated: TherapistConversationMemory = { notes: [...trimmed, next] };

  await prisma.therapistConversation.update({
    where: { id: conversationId },
    data: { memory: updated as unknown as object },
    select: { id: true },
  });

  logger.info(
    { conversationId, noteId: id, category, totalNotes: updated.notes.length },
    'therapist-conversation-memory: note added',
  );

  return { added: true, memory: updated, noteId: id };
}

/**
 * Agent Thread Memory (Layer B in the agent memory design)
 *
 * The agent's regex-based fact extractor (utils/conversation-facts.ts)
 * captures objective scheduling primitives — proposed times, blockers,
 * confirmations. Anything outside the patterns ("our usual time",
 * "user prefers single-paragraph emails", "kids back at school in
 * September") is lost on every reload.
 *
 * This module gives the agent a place to put those soft observations
 * via a `remember` tool. Notes live on the appointment row, capped at
 * 20 entries with FIFO eviction, and are injected verbatim into the
 * system prompt on the next turn.
 *
 * STRICT PER-APPOINTMENT SCOPING — the only entry points take an
 * appointment ID and read/write via `findUnique` / `update` keyed on
 * that primary key. There is no `findFirst`, no email lookup, no
 * cross-appointment query. Two appointments for the same user (or even
 * the same user/therapist pair) cannot leak notes between each other:
 * the storage column is per-row, the read uses the primary key, and
 * the system prompt builder pulls notes for the appointment whose
 * SchedulingContext is being rendered.
 *
 * Layer C (cross-appointment user/therapist profile) is intentionally
 * NOT implemented here. It deserves its own privacy review.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import crypto from 'crypto';

/**
 * Cap on how many notes we keep per thread. The agent is asked to
 * refine existing notes by re-calling `remember` rather than spam new
 * ones; the cap is a hard backstop in case it doesn't.
 */
export const MAX_NOTES_PER_THREAD = 20;

/**
 * Maximum length per note. Long enough for a useful sentence,
 * short enough that 20 notes fit comfortably in the system prompt.
 */
export const MAX_NOTE_LENGTH = 280;

export type AgentNoteCategory = 'preference' | 'constraint' | 'context' | 'decision';

export interface AgentMemoryNote {
  /** Stable per-note id; deterministic hash of (text, category) so the
   *  same observation written twice in the same turn dedupes safely. */
  id: string;
  category: AgentNoteCategory;
  text: string;
  createdAt: string;
}

export interface AgentThreadMemory {
  notes: AgentMemoryNote[];
}

const EMPTY_MEMORY: AgentThreadMemory = { notes: [] };

/**
 * Hash a note's text + category to a short id. Used both for dedup
 * (re-writing the same observation in the same turn doesn't grow the
 * notes array) and for stable note references in logs.
 */
function noteId(text: string, category: AgentNoteCategory): string {
  return crypto
    .createHash('sha256')
    .update(`${category}:${text.trim().toLowerCase()}`)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Validate a memory blob coming back from the database. Returns a safe
 * empty memory if the shape is wrong — never throws, since a corrupted
 * column shouldn't break the agent loop.
 */
function parseMemory(raw: unknown): AgentThreadMemory {
  if (!raw || typeof raw !== 'object') return EMPTY_MEMORY;
  const obj = raw as { notes?: unknown };
  if (!Array.isArray(obj.notes)) return EMPTY_MEMORY;
  const notes: AgentMemoryNote[] = [];
  for (const item of obj.notes) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Partial<AgentMemoryNote>;
    if (typeof n.id !== 'string' || typeof n.text !== 'string' || typeof n.createdAt !== 'string') continue;
    if (n.category !== 'preference' && n.category !== 'constraint' && n.category !== 'context' && n.category !== 'decision') continue;
    notes.push({ id: n.id, category: n.category, text: n.text, createdAt: n.createdAt });
  }
  return { notes };
}

/**
 * Read the agent's notes for this appointment.
 *
 * STRICT: read is by primary key only. Returns empty memory when the
 * appointment doesn't exist; never falls back to a broader query.
 */
export async function getThreadMemory(appointmentId: string): Promise<AgentThreadMemory> {
  const row = await prisma.appointmentRequest.findUnique({
    where: { id: appointmentId },
    select: { memory: true },
  });
  if (!row) return EMPTY_MEMORY;
  return parseMemory(row.memory);
}

export interface AddNoteResult {
  /** True when the write produced a new note; false when an identical
   *  note was already present and we skipped the write. */
  added: boolean;
  /** The full memory after the write (or the unchanged memory on dedup). */
  memory: AgentThreadMemory;
  /** The id of the note (existing or newly created). */
  noteId: string;
}

/**
 * Append a note to this appointment's memory.
 *
 * Behaviour:
 *   - Same note (by category + normalized text) on this appointment is
 *     a no-op. The agent can re-call `remember` without spamming.
 *   - When the array is at MAX_NOTES_PER_THREAD, the oldest entry is
 *     evicted (FIFO) so newer observations are retained.
 *
 * STRICT: write is by primary key only. The appointment ID is the only
 * identifier this function accepts; there is no path by which a write
 * intended for appointment A can land on appointment B.
 *
 * Read-then-write race: two concurrent calls on the same appointment
 * could both see the same `current.notes` and overwrite each other's
 * latest note. We accept this — the cap is a soft target, the FIFO
 * means the lost note is recoverable on the next agent turn (the
 * agent is prompted to re-remember if needed), and the alternative
 * (Serializable transaction per remember call) is heavy for a
 * non-critical write. If this becomes a real problem we can switch to
 * `update` with a JSONB array append in raw SQL.
 */
export async function addNote(
  appointmentId: string,
  category: AgentNoteCategory,
  rawText: string,
): Promise<AddNoteResult> {
  const text = rawText.trim().slice(0, MAX_NOTE_LENGTH);
  const id = noteId(text, category);

  const current = await getThreadMemory(appointmentId);

  if (current.notes.some((n) => n.id === id)) {
    logger.debug(
      { appointmentId, noteId: id, category },
      'agent-memory: note already present, skipping (idempotent remember)',
    );
    return { added: false, memory: current, noteId: id };
  }

  const next: AgentMemoryNote = {
    id,
    category,
    text,
    createdAt: new Date().toISOString(),
  };

  // FIFO eviction: keep the most recent MAX_NOTES_PER_THREAD - 1 then
  // append the new one. The newest sits at the end so the prompt
  // renders chronological context naturally.
  const trimmed = current.notes.slice(-(MAX_NOTES_PER_THREAD - 1));
  const updated: AgentThreadMemory = { notes: [...trimmed, next] };

  await prisma.appointmentRequest.update({
    where: { id: appointmentId },
    data: { memory: updated as unknown as object },
    select: { id: true },
  });

  logger.info(
    { appointmentId, noteId: id, category, totalNotes: updated.notes.length },
    'agent-memory: note added',
  );

  return { added: true, memory: updated, noteId: id };
}

/**
 * Format the memory for inclusion in the system prompt. Returns an
 * empty string when there are no notes so the prompt builder can drop
 * the section entirely.
 *
 * Notes are grouped by category in a stable order (preference,
 * constraint, context, decision) so the agent sees the same shape
 * across turns and prompt caching is preserved.
 */
export function formatMemoryForPrompt(memory: AgentThreadMemory): string {
  if (memory.notes.length === 0) return '';

  const groups: Record<AgentNoteCategory, string[]> = {
    preference: [],
    constraint: [],
    context: [],
    decision: [],
  };
  for (const note of memory.notes) {
    groups[note.category].push(`- ${note.text}`);
  }

  const sections: string[] = [];
  const labels: Record<AgentNoteCategory, string> = {
    preference: 'Preferences',
    constraint: 'Constraints',
    context: 'Context',
    decision: 'Decisions',
  };
  for (const cat of ['preference', 'constraint', 'context', 'decision'] as const) {
    if (groups[cat].length > 0) {
      sections.push(`**${labels[cat]}:**\n${groups[cat].join('\n')}`);
    }
  }

  return `## Notes from earlier in this conversation
These are observations you've recorded via the \`remember\` tool. Use them to stay consistent with prior decisions and respect stated preferences.

${sections.join('\n\n')}
`;
}

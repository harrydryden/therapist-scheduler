/**
 * Shared in-memory helpers for the "agent notes" pattern used by:
 *   - agent-memory.service.ts (AppointmentRequest.memory.notes,
 *     Layer B in the agent memory design)
 *   - therapist-conversation-memory.service.ts (TherapistConversation.memory.notes)
 *
 * Both stores share the same conceptual shape: a small bounded list of
 * (category, text, id, createdAt) records the agent curates via a
 * `remember` tool, deduped by content hash, FIFO-evicted at a cap,
 * formatted back into the system prompt on the next turn.
 *
 * This module owns the PURE bits (hashing, parsing, in-memory append
 * with eviction, prompt rendering). The owning service files own the
 * DB I/O (read the row, mutate via these helpers, write the row) and
 * the entity-specific logging. Keeping the side-effecting orchestration
 * close to the entity it touches makes the strict per-entity scoping
 * easier to audit; the pure helpers stay trivially unit-testable.
 *
 * No `prisma` import here — that's the line between "logic" and
 * "storage" and we want to keep it sharp.
 */

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

/**
 * Hash a note's text + category to a short id. Used both for dedup
 * (re-writing the same observation in the same turn doesn't grow the
 * notes array) and for stable note references in logs.
 *
 * The normalisation (lowercase + trim) is part of the contract: two
 * notes that differ only in trailing whitespace or capitalisation
 * collapse to the same id and the second is treated as a no-op.
 */
export function noteId(text: string, category: AgentNoteCategory): string {
  return crypto
    .createHash('sha256')
    .update(`${category}:${text.trim().toLowerCase()}`)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Parse an unknown blob into a clean notes array. Drops malformed
 * entries rather than throwing — a corrupted column shouldn't break
 * the agent loop. Each entry is validated independently so one bad
 * apple doesn't take out its siblings.
 */
export function parseNotes(raw: unknown): AgentMemoryNote[] {
  if (!Array.isArray(raw)) return [];
  const notes: AgentMemoryNote[] = [];
  for (const item of raw) {
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
  return notes;
}

export interface AppendNoteResult {
  /** True when the input produced a new entry; false when an identical
   *  note was already present and the result is the unchanged input. */
  added: boolean;
  /** Notes array post-append. Same reference as input when `!added`. */
  notes: AgentMemoryNote[];
  /** The id of the note (existing or newly created). */
  noteId: string;
}

/**
 * Pure in-memory append. Dedups by id; if not present, FIFO-evicts
 * the oldest entries to keep the array within `MAX_NOTES_PER_THREAD`
 * and appends the new entry at the tail.
 *
 * Side-effect-free — callers persist `result.notes` separately. This
 * separation is what makes the helper safe to share: two entity-
 * specific orchestrators can call this without ambient state.
 */
export function appendNoteToList(
  current: AgentMemoryNote[],
  category: AgentNoteCategory,
  rawText: string,
  now: Date = new Date(),
): AppendNoteResult {
  const text = rawText.trim().slice(0, MAX_NOTE_LENGTH);
  const id = noteId(text, category);

  if (current.some((n) => n.id === id)) {
    return { added: false, notes: current, noteId: id };
  }

  const next: AgentMemoryNote = {
    id,
    category,
    text,
    createdAt: now.toISOString(),
  };

  // FIFO eviction: keep the most recent MAX_NOTES_PER_THREAD - 1 then
  // append the new one. The newest sits at the end so the prompt
  // renders chronological context naturally.
  const trimmed = current.slice(-(MAX_NOTES_PER_THREAD - 1));
  return { added: true, notes: [...trimmed, next], noteId: id };
}

const CATEGORY_LABELS: Record<AgentNoteCategory, string> = {
  preference: 'Preferences',
  constraint: 'Constraints',
  context: 'Context',
  decision: 'Decisions',
};

/**
 * Format notes for inclusion in the system prompt. Returns an empty
 * string when there are no notes so the prompt builder can drop the
 * section entirely.
 *
 * Notes are grouped by category in a stable order (preference,
 * constraint, context, decision) so the agent sees the same shape
 * across turns and prompt caching is preserved.
 */
export function formatNotesForPrompt(notes: AgentMemoryNote[]): string {
  if (notes.length === 0) return '';

  const groups: Record<AgentNoteCategory, string[]> = {
    preference: [],
    constraint: [],
    context: [],
    decision: [],
  };
  for (const note of notes) {
    groups[note.category].push(`- ${note.text}`);
  }

  const sections: string[] = [];
  for (const cat of ['preference', 'constraint', 'context', 'decision'] as const) {
    if (groups[cat].length > 0) {
      sections.push(`**${CATEGORY_LABELS[cat]}:**\n${groups[cat].join('\n')}`);
    }
  }

  return `## Notes from earlier in this conversation
These are observations you've recorded via the \`remember\` tool. Use them to stay consistent with prior decisions and respect stated preferences.

${sections.join('\n\n')}
`;
}

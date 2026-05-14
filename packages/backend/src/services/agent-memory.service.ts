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
 * Refactored: the pure list-manipulation pieces (hashing, parsing,
 * FIFO eviction, prompt rendering) now live in
 * `agent-notes-store.ts` and `domain/scheduling/availability/windows/store.ts`,
 * shared with the therapist-side stores. This file retains the
 * appointment-specific DB I/O and combined-blob handling.
 *
 * Layer C (cross-appointment user/therapist profile) is intentionally
 * NOT implemented here. It deserves its own privacy review.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { withSerializationRetry } from '../utils/serialization-retry';
import {
  MAX_NOTES_PER_THREAD,
  MAX_NOTE_LENGTH,
  type AgentNoteCategory,
  type AgentMemoryNote,
  parseNotes,
  appendNoteToList,
  formatNotesForPrompt,
} from './agent-notes-store';
import {
  MAX_WINDOW_QUOTE_LENGTH,
  type AvailabilityWindow,
  parseWindows,
  appendWindowToList,
  getActiveWindows as getActiveWindowsShared,
  formatWindowsForPrompt,
} from '../domain/scheduling/availability/windows/store';

// Re-export so external callers continue to import these from
// agent-memory.service.ts (where they've lived since launch).
export {
  MAX_NOTES_PER_THREAD,
  MAX_NOTE_LENGTH,
  MAX_WINDOW_QUOTE_LENGTH,
};
export type { AgentNoteCategory, AgentMemoryNote, AvailabilityWindow };

/** Cap on availability windows. Same FIFO eviction model as notes. */
export const MAX_WINDOWS_PER_THREAD = 30;

export interface AgentThreadMemory {
  notes: AgentMemoryNote[];
  availabilityWindows: AvailabilityWindow[];
}

const EMPTY_MEMORY: AgentThreadMemory = { notes: [], availabilityWindows: [] };

/**
 * Validate a memory blob coming back from the database. Returns a safe
 * empty memory if the shape is wrong — never throws, since a corrupted
 * column shouldn't break the agent loop. Each sub-array (notes,
 * availabilityWindows) is parsed defensively via the shared parsers
 * so a malformed entry drops without taking out its siblings.
 */
function parseMemory(raw: unknown): AgentThreadMemory {
  if (!raw || typeof raw !== 'object') return EMPTY_MEMORY;
  const obj = raw as { notes?: unknown; availabilityWindows?: unknown };
  return {
    notes: parseNotes(obj.notes),
    availabilityWindows: parseWindows(obj.availabilityWindows),
  };
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
 * CONCURRENCY: The read-modify-write happens inside an interactive
 * transaction with `SELECT ... FOR UPDATE` on the appointment row, so
 * a concurrent caller (e.g. an inbound email racing the tool loop)
 * waits for our update to commit before reading. Without this, both
 * callers could see the same `current.notes` snapshot and the second
 * write would clobber the first. The per-appointment conversation
 * gate prevents most of this surface, but not all — two inbound
 * webhooks landing within ms of each other can both pass the gate
 * before either commits, so the row lock is the load-bearing layer.
 * Same pattern as `therapist-availability.service.ts`.
 */
export async function addNote(
  appointmentId: string,
  category: AgentNoteCategory,
  rawText: string,
): Promise<AddNoteResult> {
  return withSerializationRetry(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM appointment_requests WHERE id = ${appointmentId} FOR UPDATE`;
        const row = await tx.appointmentRequest.findUnique({
          where: { id: appointmentId },
          select: { memory: true },
        });
        const current = row ? parseMemory(row.memory) : EMPTY_MEMORY;
        const result = appendNoteToList(current.notes, category, rawText);

        if (!result.added) {
          logger.debug(
            { appointmentId, noteId: result.noteId, category },
            'agent-memory: note already present, skipping (idempotent remember)',
          );
          return { added: false, memory: current, noteId: result.noteId };
        }

        const updated: AgentThreadMemory = {
          notes: result.notes,
          availabilityWindows: current.availabilityWindows,
        };

        await tx.appointmentRequest.update({
          where: { id: appointmentId },
          data: { memory: updated as unknown as object },
          select: { id: true },
        });

        // Phase 3a dual-write: mirror `memory` to the sibling
        // appointment_conversations row. Same transaction so a
        // partial-write divergence is impossible. Cutover (reads
        // switching to the mirror) is a follow-up PR.
        await tx.appointmentConversation.upsert({
          where: { appointmentId },
          create: { appointmentId, memory: updated as unknown as object },
          update: { memory: updated as unknown as object },
        });

        logger.info(
          { appointmentId, noteId: result.noteId, category, totalNotes: updated.notes.length },
          'agent-memory: note added',
        );

        return { added: true, memory: updated, noteId: result.noteId };
      }),
    { appointmentId, op: 'addNote' },
    (msg, ctx) => logger.warn(ctx, msg),
  );
}

export interface AddWindowResult {
  added: boolean;
  memory: AgentThreadMemory;
  windowId: string;
}

/**
 * Append an availability window to this appointment's memory.
 *
 * Validation: `startsAt` and `endsAt` must be parseable ISO 8601 with
 * offset, and `endsAt` must be strictly after `startsAt`. The caller
 * (the tool executor) also rejects calls where the window has already
 * fully passed — a window with `endsAt` in the past has no value and
 * usually indicates the agent misread "Friday" as the wrong Friday.
 *
 * STRICT per-appointment scoping (same contract as addNote): the only
 * identifier we accept is the appointment ID, and writes go through
 * primary-key update.
 */
export async function addAvailabilityWindow(
  appointmentId: string,
  params: {
    startsAt: string;
    endsAt: string;
    status: 'available' | 'unavailable';
    source: 'therapist' | 'user';
    quote: string;
  },
): Promise<AddWindowResult> {
  return withSerializationRetry(
    () =>
      prisma.$transaction(async (tx) => {
        // Same row-lock contract as addNote — see the note's CONCURRENCY
        // section for why the gate alone isn't sufficient.
        await tx.$queryRaw`SELECT id FROM appointment_requests WHERE id = ${appointmentId} FOR UPDATE`;
        const row = await tx.appointmentRequest.findUnique({
          where: { id: appointmentId },
          select: { memory: true },
        });
        const current = row ? parseMemory(row.memory) : EMPTY_MEMORY;

        // Per-appointment lists are short-lived (one booking thread);
        // no need to compact past windows on every write here, unlike
        // the per-therapist store.
        const result = appendWindowToList(current.availabilityWindows, params, {
          maxSize: MAX_WINDOWS_PER_THREAD,
          compactPast: false,
        });

        if (!result.added) {
          logger.debug(
            { appointmentId, windowId: result.windowId, status: params.status },
            'agent-memory: availability window already present, skipping (idempotent)',
          );
          return { added: false, memory: current, windowId: result.windowId };
        }

        const updated: AgentThreadMemory = {
          notes: current.notes,
          availabilityWindows: result.windows,
        };

        await tx.appointmentRequest.update({
          where: { id: appointmentId },
          data: { memory: updated as unknown as object },
          select: { id: true },
        });

        // Phase 3a dual-write — see the addNote handler for context.
        await tx.appointmentConversation.upsert({
          where: { appointmentId },
          create: { appointmentId, memory: updated as unknown as object },
          update: { memory: updated as unknown as object },
        });

        logger.info(
          {
            appointmentId,
            windowId: result.windowId,
            status: params.status,
            source: params.source,
            startsAt: params.startsAt,
            endsAt: params.endsAt,
            totalWindows: updated.availabilityWindows.length,
          },
          'agent-memory: availability window added',
        );

        return { added: true, memory: updated, windowId: result.windowId };
      }),
    { appointmentId, op: 'addAvailabilityWindow' },
    (msg, ctx) => logger.warn(ctx, msg),
  );
}

/**
 * Future-only view, sorted by start. Past windows are filtered out;
 * showing them to the agent or merging them into the booking-side
 * formatter would only mislead.
 *
 * Wraps the shared `getActiveWindows` so callers can pass the whole
 * `AgentThreadMemory` (the historical signature) rather than a bare
 * array.
 */
export function getActiveWindows(
  memory: AgentThreadMemory,
  now: Date = new Date(),
): AvailabilityWindow[] {
  return getActiveWindowsShared(memory.availabilityWindows, now);
}

/**
 * Format the memory's NOTES for inclusion in the system prompt.
 * Returns an empty string when there are no notes so the prompt
 * builder can drop the section entirely.
 *
 * Delegates to the shared renderer (`formatNotesForPrompt`); kept here
 * as a thin wrapper so callers' import sites don't have to change.
 */
export function formatMemoryForPrompt(memory: AgentThreadMemory): string {
  return formatNotesForPrompt(memory.notes);
}

/**
 * Format the memory's AVAILABILITY WINDOWS for inclusion in the
 * system prompt, filtered to future windows only and sorted by start.
 * Past windows are dropped (they would mislead the agent).
 *
 * Empty string when there are no future windows so the prompt builder
 * can drop the whole section.
 *
 * Uses the per-appointment framing ("Ad-hoc availability mentioned in
 * this conversation"); the per-therapist formatter in
 * `therapist-availability.service.ts` uses a different header that
 * makes clear those windows came from a previous conversation.
 */
export function formatAvailabilityWindowsForPrompt(
  memory: AgentThreadMemory,
  now: Date = new Date(),
  tzTargets?: import('../domain/scheduling/availability/windows/store').FormatWindowsTimezoneTargets,
): string {
  return formatWindowsForPrompt(
    memory.availabilityWindows,
    {
      sectionHeader: '## Ad-hoc availability mentioned in this conversation',
      sectionIntro:
        "These are episodic windows the parties have mentioned in addition to the therapist's base availability above. Times are absolute (ISO 8601 with offset); the lines below each bullet pre-convert the wall-clock for each party's timezone so you can quote them without computing the conversion yourself. Past windows have already been filtered out.",
      availableLabel: 'Mentioned available windows',
      unavailableLabel: 'Mentioned unavailable windows',
    },
    now,
    tzTargets,
  );
}

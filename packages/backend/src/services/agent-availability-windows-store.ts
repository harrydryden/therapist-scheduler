/**
 * Shared in-memory helpers for the "availability windows" pattern used by:
 *   - agent-memory.service.ts (AppointmentRequest.memory.availabilityWindows,
 *     per-appointment Layer B)
 *   - therapist-availability.service.ts (Therapist.upcomingAvailability,
 *     per-therapist storage populated by the availability-collection agent)
 *
 * Both stores share the same conceptual shape: a list of
 * (id, startsAt, endsAt, status, source, quote, recordedAt) records
 * captured from conversation, deduped by content hash, FIFO-evicted
 * at a per-entity cap (different caps for the two consumers — passed
 * in by the orchestrator).
 *
 * This module owns the PURE bits (hashing, parsing, in-memory append
 * with optional past-compaction + FIFO eviction, prompt rendering).
 * The owning service files own the DB I/O and entity-specific logging.
 *
 * No `prisma` import — the line between "logic" and "storage" stays
 * sharp.
 */

import crypto from 'crypto';

/** Cap on the quote string captured from the original message. */
export const MAX_WINDOW_QUOTE_LENGTH = 280;

/**
 * An ad-hoc / episodic availability window mentioned in conversation.
 *
 * Distinct from the recurring weekly base availability stored on the
 * Therapist row: windows are one-off, time-bounded, and naturally
 * expire when their endsAt passes.
 *
 * Both startsAt and endsAt are absolute ISO 8601 timestamps with
 * offset — the agent resolves relative phrasings ("next Friday", "the
 * week of the 15th") to absolute instants at capture time, so the
 * meaning doesn't drift if the conversation continues for days.
 */
export interface AvailabilityWindow {
  id: string;
  /** ISO 8601 with offset. */
  startsAt: string;
  /** ISO 8601 with offset. */
  endsAt: string;
  /** 'available' = an open slot; 'unavailable' = a known block. */
  status: 'available' | 'unavailable';
  /** Who said it. Usually 'therapist' but the user can also note absences. */
  source: 'therapist' | 'user';
  /** Original phrase from the email. Audit trail + helps admins verify
   *  the agent's date resolution (e.g. that "next Friday" became the
   *  expected ISO). */
  quote: string;
  /** Wall-clock at the moment of capture, used for FIFO ordering. */
  recordedAt: string;
}

/**
 * Hash a window's defining fields. Same (status, source, startsAt,
 * endsAt) hashes to the same id, so two paraphrases of the same
 * statement within a single turn dedupe instead of producing two
 * near-identical entries.
 */
export function windowId(
  starts: string,
  ends: string,
  status: string,
  source: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`${status}:${source}:${starts}:${ends}`)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Parse an unknown blob into a clean windows array. Drops malformed
 * entries rather than throwing — a corrupted column shouldn't break
 * the agent loop. Includes a parseability check on the timestamps
 * because rendering a window with an unparseable startsAt would put
 * garbage in the prompt.
 */
export function parseWindows(raw: unknown): AvailabilityWindow[] {
  if (!Array.isArray(raw)) return [];
  const windows: AvailabilityWindow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Partial<AvailabilityWindow>;
    if (
      typeof w.id !== 'string' ||
      typeof w.startsAt !== 'string' ||
      typeof w.endsAt !== 'string' ||
      typeof w.quote !== 'string' ||
      typeof w.recordedAt !== 'string'
    )
      continue;
    if (w.status !== 'available' && w.status !== 'unavailable') continue;
    if (w.source !== 'therapist' && w.source !== 'user') continue;
    if (isNaN(Date.parse(w.startsAt)) || isNaN(Date.parse(w.endsAt))) continue;
    windows.push({
      id: w.id,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      status: w.status,
      source: w.source,
      quote: w.quote,
      recordedAt: w.recordedAt,
    });
  }
  return windows;
}

export interface AppendWindowParams {
  startsAt: string;
  endsAt: string;
  status: 'available' | 'unavailable';
  source: 'therapist' | 'user';
  quote: string;
}

export interface AppendWindowResult {
  /** True for a new row; false when an identical
   *  (status,source,starts,ends) combination was already present and
   *  the input is returned unchanged. */
  added: boolean;
  windows: AvailabilityWindow[];
  windowId: string;
}

export interface AppendWindowOptions {
  /** Maximum array size after the append. Older entries are FIFO-
   *  evicted to fit. Different consumers (per-appointment vs.
   *  per-therapist) use different caps; the helper doesn't impose one. */
  maxSize: number;
  /** When true, past windows (`endsAt < now`) are filtered from the
   *  existing list before applying the FIFO budget. Avoids burning
   *  capacity on already-expired rows. Therapist-side uses this; the
   *  per-appointment side doesn't (the per-appointment list is short-
   *  lived enough that compacting on every write isn't worth it). */
  compactPast?: boolean;
  /** Clock injection for tests. */
  now?: Date;
}

/**
 * Pure in-memory append. Validates the inputs, dedups by id, optionally
 * compacts past entries, then FIFO-evicts the head until the array
 * fits within `maxSize` and appends the new entry at the tail.
 *
 * Throws on malformed inputs (invalid ISO 8601 or end <= start). The
 * caller is expected to additionally check "not entirely in the past"
 * if that's a meaningful precondition for them.
 */
export function appendWindowToList(
  current: AvailabilityWindow[],
  params: AppendWindowParams,
  options: AppendWindowOptions,
): AppendWindowResult {
  const startMs = Date.parse(params.startsAt);
  const endMs = Date.parse(params.endsAt);
  if (isNaN(startMs) || isNaN(endMs)) {
    throw new Error(
      'appendWindowToList: startsAt and endsAt must be parseable ISO 8601 datetimes',
    );
  }
  if (endMs <= startMs) {
    throw new Error('appendWindowToList: endsAt must be strictly after startsAt');
  }

  const id = windowId(params.startsAt, params.endsAt, params.status, params.source);
  const quote = params.quote.trim().slice(0, MAX_WINDOW_QUOTE_LENGTH);
  const now = options.now ?? new Date();

  if (current.some((w) => w.id === id)) {
    return { added: false, windows: current, windowId: id };
  }

  const next: AvailabilityWindow = {
    id,
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    status: params.status,
    source: params.source,
    quote,
    recordedAt: now.toISOString(),
  };

  // Optional past-compaction. Order matters: if we trimmed FIFO first,
  // we might evict a future window in favour of keeping a past one.
  const cutoff = now.getTime();
  const compacted = options.compactPast
    ? current.filter((w) => Date.parse(w.endsAt) > cutoff)
    : current;
  const trimmed = compacted.slice(-(options.maxSize - 1));
  return { added: true, windows: [...trimmed, next], windowId: id };
}

/**
 * Future-only view, sorted by start. Past windows are filtered out;
 * showing them to the agent or merging them into the booking-side
 * formatter would only mislead.
 */
export function getActiveWindows(
  windows: AvailabilityWindow[],
  now: Date = new Date(),
): AvailabilityWindow[] {
  const cutoff = now.getTime();
  return windows
    .filter((w) => Date.parse(w.endsAt) > cutoff)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

export interface FormatWindowsHeaders {
  /** Top-level section header, e.g. "## Ad-hoc availability mentioned
   *  in this conversation". */
  sectionHeader: string;
  /** Explanatory paragraph rendered between the header and the bullet
   *  lists. */
  sectionIntro: string;
  /** Sub-header for available windows. */
  availableLabel: string;
  /** Sub-header for unavailable windows. */
  unavailableLabel: string;
}

/**
 * Format the windows for inclusion in a system prompt, filtered to
 * future windows only and sorted by start. Empty string when there
 * are no future windows so the prompt builder can drop the section.
 *
 * Headers/intro are parameterised so the two consumers (per-appointment
 * Layer B vs. per-therapist long-lived) can use different framing —
 * the per-appointment formatter calls it "Ad-hoc availability mentioned
 * in this conversation", the per-therapist formatter calls it
 * "Upcoming availability the therapist has previously shared".
 */
export function formatWindowsForPrompt(
  windows: AvailabilityWindow[],
  headers: FormatWindowsHeaders,
  now: Date = new Date(),
): string {
  const active = getActiveWindows(windows, now);
  if (active.length === 0) return '';

  const available = active.filter((w) => w.status === 'available');
  const unavailable = active.filter((w) => w.status === 'unavailable');

  const fmt = (w: AvailabilityWindow): string => {
    const sourceLabel = w.source === 'therapist' ? 'Therapist' : 'Client';
    return `- ${w.startsAt} → ${w.endsAt} (recorded from ${sourceLabel}: "${w.quote}")`;
  };

  const sections: string[] = [];
  if (available.length > 0) {
    sections.push(`**${headers.availableLabel}:**\n${available.map(fmt).join('\n')}`);
  }
  if (unavailable.length > 0) {
    sections.push(`**${headers.unavailableLabel}:**\n${unavailable.map(fmt).join('\n')}`);
  }

  return `${headers.sectionHeader}
${headers.sectionIntro}

${sections.join('\n\n')}
`;
}

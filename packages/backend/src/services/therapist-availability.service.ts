/**
 * Per-Therapist Upcoming Availability
 *
 * Storage helpers for `Therapist.upcomingAvailability` — the per-therapist
 * version of the per-appointment `appointment.memory.availabilityWindows`
 * that already lives in agent-memory.service.ts.
 *
 * Two distinct columns on `therapists`:
 *   - `availability`: recurring weekly schedule {timezone, slots, exceptions}
 *     — written by the booking agent's `update_therapist_availability` tool.
 *   - `upcomingAvailability`: episodic one-off windows captured by the new
 *     availability-collection agent's `record_availability_window` tool.
 *     Shape mirrors `AvailabilityWindow` from agent-memory.service.ts so
 *     downstream readers (e.g. the booking system prompt) can union all
 *     three sources — recurring + per-appointment + per-therapist — into a
 *     single render path without three different formatters.
 *
 * STRICT PER-THERAPIST SCOPING: read/write only via `findUnique` /
 * `update` keyed on Therapist.id. There is no lookup by name, email, or
 * any other field. Windows written for therapist A cannot leak into a
 * read for therapist B.
 *
 * FIFO eviction at MAX_UPCOMING_WINDOWS_PER_THERAPIST keeps the JSON
 * column bounded. Past windows (endsAt < now) are filtered at read time
 * by `getActiveUpcomingWindows` so the agent never sees stale entries,
 * and the write path compacts them out on insert so the FIFO budget
 * doesn't burn on already-expired rows.
 */

import crypto from 'crypto';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import type { AvailabilityWindow } from './agent-memory.service';
import { MAX_WINDOW_QUOTE_LENGTH } from './agent-memory.service';

/**
 * Bound on stored windows. Higher than the per-appointment cap (30)
 * because a therapist may accumulate windows across multiple weeks of
 * onboarding back-and-forth, not just one booking thread.
 */
export const MAX_UPCOMING_WINDOWS_PER_THERAPIST = 50;

/** Empty fallback used when the column is null or a corrupted shape. */
const EMPTY: AvailabilityWindow[] = [];

/**
 * Defensive parser. Same shape contract as agent-memory.service.ts's
 * parseMemory but for the array-shaped upcomingAvailability column.
 * Drops malformed entries rather than throwing — a corrupted column
 * shouldn't break the agent or the booking flow.
 */
function parseUpcomingWindows(raw: unknown): AvailabilityWindow[] {
  if (!Array.isArray(raw)) return EMPTY;
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

/**
 * Deterministic window id: same (status, source, startsAt, endsAt) on
 * the same therapist hashes to the same id, so two paraphrases of the
 * same statement within a single turn dedupe instead of producing two
 * near-identical entries.
 */
function windowId(starts: string, ends: string, status: string, source: string): string {
  return crypto
    .createHash('sha256')
    .update(`${status}:${source}:${starts}:${ends}`)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Read the therapist's upcoming windows. Returns [] when the row
 * doesn't exist; never falls back to a broader lookup.
 */
export async function getUpcomingAvailability(
  therapistId: string,
): Promise<AvailabilityWindow[]> {
  const row = await prisma.therapist.findUnique({
    where: { id: therapistId },
    select: { upcomingAvailability: true },
  });
  if (!row) return EMPTY;
  return parseUpcomingWindows(row.upcomingAvailability);
}

export interface AddUpcomingWindowResult {
  /** True for a new row; false when an identical (status,source,starts,ends)
   *  combination was already present and we skipped the write. */
  added: boolean;
  windows: AvailabilityWindow[];
  windowId: string;
}

/**
 * Append an upcoming window to the therapist row.
 *
 * Same validation contract as agent-memory.service.ts's
 * addAvailabilityWindow — ISO 8601 with offset on both ends, endsAt
 * strictly after startsAt. The caller is expected to reject windows
 * that have already fully passed (endsAt < now) so we don't burn FIFO
 * capacity on stale rows.
 *
 * On insert we also compact past windows out of the existing list —
 * dropping them at write time keeps the column lean over the lifetime
 * of a busy therapist without needing a separate cleanup job.
 */
export async function addUpcomingAvailability(
  therapistId: string,
  params: {
    startsAt: string;
    endsAt: string;
    status: 'available' | 'unavailable';
    source: 'therapist' | 'user';
    quote: string;
  },
  now: Date = new Date(),
): Promise<AddUpcomingWindowResult> {
  const startMs = Date.parse(params.startsAt);
  const endMs = Date.parse(params.endsAt);

  if (isNaN(startMs) || isNaN(endMs)) {
    throw new Error('addUpcomingAvailability: startsAt and endsAt must be parseable ISO 8601 datetimes');
  }
  if (endMs <= startMs) {
    throw new Error('addUpcomingAvailability: endsAt must be strictly after startsAt');
  }

  const id = windowId(params.startsAt, params.endsAt, params.status, params.source);
  const quote = params.quote.trim().slice(0, MAX_WINDOW_QUOTE_LENGTH);

  const current = await getUpcomingAvailability(therapistId);

  if (current.some((w) => w.id === id)) {
    logger.debug(
      { therapistId, windowId: id, status: params.status },
      'therapist-availability: window already present, skipping (idempotent)',
    );
    return { added: false, windows: current, windowId: id };
  }

  const next: AvailabilityWindow = {
    id,
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    status: params.status,
    source: params.source,
    quote,
    recordedAt: new Date().toISOString(),
  };

  // Compact past windows on write, then apply the FIFO budget. Order
  // matters: if we trimmed first, we might evict a future window in
  // favour of keeping a past one.
  const cutoff = now.getTime();
  const future = current.filter((w) => Date.parse(w.endsAt) > cutoff);
  const trimmed = future.slice(-(MAX_UPCOMING_WINDOWS_PER_THERAPIST - 1));
  const updated = [...trimmed, next];

  await prisma.therapist.update({
    where: { id: therapistId },
    data: { upcomingAvailability: updated as unknown as object },
    select: { id: true },
  });

  logger.info(
    {
      therapistId,
      windowId: id,
      status: params.status,
      source: params.source,
      startsAt: params.startsAt,
      endsAt: params.endsAt,
      total: updated.length,
    },
    'therapist-availability: window added',
  );

  return { added: true, windows: updated, windowId: id };
}

/**
 * Future-only view, sorted by start. Past windows are filtered out;
 * showing them to the agent or merging them into the booking-side
 * formatter would only mislead.
 */
export function getActiveUpcomingWindows(
  windows: AvailabilityWindow[],
  now: Date = new Date(),
): AvailabilityWindow[] {
  const cutoff = now.getTime();
  return windows
    .filter((w) => Date.parse(w.endsAt) > cutoff)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/**
 * Prompt-ready rendering, parallel in shape to agent-memory.service.ts's
 * formatAvailabilityWindowsForPrompt. Empty string when there are no
 * active windows so the prompt builder can drop the whole section.
 *
 * Times are rendered as ISO 8601 with offset — unambiguous. The agent
 * is expected to convert to the recipient's timezone via the existing
 * timezone-section guidance when proposing slots.
 */
export function formatUpcomingAvailabilityForPrompt(
  windows: AvailabilityWindow[],
  now: Date = new Date(),
): string {
  const active = getActiveUpcomingWindows(windows, now);
  if (active.length === 0) return '';

  const available = active.filter((w) => w.status === 'available');
  const unavailable = active.filter((w) => w.status === 'unavailable');

  const fmt = (w: AvailabilityWindow): string => {
    const sourceLabel = w.source === 'therapist' ? 'Therapist' : 'Client';
    return `- ${w.startsAt} → ${w.endsAt} (recorded from ${sourceLabel}: "${w.quote}")`;
  };

  const sections: string[] = [];
  if (available.length > 0) {
    sections.push(`**Upcoming availability windows shared by the therapist:**\n${available.map(fmt).join('\n')}`);
  }
  if (unavailable.length > 0) {
    sections.push(`**Upcoming unavailable windows shared by the therapist:**\n${unavailable.map(fmt).join('\n')}`);
  }

  return `## Upcoming availability the therapist has previously shared
Windows here are episodic — they complement the recurring weekly schedule but don't replace it. Times are absolute ISO 8601 with offset; convert to the recipient's local timezone before proposing slots. Past windows have already been filtered.

${sections.join('\n\n')}
`;
}

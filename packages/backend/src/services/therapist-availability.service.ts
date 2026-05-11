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
 *     Shape mirrors `AvailabilityWindow` from
 *     `agent-availability-windows-store.ts` so downstream readers (e.g. the
 *     booking system prompt) can union all three sources — recurring +
 *     per-appointment + per-therapist — into a single render path without
 *     three different formatters.
 *
 * Refactored: the pure list-manipulation pieces (hashing, parsing, FIFO
 * eviction with optional past-compaction, prompt rendering) now live in
 * `agent-availability-windows-store.ts`, shared with agent-memory.service.ts.
 * This file retains the therapist-specific DB I/O.
 *
 * STRICT PER-THERAPIST SCOPING: read/write only via `findUnique` /
 * `update` keyed on Therapist.id. There is no lookup by name, email, or
 * any other field. Windows written for therapist A cannot leak into a
 * read for therapist B.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import {
  type AvailabilityWindow,
  parseWindows,
  appendWindowToList,
  getActiveWindows as getActiveWindowsShared,
  formatWindowsForPrompt,
} from './agent-availability-windows-store';

/**
 * Bound on stored windows. Higher than the per-appointment cap (30)
 * because a therapist may accumulate windows across multiple weeks of
 * onboarding back-and-forth, not just one booking thread.
 */
export const MAX_UPCOMING_WINDOWS_PER_THERAPIST = 50;

/** Empty fallback used when the column is null or a corrupted shape. */
const EMPTY: AvailabilityWindow[] = [];

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
  return parseWindows(row.upcomingAvailability);
}

/**
 * Combined read used by the booking agent's system-prompt builder:
 * fetches both the upcoming windows AND the booking link in a single
 * Therapist row query. Saves a round-trip vs. calling
 * `getUpcomingAvailability` + a separate findUnique for bookingLink.
 *
 * STRICT per-therapist scoping: same primary-key contract as
 * `getUpcomingAvailability` — `findUnique` only, no fallbacks.
 */
export async function getTherapistSchedulingDataForPrompt(
  therapistId: string,
): Promise<{ windows: AvailabilityWindow[]; bookingLink: string | null }> {
  const row = await prisma.therapist.findUnique({
    where: { id: therapistId },
    select: { upcomingAvailability: true, bookingLink: true },
  });
  if (!row) return { windows: EMPTY, bookingLink: null };
  return {
    windows: parseWindows(row.upcomingAvailability),
    bookingLink: row.bookingLink,
  };
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
 * Past-compaction is enabled on every write so the column doesn't
 * accumulate expired entries over a therapist's lifetime on the
 * platform — distinct from the per-appointment store where the list
 * is short-lived enough that compacting on every write isn't worth it.
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
  const current = await getUpcomingAvailability(therapistId);
  const result = appendWindowToList(current, params, {
    maxSize: MAX_UPCOMING_WINDOWS_PER_THERAPIST,
    compactPast: true,
    now,
  });

  if (!result.added) {
    logger.debug(
      { therapistId, windowId: result.windowId, status: params.status },
      'therapist-availability: window already present, skipping (idempotent)',
    );
    return { added: false, windows: current, windowId: result.windowId };
  }

  await prisma.therapist.update({
    where: { id: therapistId },
    data: { upcomingAvailability: result.windows as unknown as object },
    select: { id: true },
  });

  logger.info(
    {
      therapistId,
      windowId: result.windowId,
      status: params.status,
      source: params.source,
      startsAt: params.startsAt,
      endsAt: params.endsAt,
      total: result.windows.length,
    },
    'therapist-availability: window added',
  );

  return { added: true, windows: result.windows, windowId: result.windowId };
}

/**
 * Persist a booking-link URL on the therapist row. The single
 * writeable surface for `Therapist.bookingLink` from agents — both
 * the availability-collection agent (via record_booking_link) and
 * the booking agent (via record_booking_link, added in the
 * one-source-of-truth follow-up) route here. Admins still write
 * directly to the column via the therapist edit UI; that path stays
 * separate.
 *
 * STRICT per-therapist scoping: update keyed on Therapist.id only.
 * URL validation is the caller's responsibility — the Zod schema at
 * the tool boundary rejects non-URL strings before reaching this
 * helper.
 */
export async function recordTherapistBookingLink(
  therapistId: string,
  url: string,
): Promise<void> {
  await prisma.therapist.update({
    where: { id: therapistId },
    data: { bookingLink: url },
    select: { id: true },
  });
  logger.info({ therapistId, url }, 'therapist-availability: booking link recorded');
}

/**
 * Future-only view, sorted by start. Re-exposed here for callers that
 * already imported it from this module; delegates to the shared
 * implementation.
 */
export function getActiveUpcomingWindows(
  windows: AvailabilityWindow[],
  now: Date = new Date(),
): AvailabilityWindow[] {
  return getActiveWindowsShared(windows, now);
}

/**
 * Prompt-ready rendering of the therapist's upcoming windows. Empty
 * string when there are no active windows so the prompt builder can
 * drop the whole section.
 *
 * Uses the per-therapist framing ("Upcoming availability the therapist
 * has previously shared") which makes clear these windows came from
 * a different conversation, distinct from the per-appointment Layer B
 * formatter's "Ad-hoc availability mentioned in this conversation".
 */
export function formatUpcomingAvailabilityForPrompt(
  windows: AvailabilityWindow[],
  now: Date = new Date(),
): string {
  return formatWindowsForPrompt(
    windows,
    {
      sectionHeader: '## Upcoming availability the therapist has previously shared',
      sectionIntro:
        "Windows here are episodic — they complement the recurring weekly schedule but don't replace it. Times are absolute ISO 8601 with offset; convert to the recipient's local timezone before proposing slots. Past windows have already been filtered.",
      availableLabel: 'Upcoming availability windows shared by the therapist',
      unavailableLabel: 'Upcoming unavailable windows shared by the therapist',
    },
    now,
  );
}

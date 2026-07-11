/**
 * Wall-clock → absolute-instant resolver, DST-safe.
 *
 * The availability agent and the booking agent both need to convert a
 * therapist- or client-supplied wall-clock time ("Tuesday at 2pm") in a
 * particular IANA timezone into an ISO 8601 string with the correct
 * offset for that date. JavaScript's Date doesn't expose this directly —
 * `new Date(...)` interprets bare wall-clock inputs in the server's
 * local timezone, and `Date.parse` accepts offset-less strings the same
 * way. Letting the model compute the offset itself produces consistent
 * errors around DST transitions and non-UK/US zones.
 *
 * `resolveWallClock` is the surface this module is built around: give
 * it (timezone, year, month, day, hour, minute) and it returns the
 * absolute UTC instant and the offset that timezone was using at that
 * moment, or an error if the wall-clock time is ambiguous (occurs
 * twice during a fall-back) or non-existent (skipped over by a
 * spring-forward). Callers turn those back into ISO 8601 with
 * `formatIsoWithOffset` for the record-window tool inputs.
 *
 * Implementation: Intl-based, no external deps. The algorithm is a
 * two-pass guess-and-verify — initial UTC guess, observe what
 * wall-clock that lands on in the target zone, shift the guess by the
 * gap, verify the shifted instant round-trips to the input wall-clock.
 * If it doesn't round-trip, the input is either ambiguous (try both
 * offsets and see which matches) or non-existent (neither offset
 * matches, the gap is the spring-forward).
 */

/**
 * Validate that a string is a real IANA timezone identifier.
 *
 * `Intl.DateTimeFormat` throws when constructed with an unknown
 * timeZone — we use that as the oracle.
 */
export function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Internal: read the wall-clock components of `date` in `timezone`.
 * Inlined rather than imported from `./date` so this module stays
 * dependency-free (date.ts pulls in config/settings, which trip up
 * tests that mount only the resolver).
 */
function readWallClock(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
} {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (t: string) => +(parts.find((p) => p.type === t)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month') - 1,
    day: get('day'),
    // Intl renders 24:00 for midnight in en-GB; normalise to 00:00.
    hours: get('hour') === 24 ? 0 : get('hour'),
    minutes: get('minute'),
  };
}

/** Successful resolution: a single absolute instant + the offset used. */
export interface ResolvedInstant {
  /** Absolute UTC instant as ms since epoch. */
  utcMs: number;
  /** Offset in minutes (e.g. +60 for BST). */
  offsetMinutes: number;
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedInstant }
  | { ok: false; error: 'ambiguous' | 'non_existent' | 'invalid_timezone'; detail: string };

/**
 * Compute the offset (in minutes) the target timezone is using at a
 * given UTC instant. Positive for zones ahead of UTC, negative for
 * zones behind.
 */
function offsetAtInstant(timezone: string, utcMs: number): number {
  const parts = readWallClock(new Date(utcMs), timezone);
  const wallClockUtcMs = Date.UTC(
    parts.year,
    parts.month,
    parts.day,
    parts.hours,
    parts.minutes,
  );
  return Math.round((wallClockUtcMs - utcMs) / 60000);
}

/**
 * Verify whether a given UTC instant round-trips to the requested
 * wall-clock components in the target timezone. Used after applying
 * an offset guess to confirm we landed on the right side of a DST
 * transition.
 */
function landsOn(
  timezone: string,
  utcMs: number,
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): boolean {
  const parts = readWallClock(new Date(utcMs), timezone);
  return (
    parts.year === year &&
    parts.month === monthIndex &&
    parts.day === day &&
    parts.hours === hour &&
    parts.minutes === minute
  );
}

/**
 * Resolve a wall-clock time in `timezone` to an absolute instant.
 *
 * Returns an error result rather than throwing — the calling tool
 * handler converts these into specific messages the agent can react
 * to (e.g. "ambiguous: this hour occurs twice, please clarify which
 * one").
 */
export function resolveWallClock(
  timezone: string,
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): ResolveResult {
  if (!isValidIanaTimezone(timezone)) {
    return {
      ok: false,
      error: 'invalid_timezone',
      detail: `Unknown IANA timezone: ${timezone}`,
    };
  }

  // Treat the wall-clock as UTC for an initial guess.
  const naiveUtcMs = Date.UTC(year, monthIndex, day, hour, minute);

  // Sample the zone's offset a day either side of the target moment (and
  // at the guess itself). In steady state all three probes agree; around
  // a DST transition they yield BOTH the pre- and post-transition
  // offsets, which is exactly the candidate set we need to detect
  // ambiguity rather than silently picking one side.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const candidateOffsets = new Set<number>([
    offsetAtInstant(timezone, naiveUtcMs - DAY_MS),
    offsetAtInstant(timezone, naiveUtcMs),
    offsetAtInstant(timezone, naiveUtcMs + DAY_MS),
  ]);

  // A candidate offset "lands" when shifting the naive guess by it
  // round-trips to the requested wall-clock. Zero landings = the
  // wall-clock was skipped (spring-forward gap); exactly one =
  // unambiguous; two distinct instants = the wall-clock occurs twice
  // (fall-back ambiguity).
  const landings: ResolvedInstant[] = [];
  for (const offset of candidateOffsets) {
    const utcMs = naiveUtcMs - offset * 60000;
    if (landsOn(timezone, utcMs, year, monthIndex, day, hour, minute)) {
      // A landing's offset equals the candidate by construction
      // (wall-clock UTC minus instant = the shift we just applied).
      landings.push({ utcMs, offsetMinutes: offset });
    }
  }

  if (landings.length === 1) {
    return { ok: true, resolved: landings[0] };
  }

  if (landings.length > 1) {
    const offsets = landings.map((l) => `${l.offsetMinutes >= 0 ? '+' : ''}${l.offsetMinutes / 60}h`).join(' and ');
    return {
      ok: false,
      error: 'ambiguous',
      detail: `Wall-clock ${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} occurs twice in ${timezone} (DST fall-back; valid at both ${offsets} offsets). Ask which occurrence is meant, or pick a time outside the transition hour.`,
    };
  }

  // No sampled offset landed. Before concluding the wall-clock doesn't
  // exist, probe half-hour neighbours — zones like Australia/Lord_Howe
  // shift by 30 minutes, which the day-probes straddle without hitting.
  for (const base of candidateOffsets) {
    for (const delta of [-30, 30, -60, 60]) {
      const candidate = naiveUtcMs - (base + delta) * 60000;
      if (landsOn(timezone, candidate, year, monthIndex, day, hour, minute)) {
        return {
          ok: true,
          resolved: { utcMs: candidate, offsetMinutes: base + delta },
        };
      }
    }
  }

  return {
    ok: false,
    error: 'non_existent',
    detail: `Wall-clock ${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} does not exist in ${timezone} (likely a DST spring-forward gap)`,
  };
}

/**
 * Format a UTC instant + offset back into ISO 8601 with the offset
 * suffix. The output is exactly the format `record_availability_window`
 * expects in its starts_at / ends_at fields.
 */
export function formatIsoWithOffset(resolved: ResolvedInstant): string {
  const local = new Date(resolved.utcMs + resolved.offsetMinutes * 60000);
  // local is constructed so its UTC getters return the WALL-CLOCK
  // components of the target zone — convenient for the string build,
  // but never expose this Date to callers; it's a stringification
  // helper only.
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(local.getUTCDate()).padStart(2, '0');
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mi = String(local.getUTCMinutes()).padStart(2, '0');
  const ss = String(local.getUTCSeconds()).padStart(2, '0');
  const sign = resolved.offsetMinutes >= 0 ? '+' : '-';
  const absOff = Math.abs(resolved.offsetMinutes);
  const oh = String(Math.floor(absOff / 60)).padStart(2, '0');
  const om = String(absOff % 60).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${oh}:${om}`;
}

/**
 * Render an ISO 8601 timestamp as a human-readable wall-clock string
 * in the supplied IANA timezone, e.g. "Tue 19 May 2026, 14:00 BST".
 *
 * Used by the booking-agent prompt builder to pre-convert stored
 * windows to both parties' timezones rather than asking the model to
 * do the conversion freehand.
 */
export function formatInTimezone(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    });
    return fmt.format(date);
  } catch {
    return iso;
  }
}

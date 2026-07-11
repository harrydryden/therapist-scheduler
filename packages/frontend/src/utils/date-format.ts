/**
 * Shared date formatting utilities for the frontend.
 * Extracted from AdminAppointmentsPage to avoid duplication across pages.
 *
 * Timezone convention: appointment times are stored in UK time
 * (Europe/London) — see packages/shared/src/constants/countries.ts. Every
 * render and every picker in the admin UI therefore works in LONDON
 * wall-clock, never the admin's browser timezone. A US-based admin sees and
 * edits the same times a UK admin does; before this convention was enforced
 * here, `new Date(pickerValue).toISOString()` silently re-encoded times
 * against the browser zone (a 5-hour shift for a New York admin).
 */

export const LONDON_TZ = 'Europe/London';

/** Read the wall-clock components of an instant as seen in London. */
function londonParts(date: Date): {
  year: number;
  month: number; // 1-12
  day: number;
  hours: number;
  minutes: number;
} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Some ICU builds render midnight as 24:00 in h24 cycles; normalise.
    hours: get('hour') % 24,
    minutes: get('minute'),
  };
}

/**
 * Convert a `datetime-local` input value (`YYYY-MM-DDTHH:mm`), interpreted
 * as LONDON wall-clock time, to a UTC ISO string. Mirrors the backend's
 * `wallClockToUtc` (guess-and-verify via Intl) so the conversion is
 * DST-correct and independent of the browser's own timezone.
 *
 * Returns '' for unparseable input.
 */
export function londonWallClockToIso(localValue: string): string {
  const m = localValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return '';
  const [year, month, day, hours, minutes] = m.slice(1).map(Number);

  // Guess: treat the wall-clock as UTC, observe what London wall-clock that
  // instant produces, and shift the guess by the difference (= the London
  // offset at that moment).
  const guessMs = Date.UTC(year, month - 1, day, hours, minutes);
  const observed = londonParts(new Date(guessMs));
  const observedMs = Date.UTC(
    observed.year,
    observed.month - 1,
    observed.day,
    observed.hours,
    observed.minutes,
  );
  return new Date(guessMs + (guessMs - observedMs)).toISOString();
}

/**
 * Turn a `datetime-local` value (London wall-clock) into the explicit,
 * unambiguous UK prose string submitted as `confirmedDateTime` — e.g.
 * "Tuesday 23 June 2026 at 14:00". This is the ONE wire format both admin
 * editors send: it is human-readable wherever the raw column surfaces
 * (detail panel, email fallback copy) and chrono-parses on the backend in
 * the platform timezone to the exact instant the admin picked.
 */
export function datetimeLocalToLondonProse(localValue: string): string {
  const iso = londonWallClockToIso(localValue);
  if (!iso) return '';
  const d = new Date(iso);
  const dateStr = d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: LONDON_TZ,
  });
  const timeStr = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: LONDON_TZ,
  });
  return `${dateStr} at ${timeStr}`;
}

/**
 * Format a date string to human-readable format (e.g., "06 Mar 2026, 14:30"),
 * rendered in LONDON time regardless of the admin's browser timezone.
 */
export function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Invalid Date';
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: LONDON_TZ,
    });
  } catch {
    return dateStr;
  }
}

/**
 * Format a date/timestamp as relative time (e.g., "5m ago", "2h ago", "3d ago").
 *
 * When a string is passed and it's null/invalid, returns the `nullValue`
 * fallback (default '—'). This matches the shape needed by list views where a
 * missing timestamp should render as a dash.
 */
export function formatTimeAgo(
  dateOrTimestamp: string | number | null,
  nullValue = '—'
): string {
  if (dateOrTimestamp == null) return nullValue;
  const time = typeof dateOrTimestamp === 'number'
    ? dateOrTimestamp
    : new Date(dateOrTimestamp).getTime();
  if (isNaN(time)) return nullValue;
  const diffMs = Date.now() - time;
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  // Older than 30 days: fall back to a short absolute date so users don't
  // have to parse "60d ago".
  return new Date(time).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: LONDON_TZ,
  });
}

/**
 * Format an expiry date: "Expired" if in the past, otherwise a short absolute
 * date ("12 Apr 2026"). Returns `nullValue` for missing dates.
 */
export function formatExpiryDate(dateStr: string | null, nullValue = '—'): string {
  if (!dateStr) return nullValue;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return nullValue;
  if (date < new Date()) return 'Expired';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: LONDON_TZ,
  });
}

/**
 * Format a Date or ISO string to datetime-local input value (YYYY-MM-DDTHH:mm)
 * for <input type="datetime-local"> fields, rendered as the LONDON wall-clock
 * of the instant. Paired with `londonWallClockToIso` /
 * `datetimeLocalToLondonProse` on save, values round-trip exactly for every
 * admin regardless of their browser timezone.
 */
export function toDatetimeLocalValue(dateStr: string | null): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const p = londonParts(d);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hours)}:${pad(p.minutes)}`;
  } catch {
    return '';
  }
}

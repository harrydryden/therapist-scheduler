/**
 * Shared date formatting utilities for the frontend.
 * Extracted from AdminAppointmentsPage to avoid duplication across pages.
 */

/**
 * Format a date string to human-readable format (e.g., "06 Mar 2026, 14:30")
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
  return new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
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
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Format a Date or ISO string to datetime-local input value (YYYY-MM-DDTHH:mm)
 * Used for <input type="datetime-local"> fields.
 */
export function toDatetimeLocalValue(dateStr: string | null): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

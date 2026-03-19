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
 * Format a date/timestamp as relative time (e.g., "5m ago", "2h ago", "3d ago")
 */
export function formatTimeAgo(dateOrTimestamp: string | number): string {
  const time = typeof dateOrTimestamp === 'number' ? dateOrTimestamp : new Date(dateOrTimestamp).getTime();
  const diffMs = Date.now() - time;
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
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

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

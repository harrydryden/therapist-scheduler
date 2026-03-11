/**
 * Shared Date Formatting Utilities
 *
 * Common date/time formatting functions used by both email-date-formatter
 * and availability-formatter. Extracted to eliminate duplication.
 */

export const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Get ordinal suffix for a day number (1st, 2nd, 3rd, 4th...)
 */
export function getOrdinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * Format time in 12-hour format with minutes always shown: "9:30am", "1:00pm"
 */
export function formatTime12(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  const minuteStr = minutes.toString().padStart(2, '0');
  return `${hours}:${minuteStr}${ampm}`;
}

/**
 * Format time in 12-hour format, omitting :00 minutes: "10am", "2:30pm"
 */
export function formatTime12Compact(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  const minuteStr = minutes === 0 ? '' : `:${minutes.toString().padStart(2, '0')}`;
  return `${hours}${minuteStr}${ampm}`;
}

/**
 * Format time in 24-hour format: "09:30", "13:45"
 */
export function formatTime24(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

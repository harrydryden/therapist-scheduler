/**
 * Centralized color mappings for badges and status indicators
 * Single source of truth for consistent UI theming
 */

// Appointment status badge colors
export const STATUS_BADGE_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  contacted: 'bg-blue-100 text-blue-800',
  negotiating: 'bg-purple-100 text-purple-800',
  confirmed: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-800',
} as const;

// Knowledge base audience colors
export const AUDIENCE_BADGE_COLORS: Record<string, string> = {
  therapist: 'bg-purple-100 text-purple-800',
  user: 'bg-blue-100 text-blue-800',
  both: 'bg-green-100 text-green-800',
} as const;

// Priority level colors
export const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-slate-100 text-slate-800',
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-orange-100 text-orange-800',
  urgent: 'bg-red-100 text-red-800',
} as const;

// Common badge styles for labels/tags
export const TAG_COLORS = {
  default: 'bg-slate-100 text-slate-600',
  custom: 'bg-primary-50 text-primary-700',
  inactive: 'bg-slate-200 text-slate-600',
  warning: 'bg-amber-200 text-amber-800',
  success: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-800',
  info: 'bg-blue-100 text-blue-800',
  human: 'bg-orange-100 text-orange-800',
  stale: 'bg-red-100 text-red-800',
} as const;

// Utility function to get status color with fallback
export function getStatusColor(status: string): string {
  return STATUS_BADGE_COLORS[status] || 'bg-slate-100 text-slate-800';
}

// Utility function to get audience color with fallback
export function getAudienceColor(audience: string): string {
  return AUDIENCE_BADGE_COLORS[audience] || 'bg-slate-100 text-slate-800';
}

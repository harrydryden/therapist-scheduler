/**
 * Centralized color mappings for badges and status indicators
 * Single source of truth for consistent UI theming
 * Uses Spill color palette (spill-blue, spill-teal, spill-yellow, spill-red, spill-grey)
 */

// Appointment status badge colors - Full lifecycle
export const STATUS_BADGE_COLORS: Record<string, string> = {
  // Pre-booking stages
  pending: 'bg-spill-yellow-100 text-spill-yellow-600',
  contacted: 'bg-spill-blue-100 text-spill-blue-800',
  negotiating: 'bg-spill-blue-200 text-spill-blue-900',

  // Booking confirmed
  confirmed: 'bg-spill-teal-100 text-spill-teal-600',

  // Post-session stages
  session_held: 'bg-spill-teal-200 text-spill-teal-700',
  feedback_requested: 'bg-purple-100 text-purple-700',
  completed: 'bg-green-100 text-green-700',

  // Terminal
  cancelled: 'bg-spill-red-100 text-spill-red-600',
} as const;

// Knowledge base audience colors
export const AUDIENCE_BADGE_COLORS: Record<string, string> = {
  therapist: 'bg-spill-blue-200 text-spill-blue-900',
  user: 'bg-spill-blue-100 text-spill-blue-800',
  both: 'bg-spill-teal-100 text-spill-teal-600',
} as const;

// Health status colors (traffic light system)
export const HEALTH_STATUS_COLORS: Record<string, string> = {
  green: 'bg-spill-teal-400',
  yellow: 'bg-spill-yellow-400',
  red: 'bg-spill-red-400',
} as const;

// Conversation stage labels (human-readable)
export const STAGE_LABELS: Record<string, string> = {
  initial_contact: 'Initial Contact',
  awaiting_therapist_availability: 'Awaiting Availability',
  awaiting_user_slot_selection: 'Awaiting User Selection',
  awaiting_therapist_confirmation: 'Awaiting Confirmation',
  awaiting_meeting_link: 'Awaiting Meeting Link',
  confirmed: 'Confirmed',
  rescheduling: 'Rescheduling',
  cancelled: 'Cancelled',
  stalled: 'Stalled',
} as const;

// Utility function to get status color with fallback
export function getStatusColor(status: string): string {
  return STATUS_BADGE_COLORS[status] || 'bg-slate-100 text-slate-800';
}

// Utility function to get audience color with fallback
export function getAudienceColor(audience: string): string {
  return AUDIENCE_BADGE_COLORS[audience] || 'bg-slate-100 text-slate-800';
}

// Utility function to get health status color with fallback
export function getHealthColor(status: string): string {
  return HEALTH_STATUS_COLORS[status] || HEALTH_STATUS_COLORS.green;
}

// Utility function to get stage label with fallback
export function getStageLabel(stage: string | null): string {
  if (!stage) return 'Unknown';
  return STAGE_LABELS[stage] || stage;
}

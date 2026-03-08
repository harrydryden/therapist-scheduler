/**
 * Constants shared between frontend and backend.
 */

import type { AppointmentStatus } from '../types';

// HTTP Headers used by both frontend API client and backend middleware
export const HEADERS = {
  WEBHOOK_SECRET: 'x-webhook-secret',
} as const;

// Re-export AppointmentStatus and APPOINTMENT_STATUS from types
// (they live in types/index.ts but are also conceptually constants)
export type { AppointmentStatus } from '../types';
export { APPOINTMENT_STATUS } from '../types';

// ============================================
// Status Labels & Groupings
// ============================================

/** Human-readable labels for each appointment status */
export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  pending: 'Pending',
  contacted: 'Contacted',
  negotiating: 'Negotiating',
  confirmed: 'Confirmed',
  session_held: 'Session Held',
  feedback_requested: 'Feedback Req.',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** All statuses in lifecycle order */
export const ALL_STATUSES: readonly AppointmentStatus[] = [
  'pending',
  'contacted',
  'negotiating',
  'confirmed',
  'session_held',
  'feedback_requested',
  'completed',
  'cancelled',
] as const;

/** Pre-booking active statuses (not yet confirmed or beyond) */
export const PRE_BOOKING_STATUSES: readonly AppointmentStatus[] = [
  'pending',
  'contacted',
  'negotiating',
] as const;

/** Active statuses (everything except terminal states) */
export const ACTIVE_STATUSES: readonly AppointmentStatus[] = [
  'pending',
  'contacted',
  'negotiating',
  'confirmed',
  'session_held',
  'feedback_requested',
] as const;

/** Post-session statuses */
export const POST_SESSION_STATUSES: readonly AppointmentStatus[] = [
  'session_held',
  'feedback_requested',
  'completed',
] as const;

/** Post-booking statuses (confirmed and beyond, excluding cancelled) */
export const POST_BOOKING_STATUSES: readonly AppointmentStatus[] = [
  'confirmed',
  'session_held',
  'feedback_requested',
  'completed',
] as const;

/** Terminal statuses */
export const TERMINAL_STATUSES: readonly AppointmentStatus[] = [
  'completed',
  'cancelled',
] as const;

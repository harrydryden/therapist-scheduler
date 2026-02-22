/**
 * Constants shared between frontend and backend.
 */

// HTTP Headers used by both frontend API client and backend middleware
export const HEADERS = {
  WEBHOOK_SECRET: 'x-webhook-secret',
} as const;

// Re-export AppointmentStatus and APPOINTMENT_STATUS from types
// (they live in types/index.ts but are also conceptually constants)
export type { AppointmentStatus } from '../types';
export { APPOINTMENT_STATUS } from '../types';

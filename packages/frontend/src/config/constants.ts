/**
 * Centralized constants for the frontend application.
 * HEADERS is imported from the shared package (single source of truth).
 */
export { HEADERS } from '@therapist-scheduler/shared';

// Application branding
export const APP = {
  COORDINATOR_NAME: 'Justin Time',
  DEFAULT_TIMEZONE: 'Europe/London',
} as const;

// Timeouts
export const TIMEOUTS = {
  DEFAULT_MS: 30000, // 30 seconds
  LONG_MS: 120000, // 2 minutes (for AI operations)
} as const;

// UI Layout constants
export const UI = {
  // TherapistCard section heights (in pixels) - no longer used for fixed heights
  CATEGORY_SECTION_HEIGHT: 56,
  BIO_SECTION_HEIGHT: 100,
  AVAILABILITY_SECTION_HEIGHT: 48,
  // Maximum visible items before "show more"
  // Set high to show all badges by default (user feedback: want to see all areas of focus)
  MAX_VISIBLE_BADGES: 100,
  MAX_AVAILABILITY_SLOTS: 2,
  // Bio truncation
  BIO_TRUNCATE_LENGTH: 100,
  // Z-index layers
  Z_INDEX: {
    TOOLTIP: 9999,
    MODAL: 1000,
    DROPDOWN: 100,
  },
} as const;


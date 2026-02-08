/**
 * Centralized constants for the frontend application
 */

// Application branding
export const APP = {
  COORDINATOR_NAME: 'Justin Time',
  DEFAULT_TIMEZONE: 'Europe/London',
} as const;

// HTTP Headers
export const HEADERS = {
  WEBHOOK_SECRET: 'x-webhook-secret',
} as const;

// Query/Cache settings
export const CACHE = {
  STALE_TIME_MS: 5 * 60 * 1000, // 5 minutes
  GC_TIME_MS: 10 * 60 * 1000, // 10 minutes
} as const;

// Timeouts
export const TIMEOUTS = {
  DEFAULT_MS: 30000, // 30 seconds
  LONG_MS: 120000, // 2 minutes (for AI operations)
} as const;

// Pagination defaults
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
} as const;

// File upload limits
export const UPLOAD = {
  MAX_FILE_SIZE_MB: 10,
  ALLOWED_TYPES: ['application/pdf'] as const,
} as const;

// UI Layout constants
export const UI = {
  // TherapistCard section heights (in pixels)
  CATEGORY_SECTION_HEIGHT: 56,
  BIO_SECTION_HEIGHT: 100,
  AVAILABILITY_SECTION_HEIGHT: 48,
  // Maximum visible items before "show more"
  MAX_VISIBLE_BADGES: 2,
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

// Admin dashboard settings
export const ADMIN = {
  REFETCH_INTERVAL_MS: 30000, // 30 seconds
  DEFAULT_LIMIT: 100,
  MAX_CONTENT_HEIGHT: 600, // pixels
  TEXT_AREA_MAX_LENGTH: 12000, // characters (~2000 words)
} as const;

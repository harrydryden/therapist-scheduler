/**
 * Centralized constants for the frontend application
 */

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

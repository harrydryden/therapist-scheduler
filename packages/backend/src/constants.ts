/**
 * Centralized constants for the backend application.
 * HEADERS and AppointmentStatus/APPOINTMENT_STATUS are imported from the shared package.
 */
export { HEADERS } from '@therapist-scheduler/shared';

// Input validation limits
export const INPUT_LIMITS = {
  MAX_EMAIL_SUBJECT_LENGTH: 1000,
  MAX_EMAIL_BODY_LENGTH: 500000, // 500KB
  MAX_CHUNK_ACCUMULATION_BYTES: 15 * 1024 * 1024, // 15MB
  MAX_NAME_LENGTH: 255,
  MAX_EMAIL_LENGTH: 320, // RFC 5321 max
} as const;

// Rate limiting
export const RATE_LIMITS = {
  PUBLIC_APPOINTMENT_REQUEST: {
    max: 5,
    timeWindowMs: 60000, // 1 minute
  },
  PUBLIC_THERAPIST_LIST: {
    max: 30, // 30 requests per minute for listing therapists
    timeWindowMs: 60000,
  },
  ADMIN_ENDPOINTS: {
    max: 60, // 60 requests per minute for admin ops
    timeWindowMs: 60000,
  },
  ADMIN_MUTATIONS: {
    max: 20, // 20 mutations per minute (take control, send message, etc.)
    timeWindowMs: 60000,
  },
  WEBHOOK: {
    max: 60, // 60 webhook calls per minute (Gmail push notifications)
    timeWindowMs: 60000,
  },
  DEFAULT: {
    max: 100,
    timeWindowMs: 60000,
  },
} as const;

// Inactivity thresholds (simplified - single threshold for admin alert + auto-unfreeze)
export const INACTIVITY_THRESHOLDS = {
  // Alert admin and auto-unfreeze therapist after this many hours of inactivity
  // Default 72 hours - configurable via notifications.inactivityAlertHours
  ALERT_HOURS: 72,
} as const;

// FIX #45: Cleaned up stale alias. MARK_STALE_HOURS is actively used by conversation-health.
export const STALE_THRESHOLDS = {
  MARK_STALE_HOURS: 48,
  ADMIN_ALERT_HOURS: INACTIVITY_THRESHOLDS.ALERT_HOURS,
} as const;

// Conversation stall detection thresholds
// A "stall" is different from inactivity - stall means activity is happening
// but no forward progress (tool executions) is being made
export const STALL_DETECTION = {
  // Flag as stalled if no tool executed in 24h despite activity
  STALL_THRESHOLD_HOURS: 24,
} as const;

// Therapist booking freeze settings
export const THERAPIST_BOOKING = {
  // Use single inactivity threshold for unfreezing
  INACTIVITY_ALERT_HOURS: INACTIVITY_THRESHOLDS.ALERT_HOURS,
  // Max unique requests allowed (after which therapist is fully frozen)
  MAX_UNIQUE_REQUESTS: 2,
} as const;

// API timeouts
export const TIMEOUTS = {
  ANTHROPIC_API_MS: 60000, // 60 seconds
  GMAIL_API_MS: 30000, // 30 seconds
  KNOWLEDGE_QUERY_MS: 5000, // 5 seconds for knowledge base query
  SYSTEM_PROMPT_BUILD_MS: 10000, // 10 seconds total for system prompt building
} as const;

// Cache settings
export const CACHE = {
  THERAPIST_TTL_SECONDS: 300, // 5 minutes
  THERAPIST_KEY: 'therapists:all',
} as const;

// Redis keys
export const REDIS_KEYS = {
  EMAIL_LOCK_PREFIX: 'email-lock:',
  EMAIL_PROCESSING_PREFIX: 'email-processing:',
  EMAIL_LOCK_TTL_MS: 30000, // 30 seconds
} as const;

// Email settings
export const EMAIL = {
  FROM_NAME: 'Justin Time',
  // FIX #42: Make FROM_ADDRESS configurable via environment variable
  FROM_ADDRESS: process.env.EMAIL_FROM_ADDRESS || 'scheduling@spill.chat',
  SUBJECT_PREFIX: '',
  MAX_RETRIES: 5, // Max retries for pending emails
  // Exponential backoff: 1min, 5min, 15min, 1h, 4h
  RETRY_DELAYS_MS: [
    1 * 60 * 1000,    // 1 minute
    5 * 60 * 1000,    // 5 minutes
    15 * 60 * 1000,   // 15 minutes
    60 * 60 * 1000,   // 1 hour
    4 * 60 * 60 * 1000, // 4 hours
  ],
} as const;

// Pagination defaults
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

// AppointmentStatus type and APPOINTMENT_STATUS lookup — from shared package
export type { AppointmentStatus } from '@therapist-scheduler/shared';
export { APPOINTMENT_STATUS } from '@therapist-scheduler/shared';

// Post-booking follow-up settings
export const POST_BOOKING = {
  MEETING_LINK_CHECK_DELAY_HOURS: 24,
  MEETING_LINK_CHECK_MIN_BEFORE_HOURS: 4,
  FEEDBACK_FORM_DELAY_HOURS: 1,
  FEEDBACK_REMINDER_DELAY_HOURS: 48, // Hours after feedback form to send reminder
  CHECK_INTERVAL_MS: 15 * 60 * 1000, // 15 minutes
  SESSION_REMINDER_HOURS_BEFORE: 4, // Hours before session to send reminder (Edge Case #6)
} as const;

// Conversation state limits (to prevent unbounded growth)
export const CONVERSATION_LIMITS = {
  // Max messages in conversation state (keeps last N pairs)
  MAX_MESSAGES: 100,
  // Max total state size in bytes (prevents DB issues)
  MAX_STATE_BYTES: 500 * 1024, // 500KB
  // Number of messages to keep when trimming (keeps recent context)
  TRIM_TO_MESSAGES: 50,
  // Max individual message length (truncate longer messages)
  // Prevents single large email from causing memory issues
  MAX_MESSAGE_LENGTH: 50 * 1024, // 50KB per message
  // Truncation suffix when message is cut
  TRUNCATION_SUFFIX: '\n\n[Message truncated due to length - see original email for full content]',
} as const;

// Thread fetching limits (prevents memory exhaustion from large threads)
export const THREAD_LIMITS = {
  // Maximum messages to fetch from a single thread
  MAX_MESSAGES_PER_THREAD: 50,
  // Maximum total body size for all messages in a thread (bytes)
  MAX_THREAD_BODY_SIZE: 2 * 1024 * 1024, // 2MB total
  // Skip messages older than this when thread is very large
  KEEP_RECENT_MESSAGES: 30,
} as const;

// Claude API retry settings (for rate limit errors)
export const CLAUDE_API = {
  // Maximum retry attempts for rate limit (429) errors
  // Increased from 3 to 5 for production resilience during high-load periods
  MAX_RETRIES: 5,
  // Exponential backoff delays: 1min, 5min, 15min, 30min, 60min
  // Extended to support the increased retry count
  RETRY_DELAYS_MS: [
    1 * 60 * 1000,    // 1 minute
    5 * 60 * 1000,    // 5 minutes
    15 * 60 * 1000,   // 15 minutes
    30 * 60 * 1000,   // 30 minutes
    60 * 60 * 1000,   // 60 minutes (max delay)
  ],
  // Add jitter up to 10% of delay to prevent thundering herd
  JITTER_FACTOR: 0.1,
} as const;

// Pending email processing distributed lock
export const PENDING_EMAIL_LOCK = {
  KEY: 'pending-email:processing-lock',
  TTL_SECONDS: 120, // 2 minutes - matches processing interval
  RENEWAL_INTERVAL_MS: 30 * 1000, // Renew every 30 seconds
} as const;

// Pending email queue settings
export const PENDING_EMAIL_QUEUE = {
  DEFAULT_BATCH_SIZE: 10,
  MAX_BATCH_SIZE: 50,
  // Thresholds for dynamic batch sizing
  BACKLOG_WARNING_THRESHOLD: 100,
  BACKLOG_CRITICAL_THRESHOLD: 500,
  // Batch size multipliers based on backlog
  BATCH_SIZE_MULTIPLIER_WARNING: 2,  // 20 emails when > 100
  BATCH_SIZE_MULTIPLIER_CRITICAL: 5, // 50 emails when > 500
} as const;

// Data retention policy settings
export const DATA_RETENTION = {
  // How long to keep cancelled appointments before archiving (days)
  CANCELLED_RETENTION_DAYS: 90,
  // How long to keep confirmed/completed appointments before archiving (days)
  COMPLETED_RETENTION_DAYS: 365,
  // How long to keep processed Gmail messages in dedup table (days)
  PROCESSED_MESSAGE_RETENTION_DAYS: 30,
  // How long to keep abandoned pending emails (days)
  ABANDONED_EMAIL_RETENTION_DAYS: 30,
  // Batch size for cleanup operations (to avoid long transactions)
  CLEANUP_BATCH_SIZE: 100,
} as const;

// Stale check distributed lock (for multi-instance safety)
export const STALE_CHECK_LOCK = {
  KEY: 'stale-check:processing-lock',
  TTL_SECONDS: 300, // 5 minutes - stale check can take a while
  RENEWAL_INTERVAL_MS: 60 * 1000, // Renew every 60 seconds
} as const;

// Data retention cleanup distributed lock
export const RETENTION_CLEANUP_LOCK = {
  KEY: 'retention-cleanup:processing-lock',
  TTL_SECONDS: 600, // 10 minutes - cleanup can be slow
  RENEWAL_INTERVAL_MS: 120 * 1000, // Renew every 2 minutes
} as const;

// Application defaults
export const APP_DEFAULTS = {
  // Default timezone for the application (IANA timezone identifier)
  TIMEZONE: 'Europe/London',
} as const;

// Weekly mailing list settings and distributed lock
export const WEEKLY_MAILING = {
  // Check interval: every hour
  CHECK_INTERVAL_MS: 60 * 60 * 1000,
  // Distributed lock key
  LOCK_KEY: 'weekly-mailing:processing-lock',
  // Lock TTL: 10 minutes (sending to many users can take time)
  LOCK_TTL_SECONDS: 600,
  // Lock renewal interval: every 2 minutes
  RENEWAL_INTERVAL_MS: 120 * 1000,
  // Key to track last send date
  LAST_SEND_KEY: 'weekly-mailing:last-send-date',
} as const;

// Slack notification settings
export const SLACK_NOTIFICATIONS = {
  // Weekly summary: Monday at 9am (Europe/London timezone)
  WEEKLY_SUMMARY_DAY: 1, // 0 = Sunday, 1 = Monday, etc.
  WEEKLY_SUMMARY_HOUR: 9,
  // Check interval for weekly summary: every hour
  CHECK_INTERVAL_MS: 60 * 60 * 1000,
  // Distributed lock for weekly summary
  LOCK_KEY: 'slack-weekly-summary:processing-lock',
  LOCK_TTL_SECONDS: 120,
  // Key to track last summary date
  LAST_SUMMARY_KEY: 'slack-weekly-summary:last-send-date',
} as const;

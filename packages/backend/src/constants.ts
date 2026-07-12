/**
 * Centralized constants for the backend application.
 * HEADERS and AppointmentStatus/APPOINTMENT_STATUS are imported from the shared package.
 */
export { HEADERS } from '@therapist-scheduler/shared';

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
  /**
   * Per-email cap on public booking submissions across a 24h window.
   * The IP-level limiter handles burst control; this caps total
   * submissions for any single (potentially attacker-spoofed) email
   * regardless of source IP, to bound platform-mediated harassment of
   * a single victim. Both pending and cancelled requests count —
   * harassers tend to cancel-and-recreate to keep the active-thread
   * limit from kicking in.
   */
  PUBLIC_APPOINTMENT_REQUEST_PER_EMAIL: {
    max: 8,
    timeWindowMs: 24 * 60 * 60 * 1000, // 24h
  },
  DEFAULT: {
    max: 100,
    timeWindowMs: 60000,
  },
} as const;

// Inactivity thresholds — DEFAULTS ONLY, runtime values come from admin settings:
// notifications.inactivityAlertHours
export const INACTIVITY_THRESHOLDS = {
  ALERT_HOURS: 72,
} as const;

// Stale thresholds — DEFAULTS ONLY, runtime value: general.staleThresholdHours
export const STALE_THRESHOLDS = {
  MARK_STALE_HOURS: 48,
  ADMIN_ALERT_HOURS: INACTIVITY_THRESHOLDS.ALERT_HOURS,
} as const;

// Stall detection — DEFAULTS ONLY, runtime value: notifications.stallDetectionHours
export const STALL_DETECTION = {
  STALL_THRESHOLD_HOURS: 24,
} as const;

// Therapist booking freeze — DEFAULTS ONLY, runtime value: general.maxBookingRequestsPerTherapist
export const THERAPIST_BOOKING = {
  INACTIVITY_ALERT_HOURS: INACTIVITY_THRESHOLDS.ALERT_HOURS,
  MAX_UNIQUE_REQUESTS: 2,
} as const;

// Therapist nudge ceiling. The "still looking for a client" nudge runs on
// a cadence (therapistNudge.intervalWeeks); this caps how many times an
// unmatched therapist is emailed before we stop and escalate to an admin
// instead — the loop equivalent of the per-appointment tool ceiling.
export const THERAPIST_NUDGE = {
  MAX_NUDGES: 3,
} as const;

// API timeouts — single source of truth for all operation timeouts.
// Previously split between constants.ts and utils/timeout.ts DEFAULT_TIMEOUTS.
export const TIMEOUTS = {
  ANTHROPIC_API_MS: 60000, // 60 seconds
  GMAIL_API_MS: 30000, // 30 seconds
  KNOWLEDGE_QUERY_MS: 5000, // 5 seconds for knowledge base query
  SYSTEM_PROMPT_BUILD_MS: 10000, // 10 seconds total for system prompt building
  HTTP_FETCH_MS: 30000, // 30 seconds for HTTP fetch operations
  DATABASE_MS: 10000, // 10 seconds for database queries
  CACHE_MS: 5000, // 5 seconds for cache operations
  EXTERNAL_API_MS: 15000, // 15 seconds for external API calls (Slack, etc.)
  AI_MODEL_MS: 120000, // 120 seconds for AI model calls (Claude)
  FILE_IO_MS: 30000, // 30 seconds for file operations
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
export {
  APPOINTMENT_STATUS,
  ACTIVE_STATUSES,
  PRE_BOOKING_STATUSES,
  POST_BOOKING_STATUSES,
  TERMINAL_STATUSES,
  CONFIRMED_ACTIVE_STATUSES,
} from '@therapist-scheduler/shared';

// Post-booking follow-up distributed lock. Was the only appointment-
// mutating periodic runner with no lock at all (single-writer sends were
// protected only by the per-appointment sentinel columns, not a
// process-level lock) — see docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md.
export const POST_BOOKING_FOLLOWUP_LOCK = {
  KEY: 'post-booking-followup:processing-lock',
  TTL_SECONDS: 300, // 5 minutes - runs 6 sequential sub-checks per tick
  RENEWAL_INTERVAL_MS: 60 * 1000, // Renew every 60 seconds
} as const;

// Post-booking follow-up — DEFAULTS ONLY, runtime values come from postBooking.* settings
export const POST_BOOKING = {
  MEETING_LINK_CHECK_DELAY_HOURS: 24,
  MEETING_LINK_CHECK_MIN_BEFORE_HOURS: 4,
  FEEDBACK_FORM_DELAY_HOURS: 1,
  FEEDBACK_REMINDER_DELAY_HOURS: 48,
  CHECK_INTERVAL_MS: 15 * 60 * 1000, // Infrastructure interval, not admin-configurable
  SESSION_REMINDER_HOURS_BEFORE: 4,
} as const;

// Shared boundary for "this session is over": a confirmed session is
// treated as having taken place once it is this long past its scheduled
// start (50min session + 10min slack). Two consumers MUST stay in
// lock-step on this value:
//   - the lifecycle tick, which promotes confirmed → session_held past it
//   - the initiate_reschedule guard, which refuses to wipe the confirmed
//     datetime past it (a "reschedule" of a session that already happened
//     is really a new-booking request, and clearing the date would strand
//     the appointment outside the tick's query forever)
// A single constant means there is no window where a row is both
// promotable and reschedulable.
export const SESSION_END_BUFFER_MS = 60 * 60 * 1000; // 1 hour

// How long after the abandoned previous slot a still-unresolved reschedule
// is flagged to admins by the stale-check watchdog. Generous enough to
// ignore reschedules that are actively converging (and to absorb timezone
// ambiguity when parsing the stored slot string), small enough that a
// stranded appointment surfaces the next day rather than never.
export const RESCHEDULE_OVERDUE_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Chase follow-up — DEFAULTS ONLY, runtime values come from chase.* settings
export const CHASE_FOLLOWUP = {
  CHASE_AFTER_STALE_HOURS: 72,
  CLOSURE_RECOMMENDATION_HOURS: 48,
  MAX_CHASE_BATCH_SIZE: 10,
  MAX_CLOSURE_BATCH_SIZE: 20,
} as const;

// Conversation state limits (to prevent unbounded growth)
export const CONVERSATION_LIMITS = {
  // Max messages in conversation state (keeps last N pairs)
  MAX_MESSAGES: 100,
  // Max total state size in bytes (prevents DB issues)
  MAX_STATE_BYTES: 500 * 1024, // 500KB
  // Total messages to keep after trimming
  TRIM_TO_MESSAGES: 50,
  // When trimming, keep the first N messages (initial booking context)
  // so the agent always sees how the conversation started, not just the
  // most recent reschedule chatter. The middle is dropped with a summary
  // placeholder. The remaining slots are filled from the tail (recent
  // context). This preserves coherence on long-running threads.
  TRIM_KEEP_FIRST: 4,
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
  // Reduced from 30 to 7 — messages older than 7 days won't be reprocessed,
  // and this table can grow significantly during Redis outages (database fallback)
  PROCESSED_MESSAGE_RETENTION_DAYS: 7,
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

// Missed message scanner distributed lock
export const MISSED_MESSAGE_SCANNER_LOCK = {
  KEY: 'missed-message-scanner:processing-lock',
  TTL_SECONDS: 600, // 10 minutes - scanning many threads can be slow
  RENEWAL_INTERVAL_MS: 120 * 1000, // Renew every 2 minutes
} as const;

// Missed message scanner intervals
export const MISSED_MESSAGE_SCANNER_INTERVALS = {
  /** How often to run the full scan (ms) — reduced from 4h to 1h to catch missed messages sooner */
  SCAN_INTERVAL_MS: 1 * 60 * 60 * 1000,
  /** Delay before first scan after startup (ms) — 2 minutes to let services initialize */
  STARTUP_DELAY_MS: 2 * 60 * 1000,
  /** Max appointments to scan per batch (to respect Gmail API rate limits) */
  BATCH_SIZE: 25,
  /** Delay between batches (ms) to avoid Gmail rate limiting */
  BATCH_DELAY_MS: 2000,
  /** Alert after this many consecutive skipped cycles (OAuth failures, lock contention, etc.) */
  CONSECUTIVE_SKIP_ALERT_THRESHOLD: 3,
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
  // Key holding the ISO timestamp of the last successful send.
  // Used both to enforce the once-per-7-days ceiling AND as the cutoff for
  // the "any new therapists since last send?" event-trigger check, so its
  // TTL is generous (90 days) — if the service stays quiet for weeks the
  // timestamp must still be there to anchor the next event trigger.
  LAST_SEND_KEY: 'weekly-mailing:last-send-date',
  LAST_SEND_TTL_SECONDS: 90 * 24 * 60 * 60,
  // Minimum gap between sends. Both the periodic check and admin-triggered
  // sends honour this — pass `skipAlreadySentCheck` to forceSend() only
  // when an internal caller explicitly needs to override it.
  MIN_INTERVAL_DAYS: 7,
} as const;

// Daily work report settings
export const WORK_REPORT = {
  // Work report: weekdays at 9am (Europe/London timezone)
  REPORT_HOUR: 9,
  // Check interval: every 30 minutes
  CHECK_INTERVAL_MS: 30 * 60 * 1000,
  // Distributed lock for work report generation
  LOCK_KEY: 'work-report:processing-lock',
  LOCK_TTL_SECONDS: 120,
  // Key to track last report date
  LAST_REPORT_KEY: 'work-report:last-send-date',
} as const;

// Redis backpressure thresholds
export const REDIS_BACKPRESSURE = {
  /** After this many consecutive failures, enter light backpressure */
  LIGHT_THRESHOLD: 3,
  /** After this many consecutive failures, enter moderate backpressure */
  MODERATE_THRESHOLD: 5,
  /** After this many consecutive failures, enter severe backpressure */
  SEVERE_THRESHOLD: 10,
  /** Time in ms to wait before attempting recovery */
  RECOVERY_WAIT_MS: 5000,
  /** Multiplier for backoff during backpressure */
  BACKOFF_MULTIPLIER: 2,
  /** Default cache TTL in seconds */
  DEFAULT_CACHE_TTL_SECONDS: 3600, // 1 hour
} as const;

// Email message processing
export const EMAIL_PROCESSING = {
  /** Redis ZSET key for processed messages */
  PROCESSED_MESSAGES_KEY: 'gmail:processedMessages',
  /** Redis key prefix for message locks */
  MESSAGE_LOCK_PREFIX: 'gmail:lock:message:',
  /** Redis key prefix for unmatched attempt tracking */
  UNMATCHED_ATTEMPT_PREFIX: 'gmail:unmatched:',
  /** Redis key prefix for first-failure Slack alert dedup */
  PROCESSING_ALERT_DEDUP_PREFIX: 'gmail:processingAlertDedup:',
  /** Days to keep processed message IDs */
  PROCESSED_MESSAGE_TTL_DAYS: 30,
  /** Max attempts to match a message before giving up */
  MAX_UNMATCHED_ATTEMPTS: 3,
  /** Max attempts to process a message (post-match) before giving up to prevent infinite scanner loops */
  MAX_PROCESSING_FAILURES: 3,
  /** TTL for unmatched attempt tracking (seconds) */
  UNMATCHED_ATTEMPT_TTL_SECONDS: 3600,
  /** TTL for first-failure alert dedup (seconds) — prevents alert spam from hourly scans */
  PROCESSING_ALERT_DEDUP_TTL_SECONDS: 60 * 60,
  /** Only run cleanup every N messages */
  CLEANUP_INTERVAL_MESSAGES: 100,
  /** Redis key for atomic cleanup counter */
  CLEANUP_COUNTER_KEY: 'gmail:cleanupCounter',
} as const;

// Post-booking follow-up processing
export const POST_BOOKING_PROCESSING = {
  /** Batch size for processing to prevent memory issues */
  BATCH_SIZE: 50,
  /** Maximum parse attempts before giving up on a datetime string */
  MAX_PARSE_ATTEMPTS: 3,
  /** Reset parse failure tracking after this period (ms) */
  PARSE_FAILURE_RESET_MS: 60 * 60 * 1000, // 1 hour
  /** Force retry of all failures after this period (ms) */
  DAILY_REPARSE_MS: 24 * 60 * 60 * 1000, // 24 hours
  /** Max tracked parse failures to prevent unbounded memory growth */
  MAX_PARSE_FAILURES: 500,
} as const;

// Stale check service intervals
export const STALE_CHECK_INTERVALS = {
  /** How often to run stale checks (ms) */
  CHECK_INTERVAL_MS: 60 * 60 * 1000, // 1 hour
  /** How often to run retention cleanup (ms) */
  RETENTION_CHECK_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24 hours
} as const;

// Slack notification operational constants
export const SLACK_OPERATIONAL = {
  /** Redis key for persisted notification queue */
  QUEUE_KEY: 'slack:notification:queue',
  /** TTL for queued notifications (seconds) */
  QUEUE_TTL_SECONDS: 86400, // 24 hours
  /** Suppress identical alerts within this window (seconds) */
  NOTIFICATION_DEDUP_TTL_SECONDS: 120,
  /** Suppress same notification type per appointment (seconds) */
  APPOINTMENT_DEDUP_TTL_SECONDS: 86400, // 24 hours
  /** Max queued notifications in memory */
  MAX_QUEUE_SIZE: 100,
  /** Circuit breaker config for Slack webhooks */
  CIRCUIT_BREAKER: {
    name: 'slack-webhook',
    failureThreshold: 5,
    resetTimeout: 30000, // 30 seconds
    successThreshold: 2,
    failureWindow: 60000, // 1 minute
  },
} as const;

// Tool execution idempotency
export const TOOL_EXECUTION = {
  /** Redis key prefix for tool execution tracking */
  PREFIX: 'tool:executed:',
  /** TTL for idempotency keys (seconds) */
  TTL_SECONDS: 3600, // 1 hour
  /** Redis key prefix for per-appointment tool-call count */
  COUNT_PREFIX: 'tool:count:',
  /** TTL for per-appointment counters (seconds): 30 days. Long enough to
   *  cover an appointment's full lifecycle (creation → confirmation →
   *  session → feedback) without piling up keys for archived ones. */
  COUNT_TTL_SECONDS: 30 * 24 * 60 * 60,
  /** Hard ceiling on tool calls per appointment. The per-turn cap
   *  (TURN_TOOL_BUDGET = 12 state-changing calls) bounds runaway loops
   *  within one inbound email; this ceiling bounds total agent activity
   *  across an entire appointment, so a prompt-injecting back-and-forth
   *  can't keep driving the agent indefinitely. When exceeded we flip
   *  the appointment into human control and Slack-alert. */
  PER_APPOINTMENT_LIMIT: 50,
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

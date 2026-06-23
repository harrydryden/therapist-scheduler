/**
 * Slack Notification Service
 *
 * Sends real-time notifications to Slack via incoming webhooks for:
 * - Auto-escalation (72h stall → human control)
 * - Thread divergence alerts
 * - Email bounce detection
 * - Conversation stalls needing attention
 * - Daily/weekly summaries
 *
 * Setup:
 * 1. Create a Slack app at https://api.slack.com/apps
 * 2. Enable "Incoming Webhooks"
 * 3. Add webhook to your desired channel
 * 4. Set SLACK_WEBHOOK_URL env var
 *
 * Optional: Set SLACK_WEBHOOK_URL_URGENT for critical alerts to a different channel
 */

import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import { circuitBreakerRegistry, CircuitBreakerError } from '../utils/circuit-breaker';
import { DEFAULT_TIMEOUTS } from '../utils/timeout';
import { cacheManager } from '../utils/redis';
import { SLACK_OPERATIONAL } from '../constants';
import { firstName } from '../utils/first-name';

// Operational constants — imported from centralized constants
const SLACK_QUEUE_KEY = SLACK_OPERATIONAL.QUEUE_KEY;
const SLACK_QUEUE_TTL = SLACK_OPERATIONAL.QUEUE_TTL_SECONDS;
const NOTIFICATION_DEDUP_TTL_SECONDS = SLACK_OPERATIONAL.NOTIFICATION_DEDUP_TTL_SECONDS;
const APPOINTMENT_DEDUP_TTL_SECONDS = SLACK_OPERATIONAL.APPOINTMENT_DEDUP_TTL_SECONDS;
const MAX_QUEUE_SIZE = SLACK_OPERATIONAL.MAX_QUEUE_SIZE;

// Get or create the Slack circuit breaker
const slackCircuitBreaker = circuitBreakerRegistry.getOrCreate(SLACK_OPERATIONAL.CIRCUIT_BREAKER);

// Notification queue for retry (in-memory for simplicity, could be Redis for persistence)
interface QueuedNotification {
  message: SlackMessage;
  useUrgentChannel: boolean;
  queuedAt: Date;
  attempts: number;
}
const notificationQueue: QueuedNotification[] = [];

// Slack Block Kit types for rich message formatting
interface SlackTextBlock {
  type: 'section' | 'header' | 'divider' | 'context';
  text?: {
    type: 'mrkdwn' | 'plain_text';
    text: string;
    emoji?: boolean;
  };
  fields?: Array<{
    type: 'mrkdwn' | 'plain_text';
    text: string;
  }>;
  elements?: Array<{
    type: 'mrkdwn' | 'plain_text';
    text: string;
  }>;
}

interface SlackMessage {
  text: string; // Fallback text for notifications
  blocks?: SlackTextBlock[];
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface SlackAlertOptions {
  title: string;
  severity: AlertSeverity;
  appointmentId?: string;
  therapistName?: string;
  details: string;
  additionalFields?: Record<string, string>;
  emoji?: string; // Override default severity emoji
  fallbackSuffix?: string; // Extra text appended to the plain-text fallback (push notifications)
  /**
   * Optional logical grouping for the 24h appointment-scoped dedup.
   *
   * Different alerts that describe the SAME root cause (e.g. "Human Review
   * Requested" from the agent + "Auto-Escalation Triggered" from the
   * stale-check service — both fire when an appointment flips to human
   * control) have different titles and slip through title-based dedup.
   * Setting the same `dedupGroup` on related alerts collapses them to one
   * notification per appointment per 24h window.
   *
   * When omitted, dedup keys on the title (legacy behaviour).
   */
  dedupGroup?: string;
}

// Emoji mapping for severity
const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  low: 'ℹ️',
  medium: '⚠️',
  high: '🔶',
  critical: '🚨',
};

/**
 * Escape user-provided text for safe inclusion in Slack mrkdwn blocks.
 * Prevents accidental formatting from *, _, ~, `, and entity confusion from &, <, >.
 */
function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\u200B$1');
}

class SlackNotificationService {
  private webhookUrl: string | null = null;
  private webhookUrlUrgent: string | null = null;
  private adminDashboardBaseUrl: string = 'https://free.spill.app/admin';
  private enabled: boolean = false;

  constructor() {
    this.webhookUrl = process.env.SLACK_WEBHOOK_URL || null;
    this.webhookUrlUrgent = process.env.SLACK_WEBHOOK_URL_URGENT || null;
    this.adminDashboardBaseUrl = process.env.ADMIN_DASHBOARD_URL || 'https://free.spill.app/admin';
    this.enabled = !!this.webhookUrl;

    if (this.enabled) {
      logger.info('Slack notification service initialized');
    } else {
      logger.info('Slack notifications disabled (SLACK_WEBHOOK_URL not set)');
    }
  }

  /**
   * Check if Slack notifications are enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Queue a notification for retry (persisted to Redis)
   */
  private async queueForRetry(message: SlackMessage, useUrgentChannel: boolean): Promise<void> {
    // Also keep in memory for immediate retry attempts
    if (notificationQueue.length >= MAX_QUEUE_SIZE) {
      notificationQueue.shift();
      logger.warn('Slack notification in-memory queue full - dropping oldest item');
    }
    notificationQueue.push({
      message,
      useUrgentChannel,
      queuedAt: new Date(),
      attempts: 0,
    });

    // Persist to Redis for crash recovery
    try {
      const queueItem = {
        message,
        useUrgentChannel,
        queuedAt: new Date().toISOString(),
        attempts: 0,
      };

      // Get existing queue
      const existing = await cacheManager.getJson<typeof queueItem[]>(SLACK_QUEUE_KEY) || [];

      // Trim if too large
      while (existing.length >= MAX_QUEUE_SIZE) {
        existing.shift();
      }

      existing.push(queueItem);
      await cacheManager.setJson(SLACK_QUEUE_KEY, existing, SLACK_QUEUE_TTL);

      logger.info(
        { queueLength: existing.length, inMemoryLength: notificationQueue.length },
        'Slack notification queued for retry (persisted to Redis)'
      );
    } catch (err) {
      // Redis failure shouldn't prevent in-memory queue from working
      logger.warn({ err }, 'Failed to persist Slack notification to Redis - will retry from memory');
    }
  }

  /**
   * Load queued notifications from Redis on startup
   */
  async loadPersistedQueue(): Promise<number> {
    try {
      const persisted = await cacheManager.getJson<QueuedNotification[]>(SLACK_QUEUE_KEY);
      if (persisted && persisted.length > 0) {
        // Restore to in-memory queue, dropping stale items that are older than
        // the appointment-scoped dedup window. Sending day-old notifications
        // after a restart causes confusing duplicates.
        const maxAgeMs = APPOINTMENT_DEDUP_TTL_SECONDS * 1000;
        let dropped = 0;
        for (const item of persisted) {
          const age = Date.now() - new Date(item.queuedAt).getTime();
          if (age > maxAgeMs) {
            dropped++;
            continue;
          }
          if (notificationQueue.length < MAX_QUEUE_SIZE) {
            notificationQueue.push({
              ...item,
              queuedAt: new Date(item.queuedAt),
            });
          }
        }
        if (dropped > 0) {
          logger.info({ dropped }, 'Dropped stale Slack notifications from persisted queue (older than 24h)');
        }

        // Clear Redis queue after loading to prevent duplicate loading on rapid restarts
        try {
          await cacheManager.delete(SLACK_QUEUE_KEY);
        } catch {
          // Non-fatal — queue will be overwritten on next processQueue sync
        }

        logger.info({ count: persisted.length }, 'Loaded persisted Slack notifications from Redis');
        return persisted.length;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load persisted Slack notifications from Redis');
    }
    return 0;
  }

  /**
   * Process queued notifications (call periodically or on circuit close)
   */
  async processQueue(): Promise<{ processed: number; failed: number }> {
    if (notificationQueue.length === 0) {
      return { processed: 0, failed: 0 };
    }

    // Don't process if circuit is open
    if (slackCircuitBreaker.isOpen()) {
      logger.debug('Skipping queue processing - circuit is open');
      return { processed: 0, failed: 0 };
    }

    let processed = 0;
    let failed = 0;
    const maxRetries = 3;

    // Process up to 10 items per batch
    const batch = notificationQueue.splice(0, 10);

    for (const item of batch) {
      if (item.attempts >= maxRetries) {
        logger.error(
          {
            attempts: item.attempts,
            message: item.message.text?.substring(0, 200),
            queuedAt: item.queuedAt,
            ageSeconds: Math.round((Date.now() - item.queuedAt.getTime()) / 1000),
          },
          'Permanently dropping Slack notification after max retries — message lost'
        );
        failed++;
        continue;
      }

      try {
        const success = await this.sendToSlackDirect(item.message, item.useUrgentChannel);
        if (success) {
          processed++;
        } else {
          // Put back in queue with incremented attempts
          item.attempts++;
          notificationQueue.push(item);
          failed++;
        }
      } catch (err) {
        item.attempts++;
        notificationQueue.push(item);
        failed++;
      }
    }

    // Update Redis queue
    if (processed > 0 || failed > 0) {
      try {
        await cacheManager.setJson(SLACK_QUEUE_KEY, notificationQueue, SLACK_QUEUE_TTL);
      } catch (err) {
        // Non-fatal
        logger.warn({ err }, 'Failed to update Redis Slack queue');
      }
    }

    if (processed > 0 || failed > 0) {
      logger.info({ processed, failed, remaining: notificationQueue.length }, 'Processed Slack notification queue');
    }

    return { processed, failed };
  }

  /**
   * Get queue stats for monitoring
   */
  getQueueStats(): { inMemory: number; oldestAge?: number } {
    const oldest = notificationQueue[0];
    return {
      inMemory: notificationQueue.length,
      oldestAge: oldest ? Math.floor((Date.now() - oldest.queuedAt.getTime()) / 1000) : undefined,
    };
  }

  /**
   * Get circuit breaker stats for health checks
   */
  getCircuitStats() {
    return slackCircuitBreaker.getStats();
  }

  /**
   * Reset the circuit breaker to closed state (admin action)
   */
  resetCircuit(): void {
    slackCircuitBreaker.reset();
  }

  /**
   * Direct send without queuing (used by queue processor)
   */
  private async sendToSlackDirect(message: SlackMessage, useUrgentChannel: boolean): Promise<boolean> {
    const url = useUrgentChannel && this.webhookUrlUrgent
      ? this.webhookUrlUrgent
      : this.webhookUrl;

    if (!url) {
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUTS.EXTERNAL_API);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * Send a raw message to Slack (with circuit breaker protection)
   */
  private async sendToSlack(message: SlackMessage, useUrgentChannel: boolean = false): Promise<boolean> {
    const url = useUrgentChannel && this.webhookUrlUrgent
      ? this.webhookUrlUrgent
      : this.webhookUrl;

    if (!url) {
      logger.debug('Slack notification skipped - webhook URL not configured');
      return false;
    }

    try {
      // Use circuit breaker to protect against Slack outages
      const result = await slackCircuitBreaker.execute(async () => {
        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUTS.EXTERNAL_API);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
            signal: controller.signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Slack API error: ${response.status} - ${errorText}`);
          }

          return true;
        } finally {
          clearTimeout(timeoutId);
        }
      });

      logger.debug('Slack notification sent successfully');
      return result;
    } catch (error) {
      // Handle circuit breaker open state - queue for retry
      if (error instanceof CircuitBreakerError) {
        logger.warn('Slack circuit open - queueing notification for retry');
        this.queueForRetry(message, useUrgentChannel);
        return false;
      }

      logger.error({ error }, 'Error sending Slack notification');
      // Queue for retry on other errors too
      this.queueForRetry(message, useUrgentChannel);
      return false;
    }
  }

  /**
   * Build appointment link for admin dashboard
   */
  private getAppointmentLink(appointmentId: string): string {
    return `${this.adminDashboardBaseUrl}/dashboard?appointment=${encodeURIComponent(appointmentId)}`;
  }

  /**
   * Check whether an identical alert was recently sent and, if not, mark it as sent.
   * Returns true when this is a duplicate that should be suppressed.
   *
   * Two layers of deduplication:
   *
   * 1. **Exact-match (120s)**: SHA-256 of title + appointmentId + details.
   *    Catches race conditions from Pub/Sub re-delivery, push+poll overlap,
   *    and queue retry after a Slack timeout where the message was delivered.
   *
   * 2. **Appointment-scoped (24h)**: Keyed on title + appointmentId only,
   *    ignoring details. Prevents the same notification *type* from firing
   *    more than once per day per appointment — e.g. repeated OOO auto-replies
   *    from the same therapist, or the AI re-flagging human review on each
   *    email processing cycle. Only applies when appointmentId is present.
   */
  private async isDuplicateAlert(options: SlackAlertOptions): Promise<boolean> {
    try {
      // Layer 1: Exact-match dedup (short TTL, catches race conditions)
      const raw = `${options.title}|${options.appointmentId || ''}|${options.details}`;
      const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
      const key = `slack:dedup:${hash}`;

      // SET NX returns 'OK' only when the key didn't exist
      const result = await cacheManager.setNX(key, '1', NOTIFICATION_DEDUP_TTL_SECONDS);
      if (result === 'EXISTS') {
        logger.info(
          { title: options.title, appointmentId: options.appointmentId },
          'Suppressed duplicate Slack notification (exact match)'
        );
        return true;
      }

      // Layer 2: Appointment-scoped dedup (24h TTL, catches re-triggered events).
      // Only applies when an appointmentId is present — global notifications
      // (e.g. weekly summaries, unmatched emails) are not appointment-scoped.
      //
      // Keys on `dedupGroup` when supplied, falling back to `title`. Using a
      // shared dedupGroup across alerts that describe the same root cause
      // (e.g. agent-flag + auto-escalation) collapses them to one alert per
      // appointment per 24h, preventing the alert-storm pattern called out
      // by the operability audit.
      if (options.appointmentId) {
        const scopedRaw = `${options.dedupGroup || options.title}|${options.appointmentId}`;
        const scopedHash = createHash('sha256').update(scopedRaw).digest('hex').slice(0, 16);
        const scopedKey = `slack:dedup:apt:${scopedHash}`;

        const scopedResult = await cacheManager.setNX(scopedKey, '1', APPOINTMENT_DEDUP_TTL_SECONDS);
        if (scopedResult === 'EXISTS') {
          logger.info(
            {
              title: options.title,
              dedupGroup: options.dedupGroup,
              appointmentId: options.appointmentId,
            },
            'Suppressed duplicate Slack notification (appointment-scoped, 24h window)'
          );
          return true;
        }
      }

      return false;
    } catch (err) {
      // Redis failure should never block a real notification
      logger.warn({ err }, 'Notification dedup check failed - allowing through');
      return false;
    }
  }

  /**
   * Send a generic alert notification
   */
  async sendAlert(options: SlackAlertOptions): Promise<boolean> {
    const {
      title,
      severity,
      appointmentId,
      therapistName,
      details,
      additionalFields,
      emoji: customEmoji,
      fallbackSuffix,
    } = options;

    // Deduplicate: suppress if an identical alert was sent recently
    if (await this.isDuplicateAlert(options)) {
      return true; // Treat as "sent" to avoid upstream retry
    }

    const emoji = customEmoji || SEVERITY_EMOJI[severity];
    const useUrgent = severity === 'critical' || severity === 'high';

    // Slack section text has a 3000-character limit.
    // Reserve space for the header line and therapist, then distribute the rest.
    const SLACK_SECTION_TEXT_LIMIT = 3000;
    const MAX_FIELD_VALUE_LENGTH = 200;

    // Build compact message with inline fields
    let messageText = details;

    // Add therapist inline if available (escaped for safety even though
    // therapist names are admin-set, as defense-in-depth).
    if (therapistName) {
      messageText += `\n*Therapist:* ${escapeSlackMrkdwn(therapistName)}`;
    }

    // Add additional fields inline, truncating long values to stay within Slack limits.
    // Cap the number of fields to keep the message scannable.
    const MAX_INLINE_FIELDS = 10;
    if (additionalFields && Object.keys(additionalFields).length > 0) {
      const entries = Object.entries(additionalFields);
      const shown = entries.slice(0, MAX_INLINE_FIELDS);
      for (const [key, value] of shown) {
        const truncated = value.length > MAX_FIELD_VALUE_LENGTH
          ? value.substring(0, MAX_FIELD_VALUE_LENGTH) + '...'
          : value;
        messageText += `\n*${escapeSlackMrkdwn(key)}:* ${escapeSlackMrkdwn(truncated)}`;
      }
      if (entries.length > MAX_INLINE_FIELDS) {
        messageText += `\n_…and ${entries.length - MAX_INLINE_FIELDS} more_`;
      }
    }

    // Final safety check: truncate at the last complete line boundary to avoid
    // slicing through a key-value pair, which would produce garbled mrkdwn.
    const headerLine = `${emoji} *${title}*\n`;
    const maxBodyLength = SLACK_SECTION_TEXT_LIMIT - headerLine.length;
    if (messageText.length > maxBodyLength) {
      const truncated = messageText.substring(0, maxBodyLength - 20);
      const lastNewline = truncated.lastIndexOf('\n');
      messageText = lastNewline > 0
        ? truncated.substring(0, lastNewline) + '\n_…message truncated_'
        : truncated + '…';
    }

    // Build compact blocks
    const blocks: SlackTextBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${headerLine}${messageText}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${severity.toUpperCase()} | ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })} | ${appointmentId ? `<${this.getAppointmentLink(appointmentId)}|View> | ` : ''}<${this.adminDashboardBaseUrl}/dashboard|Dashboard>`,
          },
        ],
      },
    ];

    // The `text` field is used by Slack as the fallback for push notifications
    // and email digests where Block Kit isn't rendered. Include the suffix so
    // key data (e.g. feedback scores) is visible even outside the Slack app.
    const fallbackText = `${emoji} ${title}: ${details}${fallbackSuffix || ''}`;

    const message: SlackMessage = {
      text: fallbackText.length > 3000 ? fallbackText.substring(0, 2997) + '...' : fallbackText,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    };

    return this.sendToSlack(message, useUrgent);
  }

  // ============================================
  // Specific Alert Types
  // ============================================

  /**
   * Alert when auto-escalation triggers (72h stall → human control).
   *
   * Shares the `human-control` dedup group with notifyHumanReviewFlagged
   * so an appointment that gets escalated by the system AND then flagged
   * by the agent (or vice versa) only produces one alert per 24h window
   * — both events describe the same root cause from the admin's POV.
   */
  async notifyAutoEscalation(params: {
    appointmentId: string;
    therapistName: string;
    stallDurationHours: number;
  }): Promise<boolean> {
    return this.sendAlert({
      title: 'Auto-Escalation Triggered',
      severity: 'high',
      appointmentId: params.appointmentId,
      therapistName: params.therapistName,
      details: `Conversation stalled for *${Math.round(params.stallDurationHours)}h*. Human control enabled.`,
      dedupGroup: 'human-control',
    });
  }

  /**
   * Alert for thread divergence on first detection (crossed wires, CC issues).
   * Fires once per blocked message — see `notifyDivergenceAbandoned` for the
   * terminal alert when retries exhaust.
   */
  async notifyThreadDivergence(params: {
    appointmentId: string;
    therapistName: string;
    divergenceType: string;
    description: string;
  }): Promise<boolean> {
    return this.sendAlert({
      title: 'Thread Divergence',
      severity: 'high',
      appointmentId: params.appointmentId,
      therapistName: params.therapistName,
      details: params.description,
      additionalFields: {
        'Type': params.divergenceType,
      },
    });
  }

  /**
   * Alert when a divergence-blocked message is permanently abandoned after
   * exhausting MAX_PROCESSING_FAILURES retries. Surfaces the terminal state
   * so admins see "this message is gone now" rather than only the first-
   * attempt alert and silence after.
   */
  async notifyDivergenceAbandoned(params: {
    appointmentId: string;
    therapistName: string;
    divergenceType: string;
    attempts: number;
    from: string;
    subject: string;
  }): Promise<boolean> {
    // PII discipline mirrors notifyUnmatchedEmailAbandoned: the subject is
    // kept so admins can locate the message in Gmail, the sender's email is
    // dropped from Slack (admins pivot via the appointment link).
    void params.from;
    return this.sendAlert({
      title: 'Divergence-Blocked Message Abandoned',
      severity: 'critical',
      appointmentId: params.appointmentId,
      therapistName: params.therapistName,
      details:
        `An inbound email was blocked by thread divergence and has been ` +
        `abandoned after *${params.attempts}* retries. The reply will not be ` +
        `processed automatically — manual review needed.`,
      additionalFields: {
        'Type': params.divergenceType,
        'Subject': params.subject.slice(0, 100),
      },
    });
  }

  /**
   * Alert for email bounce
   */
  async notifyEmailBounce(params: {
    appointmentId: string;
    userName: string | null;
    therapistName: string;
    bouncedRole: 'client' | 'therapist';
    bounceReason: string;
  }): Promise<boolean> {
    // PII discipline: don't include the bounced email address in Slack.
    // Admins use the appointmentId link to view the full record. We
    // surface only the role so they know whether the client or
    // therapist email failed.
    const recipientLabel =
      params.bouncedRole === 'therapist'
        ? `Therapist (${params.therapistName})`
        : `Client (${firstName(params.userName, 'unknown')})`;
    return this.sendAlert({
      title: 'Email Bounce',
      severity: 'critical',
      appointmentId: params.appointmentId,
      therapistName: params.therapistName,
      details: `Email to *${recipientLabel}* bounced.`,
      additionalFields: {
        'Reason': params.bounceReason,
      },
    });
  }

  /**
   * Alert for conversation stall (activity but no progress)
   */
  async notifyConversationStall(params: {
    appointmentId: string;
    therapistName: string;
    stallDurationHours: number;
    lastToolFailure?: string;
  }): Promise<boolean> {
    const additionalFields: Record<string, string> = {};
    if (params.lastToolFailure) {
      additionalFields['Last Failure'] = params.lastToolFailure;
    }

    return this.sendAlert({
      title: 'Conversation Stalled',
      severity: 'medium',
      appointmentId: params.appointmentId,
      therapistName: params.therapistName,
      details: `No progress for *${Math.round(params.stallDurationHours)}h*.`,
      additionalFields: Object.keys(additionalFields).length > 0 ? additionalFields : undefined,
    });
  }

  /**
   * Alert when human review is flagged by the agent.
   *
   * Shares the `human-control` dedup group with notifyAutoEscalation —
   * see that method's comment for the rationale.
   */
  async notifyHumanReviewFlagged(params: {
    appointmentId: string;
    therapistName: string;
    reason: string;
  }): Promise<boolean> {
    return this.sendAlert({
      title: 'Human Review Requested',
      severity: 'high',
      appointmentId: params.appointmentId,
      therapistName: params.therapistName,
      details: `AI flagged for review: ${params.reason}`,
      dedupGroup: 'human-control',
    });
  }

  // ============================================
  // Appointment Lifecycle Notifications
  // ============================================

  /**
   * Notify when a new appointment is created
   */
  async notifyAppointmentCreated(params: {
    appointmentId: string;
    therapistName: string;
  }): Promise<boolean> {
    return this.sendAlert({
      title: 'Appointment Request',
      severity: 'low',
      appointmentId: params.appointmentId,
      therapistName: params.therapistName,
      details: `New scheduling request created.`,
    });
  }

  /**
   * Notify when an appointment is confirmed
   */
  async notifyAppointmentConfirmed(params: {
    appointmentId: string;
    therapistName: string;
    confirmedDateTime: string;
  }): Promise<boolean> {
    return this.sendAlert({
      title: 'Appointment Confirmed',
      severity: 'low',
      appointmentId: params.appointmentId,
      therapistName: params.therapistName,
      details: `Booked for ${params.confirmedDateTime}.`,
      emoji: '🤝',
    });
  }

  /**
   * Notify when an appointment is cancelled
   */
  async notifyAppointmentCancelled(params: {
    appointmentId: string;
    therapistName: string;
    reason: string;
    cancelledBy?: string;
  }): Promise<boolean> {
    const details = params.cancelledBy
      ? `Cancelled by ${params.cancelledBy}. Reason: ${params.reason}`
      : `Reason: ${params.reason}`;

    return this.sendAlert({
      title: 'Appointment Cancelled',
      severity: 'medium',
      appointmentId: params.appointmentId,
      therapistName: params.therapistName,
      details,
      emoji: '❌',
    });
  }

  /**
   * Notify when an appointment is completed (feedback received).
   *
   * Feedback answers are shown as an abridged inline summary beneath a
   * "Feedback" header. The full responses are always accessible via the
   * admin forms dashboard link.
   */
  async notifyAppointmentCompleted(params: {
    appointmentId: string;
    therapistName: string;
    feedbackSubmissionId?: string;
    feedbackData?: Record<string, string>;
  }): Promise<boolean> {
    const formsUrl = `${this.adminDashboardBaseUrl}/forms`;

    let details = params.feedbackSubmissionId
      ? `Session completed, feedback received. <${formsUrl}|View Feedback>`
      : 'Session completed.';

    // Place therapist in the details block so it renders above the
    // feedback header — sendAlert would otherwise append it *after*
    // the "📋 Feedback:" line, making it look like a feedback answer.
    details += `\n*Therapist:* ${escapeSlackMrkdwn(params.therapistName)}`;

    const hasFeedback = params.feedbackData && Object.keys(params.feedbackData).length > 0;

    // Add a visual separator before feedback answers so they don't
    // blend into the appointment details line.
    if (hasFeedback) {
      details += '\n\n📋 *Feedback:*';
    }

    // Build a compact fallback that includes key feedback values so
    // push notifications and email digests are still informative.
    let fallbackSuffix = '';
    if (hasFeedback) {
      const summaryParts = Object.entries(params.feedbackData!)
        .slice(0, 4)
        .map(([k, v]) => {
          const shortKey = k.length > 25 ? k.slice(0, 22) + '...' : k;
          const shortVal = v.length > 30 ? v.slice(0, 27) + '...' : v;
          return `${shortKey}: ${shortVal}`;
        });
      fallbackSuffix = ` | ${summaryParts.join(' | ')}`;
    }

    // therapistName intentionally omitted — already embedded in details
    // above so it renders before the feedback section, not inside it.
    return this.sendAlert({
      title: 'Appointment Completed',
      severity: 'low',
      appointmentId: params.appointmentId,
      details,
      emoji: '✅',
      additionalFields: hasFeedback ? params.feedbackData : undefined,
      fallbackSuffix,
    });
  }

  /**
   * Alert when the agent recommends cancelling a match because the user
   * has declined the therapist (e.g. due to availability).  This frees
   * the counsellor for other users.
   */
  async notifyCancelMatchRecommended(params: {
    appointmentId: string;
    userName: string | null;
    therapistName: string;
    reason: string;
  }): Promise<boolean> {
    // PII discipline: first name only for the user; appointmentId in the
    // alert metadata gives admins a click-through to the full record.
    const userLabel = firstName(params.userName, 'The client');
    return this.sendAlert({
      title: 'Cancel Match Recommended',
      severity: 'high',
      appointmentId: params.appointmentId,
      therapistName: params.therapistName,
      details: `*${userLabel}* has declined this therapist. Recommend cancelling the match so the counsellor is available to others.`,
      additionalFields: {
        'Reason': params.reason,
        'Action needed': 'Review and cancel match via dashboard',
      },
      emoji: '🔄',
    });
  }

  /**
   * Alert when an incoming email could not be matched to any appointment
   * after max retries. This means a therapist or client reply was silently dropped.
   */
  async notifyUnmatchedEmailAbandoned(params: {
    messageId: string;
    from: string;
    subject: string;
    attempts: number;
  }): Promise<boolean> {
    // PII discipline: don't echo the sender's email. Subject is kept
    // because it's needed for admins to find the message in Gmail; the
    // Message ID lets ops correlate with logs. The subject may itself
    // contain the user's name, but we trust admins to handle it once
    // they pivot from this alert into Gmail; the Slack channel itself
    // shouldn't be the leak point.
    void params.from;
    return this.sendAlert({
      title: 'Unmatched Email Dropped',
      severity: 'high',
      details: `Incoming email could not be matched to any appointment after *${params.attempts}* attempts and was abandoned. Manual review needed.`,
      additionalFields: {
        'Subject': params.subject.slice(0, 100),
        'Message ID': params.messageId,
      },
    });
  }

  /**
   * Alert when an unmatched therapist has reached the nudge ceiling
   * (THERAPIST_NUDGE.MAX_NUDGES) without ever being matched to a client.
   *
   * Fires once — the nudge service stops emailing this therapist after
   * the cap, so the admin needs to decide what happens next (source a
   * client manually, pause them, or reach out personally) rather than the
   * system silently re-nudging forever.
   */
  async notifyTherapistNudgeExhausted(params: {
    therapistName: string;
    nudgeCount: number;
  }): Promise<boolean> {
    return this.sendAlert({
      title: 'Therapist Nudge Limit Reached',
      severity: 'medium',
      therapistName: params.therapistName,
      details:
        `This therapist has now received *${params.nudgeCount}* "still looking for a client" ` +
        `nudges without being matched. Automatic nudging has stopped — please decide whether to ` +
        `source a client for them, pause them, or follow up personally.`,
    });
  }

  // ============================================
  // Summary Reports
  // ============================================

  /**
   * Send a weekly summary of appointments (Monday 9am)
   */
  async sendWeeklySummary(stats: {
    totalActive: number;
    pending: number;
    contacted: number;
    negotiating: number;
    confirmed: number;
    stalled: number;
    needingAttention: number;
    completedThisWeek: number;
    cancelledThisWeek: number;
  }): Promise<boolean> {
    // Build compact summary text
    let summaryText = `📊 *Weekly Summary*\n`;
    summaryText += `Active: *${stats.totalActive}* | Completed: *${stats.completedThisWeek}* | Cancelled: *${stats.cancelledThisWeek}*\n`;
    summaryText += `Pending: ${stats.pending} | Contacted: ${stats.contacted} | Negotiating: ${stats.negotiating} | Confirmed: ${stats.confirmed}`;

    if (stats.stalled > 0 || stats.needingAttention > 0) {
      summaryText += `\n⚠️ *${stats.needingAttention} need attention* (${stats.stalled} stalled)`;
    }

    const blocks: SlackTextBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: summaryText,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })} | <${this.adminDashboardBaseUrl}/dashboard|Dashboard>`,
          },
        ],
      },
    ];

    return this.sendToSlack({
      text: `📊 Weekly Summary: ${stats.totalActive} active, ${stats.completedThisWeek} completed`,
      blocks,
    });
  }

  /**
   * Send a daily work report summary
   */
  async sendWorkReport(stats: {
    periodStart: Date;
    periodEnd: Date;
    emailsSent: number;
    emailsReceived: number;
    appointmentsCreated: number;
    appointmentsConfirmed: number;
    appointmentsCompleted: number;
    appointmentsCancelled: number;
    staleConversationsFlagged: number;
    humanControlTakeovers: number;
    chaseFollowUpsSent: number;
    closureRecommendations: number;
    pipelinePending: number;
    pipelineContacted: number;
    pipelineNegotiating: number;
    pipelineConfirmed: number;
    feedbackSubmissions: number;
    synopsis?: string | null;
  }): Promise<boolean> {
    const ukOptions: Intl.DateTimeFormatOptions = {
      timeZone: 'Europe/London',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    };
    const periodLabel = `${stats.periodStart.toLocaleString('en-GB', ukOptions)} — ${stats.periodEnd.toLocaleString('en-GB', ukOptions)}`;

    const totalPipeline = stats.pipelinePending + stats.pipelineContacted + stats.pipelineNegotiating + stats.pipelineConfirmed;

    let reportText = `📋 *Daily Report* · _${periodLabel}_\n`;
    reportText += `📨 Sent *${stats.emailsSent}* · Recv *${stats.emailsReceived}* | 📅 New *${stats.appointmentsCreated}* · Conf *${stats.appointmentsConfirmed}* · Done *${stats.appointmentsCompleted}* · Canc *${stats.appointmentsCancelled}*\n`;
    reportText += `📊 *${totalPipeline} active* — ${stats.pipelinePending} pending · ${stats.pipelineContacted} contacted · ${stats.pipelineNegotiating} negotiating · ${stats.pipelineConfirmed} confirmed`;

    // Alerts (only show if there are any)
    const alertParts: string[] = [];
    if (stats.staleConversationsFlagged > 0) alertParts.push(`${stats.staleConversationsFlagged} stale`);
    if (stats.humanControlTakeovers > 0) alertParts.push(`${stats.humanControlTakeovers} takeover`);
    if (stats.chaseFollowUpsSent > 0) alertParts.push(`${stats.chaseFollowUpsSent} chased`);
    if (stats.closureRecommendations > 0) alertParts.push(`${stats.closureRecommendations} closure rec`);
    if (alertParts.length > 0) {
      reportText += `\n⚠️ ${alertParts.join(' · ')}`;
    }

    if (stats.feedbackSubmissions > 0) {
      reportText += ` | 📝 ${stats.feedbackSubmissions} feedback`;
    }

    // Append synopsis inline if available
    if (stats.synopsis) {
      reportText += `\n\n🤖 ${stats.synopsis}`;
    }

    // Slack section text has a 3000-character limit
    const SLACK_SECTION_TEXT_LIMIT = 3000;
    if (reportText.length > SLACK_SECTION_TEXT_LIMIT) {
      const truncated = reportText.substring(0, SLACK_SECTION_TEXT_LIMIT - 20);
      const lastNewline = truncated.lastIndexOf('\n');
      reportText = lastNewline > 0
        ? truncated.substring(0, lastNewline) + '\n_…truncated_'
        : truncated + '…';
    }

    const blocks: SlackTextBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: reportText,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${this.adminDashboardBaseUrl}/work-reports|Reports> · <${this.adminDashboardBaseUrl}/dashboard|Dashboard>`,
          },
        ],
      },
    ];

    const fallbackText = `📋 Daily Report: ${stats.emailsSent} sent, ${stats.appointmentsConfirmed} confirmed, ${totalPipeline} active`;

    return this.sendToSlack({
      text: fallbackText.length > 3000 ? fallbackText.substring(0, 2997) + '...' : fallbackText,
      blocks,
    });
  }

  /**
   * Simple text notification (for quick alerts)
   */
  async sendSimpleMessage(text: string, urgent: boolean = false): Promise<boolean> {
    return this.sendToSlack({ text }, urgent);
  }

  /**
   * Notify admins that a signup invitation was accepted (a prospect we
   * invited has just completed signup and become a real user). Surfaces
   * the conversion in real time so admins don't have to refresh
   * /admin/invitations to see it.
   */
  async notifyInvitationAccepted(params: {
    invitationId: string;
    email: string;
    name: string | null;
    invitedBy: string;
  }): Promise<boolean> {
    // PII discipline: never put a user's email or full name in Slack.
    // First name is enough for admins to recognise the conversion; the
    // invitation ID lets them click through to /admin/invitations for
    // the rest of the detail. See utils/first-name.ts.
    return this.sendAlert({
      title: 'Signup Invitation Accepted',
      severity: 'low',
      details: `${firstName(params.name)} has completed signup via an invitation.`,
      additionalFields: {
        'Invitation ID': params.invitationId,
        'Invited by': params.invitedBy,
      },
    });
  }
}

// Singleton instance
export const slackNotificationService = new SlackNotificationService();

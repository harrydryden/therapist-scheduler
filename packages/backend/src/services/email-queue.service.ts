/**
 * BullMQ Email Queue Service
 *
 * Replaces the database-polled PendingEmail queue with a proper message queue
 * backed by Redis. Provides:
 * - Automatic retry with the same exponential backoff schedule (1m, 5m, 15m, 1h, 4h)
 * - Concurrency control (one email at a time to respect Gmail rate limits)
 * - Job deduplication
 *
 * The PendingEmail DB row is the source of truth. Every send — from this
 * worker or from the DB poller fallback — goes through
 * core/email/outbound/queue.ts's `attemptPendingEmailSend`, which claims
 * the row atomically (pending → sending) before sending, so the two
 * consumers can no longer both send the same row. The row's retryCount
 * decides retry vs abandonment; an abandoned email raises a deduped Slack
 * alert (registered below).
 */

import { createHash } from 'crypto';
import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { config } from '../config';
import { logger } from '../utils/logger';
import { prisma } from '../utils/database';
import { redis } from '../utils/redis';
import { EMAIL, PENDING_EMAIL_LOCK } from '../constants';
import { processPendingEmails } from '../core/email';
import {
  attemptPendingEmailSend,
  registerEmailAbandonedNotifier,
  retryDelayMs,
  type EmailAbandonedEvent,
} from '../core/email/outbound/queue';
import { slackNotificationService } from './slack-notification.service';
import { LockedPeriodicService } from '../utils/locked-periodic-service';
import type { LockedTaskContext } from '../utils/locked-task-runner';

/**
 * Slack alert for a permanently abandoned outbound email (#9). Deduped
 * per appointment for 24h under the 'email-abandoned' group, so an outage
 * that abandons a whole conversation's mail raises one alert, not one per
 * email. Exported for tests.
 */
export async function notifyEmailAbandoned(event: EmailAbandonedEvent): Promise<void> {
  await slackNotificationService.sendAlert({
    title: 'Outbound Email Abandoned',
    severity: 'high',
    appointmentId: event.appointmentId ?? undefined,
    dedupGroup: 'email-abandoned',
    details:
      `An outbound email could not be sent after *${event.attempts}* attempts and has been abandoned — ` +
      'the recipient has NOT received it. Check Gmail OAuth / send-quota health, then retry it from the ' +
      'admin queue view or follow up manually.\n\n' +
      `\`\`\`${event.errorMessage.slice(0, 500)}\`\`\``,
    additionalFields: {
      'Pending email ID': event.pendingEmailId,
      'Subject': event.subject.slice(0, 120),
    },
  });
}

registerEmailAbandonedNotifier(notifyEmailAbandoned);

const WAL_KEY = 'email:write-ahead-log'; // Write-ahead log for DB downtime
const WAL_ENTRY_TTL_SECONDS = 86400; // 24 hours

interface WalEntry {
  id?: string;
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  appointmentId?: string;
  createdAt?: string;
}

/** Parse a WAL entry; null if it is not JSON or lacks the fields a send needs. */
function parseWalEntry(entryStr: string): WalEntry | null {
  try {
    const parsed = JSON.parse(entryStr) as Partial<WalEntry> | null;
    if (
      !parsed ||
      typeof parsed.to !== 'string' ||
      typeof parsed.subject !== 'string' ||
      typeof parsed.body !== 'string'
    ) {
      return null;
    }
    return parsed as WalEntry;
  } catch {
    return null;
  }
}

/**
 * Deterministic PendingEmail id for a WAL entry (UUID-formatted SHA-256 of
 * the entry's own id, or of the raw entry for legacy entries without one).
 * Makes WAL recovery idempotent: recovering the same entry twice collides
 * on the primary key instead of creating a duplicate email.
 */
function walEntryPendingEmailId(entry: WalEntry, entryStr: string): string {
  const bytes = createHash('sha256')
    .update(`email-wal:${entry.id ?? entryStr}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version nibble (name-based)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Remove one occurrence of exactly this entry (LREM), wherever it now sits. */
async function removeWalEntry(entryStr: string): Promise<void> {
  await redis.eval("return redis.call('LREM', KEYS[1], 1, ARGV[1])", 1, WAL_KEY, entryStr);
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

// ============================================
// Types
// ============================================

export interface EmailJobData {
  /** PendingEmail row ID (for audit trail updates) */
  pendingEmailId: string;
  /** Recipient address */
  to: string;
  /** Email subject */
  subject: string;
  /** Email body (plain text) */
  body: string;
  /** Gmail thread ID for reply threading */
  threadId?: string;
  /** Related appointment ID (may be null for inquiry emails) */
  appointmentId?: string;
}

const QUEUE_NAME = 'email-send';


// ============================================
// Queue & Worker
// ============================================

interface EmailQueueStats {
  totalProcessed: number;
  totalSent: number;
  totalFailed: number;
  lastRunTime: Date | null;
  lastRunSent: number;
  lastRunFailed: number;
  lastQueueDepth: number;
  lastBatchSize: number;
}

class EmailQueueService {
  private queue: Queue<EmailJobData> | null = null;
  private worker: Worker<EmailJobData> | null = null;
  private queueEvents: QueueEvents | null = null;
  private started = false;

  /**
   * Initialize the BullMQ queue and worker.
   * Must be called after Redis is available.
   */
  async start(): Promise<void> {
    if (this.started) return;

    const connection = { url: config.redisUrl };

    // Create the queue
    this.queue = new Queue<EmailJobData>(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: EMAIL.MAX_RETRIES,
        backoff: { type: 'custom' },
        removeOnComplete: { count: 1000, age: 7 * 24 * 3600 }, // Keep last 1000 for 7 days
        removeOnFail: { count: 5000, age: 30 * 24 * 3600 },    // Keep failed for 30 days
      },
    });

    // Create the worker that processes email jobs
    this.worker = new Worker<EmailJobData>(
      QUEUE_NAME,
      async (job: Job<EmailJobData>) => {
        await this.processJob(job);
      },
      {
        connection,
        concurrency: 1, // One at a time to respect Gmail rate limits
        settings: {
          // Same schedule the DB poller uses (1m, 5m, 15m, 1h, 4h + jitter).
          backoffStrategy: (attemptsMade: number) => retryDelayMs(attemptsMade),
        },
      }
    );

    this.worker.on('completed', (job: Job<EmailJobData>) => {
      logger.debug({ jobId: job.id, to: job.data.to }, 'Email job completed');
    });

    // The DB row's retry / abandon state is written inside processJob by
    // the code that holds the send claim; this handler only logs.
    this.worker.on('failed', (job: Job<EmailJobData> | undefined, err: Error) => {
      if (!job) return;
      logger.warn(
        { jobId: job.id, attempt: job.attemptsMade, maxAttempts: EMAIL.MAX_RETRIES, err: err.message },
        'Email job attempt failed — retry state recorded on the pending_emails row',
      );
    });

    this.worker.on('error', (err: Error) => {
      logger.error({ err }, 'Email queue worker error');
    });

    // Monitor queue events for metrics
    this.queueEvents = new QueueEvents(QUEUE_NAME, { connection });

    this.started = true;
    logger.info('BullMQ email queue started');
  }

  /**
   * Add an email to the send queue.
   * Also creates a PendingEmail DB record for audit trail.
   */
  async enqueue(params: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    appointmentId?: string;
  }): Promise<string> {
    let pendingEmailId: string;

    try {
      // Create audit trail in DB (primary path)
      const pendingEmail = await prisma.pendingEmail.create({
        data: {
          toEmail: params.to,
          subject: params.subject,
          body: params.body,
          status: 'pending',
          appointmentId: params.appointmentId || null,
        },
      });
      pendingEmailId = pendingEmail.id;
    } catch (dbErr) {
      // DB is down — write to Redis write-ahead log to prevent message loss.
      // The recovery service will sync WAL entries to DB once it recovers.
      logger.error(
        { err: dbErr, to: params.to, subject: params.subject },
        'Database unavailable during enqueue — writing to Redis write-ahead log'
      );

      try {
        const walEntry = {
          id: `wal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          to: params.to,
          subject: params.subject,
          body: params.body,
          threadId: params.threadId,
          appointmentId: params.appointmentId,
          createdAt: new Date().toISOString(),
        };

        await redis.rpush(WAL_KEY, JSON.stringify(walEntry));
        // Set TTL on the list if it's new (best-effort, won't reset if already set)
        await redis.expire(WAL_KEY, WAL_ENTRY_TTL_SECONDS);

        logger.info(
          { walEntryId: walEntry.id, to: params.to },
          'Email saved to Redis write-ahead log — will be synced to DB on recovery'
        );
        return walEntry.id;
      } catch (redisErr) {
        // Both DB and Redis are down — this is a critical failure
        logger.error(
          { dbErr, redisErr, to: params.to, subject: params.subject },
          'CRITICAL: Both database and Redis unavailable — email enqueue failed completely'
        );
        throw new Error('Cannot enqueue email: both database and Redis are unavailable');
      }
    }

    // If queue is not available (Redis down), the DB record serves as fallback.
    // The PendingEmailService polling loop will pick it up.
    if (!this.queue) {
      logger.warn(
        { pendingEmailId },
        'BullMQ queue not available — email queued in DB only (will be picked up by polling fallback)'
      );
      return pendingEmailId;
    }

    try {
      await this.queue.add('send-email', {
        pendingEmailId,
        to: params.to,
        subject: params.subject,
        body: params.body,
        threadId: params.threadId,
        appointmentId: params.appointmentId,
      }, {
        jobId: pendingEmailId, // Deduplicate by DB ID
      });
    } catch (err) {
      logger.warn(
        { err, pendingEmailId },
        'Failed to enqueue email in BullMQ — falling back to DB-only queue'
      );
      // DB record still exists; the polling fallback will process it
    }

    return pendingEmailId;
  }

  /**
   * Process a single email job via the shared claim-then-send path.
   *
   * Throws only when the attempt failed and the row was put back to
   * `pending` for a retry, so BullMQ schedules its own retry. Everything
   * else (sent, skipped, abandoned, or the row not claimable because it
   * was already sent / is being sent by the DB poller) completes the job.
   */
  private async processJob(job: Job<EmailJobData>): Promise<void> {
    const { pendingEmailId, threadId } = job.data;
    const result = await attemptPendingEmailSend(pendingEmailId, `bullmq:${job.id}`, threadId);

    if (result.outcome === 'not-claimed') {
      logger.info(
        { jobId: job.id, pendingEmailId },
        'BullMQ job skipped — pendingEmail already sent, abandoned, deleted, or claimed by the polling fallback'
      );
      return;
    }
    if (result.outcome === 'retrying') {
      throw result.error;
    }
  }

  /**
   * Recover emails from the Redis write-ahead log (WAL).
   * Called on startup and periodically to sync any emails that were
   * buffered in Redis when the database was unavailable.
   *
   * Peek → insert → remove, never pop-first. The head entry is only
   * removed from the WAL after its PendingEmail row is committed, so a
   * failed insert (typically: the DB is still down) leaves it — and every
   * entry behind it — in place for the next recovery run instead of
   * dropping the email (lifecycle audit L13).
   *
   * Duplicate-safety: the PendingEmail id is derived deterministically from
   * the WAL entry, so re-inserting an entry that was already recovered (a
   * crash between insert and removal, or two recoverers — server startup
   * and the stale-check tick — peeking the same head concurrently) hits the
   * primary key instead of creating a second row, and is treated as
   * "already recovered". Only the recoverer whose insert created the row
   * enqueues it.
   *
   * Returns the number of recovered emails.
   */
  async recoverFromWAL(): Promise<number> {
    let recovered = 0;

    try {
      const walLength = await redis.llen(WAL_KEY);
      if (walLength === 0) return 0;

      logger.info({ walLength }, 'Found entries in email write-ahead log — recovering');

      // Process up to 100 entries per recovery run
      const maxEntries = Math.min(walLength, 100);

      for (let i = 0; i < maxEntries; i++) {
        // Peek, don't pop.
        const [entryStr] = await redis.lrange(WAL_KEY, 0, 0);
        if (!entryStr) break;

        const entry = parseWalEntry(entryStr);
        if (!entry) {
          // Genuinely unparseable — retrying can never succeed, and leaving
          // it at the head would block every entry behind it. Drop it.
          logger.error(
            { entry: entryStr.slice(0, 200) },
            'Dropping corrupt write-ahead log entry (unparseable or missing to/subject/body)'
          );
          await removeWalEntry(entryStr);
          continue;
        }

        const pendingEmailId = walEntryPendingEmailId(entry, entryStr);
        let created = false;
        try {
          // Create the DB record that was missed during downtime
          await prisma.pendingEmail.create({
            data: {
              id: pendingEmailId,
              toEmail: entry.to,
              subject: entry.subject,
              body: entry.body,
              status: 'pending',
              appointmentId: entry.appointmentId || null,
            },
          });
          created = true;
        } catch (insertErr) {
          if (!isUniqueConstraintViolation(insertErr)) {
            // DB still unavailable (or another transient failure): keep the
            // entry — and everything behind it, in order — for the next run.
            logger.warn(
              { err: insertErr, walEntryId: entry.id, remaining: walLength - recovered },
              'Failed to insert WAL entry into pending_emails — leaving it in the write-ahead log for the next recovery run'
            );
            break;
          }
          // Row already exists: an earlier run inserted it and died before
          // removing the entry, or a concurrent recoverer won. Its owner
          // (or the PendingEmail polling fallback) sends it.
          logger.info(
            { walEntryId: entry.id, pendingEmailId },
            'WAL entry already recovered — removing it from the write-ahead log'
          );
        }

        // Remove exactly this entry now that its row is committed.
        await removeWalEntry(entryStr);
        if (!created) continue;

        // Also enqueue in BullMQ if available
        if (this.queue) {
          try {
            await this.queue.add('send-email', {
              pendingEmailId,
              to: entry.to,
              subject: entry.subject,
              body: entry.body,
              threadId: entry.threadId,
              appointmentId: entry.appointmentId,
            }, {
              jobId: pendingEmailId,
            });
          } catch {
            // DB record exists; polling fallback will handle it
          }
        }

        recovered++;
        logger.info(
          { walEntryId: entry.id, pendingEmailId, to: entry.to },
          'Recovered email from write-ahead log'
        );
      }

      if (recovered > 0) {
        logger.info({ recovered, remaining: walLength - recovered }, 'WAL recovery complete');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to check write-ahead log (Redis may be unavailable)');
    }

    return recovered;
  }

  /**
   * Get queue health metrics.
   */
  async getStats(): Promise<{ available: boolean; waiting: number; active: number; delayed: number; failed: number }> {
    if (!this.queue) {
      return { available: false, waiting: 0, active: 0, delayed: 0, failed: 0 };
    }
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    return { available: true, waiting: counts.waiting, active: counts.active, delayed: counts.delayed, failed: counts.failed };
  }

  /**
   * Graceful shutdown.
   */
  async stop(): Promise<void> {
    if (this.queueEvents) {
      await this.queueEvents.close();
      this.queueEvents = null;
    }
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
    this.started = false;
    logger.info('BullMQ email queue stopped');
  }
}

export const emailQueueService = new EmailQueueService();

// ============================================
// Pending Email Processor (polling fallback)
// ============================================

/**
 * Pending Email Processor Service
 *
 * Periodically processes the pending email queue to retry failed sends.
 * This ensures emails that failed to send (due to temporary Gmail issues,
 * rate limits, etc.) eventually get delivered.
 *
 * Features:
 * - Processes pending emails every 2 minutes by default
 * - Extends LockedPeriodicService for distributed lock management
 * - Handles failures gracefully without crashing
 * - Logs success/failure counts for monitoring
 * - Prevents overlapping processing runs across all instances
 *
 * Migrated onto LockedPeriodicService in the same Stage D follow-up as
 * missed-message-scanner.service.ts (see
 * docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md) — this one only needed the
 * trigger-reason argument tick() now receives (for log context), not the
 * onLockNotAcquired/onError hooks, since it has no consecutive-skip
 * health tracking.
 */

// Default processing interval: 2 minutes
const DEFAULT_PROCESS_INTERVAL_MS = 2 * 60 * 1000;

// Minimum interval: 30 seconds
const MIN_INTERVAL_MS = 30 * 1000;

// Maximum interval: 10 minutes
const MAX_INTERVAL_MS = 10 * 60 * 1000;

// Startup delay to allow services to initialize
const STARTUP_DELAY_MS = 20000; // 20 seconds

interface ProcessResult {
  sent: number;
  failed: number;
  queueDepth?: number;
  batchSize?: number;
}

const EMPTY_PROCESS_RESULT: ProcessResult = { sent: 0, failed: 0 };

class PendingEmailService extends LockedPeriodicService<ProcessResult> {
  private processIntervalMs: number;
  // Named type so callers (and getQueueStatus's return shape) can
  // reference it without `typeof this.stats`, which fails under
  // noImplicitThis.
  private stats: EmailQueueStats = {
    totalProcessed: 0,
    totalSent: 0,
    totalFailed: 0,
    lastRunTime: null,
    lastRunSent: 0,
    lastRunFailed: 0,
    lastQueueDepth: 0,
    lastBatchSize: 0,
  };

  constructor() {
    const envInterval = process.env.PENDING_EMAIL_INTERVAL_MS
      ? parseInt(process.env.PENDING_EMAIL_INTERVAL_MS, 10)
      : DEFAULT_PROCESS_INTERVAL_MS;
    const processIntervalMs = Math.max(
      MIN_INTERVAL_MS,
      Math.min(MAX_INTERVAL_MS, envInterval || DEFAULT_PROCESS_INTERVAL_MS)
    );

    super({
      name: 'pending-email',
      intervalMs: processIntervalMs,
      startupDelayMs: STARTUP_DELAY_MS,
      lockKey: PENDING_EMAIL_LOCK.KEY,
      lockTtlSeconds: PENDING_EMAIL_LOCK.TTL_SECONDS,
      renewalIntervalMs: PENDING_EMAIL_LOCK.RENEWAL_INTERVAL_MS,
    });

    this.processIntervalMs = processIntervalMs;
  }

  protected async tick(
    ctx: LockedTaskContext,
    trigger: 'startup' | 'scheduled' | 'manual',
  ): Promise<ProcessResult> {
    const processId = Date.now().toString(36);
    logger.debug({ processId, trigger, instanceId: this.instanceId }, 'Processing pending emails');
    const result = await processPendingEmails(processId, ctx.isLockValid);

    this.stats.totalProcessed += result.sent + result.failed;
    this.stats.totalSent += result.sent;
    this.stats.totalFailed += result.failed;
    this.stats.lastRunTime = new Date();
    this.stats.lastRunSent = result.sent;
    this.stats.lastRunFailed = result.failed;
    this.stats.lastQueueDepth = result.queueDepth ?? 0;
    this.stats.lastBatchSize = result.batchSize ?? 0;

    if (result.sent > 0 || result.failed > 0) {
      logger.info(
        {
          processId,
          trigger,
          sent: result.sent,
          failed: result.failed,
          queueDepth: result.queueDepth,
          batchSize: result.batchSize,
        },
        'Pending email processing complete'
      );
    } else {
      logger.debug({ processId, trigger }, 'No pending emails to process');
    }

    return result;
  }

  protected onLockNotAcquired(trigger: 'startup' | 'scheduled' | 'manual'): void {
    logger.debug(
      { instanceId: this.instanceId, trigger },
      'Skipping pending email processing - another instance holds the lock'
    );
  }

  protected onError(err: Error, trigger: 'startup' | 'scheduled' | 'manual'): void {
    logger.error(
      { trigger, error: err },
      'Error processing pending emails - will retry next interval'
    );
  }

  /**
   * Manually trigger pending email processing
   */
  async triggerManualProcess(): Promise<{ sent: number; failed: number }> {
    const result = await this.trigger();
    return result.result ?? EMPTY_PROCESS_RESULT;
  }

  /**
   * Get service status and statistics.
   *
   * Named getQueueStatus (not getStatus) because it returns a different,
   * richer shape than LockedPeriodicService's getStatus() — overriding
   * that method would be an incompatible override, not an extension of it.
   */
  getQueueStatus(): {
    running: boolean;
    processIntervalMs: number;
    processIntervalMinutes: number;
    instanceId: string;
    stats: EmailQueueStats;
  } {
    return {
      running: super.getStatus().running,
      processIntervalMs: this.processIntervalMs,
      processIntervalMinutes: this.processIntervalMs / 60000,
      instanceId: this.instanceId,
      stats: {
        ...this.stats,
        lastRunTime: this.stats.lastRunTime,
      },
    };
  }
}

export const pendingEmailService = new PendingEmailService();

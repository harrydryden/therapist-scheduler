/**
 * BullMQ Email Queue Service
 *
 * Replaces the database-polled PendingEmail queue with a proper message queue
 * backed by Redis. Provides:
 * - Automatic retry with the same exponential backoff schedule (1m, 5m, 15m, 1h, 4h)
 * - Dead letter queue for permanently failed jobs
 * - Concurrency control (one email at a time to respect Gmail rate limits)
 * - Job deduplication
 *
 * The PendingEmail DB table is kept as an audit trail: records are created when
 * jobs are enqueued and updated when they complete or fail permanently.
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { config } from '../config';
import { logger } from '../utils/logger';
import { prisma } from '../utils/database';
import { redis } from '../utils/redis';
import { EMAIL } from '../constants';

// Redis keys for reliability features
const SEND_GUARD_PREFIX = 'email:send-guard:'; // Idempotent send guard
const SEND_GUARD_TTL_SECONDS = 3600; // 1 hour
const WAL_KEY = 'email:write-ahead-log'; // Write-ahead log for DB downtime
const WAL_ENTRY_TTL_SECONDS = 86400; // 24 hours

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

// Map the existing backoff schedule to BullMQ's format
// Original: 1min, 5min, 15min, 1h, 4h
// BullMQ custom backoff receives attempt number (1-indexed)
function getBackoffDelay(attemptsMade: number): number {
  const idx = Math.min(attemptsMade - 1, EMAIL.RETRY_DELAYS_MS.length - 1);
  const baseDelay = EMAIL.RETRY_DELAYS_MS[idx];
  // 10% jitter to prevent thundering herd
  const jitter = Math.floor(baseDelay * 0.1 * Math.random());
  return baseDelay + jitter;
}

// ============================================
// Queue & Worker
// ============================================

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
          backoffStrategy: (attemptsMade: number) => getBackoffDelay(attemptsMade),
        },
      }
    );

    this.worker.on('completed', (job: Job<EmailJobData>) => {
      logger.debug({ jobId: job.id, to: job.data.to }, 'Email job completed');
    });

    this.worker.on('failed', (job: Job<EmailJobData> | undefined, err: Error) => {
      if (!job) return;
      const isFinal = (job.attemptsMade ?? 0) >= EMAIL.MAX_RETRIES;
      if (isFinal) {
        logger.error(
          { jobId: job.id, to: job.data.to, attempts: job.attemptsMade, err: err.message },
          'Email permanently failed — moved to dead letter'
        );
        this.handlePermanentFailure(job, err.message).catch((e) =>
          logger.error({ err: e }, 'Failed to handle permanent email failure')
        );
      } else {
        logger.warn(
          { jobId: job.id, to: job.data.to, attempt: job.attemptsMade, err: err.message },
          `Email send failed — will retry (${job.attemptsMade}/${EMAIL.MAX_RETRIES})`
        );
        // Update the DB record with the retry count
        this.updateRetryState(job, err.message).catch((e) =>
          logger.error({ err: e }, 'Failed to update pending email retry state')
        );
      }
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
    // The legacy pending-email.service.ts polling loop will pick it up.
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
   * Process a single email job.
   */
  private async processJob(job: Job<EmailJobData>): Promise<void> {
    const { pendingEmailId, to, subject, body, threadId } = job.data;

    // Skip internal retry markers (JustinTime failure signals stored as PendingEmail)
    try {
      const parsed = JSON.parse(body);
      if (parsed?.type === 'RETRY_JUSTINTIME_START') {
        logger.info({ jobId: job.id, pendingEmailId }, 'Skipping JustinTime retry marker');
        await prisma.pendingEmail.update({
          where: { id: pendingEmailId },
          data: { status: 'sent', sentAt: new Date() },
        });
        return;
      }
    } catch {
      // Not JSON — normal email body
    }

    // Resolve thread ID from appointment if not provided directly
    let resolvedThreadId = threadId;
    if (!resolvedThreadId && job.data.appointmentId) {
      const apt = await prisma.appointmentRequest.findUnique({
        where: { id: job.data.appointmentId },
        select: { gmailThreadId: true, therapistGmailThreadId: true, therapistEmail: true },
      });
      if (apt) {
        const isTherapistEmail = to.toLowerCase() === apt.therapistEmail.toLowerCase();
        resolvedThreadId = (isTherapistEmail
          ? apt.therapistGmailThreadId
          : apt.gmailThreadId) ?? undefined;
      }
    }

    // Idempotent send guard: check if this email was already sent successfully.
    // This prevents duplicate sends when the email goes out via Gmail but the
    // subsequent DB status update fails (e.g., DB blip after send).
    // On retry, BullMQ would re-process the job and send the email again without this guard.
    const sendGuardKey = `${SEND_GUARD_PREFIX}${pendingEmailId}`;
    try {
      const alreadySent = await redis.get(sendGuardKey);
      if (alreadySent) {
        logger.info(
          { jobId: job.id, pendingEmailId },
          'Send guard: email already sent (Redis guard exists) — skipping send, updating DB only'
        );
        await prisma.pendingEmail.update({
          where: { id: pendingEmailId },
          data: { status: 'sent', sentAt: new Date() },
        });
        return;
      }
    } catch {
      // Redis unavailable for guard check — proceed with send
      // Worst case: a duplicate send, which is better than no send
    }

    // Lazy import to avoid circular dependency
    const { emailProcessingService } = await import('./email-processing.service');
    await emailProcessingService.sendEmail({
      to,
      subject,
      body,
      threadId: resolvedThreadId,
    });

    // Mark send guard in Redis BEFORE DB update.
    // If the DB update fails, the guard prevents duplicate sends on retry.
    try {
      await redis.set(sendGuardKey, 'sent', 'EX', SEND_GUARD_TTL_SECONDS);
    } catch {
      // Redis unavailable — proceed without guard (DB update is still our primary record)
    }

    // Mark as sent in audit trail
    await prisma.pendingEmail.update({
      where: { id: pendingEmailId },
      data: { status: 'sent', sentAt: new Date() },
    });
  }

  /**
   * Update DB retry state when a job fails (non-final).
   */
  private async updateRetryState(job: Job<EmailJobData>, errorMessage: string): Promise<void> {
    await prisma.pendingEmail.update({
      where: { id: job.data.pendingEmailId },
      data: {
        errorMessage,
        retryCount: job.attemptsMade ?? 0,
        lastRetryAt: new Date(),
      },
    });
  }

  /**
   * Handle permanent failure (all retries exhausted).
   * Marks DB record as abandoned and notifies admins via appointment notes.
   */
  private async handlePermanentFailure(job: Job<EmailJobData>, errorMessage: string): Promise<void> {
    const { pendingEmailId, to, subject, appointmentId } = job.data;
    const now = new Date();

    await prisma.pendingEmail.update({
      where: { id: pendingEmailId },
      data: {
        status: 'abandoned',
        errorMessage: `Abandoned after ${job.attemptsMade} attempts: ${errorMessage}`,
        retryCount: job.attemptsMade ?? 0,
        lastRetryAt: now,
      },
    });

    // Propagate to appointment for admin visibility
    if (appointmentId) {
      const apt = await prisma.appointmentRequest.findUnique({
        where: { id: appointmentId },
        select: { notes: true },
      });

      const note = `[EMAIL ABANDONED - ${now.toISOString()}]\nTo: ${to}\nSubject: ${subject.slice(0, 100)}${subject.length > 100 ? '...' : ''}\nFailed after ${job.attemptsMade} retries: ${errorMessage.slice(0, 200)}`;

      await prisma.appointmentRequest.update({
        where: { id: appointmentId },
        data: {
          notes: apt?.notes ? `${apt.notes}\n\n${note}` : note,
          conversationStallAlertAt: now,
          conversationStallAcknowledged: false,
        },
      });
    }
  }

  /**
   * Recover emails from the Redis write-ahead log (WAL).
   * Called on startup and periodically to sync any emails that were
   * buffered in Redis when the database was unavailable.
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
        const entryStr = await redis.lpop(WAL_KEY);
        if (!entryStr) break;

        try {
          const entry = JSON.parse(entryStr);

          // Create the DB record that was missed during downtime
          const pendingEmail = await prisma.pendingEmail.create({
            data: {
              toEmail: entry.to,
              subject: entry.subject,
              body: entry.body,
              status: 'pending',
              appointmentId: entry.appointmentId || null,
            },
          });

          // Also enqueue in BullMQ if available
          if (this.queue) {
            try {
              await this.queue.add('send-email', {
                pendingEmailId: pendingEmail.id,
                to: entry.to,
                subject: entry.subject,
                body: entry.body,
                threadId: entry.threadId,
                appointmentId: entry.appointmentId,
              }, {
                jobId: pendingEmail.id,
              });
            } catch {
              // DB record exists; polling fallback will handle it
            }
          }

          recovered++;
          logger.info(
            { walEntryId: entry.id, pendingEmailId: pendingEmail.id, to: entry.to },
            'Recovered email from write-ahead log'
          );
        } catch (parseErr) {
          logger.error(
            { err: parseErr, entry: entryStr.slice(0, 200) },
            'Failed to recover WAL entry — entry may be corrupt'
          );
        }
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
  async getStats() {
    if (!this.queue) {
      return { available: false, waiting: 0, active: 0, delayed: 0, failed: 0 };
    }
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    return { available: true, ...counts };
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

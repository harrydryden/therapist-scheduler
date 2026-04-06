import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { emailProcessingService } from './email-processing.service';
import { slackNotificationService } from './slack-notification.service';
import { MISSED_MESSAGE_SCANNER_LOCK, MISSED_MESSAGE_SCANNER_INTERVALS } from '../constants';

const {
  SCAN_INTERVAL_MS,
  STARTUP_DELAY_MS,
  BATCH_SIZE,
  BATCH_DELAY_MS,
  CONSECUTIVE_SKIP_ALERT_THRESHOLD,
} = MISSED_MESSAGE_SCANNER_INTERVALS;

/**
 * Missed Message Scanner Service
 *
 * Periodically scans ALL active appointment threads for messages that were
 * never processed by the application. This catches messages missed due to:
 * - Lost Gmail push notifications (server restarts, network issues, Pub/Sub outages)
 * - Emails read in Gmail (admin, mobile notification) before polling detected them
 * - Replies arriving during deployment windows or outages
 *
 * Complements the stale check's recoverMissedReplies (which covers contacted/negotiating
 * with take:10, hourly, 1h+ inactive only). This scanner is comprehensive:
 * - Covers ALL active statuses including post-booking (confirmed, session_held, feedback_requested)
 * - No limit on number of appointments scanned (processes all in batches)
 * - Runs every hour as a thorough sweep
 * - Respects humanControlEnabled flag (skips admin-controlled appointments)
 * - Sends Slack alerts when messages are recovered or when the scanner is unhealthy
 *
 * The overlap on contacted/negotiating is intentional — stale check provides fast
 * recovery (hourly, 10 at a time), this scanner provides comprehensive backup.
 *
 * Uses LockedTaskRunner for distributed locking so only one instance runs at a time
 * in multi-replica deployments.
 */
class MissedMessageScannerService {
  private intervalId: NodeJS.Timeout | null = null;
  private startupTimeoutId: NodeJS.Timeout | null = null;
  private instanceId: string;
  private taskRunner: LockedTaskRunner;
  private consecutiveSkips = 0;

  constructor() {
    this.instanceId = `${process.pid}-${Date.now().toString(36)}-missed-scanner`;

    this.taskRunner = new LockedTaskRunner({
      lockKey: MISSED_MESSAGE_SCANNER_LOCK.KEY,
      lockTtlSeconds: MISSED_MESSAGE_SCANNER_LOCK.TTL_SECONDS,
      renewalIntervalMs: MISSED_MESSAGE_SCANNER_LOCK.RENEWAL_INTERVAL_MS,
      instanceId: this.instanceId,
      context: 'missed-message-scanner',
    });
  }

  /**
   * Start the periodic missed message scanner
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Missed message scanner already running');
      return;
    }

    const intervalMinutes = Math.round(SCAN_INTERVAL_MS / (60 * 1000));
    logger.info(
      { intervalMs: SCAN_INTERVAL_MS, intervalMinutes },
      `Starting missed message scanner (runs every ${intervalMinutes} minutes)`
    );

    // Delay first scan to allow Gmail client and other services to initialize
    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null;
      this.runSafeScan('startup');
    }, STARTUP_DELAY_MS);

    // Then run at the configured interval
    this.intervalId = setInterval(() => {
      this.runSafeScan('scheduled');
    }, SCAN_INTERVAL_MS);
  }

  /**
   * Stop the scanner
   */
  stop(): void {
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId);
      this.startupTimeoutId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('Missed message scanner stopped');
  }

  /**
   * Run a scan with distributed locking and error handling
   */
  private async runSafeScan(trigger: 'startup' | 'scheduled' | 'manual'): Promise<{
    scanned: number;
    recovered: number;
  }> {
    const scanId = `scan-${Date.now().toString(36)}`;

    const result = await this.taskRunner.run(async (ctx) => {
      return this.scanActiveThreads(scanId, trigger, ctx.isLockValid);
    });

    if (!result.acquired) {
      logger.debug({ scanId, trigger }, 'Missed message scan skipped — another instance holds the lock');
      this.trackSkip(scanId, trigger, 'lock_contention');
      return { scanned: 0, recovered: 0 };
    }

    if (result.error) {
      logger.error(
        { scanId, trigger, error: result.error },
        'Missed message scan failed'
      );
      this.trackSkip(scanId, trigger, 'error');
      return { scanned: 0, recovered: 0 };
    }

    // Successful scan — reset skip counter
    this.consecutiveSkips = 0;
    return result.result || { scanned: 0, recovered: 0 };
  }

  /**
   * Track consecutive skips and alert if threshold is exceeded.
   * Consecutive skips suggest the scanner is unhealthy (OAuth issues, stuck lock, etc.).
   */
  private trackSkip(scanId: string, trigger: string, reason: string): void {
    this.consecutiveSkips++;

    if (this.consecutiveSkips >= CONSECUTIVE_SKIP_ALERT_THRESHOLD) {
      logger.error(
        { scanId, trigger, reason, consecutiveSkips: this.consecutiveSkips },
        'Missed message scanner has been skipped multiple times consecutively — messages may be going undetected'
      );

      slackNotificationService.sendAlert({
        title: 'Missed Message Scanner Unhealthy',
        severity: 'high',
        details: `Scanner has been skipped *${this.consecutiveSkips}* consecutive times (reason: ${reason}). ` +
          'Incoming messages may not be detected. Check OAuth token status and server health.',
      }).catch(() => {
        // Best-effort alerting
      });
    }
  }

  /**
   * Scan all active appointment threads for unprocessed messages.
   *
   * Queries appointments in active statuses that have Gmail thread IDs,
   * then checks each thread against the processedGmailMessage table.
   */
  private async scanActiveThreads(
    scanId: string,
    trigger: string,
    isLockValid: () => boolean
  ): Promise<{ scanned: number; recovered: number }> {
    const startTime = Date.now();

    // Pre-validate OAuth token before making Gmail API calls (matches email-polling pattern)
    const tokenStatus = await emailProcessingService.ensureValidToken(10);
    if (!tokenStatus.valid) {
      logger.warn(
        { scanId, trigger, error: tokenStatus.error },
        'OAuth token invalid before scan — skipping this cycle'
      );
      this.trackSkip(scanId, trigger, 'oauth_invalid');
      return { scanned: 0, recovered: 0 };
    }

    // Find all appointments with active threads (pre-booking + confirmed active)
    // These are the statuses where email conversations are ongoing
    const activeAppointments = await prisma.appointmentRequest.findMany({
      where: {
        status: {
          in: ['contacted', 'negotiating', 'confirmed', 'session_held', 'feedback_requested'],
        },
        humanControlEnabled: false, // Don't interfere with admin-controlled appointments
        OR: [
          { gmailThreadId: { not: null } },
          { therapistGmailThreadId: { not: null } },
        ],
      },
      select: {
        id: true,
        gmailThreadId: true,
        therapistGmailThreadId: true,
        therapistName: true,
        userName: true,
        status: true,
      },
      orderBy: { lastActivityAt: 'asc' }, // Check least-recently-active first
    });

    if (activeAppointments.length === 0) {
      logger.info({ scanId, trigger }, 'Missed message scan: no active appointments with threads');
      return { scanned: 0, recovered: 0 };
    }

    logger.info(
      { scanId, trigger, totalAppointments: activeAppointments.length },
      'Starting missed message scan for active threads'
    );

    let totalScanned = 0;
    let totalRecovered = 0;
    const recoveredAppointments: Array<{ id: string; therapistName: string; userName: string; count: number }> = [];

    // Process in batches to respect Gmail API rate limits
    for (let i = 0; i < activeAppointments.length; i += BATCH_SIZE) {
      // Check lock is still valid before each batch
      if (!isLockValid()) {
        logger.warn(
          { scanId, scannedSoFar: totalScanned, recoveredSoFar: totalRecovered },
          'Missed message scan aborted — lock lost'
        );
        break;
      }

      const batch = activeAppointments.slice(i, i + BATCH_SIZE);

      for (const appointment of batch) {
        const traceId = `${scanId}:${appointment.id}`;
        let appointmentRecovered = 0;

        try {
          // Check therapist thread
          if (appointment.therapistGmailThreadId) {
            totalScanned++;
            const recovered = await emailProcessingService.checkThreadForUnprocessedReplies(
              appointment.therapistGmailThreadId,
              traceId
            );
            if (recovered > 0) {
              logger.info(
                {
                  scanId,
                  appointmentId: appointment.id,
                  threadId: appointment.therapistGmailThreadId,
                  threadType: 'therapist',
                  recoveredCount: recovered,
                  therapistName: appointment.therapistName,
                  userName: appointment.userName,
                },
                'Missed message scanner recovered messages from therapist thread'
              );
              totalRecovered += recovered;
              appointmentRecovered += recovered;
            }
          }

          // Check client thread
          if (appointment.gmailThreadId) {
            totalScanned++;
            const recovered = await emailProcessingService.checkThreadForUnprocessedReplies(
              appointment.gmailThreadId,
              traceId
            );
            if (recovered > 0) {
              logger.info(
                {
                  scanId,
                  appointmentId: appointment.id,
                  threadId: appointment.gmailThreadId,
                  threadType: 'client',
                  recoveredCount: recovered,
                  userName: appointment.userName,
                },
                'Missed message scanner recovered messages from client thread'
              );
              totalRecovered += recovered;
              appointmentRecovered += recovered;
            }
          }

          if (appointmentRecovered > 0) {
            recoveredAppointments.push({
              id: appointment.id,
              therapistName: appointment.therapistName || 'Unknown',
              userName: appointment.userName || 'Unknown',
              count: appointmentRecovered,
            });
          }
        } catch (error) {
          logger.warn(
            { scanId, appointmentId: appointment.id, error },
            'Failed to scan appointment threads — continuing with next'
          );
        }
      }

      // Delay between batches to avoid Gmail rate limits (skip after last batch)
      if (i + BATCH_SIZE < activeAppointments.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const durationMs = Date.now() - startTime;
    logger.info(
      {
        scanId,
        trigger,
        totalAppointments: activeAppointments.length,
        threadsScanned: totalScanned,
        messagesRecovered: totalRecovered,
        durationMs,
        durationMinutes: Math.round(durationMs / 60000),
      },
      `Missed message scan complete — recovered ${totalRecovered} messages from ${totalScanned} threads`
    );

    // Alert via Slack when messages are recovered — this indicates a delivery problem
    if (totalRecovered > 0) {
      const appointmentSummary = recoveredAppointments
        .map(a => `• ${a.userName} / ${a.therapistName}: ${a.count} message(s)`)
        .join('\n');

      slackNotificationService.sendAlert({
        title: 'Missed Messages Recovered',
        severity: totalRecovered >= 3 ? 'high' : 'medium',
        details: `Scanner recovered *${totalRecovered}* missed message(s) across *${recoveredAppointments.length}* appointment(s). ` +
          'These messages were not delivered via push notifications and were caught by the periodic scan.\n\n' +
          appointmentSummary,
      }).catch(() => {
        // Best-effort alerting
      });
    }

    return { scanned: totalScanned, recovered: totalRecovered };
  }

  /**
   * Manually trigger a scan (for admin/debugging)
   */
  async triggerManualScan(): Promise<{ scanned: number; recovered: number }> {
    logger.info('Manual missed message scan triggered');
    return this.runSafeScan('manual');
  }

  /**
   * Get service status
   */
  getStatus(): {
    running: boolean;
    intervalMs: number;
    intervalMinutes: number;
    consecutiveSkips: number;
  } {
    return {
      running: this.intervalId !== null,
      intervalMs: SCAN_INTERVAL_MS,
      intervalMinutes: Math.round(SCAN_INTERVAL_MS / (60 * 1000)),
      consecutiveSkips: this.consecutiveSkips,
    };
  }
}

export const missedMessageScannerService = new MissedMessageScannerService();

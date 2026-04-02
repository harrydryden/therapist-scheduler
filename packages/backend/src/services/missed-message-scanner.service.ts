import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { emailProcessingService } from './email-processing.service';
import { MISSED_MESSAGE_SCANNER_LOCK, MISSED_MESSAGE_SCANNER_INTERVALS } from '../constants';

const {
  SCAN_INTERVAL_MS,
  STARTUP_DELAY_MS,
  BATCH_SIZE,
  BATCH_DELAY_MS,
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
 * Unlike the stale check's recoverMissedReplies (which only checks 10 appointments
 * inactive for 1h+), this scanner is comprehensive — it checks every active thread
 * in batches, running every 4 hours.
 *
 * Uses LockedTaskRunner for distributed locking so only one instance runs at a time
 * in multi-replica deployments.
 */
class MissedMessageScannerService {
  private intervalId: NodeJS.Timeout | null = null;
  private startupTimeoutId: NodeJS.Timeout | null = null;
  private instanceId: string;
  private taskRunner: LockedTaskRunner;

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

    const intervalHours = Math.round(SCAN_INTERVAL_MS / (60 * 60 * 1000));
    logger.info(
      { intervalMs: SCAN_INTERVAL_MS, intervalHours },
      `Starting missed message scanner (runs every ${intervalHours} hours)`
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
      return { scanned: 0, recovered: 0 };
    }

    if (result.error) {
      logger.error(
        { scanId, trigger, error: result.error },
        'Missed message scan failed'
      );
      return { scanned: 0, recovered: 0 };
    }

    return result.result || { scanned: 0, recovered: 0 };
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

    // Find all appointments with active threads (pre-booking + confirmed active)
    // These are the statuses where email conversations are ongoing
    const activeAppointments = await prisma.appointmentRequest.findMany({
      where: {
        status: {
          in: ['contacted', 'negotiating', 'confirmed', 'session_held', 'feedback_requested'],
        },
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
            }
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
    intervalHours: number;
  } {
    return {
      running: this.intervalId !== null,
      intervalMs: SCAN_INTERVAL_MS,
      intervalHours: Math.round(SCAN_INTERVAL_MS / (60 * 60 * 1000)),
    };
  }
}

export const missedMessageScannerService = new MissedMessageScannerService();

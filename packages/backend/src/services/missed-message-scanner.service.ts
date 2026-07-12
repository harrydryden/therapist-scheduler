import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { runWithTrace } from '../utils/request-tracing';
import { emailOAuthService } from './email-oauth.service';
import { emailIngestService } from './email-ingest.service';
import { slackNotificationService } from './slack-notification.service';
import { firstName } from '../utils/first-name';
import { MISSED_MESSAGE_SCANNER_LOCK, MISSED_MESSAGE_SCANNER_INTERVALS, ACTIVE_STATUSES } from '../constants';

// Redis key for the scanner heartbeat — written on every successful scan completion.
// External monitoring (or /health/full) reads this to detect a hung/crashed scanner:
// if the timestamp is older than ~2× SCAN_INTERVAL_MS, the service is unhealthy.
const HEARTBEAT_KEY = 'missed-message-scanner:heartbeat';
const HEARTBEAT_TTL_SECONDS = 24 * 60 * 60; // 24h — long enough to detect "missing for a day"

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
 * This is the single authoritative missed-message recovery path. It covers:
 * - ALL active statuses (contacted, negotiating, confirmed, session_held, feedback_requested)
 * - No limit on number of appointments scanned (processes all in batches)
 * - Runs every hour
 * - Respects humanControlEnabled flag (skips admin-controlled appointments)
 * - Sends Slack alerts when messages are recovered or when the scanner is unhealthy
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
   * Run a scan with distributed locking and error handling.
   *
   * Skip tracking lives here (not inside scanActiveThreads) so that
   * the reset-on-success at the end only fires when we truly completed a scan.
   */
  private async runSafeScan(trigger: 'startup' | 'scheduled' | 'manual'): Promise<ScanResult> {
    const scanId = `scan-${Date.now().toString(36)}`;

    const result = await this.taskRunner.run(async (ctx) => {
      return this.scanActiveThreads(scanId, trigger, ctx.isLockValid);
    });

    if (!result.acquired) {
      logger.debug({ scanId, trigger }, 'Missed message scan skipped — another instance holds the lock');
      this.trackSkip(scanId, trigger, 'lock_contention');
      return EMPTY_RESULT;
    }

    if (result.error) {
      logger.error(
        { scanId, trigger, error: result.error },
        'Missed message scan failed'
      );
      this.trackSkip(scanId, trigger, 'error', result.error.message);
      return EMPTY_RESULT;
    }

    // Successful scan — reset skip counter
    this.consecutiveSkips = 0;
    return result.result || EMPTY_RESULT;
  }

  /**
   * Track consecutive skips and alert if threshold is exceeded.
   * Consecutive skips suggest the scanner is unhealthy (OAuth issues, stuck lock, etc.).
   *
   * `errorMessage` is the underlying `Error.message` when `reason === 'error'`
   * (i.e. the task threw inside the locked runner). It is surfaced in the
   * Slack alert so operators can triage the actual failure (e.g.
   * "OAuth token invalid: invalid_grant") without grepping server logs —
   * the previous alert just said "reason: error" and left them digging.
   */
  private trackSkip(scanId: string, trigger: string, reason: string, errorMessage?: string): void {
    this.consecutiveSkips++;

    if (this.consecutiveSkips >= CONSECUTIVE_SKIP_ALERT_THRESHOLD) {
      logger.error(
        { scanId, trigger, reason, consecutiveSkips: this.consecutiveSkips },
        'Missed message scanner has been skipped multiple times consecutively — messages may be going undetected'
      );

      const additionalFields: Record<string, string> = {
        'Scan ID': scanId,
        'Trigger': trigger,
      };
      if (errorMessage) {
        // Truncate defensively: known error sources here (OAuth-library
        // strings, Prisma messages, the locked-runner timeout string) are
        // short and PII-free, but a future throw site could leak a long
        // payload. 200 chars is enough for a useful triage hint.
        additionalFields['Error'] =
          errorMessage.length > 200 ? `${errorMessage.slice(0, 200)}…` : errorMessage;
      }

      slackNotificationService.sendAlert({
        title: 'Missed Message Scanner Unhealthy',
        severity: 'high',
        details: `Scanner has been skipped *${this.consecutiveSkips}* consecutive times (reason: ${reason}). ` +
          'Incoming messages may not be detected. Check OAuth token status and server health.',
        additionalFields,
      }).catch(() => {});
    }
  }

  /**
   * Scan all active appointment threads for unprocessed messages.
   *
   * Queries appointments in active statuses that have Gmail thread IDs,
   * then checks each thread against the processedGmailMessage table.
   *
   * Throws on infrastructure failures (OAuth, DB) so the caller can
   * track skips correctly. Per-thread errors are caught and logged
   * without aborting the full scan.
   */
  private async scanActiveThreads(
    scanId: string,
    trigger: string,
    isLockValid: () => boolean
  ): Promise<ScanResult> {
    const startTime = Date.now();

    // Pre-validate OAuth token — throw so caller tracks this as a skip
    const tokenStatus = await emailOAuthService.ensureValidToken(10);
    if (!tokenStatus.valid) {
      throw new Error(`OAuth token invalid: ${tokenStatus.error || 'unknown'}`);
    }

    // Use the shared ACTIVE_STATUSES constant (pending is included but harmless —
    // pending appointments never have thread IDs, so the OR clause filters them out)
    const activeAppointments = await prisma.appointmentRequest.findMany({
      where: {
        status: { in: [...ACTIVE_STATUSES] },
        humanControlEnabled: false,
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
      orderBy: { lastActivityAt: 'asc' },
    });

    if (activeAppointments.length === 0) {
      logger.info({ scanId, trigger }, 'Missed message scan: no active appointments with threads');
      return EMPTY_RESULT;
    }

    logger.info(
      { scanId, trigger, totalAppointments: activeAppointments.length },
      'Starting missed message scan for active threads'
    );

    let totalScanned = 0;
    let totalRecovered = 0;
    let totalFailed = 0;
    const recoveredAppointments: Array<{ id: string; therapistName: string; userName: string; count: number }> = [];

    for (let i = 0; i < activeAppointments.length; i += BATCH_SIZE) {
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
        const threadIds = [
          appointment.therapistGmailThreadId,
          appointment.gmailThreadId,
        ].filter((id): id is string => id !== null);

        totalScanned += threadIds.length;

        // Wrap the per-appointment thread scan in a request context so every
        // log line emitted by checkThreadForUnprocessedReplies and the
        // downstream processMessage call automatically gets traceId +
        // appointmentId. Makes log correlation across the recovery chain
        // possible without joining on message IDs by hand.
        const appointmentRecovered = await runWithTrace(
          { traceId, appointmentId: appointment.id, source: 'missed-message-scanner' },
          async () => {
            try {
              // The therapist and client threads are independent Gmail API calls.
              const results = await Promise.all(
                threadIds.map(threadId =>
                  emailIngestService.checkThreadForUnprocessedReplies(threadId, traceId)
                )
              );
              return results.reduce((sum, n) => sum + n, 0);
            } catch (error) {
              totalFailed++;
              logger.warn(
                { scanId, appointmentId: appointment.id, error },
                'Failed to scan appointment threads — continuing with next'
              );
              return 0;
            }
          },
        );

        if (appointmentRecovered > 0) {
          totalRecovered += appointmentRecovered;
          recoveredAppointments.push({
            id: appointment.id,
            therapistName: appointment.therapistName || 'Unknown',
            userName: appointment.userName || 'Unknown',
            count: appointmentRecovered,
          });
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
        threadsFailed: totalFailed,
        durationMs,
      },
      `Missed message scan complete — recovered ${totalRecovered} messages from ${totalScanned} threads`
    );

    // Alert via Slack when messages are recovered. PII discipline:
    // first name only for the user (utils/first-name.ts).
    if (totalRecovered > 0) {
      const appointmentSummary = recoveredAppointments
        .map(a => `• ${firstName(a.userName, '(unknown)')} / ${a.therapistName}: ${a.count} message(s)`)
        .join('\n');

      slackNotificationService.sendAlert({
        title: 'Missed Messages Recovered',
        severity: totalRecovered >= 3 ? 'high' : 'medium',
        details: `Scanner recovered *${totalRecovered}* missed message(s) across *${recoveredAppointments.length}* appointment(s). ` +
          'These were not delivered via push notifications.\n\n' +
          appointmentSummary,
      }).catch(() => {});
    }

    // Record heartbeat: this scan ran to completion. External monitoring +
    // /health/full reads this to detect a hung/crashed scanner.
    await this.writeHeartbeat();

    return { scanned: totalScanned, recovered: totalRecovered, failed: totalFailed };
  }

  /**
   * Manually trigger a scan (for admin/debugging)
   */
  async triggerManualScan(): Promise<ScanResult> {
    logger.info('Manual missed message scan triggered');
    return this.runSafeScan('manual');
  }

  /**
   * Write the heartbeat key to Redis. Called from the success path of every
   * scan. Best-effort — if Redis is down, the heartbeat is missing and the
   * health check correctly reports degraded.
   */
  private async writeHeartbeat(): Promise<void> {
    try {
      await redis.set(HEARTBEAT_KEY, new Date().toISOString(), 'EX', HEARTBEAT_TTL_SECONDS);
    } catch (err) {
      logger.warn({ err }, 'Failed to write missed-message-scanner heartbeat');
    }
  }

  /**
   * Read the heartbeat key. Returns null if no heartbeat has been written
   * since process start (or Redis is unavailable).
   */
  private async readHeartbeat(): Promise<Date | null> {
    try {
      const value = await redis.get(HEARTBEAT_KEY);
      return value ? new Date(value) : null;
    } catch {
      return null;
    }
  }

  /**
   * Get service status, including a freshness check on the heartbeat.
   * "healthy" means the scanner has completed a scan recently — within
   * 2× the scan interval, with a 5-minute floor for short intervals.
   */
  async getStatus(): Promise<{
    running: boolean;
    intervalMs: number;
    intervalMinutes: number;
    consecutiveSkips: number;
    lastScanAt: string | null;
    secondsSinceLastScan: number | null;
    healthy: boolean;
  }> {
    const lastScanAt = await this.readHeartbeat();
    const now = Date.now();
    const secondsSinceLastScan = lastScanAt
      ? Math.round((now - lastScanAt.getTime()) / 1000)
      : null;

    const stalenessThresholdMs = Math.max(2 * SCAN_INTERVAL_MS, 5 * 60 * 1000);
    const healthy =
      this.intervalId !== null &&
      lastScanAt !== null &&
      now - lastScanAt.getTime() < stalenessThresholdMs;

    return {
      running: this.intervalId !== null,
      intervalMs: SCAN_INTERVAL_MS,
      intervalMinutes: Math.round(SCAN_INTERVAL_MS / (60 * 1000)),
      consecutiveSkips: this.consecutiveSkips,
      lastScanAt: lastScanAt?.toISOString() ?? null,
      secondsSinceLastScan,
      healthy,
    };
  }
}

interface ScanResult {
  scanned: number;
  recovered: number;
  failed: number;
}

const EMPTY_RESULT: ScanResult = { scanned: 0, recovered: 0, failed: 0 };

export const missedMessageScannerService = new MissedMessageScannerService();

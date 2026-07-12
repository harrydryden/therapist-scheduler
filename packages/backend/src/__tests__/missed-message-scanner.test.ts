/**
 * Regression tests for missed-message-scanner.service.ts's migration onto
 * LockedPeriodicService (Stage D follow-up — see
 * docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md). The consecutive-skip health
 * tracking (including lock-contention skips) and trigger-reason logging
 * are the reason this needed the onLockNotAcquired/onError/trigger-arg
 * extension to the base class rather than a mechanical swap — these tests
 * pin that the extension actually preserves the original behavior.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const acquireLockMock = jest.fn();
const releaseLockMock = jest.fn();
const renewLockMock = jest.fn();
jest.mock('../utils/redis-locks', () => ({
  acquireLock: (...a: unknown[]) => acquireLockMock(...a),
  releaseLock: (...a: unknown[]) => releaseLockMock(...a),
  renewLock: (...a: unknown[]) => renewLockMock(...a),
}));

const redisGetMock = jest.fn();
const redisSetMock = jest.fn();
jest.mock('../utils/redis', () => ({
  redis: {
    get: (...a: unknown[]) => redisGetMock(...a),
    set: (...a: unknown[]) => redisSetMock(...a),
  },
}));

const findManyMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findMany: (...a: unknown[]) => findManyMock(...a),
    },
  },
}));

const ensureValidTokenMock = jest.fn();
jest.mock('../services/email-oauth.service', () => ({
  emailOAuthService: {
    ensureValidToken: (...a: unknown[]) => ensureValidTokenMock(...a),
  },
}));

jest.mock('../services/email-ingest.service', () => ({
  emailIngestService: {
    checkThreadForUnprocessedReplies: jest.fn().mockResolvedValue(0),
  },
}));

const sendAlertMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: (...a: unknown[]) => sendAlertMock(...a),
    notifyUnmatchedEmailAbandoned: jest.fn().mockResolvedValue(undefined),
  },
}));

import type { missedMessageScannerService as MissedMessageScannerServiceType } from '../services/missed-message-scanner.service';

describe('missedMessageScannerService — consecutive-skip tracking after LockedPeriodicService migration', () => {
  // The exported service is a module-level singleton (consecutiveSkips is
  // private instance state with no reset hook) — reset the module registry
  // and re-require it fresh in each test so skip counts don't leak across
  // cases. jest.resetModules() only clears the require cache; it doesn't
  // touch jest.mock() factories registered above, which stay in effect.
  let missedMessageScannerService: typeof MissedMessageScannerServiceType;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    missedMessageScannerService =
      require('../services/missed-message-scanner.service').missedMessageScannerService;
    renewLockMock.mockResolvedValue(true);
    releaseLockMock.mockResolvedValue(undefined);
    redisSetMock.mockResolvedValue('OK');
    redisGetMock.mockResolvedValue(null);
    findManyMock.mockResolvedValue([]);
    ensureValidTokenMock.mockResolvedValue({ valid: true });
  });

  it('alerts after 3 consecutive lock-contention skips (onLockNotAcquired path)', async () => {
    acquireLockMock.mockResolvedValue(false);

    await missedMessageScannerService.triggerManualScan();
    await missedMessageScannerService.triggerManualScan();
    expect(sendAlertMock).not.toHaveBeenCalled();

    await missedMessageScannerService.triggerManualScan();
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const alert = sendAlertMock.mock.calls[0][0];
    expect(alert.title).toBe('Missed Message Scanner Unhealthy');
    expect(alert.details).toContain('lock_contention');
    expect(alert.additionalFields['Trigger']).toBe('manual');
  });

  it('alerts after 3 consecutive errors (onError path) with the error message surfaced', async () => {
    acquireLockMock.mockResolvedValue(true);
    ensureValidTokenMock.mockResolvedValue({ valid: false, error: 'invalid_grant' });

    await missedMessageScannerService.triggerManualScan();
    await missedMessageScannerService.triggerManualScan();
    await missedMessageScannerService.triggerManualScan();

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const alert = sendAlertMock.mock.calls[0][0];
    expect(alert.details).toContain('error');
    expect(alert.additionalFields['Error']).toContain('invalid_grant');
  });

  it('resets the consecutive-skip counter after a real completed scan', async () => {
    acquireLockMock.mockResolvedValue(false);
    await missedMessageScannerService.triggerManualScan();
    await missedMessageScannerService.triggerManualScan();

    // A real scan completes (lock acquired, token valid, nothing to scan).
    acquireLockMock.mockResolvedValue(true);
    ensureValidTokenMock.mockResolvedValue({ valid: true });
    findManyMock.mockResolvedValue([]);
    await missedMessageScannerService.triggerManualScan();

    // Two more skips — if the counter hadn't reset, this would be skip #5
    // (past the threshold of 3) and would have already alerted above.
    acquireLockMock.mockResolvedValue(false);
    await missedMessageScannerService.triggerManualScan();
    await missedMessageScannerService.triggerManualScan();
    expect(sendAlertMock).not.toHaveBeenCalled();

    await missedMessageScannerService.triggerManualScan();
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
  });

  it('writes the heartbeat on a completed scan and getHealthStatus reports healthy', async () => {
    acquireLockMock.mockResolvedValue(true);
    ensureValidTokenMock.mockResolvedValue({ valid: true });
    // Non-empty so the scan reaches its end-of-scan heartbeat write —
    // the zero-appointments branch returns early, before the heartbeat.
    findManyMock.mockResolvedValue([
      {
        id: 'apt-1',
        gmailThreadId: 'thread-1',
        therapistGmailThreadId: null,
        therapistName: 'Alex',
        userName: 'Sam',
        status: 'confirmed',
      },
    ]);

    await missedMessageScannerService.triggerManualScan();
    expect(redisSetMock).toHaveBeenCalledWith(
      'missed-message-scanner:heartbeat',
      expect.any(String),
      'EX',
      expect.any(Number),
    );

    redisGetMock.mockResolvedValue(new Date().toISOString());
    const status = await missedMessageScannerService.getHealthStatus();
    expect(status.consecutiveSkips).toBe(0);
  });
});

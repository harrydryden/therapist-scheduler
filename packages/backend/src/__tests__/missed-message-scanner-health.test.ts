/**
 * O7 — the missed-message scanner reported healthy while every Gmail fetch
 * failed: checkThreadForUnprocessedReplies swallowed errors as "0
 * recovered", so the scan "completed", wrote its heartbeat and reset the
 * skip counter. Failures are now counted per thread, and a scan in which
 * more than half the thread checks failed is treated as a skipped scan:
 * no heartbeat, and the escalating unhealthy-alert path.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

const acquireLockMock = jest.fn().mockResolvedValue(true);
jest.mock('../utils/redis-locks', () => ({
  acquireLock: (...a: unknown[]) => acquireLockMock(...a),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  renewLock: jest.fn().mockResolvedValue(true),
}));

const redisSetMock = jest.fn().mockResolvedValue('OK');
jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn().mockResolvedValue(null), set: (...a: unknown[]) => redisSetMock(...a) },
}));

const findManyMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: { appointmentRequest: { findMany: (...a: unknown[]) => findManyMock(...a) } },
}));

jest.mock('../services/email-oauth.service', () => ({
  emailOAuthService: { ensureValidToken: jest.fn().mockResolvedValue({ valid: true }) },
}));

const checkThreadMock = jest.fn();
jest.mock('../services/email-ingest.service', () => ({
  emailIngestService: { checkThreadForUnprocessedReplies: (...a: unknown[]) => checkThreadMock(...a) },
}));

const sendAlertMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: (...a: unknown[]) => sendAlertMock(...a) },
}));

import type { missedMessageScannerService as ScannerType } from '../services/missed-message-scanner.service';

const appointment = (id: string) => ({
  id,
  gmailThreadId: `${id}-client`,
  therapistGmailThreadId: `${id}-therapist`,
  therapistName: 'Alex',
  userName: 'Sam',
  status: 'negotiating',
});

const heartbeatWritten = () =>
  redisSetMock.mock.calls.some(([key]) => key === 'missed-message-scanner:heartbeat');

let scanner: typeof ScannerType;
beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  scanner = require('../services/missed-message-scanner.service').missedMessageScannerService;
  findManyMock.mockResolvedValue([appointment('a1'), appointment('a2')]);
});

describe('missed-message scanner health under Gmail failures (O7)', () => {
  it('writes no heartbeat and counts a skip when most thread fetches fail', async () => {
    checkThreadMock.mockRejectedValue(Object.assign(new Error('quota exceeded'), { code: 429 }));

    const result = await scanner.triggerManualScan();

    expect(result).toEqual({ scanned: 4, recovered: 0, failed: 4 });
    expect(heartbeatWritten()).toBe(false);
    expect((await scanner.getHealthStatus()).consecutiveSkips).toBe(1);
  });

  it('escalates to the unhealthy alert after repeated degraded scans', async () => {
    checkThreadMock.mockRejectedValue(new Error('Gmail 503'));

    for (let i = 0; i < 3; i++) await scanner.triggerManualScan();

    const alerts = sendAlertMock.mock.calls.map(([a]) => a).filter((a) => a.title === 'Missed Message Scanner Unhealthy');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].details).toContain('gmail_fetch_failures');
    expect(alerts[0].additionalFields.Error).toContain('4 of 4');
  });

  it('a scan with only a minority of failures still completes and records its heartbeat', async () => {
    checkThreadMock
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(0);

    const result = await scanner.triggerManualScan();

    expect(result.failed).toBe(1);
    expect(heartbeatWritten()).toBe(true);
    expect((await scanner.getHealthStatus()).consecutiveSkips).toBe(0);
  });

  it('counts each failed thread, not each appointment', async () => {
    // Client thread fails, therapist thread succeeds, for both appointments.
    checkThreadMock.mockImplementation(async (threadId: string) => {
      if (threadId.endsWith('-client')) throw new Error('boom');
      return 1;
    });

    const result = await scanner.triggerManualScan();

    expect(result).toEqual({ scanned: 4, recovered: 2, failed: 2 });
    expect(heartbeatWritten()).toBe(true);
  });
});

/**
 * E8 regression: POST /api/admin/processing-failures/retry was a silent
 * no-op.
 *
 * The endpoint deleted the DB dedup + failure rows but NOT the Redis
 * processed-ZSET member that markMessageProcessed('processing-failed-
 * abandoned') had written (30-day retention). ATOMIC_LOCK_CHECK_SCRIPT then
 * kept answering `already_processed`, so the documented bulk recovery
 * (MISSED_MESSAGE_RECOVERY "Option B") reported "Cleared N" and reprocessed
 * nothing — while destroying the failure records.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { webhookSecret: 'test-webhook-secret', backendUrl: 'https://backend.test' },
}));

// Auth is covered elsewhere; let every request through.
jest.mock('../middleware/auth', () => ({
  verifyWebhookSecret: jest.fn(async () => undefined),
}));

const mockProcessedDeleteMany = jest.fn();
const mockFailureDeleteMany = jest.fn();
const mockUnmatchedDeleteMany = jest.fn();
const mockFailureCount = jest.fn();
const mockFailureFindMany = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    processedGmailMessage: { deleteMany: (...a: unknown[]) => mockProcessedDeleteMany(...a) },
    messageProcessingFailure: {
      deleteMany: (...a: unknown[]) => mockFailureDeleteMany(...a),
      count: (...a: unknown[]) => mockFailureCount(...a),
      findMany: (...a: unknown[]) => mockFailureFindMany(...a),
    },
    unmatchedEmailAttempt: { deleteMany: (...a: unknown[]) => mockUnmatchedDeleteMany(...a) },
  },
}));

const mockZrem = jest.fn();
const mockDel = jest.fn();
jest.mock('../utils/redis', () => ({
  redis: {
    zrem: (...a: unknown[]) => mockZrem(...a),
    del: (...a: unknown[]) => mockDel(...a),
  },
}));

jest.mock('../core/email', () => ({ sendEmail: jest.fn(), processPendingEmails: jest.fn() }));
jest.mock('../services/email-oauth.service', () => ({ emailOAuthService: {} }));
jest.mock('../services/email-ingest.service', () => ({ emailIngestService: {} }));
jest.mock('../services/slack-notification.service', () => ({ slackNotificationService: {} }));
jest.mock('../services/settings.service', () => ({ getSettingValues: jest.fn() }));
jest.mock('../utils/email-templates', () => ({ renderTemplate: jest.fn() }));
jest.mock('../utils/unsubscribe-token', () => ({ generateUnsubscribeUrl: jest.fn() }));
jest.mock('../utils/background-task', () => ({ getTaskMetrics: jest.fn() }));

const mockTriggerManualScan = jest.fn();
jest.mock('../services/missed-message-scanner.service', () => ({
  missedMessageScannerService: { triggerManualScan: (...a: unknown[]) => mockTriggerManualScan(...a) },
}));

import Fastify from 'fastify';
import { adminRoutes } from '../routes/admin.routes';
import { EMAIL_PROCESSING } from '../constants';

const { PROCESSED_MESSAGES_KEY, MESSAGE_LOCK_PREFIX, UNMATCHED_ATTEMPT_PREFIX } = EMAIL_PROCESSING;

async function buildApp() {
  const app = Fastify();
  await app.register(adminRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockProcessedDeleteMany.mockResolvedValue({ count: 2 });
  mockFailureDeleteMany.mockResolvedValue({ count: 2 });
  mockUnmatchedDeleteMany.mockResolvedValue({ count: 0 });
  mockZrem.mockResolvedValue(1);
  mockDel.mockResolvedValue(1);
  mockTriggerManualScan.mockResolvedValue({ recovered: 2 });
});

describe('POST /api/admin/processing-failures/retry (E8)', () => {
  it('clears the Redis processed-set member (and lock / unmatched keys) for every message', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/processing-failures/retry',
      payload: { messageIds: ['msg-a', 'msg-b'] },
    });

    expect(res.statusCode).toBe(200);
    for (const id of ['msg-a', 'msg-b']) {
      expect(mockZrem).toHaveBeenCalledWith(PROCESSED_MESSAGES_KEY, id);
      expect(mockDel).toHaveBeenCalledWith(`${MESSAGE_LOCK_PREFIX}${id}`);
      expect(mockDel).toHaveBeenCalledWith(`${UNMATCHED_ATTEMPT_PREFIX}${id}`);
    }
    expect(mockProcessedDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['msg-a', 'msg-b'] } } });
    expect(mockFailureDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['msg-a', 'msg-b'] } } });
    expect(mockTriggerManualScan).toHaveBeenCalled();

    const body = res.json();
    expect(body.data).toEqual(
      expect.objectContaining({ cleared: 2, deletedDedup: 2, deletedFailures: 2 }),
    );
    await app.close();
  });

  it('clears Redis for the all=true abandoned batch too', async () => {
    mockFailureCount.mockResolvedValueOnce(1);
    mockFailureFindMany.mockResolvedValueOnce([{ id: 'msg-abandoned' }]);
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/processing-failures/retry',
      payload: { all: true },
    });

    expect(res.statusCode).toBe(200);
    expect(mockZrem).toHaveBeenCalledWith(PROCESSED_MESSAGES_KEY, 'msg-abandoned');
    await app.close();
  });

  it('still clears the DB rows and triggers a scan when Redis is down', async () => {
    mockZrem.mockRejectedValue(new Error('ECONNREFUSED'));
    mockDel.mockRejectedValue(new Error('ECONNREFUSED'));
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/processing-failures/retry',
      payload: { messageIds: ['msg-a'] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockProcessedDeleteMany).toHaveBeenCalled();
    expect(mockTriggerManualScan).toHaveBeenCalled();
    await app.close();
  });
});

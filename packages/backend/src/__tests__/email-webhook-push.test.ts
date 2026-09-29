/**
 * Gmail Pub/Sub push webhook:
 *
 *   §4.1 In production with GOOGLE_PUBSUB_TOPIC set but no
 *        GOOGLE_PUBSUB_AUDIENCE, token verification skipped the audience
 *        claim, so a token minted for ANY GCP push subscription verified.
 *        Such pushes are now rejected (401 + one deduped Slack alert) —
 *        without failing startup.
 *   O13  The fire-and-forget processing had no concurrency limit, so a
 *        Pub/Sub burst started unbounded concurrent agent turns.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

const mockConfig: Record<string, unknown> = {};
jest.mock('../config', () => ({
  get config() {
    return mockConfig;
  },
}));

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: (...a: unknown[]) => mockVerifyIdToken(...a) })),
}));

const mockProcessNotification = jest.fn();
jest.mock('../services/email-ingest.service', () => ({
  emailIngestService: {
    processGmailNotification: (...a: unknown[]) => mockProcessNotification(...a),
    pollForNewEmails: jest.fn(),
  },
}));
jest.mock('../services/email-oauth.service', () => ({ emailOAuthService: { checkHealth: jest.fn() } }));
jest.mock('../core/email', () => ({ sendEmail: jest.fn(), processPendingEmails: jest.fn() }));
jest.mock('../middleware/auth', () => ({ verifyWebhookSecret: jest.fn(async () => undefined) }));
jest.mock('../utils/redis', () => ({ redis: { set: jest.fn(), sadd: jest.fn(), expire: jest.fn() } }));

const mockSendAlert = jest.fn().mockResolvedValue(true);
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: (...a: unknown[]) => mockSendAlert(...a) },
}));

import Fastify, { FastifyInstance } from 'fastify';
import {
  emailWebhookRoutes,
  createTaskLimiter,
  PUSH_PROCESSING_CONCURRENCY,
  _resetPushAudienceAlertForTesting,
} from '../routes/email-webhook.routes';
import { isPubsubAudienceRequiredButMissing } from '../config/pubsub-warnings';

function pushBody(historyId = 1234) {
  return {
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: 'scheduling@spill.chat', historyId })).toString('base64'),
      messageId: `m-${historyId}`,
      publishTime: '2026-09-28T10:00:00Z',
    },
    subscription: 'projects/p/subscriptions/s',
  };
}

let app: FastifyInstance;
beforeEach(async () => {
  jest.clearAllMocks();
  _resetPushAudienceAlertForTesting();
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, {
    env: 'production',
    requirePubsubAuth: true,
    googlePubsubTopic: 'projects/p/topics/gmail',
    googlePubsubAudience: 'https://api.example.com/api/webhooks/gmail/push',
  });
  mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ email: 'push@p.iam.gserviceaccount.com', iss: 'accounts.google.com' }) });
  mockProcessNotification.mockResolvedValue(undefined);
  app = Fastify();
  await app.register(emailWebhookRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const post = (body = pushBody(), headers: Record<string, string> = { authorization: 'Bearer token' }) =>
  app.inject({ method: 'POST', url: '/api/webhooks/gmail/push', payload: body, headers });

describe('push audience is mandatory in production (§4.1)', () => {
  it('rejects every push with 401 when the topic is set but the audience is not, alerting once', async () => {
    delete mockConfig.googlePubsubAudience;

    const first = await post();
    const second = await post(pushBody(1235));

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    // No Google-signed token is accepted without an audience to check.
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(mockProcessNotification).not.toHaveBeenCalled();
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert.mock.calls[0][0].title).toContain('GOOGLE_PUBSUB_AUDIENCE');
  });

  it('accepts a verified push and checks the configured audience', async () => {
    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(mockVerifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'https://api.example.com/api/webhooks/gmail/push' }),
    );
    expect(mockProcessNotification).toHaveBeenCalledWith('scheduling@spill.chat', 1234, expect.any(String));
  });

  it('is not enforced outside production, or when push is not configured', () => {
    const base = { requirePubsubAuth: true, googlePubsubTopic: 't' };
    expect(isPubsubAudienceRequiredButMissing({ ...base, env: 'development' })).toBe(false);
    expect(isPubsubAudienceRequiredButMissing({ ...base, env: 'production', googlePubsubTopic: undefined })).toBe(false);
    expect(isPubsubAudienceRequiredButMissing({ ...base, env: 'production' })).toBe(true);
    expect(isPubsubAudienceRequiredButMissing({ ...base, env: 'production', googlePubsubAudience: 'aud' })).toBe(false);
  });
});

describe('push processing concurrency limit (O13)', () => {
  it(`runs at most ${PUSH_PROCESSING_CONCURRENCY} notifications at once and drains the rest in order`, async () => {
    const releases: Array<() => void> = [];
    mockProcessNotification.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );

    for (let i = 0; i < 5; i++) {
      expect((await post(pushBody(2000 + i))).statusCode).toBe(200);
    }
    await new Promise((r) => setImmediate(r));
    expect(mockProcessNotification).toHaveBeenCalledTimes(PUSH_PROCESSING_CONCURRENCY);

    releases.shift()!();
    await new Promise((r) => setImmediate(r));
    expect(mockProcessNotification).toHaveBeenCalledTimes(PUSH_PROCESSING_CONCURRENCY + 1);
    expect(mockProcessNotification.mock.calls[PUSH_PROCESSING_CONCURRENCY][1]).toBe(2000 + PUSH_PROCESSING_CONCURRENCY);

    // Let everything finish so the limiter is idle for the next test.
    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setImmediate(r));
    }
  });

  it('createTaskLimiter drops tasks once the wait queue is full', async () => {
    const limiter = createTaskLimiter(1, 1);
    let release!: () => void;
    const blocker = () => new Promise<void>((r) => { release = r; });

    expect(limiter.run(blocker)).toBe(true); // running
    expect(limiter.run(async () => undefined)).toBe(true); // queued
    expect(limiter.run(async () => undefined)).toBe(false); // dropped
    expect(limiter.stats()).toEqual({ active: 1, queued: 1 });

    await new Promise((r) => setImmediate(r)); // the running task has started
    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(limiter.stats()).toEqual({ active: 0, queued: 0 });
  });
});

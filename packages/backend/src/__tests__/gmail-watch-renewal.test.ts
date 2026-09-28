/**
 * Review #9 — a failed Gmail watch renewal was only logged and not retried
 * until the next 6-day tick; the watch lapses after 7 days. It now alerts
 * and retries hourly until a renewal succeeds.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../config', () => ({ config: { googlePubsubTopic: 'projects/p/topics/gmail' } }));

const setupPushMock = jest.fn();
jest.mock('../services/email-ingest.service', () => ({
  emailIngestService: { setupPushNotifications: (...a: unknown[]) => setupPushMock(...a) },
}));

const sendAlertMock = jest.fn().mockResolvedValue(true);
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: (...a: unknown[]) => sendAlertMock(...a) },
}));

import { gmailWatchService, WATCH_RENEWAL_RETRY_MS } from '../services/gmail-watch.service';

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => {
  gmailWatchService.stop();
  jest.useRealTimers();
});

it('alerts on a failed renewal and retries hourly until it succeeds', async () => {
  setupPushMock
    .mockRejectedValueOnce(new Error('invalid_grant'))
    .mockRejectedValueOnce(new Error('invalid_grant'))
    .mockResolvedValue({ historyId: '1', expiration: String(Date.now() + 7 * 86_400_000) });

  gmailWatchService.start();
  await jest.advanceTimersByTimeAsync(30_000); // startup renewal
  expect(setupPushMock).toHaveBeenCalledTimes(1);
  expect(sendAlertMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Gmail Watch Renewal Failed', severity: 'high' }));

  await jest.advanceTimersByTimeAsync(WATCH_RENEWAL_RETRY_MS);
  expect(setupPushMock).toHaveBeenCalledTimes(2);

  await jest.advanceTimersByTimeAsync(WATCH_RENEWAL_RETRY_MS);
  expect(setupPushMock).toHaveBeenCalledTimes(3);

  // Succeeded — no further retries.
  await jest.advanceTimersByTimeAsync(WATCH_RENEWAL_RETRY_MS * 3);
  expect(setupPushMock).toHaveBeenCalledTimes(3);
});

/**
 * O13 — external calls without a timeout. gaxios has no default timeout, so
 * one hung OAuth refresh or thread fetch stopped the backup poller (or held
 * a message lock) until the process restarted.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../utils/redis', () => ({ redis: { set: jest.fn(), eval: jest.fn() } }));

import { createOAuth2Client, refreshAccessToken } from '../utils/gmail-auth';
import { TimeoutError } from '../utils/timeout';
import { TIMEOUTS } from '../constants';

describe('OAuth token refresh is bounded', () => {
  afterEach(() => jest.useRealTimers());

  it('rejects with TimeoutError when getAccessToken never settles', async () => {
    jest.useFakeTimers();
    const hung = { getAccessToken: () => new Promise<never>(() => undefined) };

    const pending = refreshAccessToken(hung as never, 'test-refresh');
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    jest.advanceTimersByTime(TIMEOUTS.OAUTH_TOKEN_REFRESH_MS + 1);
    await assertion;
  });

  it('resolves normally when the refresh completes', async () => {
    await expect(
      refreshAccessToken({ getAccessToken: async () => ({ token: 't' }) } as never),
    ).resolves.toBeUndefined();
  });

  it('OAuth clients get a transport timeout for the refresh request itself', () => {
    const client = createOAuth2Client(
      { installed: { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] } },
      { refresh_token: 'r', access_token: 'a' },
    );
    const timeout = (client as unknown as { transporter: { defaults: { timeout?: number } } }).transporter.defaults.timeout;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBe(TIMEOUTS.OAUTH_TOKEN_REFRESH_MS);
    expect(client.credentials.refresh_token).toBe('r');
  });
});

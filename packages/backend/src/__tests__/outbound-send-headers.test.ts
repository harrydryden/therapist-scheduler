/**
 * Outbound message headers (review #13 and §4.3).
 *
 *   - Every message carries an explicit From: (EMAIL.FROM_ADDRESS with the
 *     agent.fromName display name). Outbound mail used to set none.
 *   - Bulk mail can pass `listUnsubscribe` to get the RFC 8058 one-click
 *     headers Gmail/Yahoo require of bulk senders.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

const sendMock = jest.fn();
jest.mock('../services/email-oauth.service', () => ({
  emailOAuthService: {
    ensureGmailClient: jest.fn(async () => ({
      users: {
        messages: {
          send: (...a: unknown[]) => sendMock(...a),
          get: jest.fn().mockResolvedValue({ data: { threadId: 'thread-1' } }),
        },
        threads: { get: jest.fn() },
      },
    })),
  },
  executeGmailWithProtection: (_name: string, fn: () => Promise<unknown>) => fn(),
}));

const getSettingValueMock = jest.fn();
jest.mock('../services/settings.service', () => ({
  getSettingValue: (...a: unknown[]) => getSettingValueMock(...a),
}));

import { sendEmail } from '../core/email/outbound/send';
import { formatFromHeader } from '../core/email/outbound/send';
import { EMAIL } from '../constants';

/** Headers of the raw RFC 2822 message handed to Gmail. */
function sentHeaders(): string[] {
  const raw = (sendMock.mock.calls[0][0] as { requestBody: { raw: string } }).requestBody.raw;
  const message = Buffer.from(raw, 'base64url').toString('utf-8');
  return message.split('\r\n\r\n')[0].split('\r\n');
}

beforeEach(() => {
  jest.clearAllMocks();
  sendMock.mockResolvedValue({ data: { id: 'msg-1' } });
  getSettingValueMock.mockResolvedValue(undefined);
});

describe('sendEmail headers', () => {
  it('sets an explicit From header with the scheduler address', async () => {
    await sendEmail({ to: 'client@example.com', subject: 'Hi', body: 'Hello' });

    expect(sentHeaders()).toContain(`From: "${EMAIL.FROM_NAME}" <${EMAIL.FROM_ADDRESS}>`);
  });

  it('uses the agent.fromName setting as the display name', async () => {
    getSettingValueMock.mockImplementation(async (key: string) => (key === 'agent.fromName' ? 'Sam, Spill' : undefined));

    await sendEmail({ to: 'client@example.com', subject: 'Hi', body: 'Hello' });

    // Quoted, so the comma cannot split the header into two addresses.
    expect(sentHeaders()).toContain(`From: "Sam, Spill" <${EMAIL.FROM_ADDRESS}>`);
  });

  it('adds RFC 8058 one-click unsubscribe headers when listUnsubscribe is given', async () => {
    await sendEmail({
      to: 'client@example.com',
      subject: 'Weekly',
      body: 'Hello',
      listUnsubscribe: { url: 'https://api.test/api/unsubscribe/v2:abc:def:ghi' },
    });

    const headers = sentHeaders();
    expect(headers).toContain('List-Unsubscribe: <https://api.test/api/unsubscribe/v2:abc:def:ghi>');
    expect(headers).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('omits the unsubscribe headers for ordinary (transactional) mail', async () => {
    await sendEmail({ to: 'client@example.com', subject: 'Hi', body: 'Hello' });

    expect(sentHeaders().some((h) => h.startsWith('List-Unsubscribe'))).toBe(false);
  });

  it('refuses an unsubscribe URL that could inject a header', async () => {
    await expect(
      sendEmail({
        to: 'client@example.com',
        subject: 'Weekly',
        body: 'Hello',
        listUnsubscribe: { url: 'https://api.test/x>\r\nBcc: victim@example.com' },
      }),
    ).rejects.toThrow(/listUnsubscribe/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('refuses a non-http(s) unsubscribe URL', async () => {
    await expect(
      sendEmail({ to: 'a@example.com', subject: 's', body: 'b', listUnsubscribe: { url: 'javascript:alert(1)' } }),
    ).rejects.toThrow(/http/);
  });
});

describe('formatFromHeader', () => {
  it('escapes quotes and backslashes inside the display name', () => {
    expect(formatFromHeader('Ann "A" \\ B', 'x@y.z')).toBe('"Ann \\"A\\" \\\\ B" <x@y.z>');
  });

  it('drops control characters so a name cannot start a new header line', () => {
    expect(formatFromHeader('Evil\r\nBcc: v@x.y', 'x@y.z')).toBe('"Evil Bcc: v@x.y" <x@y.z>');
  });

  it('RFC 2047-encodes non-ASCII names', () => {
    expect(formatFromHeader('Zoë', 'x@y.z')).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <x@y\.z>$/);
  });
});

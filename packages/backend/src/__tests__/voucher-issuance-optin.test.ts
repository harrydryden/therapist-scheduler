/**
 * issueWelcomeVoucher's opt-in gate: the public signup form is unverified,
 * so without an explicit weekly-email opt-in it must not clear a previous
 * opt-out (unsubscribedAt) or the expired-voucher strike count.
 *
 * (Setup copied from voucher-issuance.test.ts.)
 *
 * Original header follows:
 * Tests for the welcome-voucher issuance service.
 *
 * The bug being fixed: freshly-signed-up users had to wait for the
 * next weekly mailing tick to receive their first voucher, leaving
 * them stranded for up to a week if `voucher.required=true`.
 *
 * The contract pinned here:
 *   1. When voucher.enabled=false, the function is a no-op (no token,
 *      no DB write, no email).
 *   2. Happy path: token persisted, email sent, displayCode returned.
 *   3. tracking upsert failure → email is NOT sent (would mean a
 *      token in the wild that the booking endpoint can't revoke).
 *   4. email send failure → token IS persisted (user can still book
 *      if URL is shared out of band).
 *   5. The upsert clears `unsubscribedAt` and resets `strikeCount` to
 *      0 so a re-signup of an unsubscribed user revives their access.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    redisUrl: 'redis://localhost:6379',
    env: 'test',
    jwtSecret: 'test-secret',
    backendUrl: 'https://backend.test',
    frontendUrl: 'https://frontend.test',
  },
}));

const upsertMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    voucherTracking: {
      upsert: (...args: unknown[]) => upsertMock(...args),
    },
  },
}));

const settingsMock = jest.fn();
jest.mock('../services/settings.service', () => ({
  getSettingValue: (...args: unknown[]) => settingsMock(...args),
}));

const sendEmailMock = jest.fn();
jest.mock('../core/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

import { issueWelcomeVoucher } from '../services/voucher-issuance.service';

const SETTINGS_DEFAULTS: Record<string, unknown> = {
  'voucher.enabled': true,
  'voucher.expiryDays': 14,
  'weeklyMailing.webAppUrl': 'https://free.spill.app/book',
  'email.welcomeBookingSubject': 'Welcome {userName}',
  'email.welcomeBookingBody':
    'Hi {userName},\n\nThanks for signing up.\n\n{voucherSection}\n\nBook at {webAppUrl}.',
};

beforeEach(() => {
  jest.clearAllMocks();
  settingsMock.mockImplementation(async (key: string) => SETTINGS_DEFAULTS[key]);
  upsertMock.mockResolvedValue({});
  sendEmailMock.mockResolvedValue({});
});

describe('issueWelcomeVoucher optedIn', () => {
  it('without an opt-in keeps a previous opt-out and strikes', async () => {
    await issueWelcomeVoucher({ email: 'a@example.com', name: 'A', optedIn: false });
    const update = upsertMock.mock.calls[0][0].update;
    expect(update).not.toHaveProperty('unsubscribedAt');
    expect(update).not.toHaveProperty('strikeCount');
    expect(update.lastVoucherToken).toEqual(expect.any(String));
  });

  it('with an opt-in (or by default) revives access as before', async () => {
    await issueWelcomeVoucher({ email: 'a@example.com', name: 'A', optedIn: true });
    await issueWelcomeVoucher({ email: 'a@example.com', name: 'A' });
    for (const [call] of upsertMock.mock.calls) {
      expect(call.update).toMatchObject({ unsubscribedAt: null, strikeCount: 0 });
    }
  });
});

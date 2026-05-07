/**
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
jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: {
    sendEmail: (...args: unknown[]) => sendEmailMock(...args),
  },
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

describe('issueWelcomeVoucher', () => {
  it('happy path: persists tracking row + sends welcome email', async () => {
    const result = await issueWelcomeVoucher({ email: 'New@Example.com', name: 'New User' });

    expect(result.tokenIssued).toBe(true);
    expect(result.emailSent).toBe(true);
    expect(typeof result.displayCode).toBe('string');
    expect(result.skippedDisabled).toBeUndefined();

    // Tracking upsert: lower-cased email; lastVoucherToken set; strike reset.
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const upsertArgs = upsertMock.mock.calls[0][0];
    expect(upsertArgs.where.id).toBe('new@example.com');
    expect(upsertArgs.create.lastVoucherToken).toBeTruthy();
    expect(upsertArgs.create.strikeCount).toBe(0);
    // Update path resets strike + clears unsubscribedAt + reminderSentAt
    expect(upsertArgs.update.strikeCount).toBe(0);
    expect(upsertArgs.update.unsubscribedAt).toBeNull();
    expect(upsertArgs.update.reminderSentAt).toBeNull();

    // Email rendered + sent. Body contains the booking URL with the
    // voucher token embedded as a query param. Body uses the SHARED
    // voucher section (utils/voucher-section.ts::renderVoucherSection)
    // so the user-facing copy is identical to weekly-mailing's
    // first-issue text. Assert on the canonical "personal booking
    // link" phrase rather than on the displayCode (which the section
    // intentionally doesn't expose — the URL is enough for the user).
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sendArgs = sendEmailMock.mock.calls[0][0];
    expect(sendArgs.to).toBe('new@example.com');
    expect(sendArgs.subject).toContain('New User');
    expect(sendArgs.body).toContain('personal booking link');
    expect(sendArgs.body).toContain('https://free.spill.app/book?voucher=');
  });

  it('skips entirely when voucher.enabled is false', async () => {
    settingsMock.mockImplementation(async (key: string) =>
      key === 'voucher.enabled' ? false : SETTINGS_DEFAULTS[key],
    );

    const result = await issueWelcomeVoucher({ email: 'a@b.com' });

    expect(result.skippedDisabled).toBe(true);
    expect(result.tokenIssued).toBe(false);
    expect(result.emailSent).toBe(false);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does NOT send the email when tracking upsert fails (would orphan a token)', async () => {
    upsertMock.mockRejectedValueOnce(new Error('DB down'));

    const result = await issueWelcomeVoucher({ email: 'a@b.com' });

    expect(result.tokenIssued).toBe(false);
    expect(result.emailSent).toBe(false);
    // Critical: skipping the send when persistence fails means we
    // never ship a token the system can't revoke.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns tokenIssued=true emailSent=false when the email fails (token already persisted)', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('Gmail rate limited'));

    const result = await issueWelcomeVoucher({ email: 'a@b.com' });

    expect(result.tokenIssued).toBe(true);
    expect(result.emailSent).toBe(false);
    // Token stays in the DB — user can book if the URL is shared,
    // and admin can re-trigger the email manually.
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the email local-part when name is null/empty', async () => {
    await issueWelcomeVoucher({ email: 'jane.doe@example.com', name: null });
    expect(sendEmailMock.mock.calls[0][0].subject).toContain('jane.doe');

    await issueWelcomeVoucher({ email: 'john@example.com', name: '   ' });
    expect(sendEmailMock.mock.calls[1][0].subject).toContain('john');
  });

  it('voucher copy is coherent with the weekly mailing (same shared renderVoucherSection helper)', async () => {
    // The whole point of extracting renderVoucherSection into a shared
    // util: the welcome email's voucher block must match what the
    // weekly mailing produces for a first-issue voucher. If the two
    // ever drift (someone tweaks one path's hardcoded text), this
    // assertion catches it. We pin the canonical phrasing so a copy
    // change in the helper requires updating both consumers in
    // lockstep.
    await issueWelcomeVoucher({ email: 'coherence@example.com', name: 'Test' });

    const body = sendEmailMock.mock.calls[0][0].body as string;
    // Exact phrase from utils/voucher-section.ts::renderVoucherSection
    // for isReminder=false. Same string the weekly mailing injects.
    expect(body).toContain(
      "You've been allocated a new personal booking link. It expires on",
    );
    expect(body).toContain('please book before then');
  });

  it('lowercases the email everywhere (DB key + recipient)', async () => {
    await issueWelcomeVoucher({ email: 'Mixed.Case@Example.COM' });

    expect(upsertMock.mock.calls[0][0].where.id).toBe('mixed.case@example.com');
    expect(sendEmailMock.mock.calls[0][0].to).toBe('mixed.case@example.com');
  });

  it('proceeds with issuance when voucher.enabled lookup throws (safer to issue than silently skip)', async () => {
    settingsMock.mockImplementation(async (key: string) => {
      if (key === 'voucher.enabled') throw new Error('Settings DB down');
      return SETTINGS_DEFAULTS[key];
    });

    const result = await issueWelcomeVoucher({ email: 'a@b.com' });

    // We don't strand the user just because the settings lookup
    // hiccupped — the tracking upsert is the authoritative step.
    expect(result.tokenIssued).toBe(true);
    expect(result.emailSent).toBe(true);
  });
});

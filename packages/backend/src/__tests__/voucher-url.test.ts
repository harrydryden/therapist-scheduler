/**
 * Unit tests for `ensureVoucherUrlForUser`.
 *
 * The cancellation flow (therapist-initiated branch) injects a
 * voucher URL into the client apology email. The helper has to:
 *   - Return null when vouchers are disabled (so the email
 *     renders without a broken link).
 *   - Reuse an existing non-expired token when present (so the
 *     user's saved link from a weekly mailing keeps working).
 *   - Issue + persist a fresh token when no usable one exists.
 *   - Handle errors at every step without throwing — the email
 *     send shouldn't fail just because the voucher store glitched.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { frontendUrl: 'https://free.spill.app' },
}));

const mockFindUnique = jest.fn();
const mockUpsert = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    voucherTracking: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      upsert: (...a: unknown[]) => mockUpsert(...a),
    },
  },
}));

const mockGetSetting = jest.fn();
jest.mock('../services/settings.service', () => ({
  getSettingValue: (key: string) => mockGetSetting(key),
}));

// Stub out voucher-token so tests don't depend on HMAC + env config.
// The helper's contract is to produce a URL of the form
// `<webAppUrl>?voucher=<token>` — exact token bytes don't matter
// for these assertions.
const mockValidate = jest.fn();
jest.mock('../utils/voucher-token', () => ({
  generateVoucherUrl: (email: string, baseUrl: string) => ({
    token: `token-for-${email}`,
    displayCode: 'DISPLAY',
    expiresAt: new Date('2026-12-31T00:00:00Z'),
    url: `${baseUrl}?voucher=token-for-${email}`,
  }),
  validateVoucherToken: (token: string) => mockValidate(token),
}));

import { ensureVoucherUrlForUser } from '../services/voucher-url.service';

beforeEach(() => {
  jest.clearAllMocks();
  // Defaults — individual tests override.
  mockGetSetting.mockImplementation(async (key: string) => {
    if (key === 'voucher.enabled') return true;
    if (key === 'weeklyMailing.webAppUrl') return 'https://free.spill.app';
    if (key === 'voucher.expiryDays') return 14;
    return undefined;
  });
  mockFindUnique.mockResolvedValue(null);
  mockUpsert.mockResolvedValue({ id: 'noop' });
  mockValidate.mockReturnValue({ valid: false, email: null, expired: false });
});

describe('ensureVoucherUrlForUser', () => {
  it('returns null when vouchers are disabled', async () => {
    mockGetSetting.mockImplementation(async (key: string) =>
      key === 'voucher.enabled' ? false : 14,
    );
    const url = await ensureVoucherUrlForUser('user@example.com');
    expect(url).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('reuses an existing valid token without issuing a fresh one', async () => {
    mockFindUnique.mockResolvedValue({ lastVoucherToken: 'existing-token' });
    mockValidate.mockReturnValue({ valid: true, email: 'user@example.com', expired: false });

    const url = await ensureVoucherUrlForUser('user@example.com');
    expect(url).toBe('https://free.spill.app?voucher=existing-token');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('lowercases the email before looking up + reusing tokens', async () => {
    mockFindUnique.mockResolvedValue({ lastVoucherToken: 'existing-token' });
    mockValidate.mockReturnValue({ valid: true, email: 'mixedcase@example.com', expired: false });

    await ensureVoucherUrlForUser('MixedCase@Example.COM');

    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'mixedcase@example.com' } }),
    );
  });

  it('issues a fresh token when no existing one exists', async () => {
    mockFindUnique.mockResolvedValue(null);

    const url = await ensureVoucherUrlForUser('user@example.com');
    expect(url).toBe('https://free.spill.app?voucher=token-for-user@example.com');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user@example.com' },
        create: expect.objectContaining({
          id: 'user@example.com',
          lastVoucherToken: 'token-for-user@example.com',
          strikeCount: 0,
        }),
      }),
    );
  });

  it('issues a fresh token when the existing one is expired', async () => {
    mockFindUnique.mockResolvedValue({ lastVoucherToken: 'expired-token' });
    mockValidate.mockReturnValue({ valid: false, email: 'user@example.com', expired: true });

    const url = await ensureVoucherUrlForUser('user@example.com');
    expect(url).toBe('https://free.spill.app?voucher=token-for-user@example.com');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('issues a fresh token when the existing one validates to a different email', async () => {
    // Defensive: a tracking row whose stored token doesn't match
    // the user's email shouldn't be reused (corruption/tampering).
    mockFindUnique.mockResolvedValue({ lastVoucherToken: 'stale-token' });
    mockValidate.mockReturnValue({ valid: true, email: 'other@example.com', expired: false });

    const url = await ensureVoucherUrlForUser('user@example.com');
    expect(url).toBe('https://free.spill.app?voucher=token-for-user@example.com');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('returns null and does not throw when settings lookup fails', async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === 'voucher.enabled') return true;
      throw new Error('settings down');
    });

    const url = await ensureVoucherUrlForUser('user@example.com');
    expect(url).toBeNull();
  });

  it('falls through to fresh-issue when the existing-token lookup throws', async () => {
    mockFindUnique.mockRejectedValue(new Error('db down'));

    const url = await ensureVoucherUrlForUser('user@example.com');
    // Still produces a usable URL — we issued + persisted a fresh token.
    expect(url).toBe('https://free.spill.app?voucher=token-for-user@example.com');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('returns null when the fresh-issue upsert throws', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockUpsert.mockRejectedValue(new Error('db down'));

    const url = await ensureVoucherUrlForUser('user@example.com');
    expect(url).toBeNull();
  });
});

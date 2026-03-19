/**
 * Tests for the weekly mailing service's voucher lifecycle logic
 *
 * The service is a singleton class with private methods, so we test via
 * the public forceSend() entry point which exercises the same sendWeeklyEmail()
 * path without needing real Redis locks or timers.
 *
 * Covers:
 * - New user: issues fresh voucher
 * - Active unused voucher: sends reminder instead of new code
 * - Used voucher: resets strikes, issues fresh code
 * - Expired unused voucher: increments strike, issues new code
 * - Max strikes reached: sends final notice and auto-unsubscribes
 * - Non-voucher mode: sends plain email
 */

// ============================================
// Mocks (must be before imports)
// ============================================

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    jwtSecret: 'test-secret-key-for-unit-tests',
    backendUrl: 'https://backend.test',
  },
}));

jest.mock('../utils/database', () => ({
  prisma: {
    voucherTracking: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../utils/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) || null)),
      set: jest.fn((_key: string, value: string) => { store.set(_key, value); return Promise.resolve('OK'); }),
      __store: store,
    },
    cacheManager: {
      getString: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
    },
  };
});

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(),
  getSettingValues: jest.fn(),
}));

jest.mock('../services/notion-users.service', () => ({
  notionUsersService: {
    getEligibleMailingListUsers: jest.fn(),
    findUserByEmail: jest.fn(),
    updateSubscription: jest.fn(),
  },
}));

jest.mock('../services/notion.service', () => ({
  notionService: {
    fetchTherapists: jest.fn(),
  },
}));

jest.mock('../services/therapist-booking-status.service', () => ({
  therapistBookingStatusService: {
    getUnavailableTherapistIds: jest.fn(),
  },
}));

jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: {
    sendEmail: jest.fn(),
  },
}));

jest.mock('../utils/unsubscribe-token', () => ({
  generateUnsubscribeUrl: jest.fn().mockReturnValue('https://backend.test/unsubscribe/token'),
}));

jest.mock('../utils/locked-task-runner', () => ({
  LockedTaskRunner: jest.fn().mockImplementation(() => ({
    run: jest.fn(),
  })),
}));

// ============================================
// Imports
// ============================================

import { prisma } from '../utils/database';
import { redis } from '../utils/redis';
import { getSettingValue, getSettingValues } from '../services/settings.service';
import { notionUsersService } from '../services/notion-users.service';
import { emailProcessingService } from '../services/email-processing.service';

// Import after mocks — the singleton is created at import time
import { weeklyMailingListService } from '../services/weekly-mailing-list.service';

// ============================================
// Helpers
// ============================================

const testRedis = redis as unknown as { __store: Map<string, string> };

const testUser = { email: 'alice@example.com', name: 'Alice', pageId: 'notion-page-1' };

function setupSettings(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'weeklyMailing.enabled': true,
    'email.weeklyMailingSubject': 'Your code: {{voucherCode}}',
    'email.weeklyMailingBody': 'Hi {{userName}}, use {{voucherCode}} before {{voucherExpiry}}. {{webAppUrl}} {{unsubscribeUrl}}',
    'email.voucherReminderSubject': 'Reminder: {{voucherCode}}',
    'email.voucherReminderBody': 'Reminder: {{voucherCode}} expires {{voucherExpiry}}. {{webAppUrl}} {{unsubscribeUrl}}',
    'email.voucherFinalNoticeSubject': 'Goodbye {{userName}}',
    'email.voucherFinalNoticeBody': 'You have been unsubscribed. {{unsubscribeUrl}}',
    'weeklyMailing.webAppUrl': 'https://app.test',
    'voucher.enabled': true,
    'voucher.expiryDays': 14,
    'voucher.maxStrikes': 3,
    ...overrides,
  };

  (getSettingValue as jest.Mock).mockImplementation((key: string) => {
    return Promise.resolve(defaults[key]);
  });
  (getSettingValues as jest.Mock).mockImplementation((keys: string[]) => {
    const map = new Map();
    for (const key of keys) {
      map.set(key, defaults[key]);
    }
    return Promise.resolve(map);
  });
}

function makeTracking(overrides: Partial<{
  id: string;
  strikeCount: number;
  lastVoucherSentAt: Date | null;
  lastVoucherToken: string | null;
  lastVoucherUsedAt: Date | null;
  reminderSentAt: Date | null;
  unsubscribedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: 'alice@example.com',
    strikeCount: 0,
    lastVoucherSentAt: null,
    lastVoucherToken: null,
    lastVoucherUsedAt: null,
    reminderSentAt: null,
    unsubscribedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ============================================
// Tests
// ============================================

describe('Weekly Mailing Voucher Lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testRedis.__store.clear();
    setupSettings();

    // Default: one eligible user, service enabled
    (notionUsersService.getEligibleMailingListUsers as jest.Mock).mockResolvedValue([testUser]);
    (emailProcessingService.sendEmail as jest.Mock).mockResolvedValue(undefined);
    (prisma.voucherTracking.upsert as jest.Mock).mockResolvedValue({});
    (prisma.voucherTracking.update as jest.Mock).mockResolvedValue({});
  });

  // ---- New user: no tracking record ----

  it('issues a fresh voucher to a new user', async () => {
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);

    const result = await weeklyMailingListService.forceSend(true);

    expect(result.sent).toBe(1);
    expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(1);

    // Verify email contains a voucher code (word-word-word pattern)
    const emailCall = (emailProcessingService.sendEmail as jest.Mock).mock.calls[0][0];
    expect(emailCall.to).toBe('alice@example.com');
    expect(emailCall.subject).toMatch(/\w+-\w+-\w+/);

    // Verify tracking upsert was called with new token
    expect(prisma.voucherTracking.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = (prisma.voucherTracking.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertCall.create.id).toBe('alice@example.com');
    expect(upsertCall.create.lastVoucherToken).toBeTruthy();
  });

  // ---- Active unused voucher: send reminder ----

  it('sends reminder when active voucher is unused', async () => {
    const token = 'v1:abc:def:c2lnbmF0dXJl'; // fake but structurally valid
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
      makeTracking({
        lastVoucherSentAt: new Date(), // just sent
        lastVoucherToken: token,
      })
    );

    await weeklyMailingListService.forceSend(true);

    // Should send reminder, not new voucher
    const emailCall = (emailProcessingService.sendEmail as jest.Mock).mock.calls[0][0];
    expect(emailCall.subject).toMatch(/Reminder/i);

    // Should update reminderSentAt, NOT upsert new token
    expect(prisma.voucherTracking.update).toHaveBeenCalledTimes(1);
    const updateData = (prisma.voucherTracking.update as jest.Mock).mock.calls[0][0].data;
    expect(updateData.reminderSentAt).toBeInstanceOf(Date);
    expect(prisma.voucherTracking.upsert).not.toHaveBeenCalled();
  });

  // ---- Used voucher: reset strikes, issue new ----

  it('resets strikes when previous voucher was used', async () => {
    const sentAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000); // 20 days ago (expired)
    const usedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago (after send)
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
      makeTracking({
        lastVoucherSentAt: sentAt,
        lastVoucherToken: 'v1:old:tok:sig',
        lastVoucherUsedAt: usedAt,
        strikeCount: 2,
      })
    );

    await weeklyMailingListService.forceSend(true);

    // Strike should be reset to 0 (reward for using voucher)
    const updateCalls = (prisma.voucherTracking.update as jest.Mock).mock.calls;
    const strikeResetCall = updateCalls.find((c: unknown[]) =>
      (c[0] as { data: { strikeCount?: number } }).data.strikeCount === 0
    );
    expect(strikeResetCall).toBeTruthy();

    // New voucher should be issued
    expect(prisma.voucherTracking.upsert).toHaveBeenCalledTimes(1);
    expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(1);
  });

  // ---- Expired unused voucher: increment strike ----

  it('increments strike when voucher expired unused', async () => {
    const sentAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000); // 20 days ago
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
      makeTracking({
        lastVoucherSentAt: sentAt,
        lastVoucherToken: 'v1:old:tok:sig',
        strikeCount: 1,
      })
    );

    await weeklyMailingListService.forceSend(true);

    // Strike should be incremented from 1 to 2
    const updateCalls = (prisma.voucherTracking.update as jest.Mock).mock.calls;
    const strikeCall = updateCalls.find((c: unknown[]) =>
      (c[0] as { data: { strikeCount?: number } }).data.strikeCount === 2
    );
    expect(strikeCall).toBeTruthy();

    // New voucher should still be issued (under max strikes)
    expect(prisma.voucherTracking.upsert).toHaveBeenCalledTimes(1);
  });

  // ---- Max strikes: auto-unsubscribe ----

  it('auto-unsubscribes when max strikes reached', async () => {
    const sentAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
      makeTracking({
        lastVoucherSentAt: sentAt,
        lastVoucherToken: 'v1:old:tok:sig',
        strikeCount: 2, // maxStrikes is 3, so incrementing to 3 triggers unsub
      })
    );
    (notionUsersService.updateSubscription as jest.Mock).mockResolvedValue(undefined);

    await weeklyMailingListService.forceSend(true);

    // Should send final notice email (not a voucher email)
    const emailCall = (emailProcessingService.sendEmail as jest.Mock).mock.calls[0][0];
    expect(emailCall.subject).toMatch(/Goodbye/i);

    // Should update tracking with unsubscribedAt and clear token
    const updateCalls = (prisma.voucherTracking.update as jest.Mock).mock.calls;
    const unsubCall = updateCalls.find((c: unknown[]) =>
      (c[0] as { data: { unsubscribedAt?: Date } }).data.unsubscribedAt instanceof Date
    );
    expect(unsubCall).toBeTruthy();
    expect((unsubCall![0] as { data: { lastVoucherToken: null; strikeCount: number } }).data.lastVoucherToken).toBeNull();
    expect((unsubCall![0] as { data: { strikeCount: number } }).data.strikeCount).toBe(3);

    // Should NOT issue a new voucher
    expect(prisma.voucherTracking.upsert).not.toHaveBeenCalled();

    // Should unsubscribe in Notion
    expect(notionUsersService.updateSubscription).toHaveBeenCalledWith('notion-page-1', false);
  });

  // ---- Non-voucher mode ----

  it('sends plain email when vouchers are disabled', async () => {
    setupSettings({ 'voucher.enabled': false });

    await weeklyMailingListService.forceSend(true);

    expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(1);
    // Should NOT touch voucher tracking at all
    expect(prisma.voucherTracking.findUnique).not.toHaveBeenCalled();
    expect(prisma.voucherTracking.upsert).not.toHaveBeenCalled();
  });

  // ---- Service disabled ----

  it('throws when service is disabled', async () => {
    setupSettings({ 'weeklyMailing.enabled': false });

    await expect(weeklyMailingListService.forceSend(true)).rejects.toThrow(/disabled/i);
    expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
  });

  // ---- Multiple users ----

  it('processes multiple users independently', async () => {
    const user2 = { email: 'bob@example.com', name: 'Bob', pageId: 'notion-page-2' };
    (notionUsersService.getEligibleMailingListUsers as jest.Mock).mockResolvedValue([testUser, user2]);
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);

    const result = await weeklyMailingListService.forceSend(true);

    expect(result.sent).toBe(2);
    expect(result.total).toBe(2);
    expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(2);
    expect(prisma.voucherTracking.upsert).toHaveBeenCalledTimes(2);
  });

  // ---- Partial failure ----

  it('continues sending to other users when one fails', async () => {
    const user2 = { email: 'bob@example.com', name: 'Bob', pageId: 'notion-page-2' };
    (notionUsersService.getEligibleMailingListUsers as jest.Mock).mockResolvedValue([testUser, user2]);
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);
    (emailProcessingService.sendEmail as jest.Mock)
      .mockRejectedValueOnce(new Error('SMTP error'))
      .mockResolvedValueOnce(undefined);

    const result = await weeklyMailingListService.forceSend(true);

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(2);
  });

  // ---- Missing token on active voucher falls back to new voucher ----

  it('issues new voucher when active tracking has no token', async () => {
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
      makeTracking({
        lastVoucherSentAt: new Date(), // active
        lastVoucherToken: null,        // but token missing
      })
    );

    await weeklyMailingListService.forceSend(true);

    // Should issue new voucher, not send reminder
    expect(prisma.voucherTracking.upsert).toHaveBeenCalledTimes(1);
    const emailCall = (emailProcessingService.sendEmail as jest.Mock).mock.calls[0][0];
    // Should be the regular email, not reminder
    expect(emailCall.subject).not.toMatch(/Reminder/i);
  });
});

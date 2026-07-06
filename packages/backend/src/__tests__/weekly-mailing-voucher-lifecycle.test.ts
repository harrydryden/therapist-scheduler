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
 * - New therapists section: detected via Redis-tracked known IDs
 * - Unified email: both new-voucher and reminder use the same template
 * - Voucher code not shown as literal text (only in booking link)
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
    user: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    therapist: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    appointmentRequest: {
      findMany: jest.fn(),
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
import { SETTING_DEFINITIONS } from '../config/setting-definitions';
import { getSettingValue, getSettingValues } from '../services/settings.service';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { emailProcessingService } from '../services/email-processing.service';

// Import after mocks — the singleton is created at import time
import { weeklyMailingListService } from '../services/weekly-mailing-list.service';

// ============================================
// Helpers
// ============================================

const testRedis = redis as unknown as { __store: Map<string, string> };

// MailingListUser shape (id is the Postgres user uuid post-Notion-deprecation).
const testUser = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };

// Postgres Therapist rows as returned by prisma.therapist.findMany. The
// service maps these into MailingListTherapist instances internally; we only
// need the columns the service selects: id, notionId, name, areasOfFocus.
const testTherapists = [
  { id: 'therapist-1', notionId: 'therapist-1', name: 'Dr Smith', areasOfFocus: ['anxiety', 'stress'] },
  { id: 'therapist-2', notionId: 'therapist-2', name: 'Dr Jones', areasOfFocus: ['relationships'] },
];

function setupSettings(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'weeklyMailing.enabled': true,
    'email.weeklyMailingSubject': 'Your weekly therapy update',
    'email.weeklyMailingBody': 'Hi {userName},\n\nHere\'s your weekly update.\n{newTherapistsSection}\n{voucherSection}\n\n[Book your free session]({webAppUrl})\n\nBest wishes,\n\nJustin\n\n---\n[Unsubscribe]({unsubscribeUrl})',
    'email.voucherFinalNoticeSubject': 'Goodbye {userName}',
    'email.voucherFinalNoticeBody': 'You have been unsubscribed. {unsubscribeUrl}',
    'weeklyMailing.webAppUrl': 'https://app.test',
    'voucher.enabled': true,
    'voucher.expiryDays': 14,
    'voucher.maxStrikes': 3,
    // Enabled here so the legacy unsubscribe-path tests exercise it; the
    // PLATFORM default is false (asserted below) so deploys don't free up
    // anyone's spot unless an admin opts in.
    'voucher.autoUnsubscribeEnabled': true,
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

    // Default: one eligible user, service enabled, therapists available.
    // Postgres-backed wiring: user.findMany returns subscribed users (after
    // appointmentRequest.findMany filters out anyone with a pending booking),
    // therapist.findMany returns active therapists.
    (prisma.user.findMany as jest.Mock).mockResolvedValue([testUser]);
    (prisma.user.update as jest.Mock).mockResolvedValue({});
    (prisma.appointmentRequest.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.therapist.findMany as jest.Mock).mockResolvedValue(testTherapists);
    (therapistBookingStatusService.getUnavailableTherapistIds as jest.Mock).mockResolvedValue([]);
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

    // Verify email uses the unified subject (no voucher code in subject)
    const emailCall = (emailProcessingService.sendEmail as jest.Mock).mock.calls[0][0];
    expect(emailCall.to).toBe('alice@example.com');
    expect(emailCall.subject).toBe('Your weekly therapy update');

    // Verify body contains voucher section about new booking link
    expect(emailCall.body).toContain('new personal booking link');
    expect(emailCall.body).toContain('expires on');

    // Verify voucher code is NOT shown as literal text in body
    // (the word-word-word pattern should not appear in the body text)
    const bodyWithoutUrls = emailCall.body.replace(/https?:\/\/[^\s)]+/g, '');
    expect(bodyWithoutUrls).not.toMatch(/\b\w+-\w+-\w+\b/);

    // Verify booking link contains the voucher token
    expect(emailCall.body).toMatch(/\[Book your free session\]\(https:\/\/app\.test\?voucher=/);

    // Verify tracking upsert was called with new token
    expect(prisma.voucherTracking.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = (prisma.voucherTracking.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertCall.create.id).toBe('alice@example.com');
    expect(upsertCall.create.lastVoucherToken).toBeTruthy();
  });

  // ---- Active unused voucher: send reminder in unified email ----

  it('sends unified email with reminder section when active voucher is unused', async () => {
    const token = 'v1:abc:def:c2lnbmF0dXJl'; // fake but structurally valid
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
      makeTracking({
        lastVoucherSentAt: new Date(), // just sent
        lastVoucherToken: token,
      })
    );

    await weeklyMailingListService.forceSend(true);

    // Should send unified email (same subject), not separate reminder
    const emailCall = (emailProcessingService.sendEmail as jest.Mock).mock.calls[0][0];
    expect(emailCall.subject).toBe('Your weekly therapy update');

    // Body should contain reminder text
    expect(emailCall.body).toContain('reminder');
    expect(emailCall.body).toContain('booking link expires');

    // Voucher code should NOT appear as text
    const bodyWithoutUrls = emailCall.body.replace(/https?:\/\/[^\s)]+/g, '');
    expect(bodyWithoutUrls).not.toMatch(/\b\w+-\w+-\w+\b/);

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

    // Strike reset and new voucher are now atomic in a single upsert
    expect(prisma.voucherTracking.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = (prisma.voucherTracking.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertCall.create.strikeCount).toBe(0);
    expect(upsertCall.update.strikeCount).toBe(0);

    // New voucher should be issued
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

    // Strike increment and new voucher are now atomic in a single upsert
    expect(prisma.voucherTracking.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = (prisma.voucherTracking.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertCall.create.strikeCount).toBe(2);
    expect(upsertCall.update.strikeCount).toBe(2);
  });

  // ---- Max strikes: auto-unsubscribe (only when the toggle is on) ----

  it('auto-unsubscribes when max strikes reached', async () => {
    const sentAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
      makeTracking({
        lastVoucherSentAt: sentAt,
        lastVoucherToken: 'v1:old:tok:sig',
        strikeCount: 2, // maxStrikes is 3, so incrementing to 3 triggers unsub
      })
    );
    (prisma.user.update as jest.Mock).mockResolvedValue({});

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

    // Should unsubscribe by writing subscribed=false in Postgres
    // (the Notion mirror was retired in PR 2 of the deprecation).
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: testUser.id },
      data: { subscribed: false },
    });
  });

  it('keeps the user subscribed at max strikes when auto-unsubscribe is disabled', async () => {
    setupSettings({ 'voucher.autoUnsubscribeEnabled': false });
    const sentAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
      makeTracking({
        lastVoucherSentAt: sentAt,
        lastVoucherToken: 'v1:old:tok:sig',
        strikeCount: 2, // incrementing to 3 hits maxStrikes
      })
    );

    await weeklyMailingListService.forceSend(true);

    // The user gets a normal weekly email with a fresh code, NOT the
    // final "freeing up your spot" notice.
    expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(1);
    const emailCall = (emailProcessingService.sendEmail as jest.Mock).mock.calls[0][0];
    expect(emailCall.subject).toBe('Your weekly therapy update');
    expect(emailCall.subject).not.toMatch(/Goodbye/i);

    // They retain access: no unsubscribe write anywhere.
    expect(prisma.user.update).not.toHaveBeenCalled();
    const unsubWrites = (prisma.voucherTracking.update as jest.Mock).mock.calls.filter(
      (c: unknown[]) => (c[0] as { data: { unsubscribedAt?: Date } }).data.unsubscribedAt instanceof Date
    );
    expect(unsubWrites).toHaveLength(0);

    // Strikes keep counting for visibility, atomically with the new voucher.
    expect(prisma.voucherTracking.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = (prisma.voucherTracking.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertCall.update.strikeCount).toBe(3);
    expect(upsertCall.update.lastVoucherToken).toBeTruthy();
  });

  it('never unsubscribes when the toggle lookup returns undefined (fail-safe)', async () => {
    // A missing/failed setting read must not free up anyone's spot.
    setupSettings({ 'voucher.autoUnsubscribeEnabled': undefined });
    const sentAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
      makeTracking({
        lastVoucherSentAt: sentAt,
        lastVoucherToken: 'v1:old:tok:sig',
        strikeCount: 2,
      })
    );

    await weeklyMailingListService.forceSend(true);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.voucherTracking.upsert).toHaveBeenCalledTimes(1);
  });

  it('ships with auto-unsubscribe disabled by default', () => {
    // The platform default is the effective value until an admin opts in —
    // this guard is what "turn off freeing up spots" rests on.
    expect(SETTING_DEFINITIONS['voucher.autoUnsubscribeEnabled'].defaultValue).toBe(false);
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
    const user2 = { id: 'user-2', email: 'bob@example.com', name: 'Bob' };
    (prisma.user.findMany as jest.Mock).mockResolvedValue([testUser, user2]);
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);

    const result = await weeklyMailingListService.forceSend(true);

    expect(result.sent).toBe(2);
    expect(result.total).toBe(2);
    expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(2);
    expect(prisma.voucherTracking.upsert).toHaveBeenCalledTimes(2);
  });

  // ---- Partial failure ----

  it('continues sending to other users when one fails', async () => {
    const user2 = { id: 'user-2', email: 'bob@example.com', name: 'Bob' };
    (prisma.user.findMany as jest.Mock).mockResolvedValue([testUser, user2]);
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
    // Should contain new booking link text, not reminder text
    expect(emailCall.body).toContain('new personal booking link');
  });

  // ---- {newTherapistsSection} back-compat — renders empty so custom
  //      templates that still reference it don't blow up. ----

  it('renders the legacy {newTherapistsSection} variable as empty', async () => {
    setupSettings({
      'email.weeklyMailingBody':
        'Hi {userName},\n[NTS_START]{newTherapistsSection}[NTS_END]\n{voucherSection}\n\n[Book]({webAppUrl})\n[Unsub]({unsubscribeUrl})',
    });
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);

    await weeklyMailingListService.forceSend(true);

    const emailCall = (emailProcessingService.sendEmail as jest.Mock).mock.calls[0][0];
    // The marker bookends should appear adjacent (no content between them)
    // and the literal `{newTherapistsSection}` token must not survive.
    expect(emailCall.body).not.toContain('{newTherapistsSection}');
    expect(emailCall.body).toMatch(/\[NTS_START\]\s*\[NTS_END\]/);
  });
});

/**
 * Tests for the trigger / gating logic of the weekly mailing service.
 *
 * The voucher-lifecycle tests exercise forceSend() — which bypasses
 * the periodic gate by design. These tests drive the periodic `tick()`
 * path through `trigger()` (the LockedPeriodicService entry point used
 * by the runtime) so we can verify when a send actually fires:
 *
 *   - event-triggered: new therapist ingested since last send
 *   - threshold: directory holds ≥ availableThreshold active therapists
 *   - 7-day ceiling: never twice in the same week
 *   - empty directory: skip
 *   - service disabled: skip
 *   - first-ever run: treats every active therapist as new
 *
 * Also covers previewSend() (read-only, used by the admin button).
 */

// ============================================
// Mocks (must be before imports)
// ============================================

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { jwtSecret: 'test-secret', backendUrl: 'https://backend.test' },
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

// Redis is shared between hasAlreadySentThisWeek() and getLastSentAt() —
// they both read WEEKLY_MAILING.LAST_SEND_KEY. The in-memory store
// preserves writes within a test so markAsSent() round-trips correctly.
jest.mock('../utils/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: jest.fn((key: string, value: string) => { store.set(key, value); return Promise.resolve('OK'); }),
      del: jest.fn((key: string) => { store.delete(key); return Promise.resolve(1); }),
      __store: store,
    },
    cacheManager: { getString: jest.fn().mockResolvedValue(null), set: jest.fn() },
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
  emailProcessingService: { sendEmail: jest.fn() },
}));

jest.mock('../utils/unsubscribe-token', () => ({
  generateUnsubscribeUrl: jest.fn().mockReturnValue('https://backend.test/unsubscribe/token'),
}));

// LockedPeriodicService base class — short-circuit lock acquisition so
// trigger() runs the tick directly without needing real Redis locks.
jest.mock('../utils/locked-periodic-service', () => {
  return {
    LockedPeriodicService: class {
      protected async tick(_ctx: { isLockValid: () => boolean }): Promise<void> {
        // Subclass overrides this; the base no-op is fine for the type.
      }
      async trigger(): Promise<void> {
        // Bypass the lock and run the subclass tick directly.
        // The isLockValid stub always returns true (no concurrent loss).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (this as any).tick({ isLockValid: () => true });
      }
    },
  };
});

// ============================================
// Imports
// ============================================

import { prisma } from '../utils/database';
import { redis } from '../utils/redis';
import { getSettingValue, getSettingValues } from '../services/settings.service';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { emailProcessingService } from '../services/email-processing.service';
import { weeklyMailingListService } from '../services/weekly-mailing-list.service';
import { WEEKLY_MAILING } from '../constants';

// ============================================
// Helpers
// ============================================

const testRedis = redis as unknown as { __store: Map<string, string> };

const testUser = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };

const testTherapistRows = [
  { id: 't-1', notionId: 't-1', name: 'Dr Smith', areasOfFocus: ['anxiety'] },
  { id: 't-2', notionId: 't-2', name: 'Dr Jones', areasOfFocus: ['relationships'] },
];

function setupSettings(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'weeklyMailing.enabled': true,
    'weeklyMailing.availableThreshold': 5,
    'weeklyMailing.webAppUrl': 'https://app.test',
    'email.weeklyMailingSubject': 'Your weekly therapy update',
    'email.weeklyMailingBody': 'Hi {userName},\n\n{voucherSection}\n[Book]({webAppUrl})\n[Unsub]({unsubscribeUrl})',
    'email.voucherFinalNoticeSubject': 'Goodbye',
    'email.voucherFinalNoticeBody': 'Bye {userName} {unsubscribeUrl}',
    'voucher.enabled': false,
    'voucher.expiryDays': 14,
    'voucher.maxStrikes': 3,
    ...overrides,
  };

  (getSettingValue as jest.Mock).mockImplementation((key: string) => Promise.resolve(defaults[key]));
  (getSettingValues as jest.Mock).mockImplementation((keys: string[]) => {
    const map = new Map();
    for (const k of keys) map.set(k, defaults[k]);
    return Promise.resolve(map);
  });
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// ============================================
// Tick (periodic-trigger) tests
// ============================================

describe('Weekly Mailing — periodic trigger gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testRedis.__store.clear();
    setupSettings();

    (prisma.user.findMany as jest.Mock).mockResolvedValue([testUser]);
    (prisma.appointmentRequest.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.therapist.findMany as jest.Mock).mockResolvedValue(testTherapistRows);
    (prisma.therapist.count as jest.Mock).mockResolvedValue(0); // default: no new therapists
    (therapistBookingStatusService.getUnavailableTherapistIds as jest.Mock).mockResolvedValue([]);
    (emailProcessingService.sendEmail as jest.Mock).mockResolvedValue(undefined);
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);
  });

  it('skips when service is disabled', async () => {
    setupSettings({ 'weeklyMailing.enabled': false });

    await weeklyMailingListService.trigger();

    expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
    expect(prisma.therapist.count).not.toHaveBeenCalled();
  });

  it('skips when no therapists are available', async () => {
    (prisma.therapist.findMany as jest.Mock).mockResolvedValue([]);

    await weeklyMailingListService.trigger();

    expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
  });

  it('fires the event-triggered fast lane when a new therapist exists since last send', async () => {
    // Below threshold (2 < 5) so only the event path can trigger.
    testRedis.__store.set(WEEKLY_MAILING.LAST_SEND_KEY, daysAgo(10).toISOString());
    (prisma.therapist.count as jest.Mock).mockResolvedValue(1);

    await weeklyMailingListService.trigger();

    expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(1);
    // Verify the count query targeted active therapists with ingestedAt > lastSent
    const countCall = (prisma.therapist.count as jest.Mock).mock.calls[0][0];
    expect(countCall.where.active).toBe(true);
    expect(countCall.where.ingestedAt).toMatchObject({ gt: expect.any(Date) });
  });

  it('fires the weekly cadence when available count meets the threshold (no new therapists)', async () => {
    testRedis.__store.set(WEEKLY_MAILING.LAST_SEND_KEY, daysAgo(10).toISOString());
    // 5 therapists at threshold = 5
    const fiveRows = Array.from({ length: 5 }, (_, i) => ({
      id: `t-${i}`, notionId: `t-${i}`, name: `Dr ${i}`, areasOfFocus: [],
    }));
    (prisma.therapist.findMany as jest.Mock).mockResolvedValue(fiveRows);
    (prisma.therapist.count as jest.Mock).mockResolvedValue(0); // no new arrivals

    await weeklyMailingListService.trigger();

    expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('skips when below threshold AND no new therapists since last send', async () => {
    testRedis.__store.set(WEEKLY_MAILING.LAST_SEND_KEY, daysAgo(10).toISOString());
    // 2 therapists < threshold 5, no new
    (prisma.therapist.count as jest.Mock).mockResolvedValue(0);

    await weeklyMailingListService.trigger();

    expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
  });

  it('respects the 7-day ceiling — same day re-trigger is a no-op', async () => {
    testRedis.__store.set(WEEKLY_MAILING.LAST_SEND_KEY, new Date().toISOString());
    (prisma.therapist.count as jest.Mock).mockResolvedValue(10); // event-trigger ready

    await weeklyMailingListService.trigger();

    expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
    // Ceiling check must short-circuit before evaluating trigger conditions.
    expect(prisma.therapist.count).not.toHaveBeenCalled();
  });

  it('respects the 7-day ceiling — 3-day gap is still blocked', async () => {
    testRedis.__store.set(WEEKLY_MAILING.LAST_SEND_KEY, daysAgo(3).toISOString());
    (prisma.therapist.count as jest.Mock).mockResolvedValue(10);

    await weeklyMailingListService.trigger();

    expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
  });

  it('treats every active therapist as new on the first-ever run (no lastSent)', async () => {
    // No LAST_SEND_KEY in Redis.
    (prisma.therapist.count as jest.Mock).mockResolvedValue(2);

    await weeklyMailingListService.trigger();

    expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(1);
    // The query should filter ingestedAt != null (rather than gt: lastSent)
    const countCall = (prisma.therapist.count as jest.Mock).mock.calls[0][0];
    expect(countCall.where.ingestedAt).toEqual({ not: null });
  });

  it('marks as sent even when there are no eligible users (avoids hourly rechecking)', async () => {
    testRedis.__store.set(WEEKLY_MAILING.LAST_SEND_KEY, daysAgo(10).toISOString());
    (prisma.therapist.count as jest.Mock).mockResolvedValue(1);
    (prisma.user.findMany as jest.Mock).mockResolvedValue([]); // no eligible users

    await weeklyMailingListService.trigger();

    expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
    // LAST_SEND_KEY should now be a fresh timestamp
    const lastSent = testRedis.__store.get(WEEKLY_MAILING.LAST_SEND_KEY);
    expect(lastSent).toBeTruthy();
    const lastSentDate = new Date(lastSent!);
    expect(Date.now() - lastSentDate.getTime()).toBeLessThan(5000);
  });

  it('writes the new send timestamp using the longer TTL', async () => {
    testRedis.__store.set(WEEKLY_MAILING.LAST_SEND_KEY, daysAgo(10).toISOString());
    (prisma.therapist.count as jest.Mock).mockResolvedValue(1);

    await weeklyMailingListService.trigger();

    // Verify the underlying redis.set call used WEEKLY_MAILING.LAST_SEND_TTL_SECONDS
    // (the 8-day TTL was insufficient for the cutoff semantics).
    const setCalls = (redis.set as jest.Mock).mock.calls;
    const markSentCall = setCalls.find(c => c[0] === WEEKLY_MAILING.LAST_SEND_KEY);
    expect(markSentCall).toBeTruthy();
    expect(markSentCall[2]).toBe('EX');
    expect(markSentCall[3]).toBe(WEEKLY_MAILING.LAST_SEND_TTL_SECONDS);
  });
});

// ============================================
// previewSend() tests
// ============================================

describe('Weekly Mailing — previewSend()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testRedis.__store.clear();
    setupSettings();

    (prisma.user.findMany as jest.Mock).mockResolvedValue([testUser]);
    (prisma.appointmentRequest.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('returns enabled flag, recipient count, and rendered subject/body', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue([
      testUser,
      { id: 'u-2', email: 'b@x.com', name: 'Bob' },
    ]);

    const preview = await weeklyMailingListService.previewSend();

    expect(preview.enabled).toBe(true);
    expect(preview.recipientCount).toBe(2);
    expect(preview.subjectPreview).toBe('Your weekly therapy update');
    expect(preview.bodyPreview).toContain('Hi there,'); // placeholder name
    expect(preview.bodyPreview).not.toContain('{userName}');
    expect(preview.bodyPreview).not.toContain('{voucherSection}');
  });

  it('reports enabled=false when the service is disabled but still renders the preview', async () => {
    setupSettings({ 'weeklyMailing.enabled': false });
    (prisma.user.findMany as jest.Mock).mockResolvedValue([testUser]);

    const preview = await weeklyMailingListService.previewSend();

    expect(preview.enabled).toBe(false);
    // Recipient count should still reflect reality (1 eligible user).
    expect(preview.recipientCount).toBe(1);
    expect(preview.subjectPreview).toBeTruthy();
  });

  it('renders the new-voucher form when vouchers are enabled', async () => {
    setupSettings({ 'voucher.enabled': true });

    const preview = await weeklyMailingListService.previewSend();

    // The new-voucher copy contains "new personal booking link" (from
    // renderVoucherSection({ isReminder: false })). If voucher rendering
    // breaks the preview, this gives us a clear signal at the contract.
    expect(preview.bodyPreview).toMatch(/new personal booking link|booking link/);
  });

  it('renders an empty voucher section when vouchers are disabled', async () => {
    setupSettings({ 'voucher.enabled': false });

    const preview = await weeklyMailingListService.previewSend();

    expect(preview.bodyPreview).not.toMatch(/booking link expires|new personal booking link/);
  });
});

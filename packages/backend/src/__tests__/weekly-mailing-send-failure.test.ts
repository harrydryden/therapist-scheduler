/**
 * Tests for the weekly mailing's failure handling.
 *
 * Background: the service used to call markAsSent() unconditionally after
 * the send loop. Because that marker drives BOTH the 7-day ceiling and the
 * "new therapists since last send" event trigger, a run where every send
 * failed (broken Gmail credentials, open circuit breaker) silently bought a
 * week of quiet and consumed the fast lane — then repeated the next week.
 * A transient transport outage became a permanent mailing outage, with no
 * alert and only debug-level logs.
 *
 * These tests pin the corrected contract:
 *   - all sends fail        → do NOT mark, alert, retry on the next tick
 *   - some sends succeed    → mark (don't re-email the ones that worked)
 *   - eligible-user lookup fails → throw, do NOT mark
 *   - genuinely zero users  → mark (nothing to retry)
 *   - overdue mailing       → Slack alert, throttled
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
    voucherTracking: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    user: {
      findMany: jest.fn(),
      update: jest.fn(),
      // Per-recipient send-once guard; default: no prior sends, claims succeed.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      aggregate: jest.fn().mockResolvedValue({ _max: { lastWeeklyMailingAt: null } }),
    },
    therapist: { findMany: jest.fn(), count: jest.fn() },
    appointmentRequest: { findMany: jest.fn() },
  },
}));

// In-memory Redis so markAsSent() round-trips and acquireLock() behaves as
// a real SET-NX (first caller in the window wins) — the alert throttle
// depends on that semantic.
jest.mock('../utils/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      getStrict: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: jest.fn((key: string, value: string) => { store.set(key, value); return Promise.resolve('OK'); }),
      del: jest.fn((key: string) => { store.delete(key); return Promise.resolve(1); }),
      acquireLock: jest.fn((key: string, value: string) => {
        if (store.has(key)) return Promise.resolve(false);
        store.set(key, value);
        return Promise.resolve(true);
      }),
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
  therapistBookingStatusService: { getUnavailableTherapistIds: jest.fn() },
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: jest.fn().mockResolvedValue(true) },
}));

jest.mock('../core/email', () => ({ sendEmail: jest.fn() }));

jest.mock('../utils/unsubscribe-token', () => ({
  generateUnsubscribeUrl: jest.fn().mockReturnValue('https://backend.test/unsubscribe/token'),
}));

jest.mock('../utils/locked-periodic-service', () => {
  return {
    LockedPeriodicService: class {
      protected async tick(_ctx: { isLockValid: () => boolean }): Promise<void> {}
      async trigger(): Promise<void> {
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
import { slackNotificationService } from '../services/slack-notification.service';
import { sendEmail } from '../core/email';
import { weeklyMailingListService } from '../services/weekly-mailing-list.service';
import { WEEKLY_MAILING } from '../constants';

// ============================================
// Helpers
// ============================================

const testRedis = redis as unknown as { __store: Map<string, string> };

const users = [
  { id: 'user-1', email: 'alice@example.com', name: 'Alice' },
  { id: 'user-2', email: 'bob@example.com', name: 'Bob' },
];

// Six available therapists clears the default threshold of 5, so the
// periodic tick reaches the send loop without needing a new-therapist event.
const therapistRows = Array.from({ length: 6 }, (_, i) => ({
  id: `t-${i}`,
  notionId: `t-${i}`,
  name: `Dr ${i}`,
  areasOfFocus: ['anxiety'],
}));

function setupSettings(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'weeklyMailing.enabled': true,
    'weeklyMailing.availableThreshold': 5,
    'weeklyMailing.webAppUrl': 'https://app.test',
    'email.weeklyMailingSubject': 'Your weekly therapy update',
    'email.weeklyMailingBody': 'Hi {userName}, {voucherSection} [Book]({webAppUrl}) [Unsub]({unsubscribeUrl})',
    'email.voucherFinalNoticeSubject': 'Goodbye',
    'email.voucherFinalNoticeBody': 'Bye {userName} {unsubscribeUrl}',
    'voucher.enabled': false,
    'voucher.expiryDays': 14,
    'voucher.maxStrikes': 3,
    'voucher.autoUnsubscribeEnabled': false,
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

/** Seed the last-send marker so the 7-day ceiling has a known anchor. */
function setLastSent(when: Date) {
  testRedis.__store.set(WEEKLY_MAILING.LAST_SEND_KEY, when.toISOString());
}

function lastSentMarker(): string | undefined {
  return testRedis.__store.get(WEEKLY_MAILING.LAST_SEND_KEY);
}

beforeEach(() => {
  jest.clearAllMocks();
  testRedis.__store.clear();
  setupSettings();

  (prisma.user.findMany as jest.Mock).mockResolvedValue(users);
  (prisma.appointmentRequest.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.therapist.findMany as jest.Mock).mockResolvedValue(therapistRows);
  (prisma.therapist.count as jest.Mock).mockResolvedValue(0);
  (therapistBookingStatusService.getUnavailableTherapistIds as jest.Mock).mockResolvedValue([]);
  (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);
  (sendEmail as jest.Mock).mockResolvedValue(undefined);
});

// ============================================
// Total send failure
// ============================================

describe('Weekly mailing — total send failure', () => {
  it('does not consume the send window when every email fails', async () => {
    setLastSent(daysAgo(8));
    const marker = lastSentMarker();
    (sendEmail as jest.Mock).mockRejectedValue(new Error('Gmail client not initialized'));

    await weeklyMailingListService.trigger();

    expect(sendEmail).toHaveBeenCalledTimes(users.length);
    // The marker must be untouched — this is the whole bug.
    expect(lastSentMarker()).toBe(marker);
  });

  it('raises a high-severity Slack alert when every email fails', async () => {
    setLastSent(daysAgo(8));
    (sendEmail as jest.Mock).mockRejectedValue(new Error('Gmail client not initialized'));

    await weeklyMailingListService.trigger();

    expect(slackNotificationService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Weekly Mailing Send Failed', severity: 'high' }),
    );
  });

  it('retries on the next tick and sends once the transport recovers', async () => {
    setLastSent(daysAgo(8));
    const anchor = lastSentMarker();
    (sendEmail as jest.Mock).mockRejectedValue(new Error('Gmail down'));

    await weeklyMailingListService.trigger();
    expect(lastSentMarker()).toBe(anchor);

    // Transport recovers; the next tick must be free to send because the
    // failed run did not mark. Previously this waited a full week.
    (sendEmail as jest.Mock).mockResolvedValue(undefined);
    (sendEmail as jest.Mock).mockClear();

    await weeklyMailingListService.trigger();

    expect(sendEmail).toHaveBeenCalledTimes(users.length);
    const marker = lastSentMarker();
    expect(marker).toBeDefined();
    // Marker now reflects the successful run, not the 8-day-old anchor.
    expect(new Date(marker!).getTime()).toBeGreaterThan(daysAgo(1).getTime());
  });

  it('marks as sent when only some recipients fail', async () => {
    setLastSent(daysAgo(8));
    (sendEmail as jest.Mock)
      .mockRejectedValueOnce(new Error('one bad address'))
      .mockResolvedValueOnce(undefined);

    await weeklyMailingListService.trigger();

    const marker = lastSentMarker();
    expect(marker).toBeDefined();
    expect(new Date(marker!).getTime()).toBeGreaterThan(daysAgo(1).getTime());
    expect(slackNotificationService.sendAlert).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Weekly Mailing Send Failed' }),
    );
  });
});

// ============================================
// Eligible-user lookup failure vs genuine emptiness
// ============================================

describe('Weekly mailing — eligible user lookup', () => {
  it('propagates a lookup failure instead of masking it as "no eligible users"', async () => {
    setLastSent(daysAgo(8));
    const marker = lastSentMarker();
    (prisma.user.findMany as jest.Mock).mockRejectedValue(new Error('db connection lost'));

    // The tick surfaces the error (LockedPeriodicService routes it to
    // onError → logged + backoff retry) rather than swallowing it.
    await expect(weeklyMailingListService.trigger()).rejects.toThrow('db connection lost');

    // Critically: the window was not consumed by a failure.
    expect(lastSentMarker()).toBe(marker);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('still marks as sent when the list is genuinely empty', async () => {
    setLastSent(daysAgo(8));
    (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

    await weeklyMailingListService.trigger();

    // Nothing to retry, so consuming the window is correct here — it stops
    // the check re-running every hour for the next week.
    const marker = lastSentMarker();
    expect(marker).toBeDefined();
    expect(new Date(marker!).getTime()).toBeGreaterThan(daysAgo(1).getTime());
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ============================================
// Overdue alerting
// ============================================

describe('Weekly mailing — overdue alert', () => {
  it('alerts when a skip leaves the mailing overdue', async () => {
    setLastSent(daysAgo(WEEKLY_MAILING.STALL_ALERT_AFTER_DAYS + 2));
    // Empty directory → decision is `no-therapists` → skip.
    (prisma.therapist.findMany as jest.Mock).mockResolvedValue([]);

    await weeklyMailingListService.trigger();

    expect(sendEmail).not.toHaveBeenCalled();
    expect(slackNotificationService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Weekly Mailing Overdue', severity: 'medium' }),
    );
  });

  it('does not alert for a skip that is merely inside the normal cadence', async () => {
    setLastSent(daysAgo(WEEKLY_MAILING.MIN_INTERVAL_DAYS));
    (prisma.therapist.findMany as jest.Mock).mockResolvedValue([]);

    await weeklyMailingListService.trigger();

    expect(slackNotificationService.sendAlert).not.toHaveBeenCalled();
  });

  it('throttles the overdue alert to once per window', async () => {
    setLastSent(daysAgo(WEEKLY_MAILING.STALL_ALERT_AFTER_DAYS + 2));
    (prisma.therapist.findMany as jest.Mock).mockResolvedValue([]);

    await weeklyMailingListService.trigger();
    await weeklyMailingListService.trigger();
    await weeklyMailingListService.trigger();

    const overdueCalls = (slackNotificationService.sendAlert as jest.Mock).mock.calls.filter(
      ([arg]) => arg.title === 'Weekly Mailing Overdue',
    );
    expect(overdueCalls).toHaveLength(1);
  });
});

// ============================================
// forceSend (admin "Send now")
// ============================================

describe('Weekly mailing — forceSend failure handling', () => {
  it('does not consume the window when every email fails', async () => {
    (sendEmail as jest.Mock).mockRejectedValue(new Error('Gmail down'));

    const result = await weeklyMailingListService.forceSend();

    expect(result).toEqual({ sent: 0, failed: users.length, total: users.length });
    expect(lastSentMarker()).toBeUndefined();
    expect(slackNotificationService.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Weekly Mailing Send Failed' }),
    );
  });
});

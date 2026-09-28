/**
 * Weekly mailing send-once guard in Postgres (review #1).
 *
 * The only send-once guard used to be a Redis key, so an evicted or lost
 * key re-blasted every subscriber. Now:
 *   - recipient selection skips users whose `lastWeeklyMailingAt` is inside
 *     the interval;
 *   - each recipient is claimed (CAS on `lastWeeklyMailingAt`) before their
 *     email goes out, and the claim is released if the send fails;
 *   - the global "last sent" time falls back to the newest per-user stamp
 *     when the Redis marker is missing.
 *
 * Prisma is replaced by a tiny in-memory users table that evaluates the
 * `where` shapes the service uses, so the tests exercise the real filters.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../config', () => require('./_global-mocks').configMock());

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  subscribed: boolean;
  lastWeeklyMailingAt: Date | null;
};

const users: UserRow[] = [];

type DateCond = null | Date | { lt: Date };
type Where = {
  id?: string | { notIn: string[] };
  subscribed?: boolean;
  lastWeeklyMailingAt?: DateCond;
  OR?: Where[];
};

function matchesDate(value: Date | null, cond: DateCond): boolean {
  if (cond === null) return value === null;
  if (cond instanceof Date) return value !== null && value.getTime() === cond.getTime();
  return value !== null && value < cond.lt;
}

function matches(row: UserRow, where: Where): boolean {
  if (typeof where.id === 'string' && row.id !== where.id) return false;
  if (where.id && typeof where.id === 'object' && where.id.notIn.includes(row.id)) return false;
  if (where.subscribed !== undefined && row.subscribed !== where.subscribed) return false;
  if ('lastWeeklyMailingAt' in where && !matchesDate(row.lastWeeklyMailingAt, where.lastWeeklyMailingAt as DateCond)) {
    return false;
  }
  if (where.OR && !where.OR.some((w) => matches(row, w))) return false;
  return true;
}

const updateManyMock = jest.fn(async ({ where, data }: { where: Where; data: Partial<UserRow> }) => {
  const hit = users.filter((u) => matches(u, where));
  for (const u of hit) Object.assign(u, data);
  return { count: hit.length };
});

jest.mock('../utils/database', () => ({
  prisma: {
    user: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        users.filter((u) => matches(u, where)).map((u) => ({ ...u }))),
      update: jest.fn(),
      updateMany: (args: { where: Where; data: Partial<UserRow> }) => updateManyMock(args),
      aggregate: jest.fn(async () => {
        const stamps = users.map((u) => u.lastWeeklyMailingAt).filter((d): d is Date => d !== null);
        const max = stamps.length ? new Date(Math.max(...stamps.map((d) => d.getTime()))) : null;
        return { _max: { lastWeeklyMailingAt: max } };
      }),
    },
    voucherTracking: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn(), update: jest.fn() },
    therapist: {
      findMany: jest.fn().mockResolvedValue([{ id: 't-1', notionId: 't-1', name: 'Dr A', areasOfFocus: [] }]),
      count: jest.fn().mockResolvedValue(1), // a new therapist → event trigger fires
    },
    appointmentRequest: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));

const redisStore = new Map<string, string>();
const getStrictMock = jest.fn(async (key: string) => redisStore.get(key) ?? null);
jest.mock('../utils/redis', () => ({
  redis: {
    getStrict: (key: string) => getStrictMock(key),
    set: jest.fn(async (key: string, value: string) => { redisStore.set(key, value); return 'OK'; }),
    acquireLock: jest.fn().mockResolvedValue(false),
  },
}));

const settings: Record<string, unknown> = {
  'weeklyMailing.enabled': true,
  'weeklyMailing.availableThreshold': 5,
  'weeklyMailing.webAppUrl': 'https://app.test',
  'email.weeklyMailingSubject': 'Weekly',
  'email.weeklyMailingBody': 'Hi {userName} {unsubscribeUrl}',
  'email.voucherFinalNoticeSubject': 'Bye',
  'email.voucherFinalNoticeBody': 'Bye',
  'voucher.enabled': false,
  'voucher.expiryDays': 14,
  'voucher.maxStrikes': 3,
  'voucher.autoUnsubscribeEnabled': false,
};
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => settings[key]),
  getSettingValues: jest.fn(async (keys: string[]) => new Map(keys.map((k) => [k, settings[k]]))),
}));

jest.mock('../services/therapist-booking-status.service', () => ({
  therapistBookingStatusService: { getUnavailableTherapistIds: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/slack-notification.service', () => require('./_global-mocks').slackNotificationMock());

const sendEmailMock = jest.fn();
jest.mock('../core/email', () => ({ sendEmail: (...a: unknown[]) => sendEmailMock(...a) }));

jest.mock('../utils/unsubscribe-token', () => ({
  generateUnsubscribeUrl: (email: string) => `https://backend.test/api/unsubscribe/tok-${email}`,
}));

// Bypass the distributed lock: trigger() runs the tick directly.
jest.mock('../utils/locked-periodic-service', () => ({
  LockedPeriodicService: class {
    running = false;
    getStatus() { return { running: this.running }; }
    async trigger(): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this as any).tick({ isLockValid: () => true });
    }
  },
}));

import { weeklyMailingListService } from '../services/weekly-mailing-list.service';
import { WEEKLY_MAILING } from '../constants';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function addUser(id: string, lastWeeklyMailingAt: Date | null): UserRow {
  const row = { id, email: `${id}@example.com`, name: id, subscribed: true, lastWeeklyMailingAt };
  users.push(row);
  return row;
}

beforeEach(() => {
  users.length = 0;
  redisStore.clear();
  jest.clearAllMocks();
  sendEmailMock.mockResolvedValue({ messageId: 'm', threadId: 't' });
  // The Redis marker says the last send was long ago, so the global
  // ceiling is open and only the per-user guard decides.
  redisStore.set(WEEKLY_MAILING.LAST_SEND_KEY, daysAgo(30).toISOString());
});

const recipients = () => sendEmailMock.mock.calls.map((c) => (c[0] as { to: string }).to);

describe('weekly mailing — per-user send-once guard', () => {
  it('skips a user mailed 2 days ago and includes one mailed 8 days ago', async () => {
    // forceSend(true) bypasses the global ceiling (which the 2-day-old
    // stamp would otherwise close), isolating the per-user filter — which
    // is never skipped.
    addUser('recent', daysAgo(2));
    addUser('old', daysAgo(8));
    addUser('never', null);

    const result = await weeklyMailingListService.forceSend(true);

    expect(recipients().sort()).toEqual(['never@example.com', 'old@example.com']);
    expect(result).toEqual({ sent: 2, failed: 0, total: 2 });
  });

  it('stamps lastWeeklyMailingAt on every recipient it mails', async () => {
    const old = addUser('old', daysAgo(8));
    const never = addUser('never', null);
    const before = Date.now();

    await weeklyMailingListService.trigger();

    expect(recipients()).toHaveLength(2);
    for (const u of [old, never]) {
      expect(u.lastWeeklyMailingAt).not.toBeNull();
      expect(u.lastWeeklyMailingAt!.getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it('a lost Redis marker does not re-blast users mailed this week (Postgres backs the ceiling)', async () => {
    redisStore.clear(); // key evicted / Redis restarted without persistence
    addUser('a', daysAgo(2));
    addUser('b', daysAgo(2));
    addUser('newcomer', null);

    await weeklyMailingListService.trigger();

    // The newest per-user stamp is 2 days old, so the week is already used:
    // nobody is mailed, including the newcomer (they wait for next week).
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('keeps the global ceiling and the recipient filter on the same 7-calendar-day rule', async () => {
    // The ceiling used to open after 6 calendar days while recipients are
    // filtered for 7: an empty run would then be marked "sent" and push the
    // next real send back a week.
    const today = new Date();
    const utcNoonDaysAgo = (n: number) =>
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - n, 12));
    addUser('u', null);

    redisStore.set(WEEKLY_MAILING.LAST_SEND_KEY, utcNoonDaysAgo(6).toISOString());
    await weeklyMailingListService.trigger();
    expect(sendEmailMock).not.toHaveBeenCalled();

    redisStore.set(WEEKLY_MAILING.LAST_SEND_KEY, utcNoonDaysAgo(7).toISOString());
    await weeklyMailingListService.trigger();
    expect(recipients()).toEqual(['u@example.com']);
  });

  it('does not send to a recipient another run claimed first', async () => {
    addUser('raced', daysAgo(8));
    updateManyMock.mockImplementationOnce(async () => ({ count: 0 }));

    await weeklyMailingListService.trigger();

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('releases the claim when the send fails, so the next run retries that user', async () => {
    const previous = daysAgo(8);
    const user = addUser('flaky', previous);
    sendEmailMock.mockRejectedValueOnce(new Error('gmail down'));

    await weeklyMailingListService.trigger();

    expect(user.lastWeeklyMailingAt).toEqual(previous);
  });

  it('still treats an unreadable guard as already sent', async () => {
    addUser('u', null);
    getStrictMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await weeklyMailingListService.trigger();

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('attaches the one-click unsubscribe URL to every weekly email', async () => {
    addUser('u', null);

    await weeklyMailingListService.trigger();

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'u@example.com',
        listUnsubscribe: { url: 'https://backend.test/api/unsubscribe/tok-u@example.com' },
      }),
    );
  });

  it('does not schedule an error retry once the service has been stopped', async () => {
    jest.useFakeTimers();
    try {
      const triggerSpy = jest.spyOn(weeklyMailingListService, 'trigger');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (weeklyMailingListService as any).onError(new Error('tick failed'));
      jest.advanceTimersByTime(60_000);
      expect(triggerSpy).not.toHaveBeenCalled();
      triggerSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});

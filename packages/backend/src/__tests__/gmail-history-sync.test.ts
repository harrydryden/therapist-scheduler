/**
 * Review #7 — Gmail history sync and checkpoint.
 *
 *   - history.list was never paginated (no pageToken anywhere), so every
 *     history record past the first page was skipped — our own sent mail
 *     counts, so a mailing blast did it.
 *   - Watch renewal (every boot and every 6 days) reset the checkpoint to
 *     the mailbox's CURRENT position, skipping everything in between.
 *   - A 404 history gap only re-scanned the 50 newest messages of the last
 *     day, then trusted the notification's historyId as the checkpoint.
 *   - O7: thread recovery swallowed every Gmail error as "0 recovered".
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

// Redis + SystemSetting stand-ins for the checkpoint.
const redisStore = new Map<string, string>();
jest.mock('../utils/redis', () => ({
  redis: {
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; }),
  },
}));

let settingRow: { id: string; value: string; updatedAt: Date } | null = null;
let settingReadFails = false;
jest.mock('../utils/database', () => ({
  prisma: {
    systemSetting: {
      findUnique: jest.fn(async () => {
        if (settingReadFails) throw new Error('db down');
        return settingRow;
      }),
      upsert: jest.fn(async ({ create, update }: any) => {
        settingRow = settingRow
          ? { ...settingRow, value: update.value, updatedAt: new Date() }
          : { id: create.id, value: create.value, updatedAt: new Date() };
      }),
    },
    processedGmailMessage: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));

const mockHistoryList = jest.fn();
const mockMessagesList = jest.fn();
const mockGetProfile = jest.fn();
const mockThreadsGet = jest.fn();
const mockSetupWatch = jest.fn();
jest.mock('../services/email-oauth.service', () => ({
  emailOAuthService: {
    ensureGmailClient: jest.fn(async () => ({
      users: {
        history: { list: (...a: unknown[]) => mockHistoryList(...a) },
        messages: { list: (...a: unknown[]) => mockMessagesList(...a) },
        threads: { get: (...a: unknown[]) => mockThreadsGet(...a) },
        getProfile: (...a: unknown[]) => mockGetProfile(...a),
      },
    })),
    setupPushNotifications: (...a: unknown[]) => mockSetupWatch(...a),
    getOAuth2ClientRaw: jest.fn(() => ({ getAccessToken: jest.fn() })),
  },
  executeGmailWithProtection: jest.fn((_op: string, fn: () => unknown) => fn()),
}));

jest.mock('../utils/gmail-auth', () => ({
  acquireTokenRefreshLock: jest.fn().mockResolvedValue('lock'),
  releaseTokenRefreshLock: jest.fn(),
  refreshAccessToken: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../core/email', () => ({ getLastProcessingErrors: jest.fn().mockResolvedValue(new Map()) }));
jest.mock('../core/messaging/message-dedup', () => ({ clearMessageDedupState: jest.fn() }));

const mockProcessMessage = jest.fn();
jest.mock('../domain/scheduling/inbound', () => ({
  processMessage: (...a: unknown[]) => mockProcessMessage(...a),
}));

import { emailIngestService } from '../services/email-ingest.service';
import { GMAIL_SYNC } from '../constants';

const DAY = 24 * 60 * 60 * 1000;

function setCheckpoint(value: number, updatedAt = new Date()): void {
  settingRow = { id: 'gmail.lastHistoryId', value: JSON.stringify(value), updatedAt };
  redisStore.set('gmail:lastHistoryId', String(value));
}
const checkpoint = () => (settingRow ? JSON.parse(settingRow.value) : null);

function historyPage(recordIds: number[], opts: { historyId: string; next?: string }) {
  return {
    data: {
      historyId: opts.historyId,
      nextPageToken: opts.next,
      history: recordIds.map((id) => ({ id: String(id), messagesAdded: [{ message: { id: `m${id}` } }] })),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  settingRow = null;
  settingReadFails = false;
  mockProcessMessage.mockResolvedValue(true);
  mockGetProfile.mockResolvedValue({ data: { historyId: '9000' } });
});

describe('history.list pagination', () => {
  it('follows nextPageToken, processes every page and advances to the first page\'s historyId', async () => {
    setCheckpoint(100);
    mockHistoryList
      .mockResolvedValueOnce(historyPage([101, 102], { historyId: '500', next: 'page-2' }))
      .mockResolvedValueOnce(historyPage([103], { historyId: '520' }));

    await emailIngestService.processGmailNotification('me@example.com', 510, 'trace');

    expect(mockHistoryList).toHaveBeenCalledTimes(2);
    expect(mockHistoryList.mock.calls[0][0]).toMatchObject({ startHistoryId: '100', maxResults: GMAIL_SYNC.HISTORY_PAGE_SIZE });
    expect(mockHistoryList.mock.calls[1][0]).toMatchObject({ startHistoryId: '100', pageToken: 'page-2' });
    expect(mockProcessMessage.mock.calls.map((c) => c[0])).toEqual(['m101', 'm102', 'm103']);
    expect(checkpoint()).toBe(500);
  });

  it('at the page cap, advances only to the last history record it listed', async () => {
    setCheckpoint(100);
    for (let p = 0; p < GMAIL_SYNC.MAX_HISTORY_PAGES; p++) {
      mockHistoryList.mockResolvedValueOnce(historyPage([1000 + p], { historyId: '99999', next: `p${p + 1}` }));
    }

    await emailIngestService.processGmailNotification('me@example.com', 99999, 'trace');

    expect(mockHistoryList).toHaveBeenCalledTimes(GMAIL_SYNC.MAX_HISTORY_PAGES);
    expect(checkpoint()).toBe(1000 + GMAIL_SYNC.MAX_HISTORY_PAGES - 1);
  });

  it('never moves the checkpoint backwards', async () => {
    setCheckpoint(600);
    mockHistoryList.mockResolvedValueOnce(historyPage([], { historyId: '500' }));

    await emailIngestService.processGmailNotification('me@example.com', 500, 'trace');

    expect(checkpoint()).toBe(600);
  });
});

describe('watch renewal never moves an existing checkpoint', () => {
  beforeEach(() => {
    mockSetupWatch.mockResolvedValue({ historyId: '99999', expiration: String(Date.now() + 7 * DAY) });
  });

  it('keeps the stored checkpoint on renewal (every boot / every 6 days)', async () => {
    setCheckpoint(100);
    await emailIngestService.setupPushNotifications('projects/p/topics/t');
    expect(checkpoint()).toBe(100);
    expect(redisStore.get('gmail:lastHistoryId')).toBe('100');
  });

  it('initialises the checkpoint from the watch when none exists', async () => {
    await emailIngestService.setupPushNotifications('projects/p/topics/t');
    expect(checkpoint()).toBe(99999);
  });

  it('leaves the checkpoint alone when it cannot be read', async () => {
    settingReadFails = true;
    await emailIngestService.setupPushNotifications('projects/p/topics/t');
    expect(settingRow).toBeNull();
  });
});

describe('404 history gap recovery', () => {
  const gap = Object.assign(new Error('Requested entity was not found.'), { code: 404 });

  it('lists everything since the checkpoint was last written, oldest first, and resumes from Gmail\'s own historyId', async () => {
    const lastWrite = new Date(Date.now() - 3 * DAY);
    setCheckpoint(100, lastWrite);
    mockHistoryList.mockRejectedValueOnce(gap);
    mockMessagesList
      .mockResolvedValueOnce({ data: { messages: [{ id: 'newest' }, { id: 'middle' }], nextPageToken: 'next' } })
      .mockResolvedValueOnce({ data: { messages: [{ id: 'oldest' }] } });

    await emailIngestService.processGmailNotification('me@example.com', 123456, 'trace');

    const q: string = mockMessagesList.mock.calls[0][0].q;
    const afterSecs = Number(/after:(\d+)/.exec(q)![1]);
    expect(afterSecs * 1000).toBeLessThanOrEqual(lastWrite.getTime());
    expect(afterSecs * 1000).toBeGreaterThan(lastWrite.getTime() - 2 * 60 * 60 * 1000);
    expect(mockMessagesList.mock.calls[1][0]).toMatchObject({ pageToken: 'next' });
    expect(mockProcessMessage.mock.calls.map((c) => c[0])).toEqual(['oldest', 'middle', 'newest']);
    // Not the notification's historyId (123456) — Gmail's profile value.
    expect(checkpoint()).toBe(9000);
  });

  it('clamps the lookback to the maximum window for a very old checkpoint', async () => {
    setCheckpoint(100, new Date(Date.now() - 60 * DAY));
    mockHistoryList.mockRejectedValueOnce(gap);
    mockMessagesList.mockResolvedValueOnce({ data: { messages: [] } });

    await emailIngestService.processGmailNotification('me@example.com', 1, 'trace');

    const afterSecs = Number(/after:(\d+)/.exec(mockMessagesList.mock.calls[0][0].q)![1]);
    const lookbackDays = (Date.now() - afterSecs * 1000) / DAY;
    expect(lookbackDays).toBeGreaterThan(GMAIL_SYNC.GAP_RECOVERY_MAX_LOOKBACK_DAYS - 0.01);
    expect(lookbackDays).toBeLessThan(GMAIL_SYNC.GAP_RECOVERY_MAX_LOOKBACK_DAYS + 0.01);
  });

  it('keeps the checkpoint (and rethrows) when the recovery listing fails, so the retry re-runs it', async () => {
    setCheckpoint(100, new Date(Date.now() - DAY));
    mockHistoryList.mockRejectedValueOnce(gap);
    mockMessagesList.mockRejectedValueOnce(Object.assign(new Error('backend error'), { code: 500 }));

    await expect(emailIngestService.processGmailNotification('me@example.com', 1, 'trace')).rejects.toThrow('backend error');

    expect(checkpoint()).toBe(100);
  });
});

describe('thread recovery surfaces Gmail failures (O7)', () => {
  it('rethrows non-404 errors instead of reporting "0 recovered"', async () => {
    mockThreadsGet.mockRejectedValueOnce(Object.assign(new Error('quota exceeded'), { code: 429 }));
    await expect(emailIngestService.checkThreadForUnprocessedReplies('thread-1', 't')).rejects.toThrow('quota exceeded');
  });

  it('still treats a deleted thread (404) as nothing to recover', async () => {
    mockThreadsGet.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 404 }));
    await expect(emailIngestService.checkThreadForUnprocessedReplies('thread-1', 't')).resolves.toBe(0);
  });
});

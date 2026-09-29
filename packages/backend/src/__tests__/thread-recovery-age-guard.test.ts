/**
 * E1 regression: dedup-retention mismatch replayed old replies to the agent.
 *
 * checkThreadForUnprocessedReplies (hourly missed-message scanner,
 * human-control release replay, chase pre-send) walks ENTIRE Gmail threads
 * and treats any message without a ProcessedGmailMessage row as new. Rows
 * were deleted after 7 days while the Redis processed-set lasted 30, and
 * nothing bounded message age — so once rows expired (or after a Redis
 * flush) a long-running appointment's first replies were re-delivered as
 * "NEW EMAIL REQUIRING RESPONSE".
 *
 * Fix: an internalDate age guard in the recovery path (admin force-
 * reprocess bypasses it for the selected ids), and DB retention that
 * outlives both the guard and the Redis window.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockProcessedFindMany = jest.fn();
const mockProcessedDeleteMany = jest.fn();
const mockFailureDeleteMany = jest.fn();
const mockUnmatchedDeleteMany = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    processedGmailMessage: {
      findMany: (...a: unknown[]) => mockProcessedFindMany(...a),
      deleteMany: (...a: unknown[]) => mockProcessedDeleteMany(...a),
    },
    messageProcessingFailure: { deleteMany: (...a: unknown[]) => mockFailureDeleteMany(...a) },
    unmatchedEmailAttempt: { deleteMany: (...a: unknown[]) => mockUnmatchedDeleteMany(...a) },
  },
}));

const mockZrem = jest.fn();
const mockDel = jest.fn();
jest.mock('../utils/redis', () => ({
  redis: {
    zrem: (...a: unknown[]) => mockZrem(...a),
    del: (...a: unknown[]) => mockDel(...a),
  },
}));

jest.mock('../core/email', () => ({
  getLastProcessingErrors: jest.fn().mockResolvedValue(new Map()),
}));

const mockProcessMessage = jest.fn();
jest.mock('../domain/scheduling/inbound', () => ({
  processMessage: (...a: unknown[]) => mockProcessMessage(...a),
}));

jest.mock('../utils/gmail-auth', () => ({
  acquireTokenRefreshLock: jest.fn(),
  releaseTokenRefreshLock: jest.fn(),
}));

const mockThreadsGet = jest.fn();
jest.mock('../services/email-oauth.service', () => ({
  emailOAuthService: {
    ensureGmailClient: jest.fn().mockResolvedValue({
      users: { threads: { get: (...a: unknown[]) => mockThreadsGet(...a) } },
    }),
  },
  executeGmailWithProtection: jest.fn(),
}));

import { emailIngestService } from '../services/email-ingest.service';
import { DATA_RETENTION, EMAIL_PROCESSING } from '../constants';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function gmailMessage(id: string, labels: string[], internalDateMs: number | null) {
  return {
    id,
    labelIds: labels,
    ...(internalDateMs === null ? {} : { internalDate: String(internalDateMs) }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockProcessedFindMany.mockResolvedValue([]); // e.g. rows expired / Redis flushed
  mockProcessMessage.mockResolvedValue(true);
  mockProcessedDeleteMany.mockResolvedValue({ count: 1 });
  mockFailureDeleteMany.mockResolvedValue({ count: 1 });
  mockUnmatchedDeleteMany.mockResolvedValue({ count: 0 });
  mockZrem.mockResolvedValue(1);
  mockDel.mockResolvedValue(1);
});

describe('checkThreadForUnprocessedReplies — age guard (E1)', () => {
  it('does not re-deliver an old reply whose dedup row has expired', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [
          gmailMessage('msg-our-outreach', ['SENT'], NOW - 40 * DAY),
          gmailMessage('msg-first-reply-40d', ['INBOX'], NOW - 40 * DAY),
          gmailMessage('msg-reply-31d', ['INBOX'], NOW - 31 * DAY),
          gmailMessage('msg-new-reply', ['INBOX', 'UNREAD'], NOW - 1 * DAY),
        ],
      },
    });

    const processed = await emailIngestService.checkThreadForUnprocessedReplies('thread-1', 'trace-1');

    expect(processed).toBe(1);
    expect(mockProcessMessage).toHaveBeenCalledTimes(1);
    expect(mockProcessMessage).toHaveBeenCalledWith('msg-new-reply', 'trace-1');
    // The old messages never even reach the dedup lookup.
    expect(mockProcessedFindMany.mock.calls[0][0].where.id.in).toEqual(['msg-new-reply']);
  });

  it('still recovers a genuinely missed reply inside the window', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [gmailMessage('msg-missed-10d', ['INBOX'], NOW - 10 * DAY)] },
    });

    expect(await emailIngestService.checkThreadForUnprocessedReplies('thread-1', 'trace-1')).toBe(1);
    expect(mockProcessMessage).toHaveBeenCalledWith('msg-missed-10d', 'trace-1');
  });

  it('parses internalDate as an epoch-ms string (a Date() parse would be Invalid and disable the guard)', async () => {
    const old = NOW - 90 * DAY;
    expect(Number.isNaN(new Date(String(old)).getTime())).toBe(true);
    mockThreadsGet.mockResolvedValueOnce({ data: { messages: [gmailMessage('msg-90d', ['INBOX'], old)] } });

    expect(await emailIngestService.checkThreadForUnprocessedReplies('thread-1', 'trace-1')).toBe(0);
    expect(mockProcessMessage).not.toHaveBeenCalled();
  });

  it('processes a message with no internalDate (fail-open for recovery)', async () => {
    mockThreadsGet.mockResolvedValueOnce({ data: { messages: [gmailMessage('msg-no-date', ['INBOX'], null)] } });

    expect(await emailIngestService.checkThreadForUnprocessedReplies('thread-1', 'trace-1')).toBe(1);
  });

  it('admin force-reprocess bypasses the guard for exactly the selected ids', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [
          gmailMessage('msg-old-selected', ['INBOX'], NOW - 60 * DAY),
          gmailMessage('msg-old-not-selected', ['INBOX'], NOW - 60 * DAY),
        ],
      },
    });

    const result = await emailIngestService.reprocessThread('thread-1', 'trace-1', ['msg-old-selected']);

    expect(result).toEqual({ cleared: 1, reprocessed: 1 });
    expect(mockProcessMessage).toHaveBeenCalledTimes(1);
    expect(mockProcessMessage).toHaveBeenCalledWith('msg-old-selected', 'trace-1');
    // Force mode clears every dedup layer (shared helper).
    expect(mockZrem).toHaveBeenCalledWith(EMAIL_PROCESSING.PROCESSED_MESSAGES_KEY, 'msg-old-selected');
    expect(mockDel).toHaveBeenCalledWith(`${EMAIL_PROCESSING.MESSAGE_LOCK_PREFIX}msg-old-selected`);
    expect(mockDel).toHaveBeenCalledWith(`${EMAIL_PROCESSING.UNMATCHED_ATTEMPT_PREFIX}msg-old-selected`);
    expect(mockFailureDeleteMany).toHaveBeenCalled();
    expect(mockUnmatchedDeleteMany).toHaveBeenCalled();
  });
});

describe('dedup retention invariants (E1)', () => {
  it('DB dedup rows outlive the scanner age guard', () => {
    expect(DATA_RETENTION.PROCESSED_MESSAGE_RETENTION_DAYS).toBeGreaterThan(
      EMAIL_PROCESSING.SCANNER_MAX_MESSAGE_AGE_DAYS,
    );
  });

  it('DB dedup rows outlive the Redis processed-set window', () => {
    expect(DATA_RETENTION.PROCESSED_MESSAGE_RETENTION_DAYS).toBeGreaterThanOrEqual(
      EMAIL_PROCESSING.PROCESSED_MESSAGE_TTL_DAYS,
    );
  });
});

/**
 * ThreadFetchingService (§4.3, O13, scheduler address):
 *   - the body-size budget dropped the NEWEST messages (it walked oldest
 *     first and stopped at the limit) — it must keep the newest;
 *   - quoted reply text is stripped from each thread message;
 *   - the Gmail client gets an explicit timeout;
 *   - "our address" is EMAIL.FROM_ADDRESS — the Gmail profile no longer
 *     overrides it.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

const mockThreadsGet = jest.fn();
const mockGetProfile = jest.fn();
const mockGmailFactory = jest.fn(() => ({
  users: {
    threads: { get: (...a: unknown[]) => mockThreadsGet(...a) },
    getProfile: (...a: unknown[]) => mockGetProfile(...a),
  },
}));
jest.mock('googleapis', () => ({ google: { gmail: (...a: unknown[]) => (mockGmailFactory as jest.Mock)(...a) } }));

jest.mock('../utils/gmail-auth', () => ({
  loadGmailCredentials: jest.fn(() => ({ credentials: {}, token: {} })),
  createOAuth2Client: jest.fn(() => ({ getAccessToken: jest.fn() })),
  acquireTokenRefreshLock: jest.fn(),
  releaseTokenRefreshLock: jest.fn(),
  refreshAccessToken: jest.fn(),
}));

import { ThreadFetchingService } from '../services/thread-fetching.service';
import { EMAIL, THREAD_LIMITS, TIMEOUTS } from '../constants';

function rawMessage(id: string, from: string, body: string, minute: number) {
  return {
    id,
    internalDate: String(Date.UTC(2026, 8, 28, 10, minute)),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: 'someone@example.com' },
        { name: 'Subject', value: 'Re: times' },
        { name: 'Date', value: new Date(Date.UTC(2026, 8, 28, 10, minute)).toUTCString() },
      ],
      body: { data: Buffer.from(body).toString('base64url') },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetProfile.mockResolvedValue({ data: { emailAddress: 'some-other-account@gmail.com' } });
});

describe('ThreadFetchingService', () => {
  it('creates its Gmail client with an explicit timeout', () => {
    new ThreadFetchingService();
    expect(mockGmailFactory).toHaveBeenCalledWith(expect.objectContaining({ timeout: TIMEOUTS.GMAIL_API_MS }));
  });

  it('keeps the NEWEST messages when the thread exceeds the body-size budget', async () => {
    const half = 'x'.repeat(Math.floor(THREAD_LIMITS.MAX_THREAD_BODY_SIZE / 2) - 10);
    mockThreadsGet.mockResolvedValue({
      data: {
        messages: [
          rawMessage('oldest', 'a@example.com', half, 1),
          rawMessage('middle', 'b@example.com', half, 2),
          rawMessage('newest', 'c@example.com', half, 3),
        ],
      },
    });

    const thread = await new ThreadFetchingService().fetchThreadById('thread-1', 't');

    expect(thread!.messages.map((m) => m.id)).toEqual(['middle', 'newest']);
  });

  it('always keeps the newest message even if it alone exceeds the budget', async () => {
    mockThreadsGet.mockResolvedValue({
      data: {
        messages: [
          rawMessage('older', 'a@example.com', 'short', 1),
          rawMessage('huge', 'b@example.com', 'y'.repeat(THREAD_LIMITS.MAX_THREAD_BODY_SIZE + 10), 2),
        ],
      },
    });

    const thread = await new ThreadFetchingService().fetchThreadById('thread-1', 't');

    expect(thread!.messages.map((m) => m.id)).toEqual(['huge']);
  });

  it('strips quoted history from each thread message', async () => {
    mockThreadsGet.mockResolvedValue({
      data: {
        messages: [
          rawMessage('m1', 'a@example.com', 'Tuesday works.\n\nOn Mon, 28 Sep 2026, Justin wrote:\n> Which day?', 1),
        ],
      },
    });

    const thread = await new ThreadFetchingService().fetchThreadById('thread-1', 't');

    expect(thread!.messages[0].body).toBe('Tuesday works.');
  });

  it('labels our own mail by EMAIL.FROM_ADDRESS, not by the Gmail profile address', async () => {
    mockThreadsGet.mockResolvedValue({
      data: {
        messages: [
          rawMessage('ours', `Justin Time <${EMAIL.FROM_ADDRESS}>`, 'Hello', 1),
          rawMessage('profile', 'some-other-account@gmail.com', 'Hi', 2),
        ],
      },
    });
    const service = new ThreadFetchingService();
    await new Promise((r) => setImmediate(r)); // let any init-time profile read settle

    const thread = await service.fetchThreadById('thread-1', 't');

    expect(thread!.messages.find((m) => m.id === 'ours')!.isFromScheduler).toBe(true);
    expect(thread!.messages.find((m) => m.id === 'profile')!.isFromScheduler).toBe(false);
  });
});

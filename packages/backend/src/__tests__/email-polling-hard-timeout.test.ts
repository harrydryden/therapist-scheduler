/**
 * O13 — one hung Gmail / OAuth call stopped the backup poller until the
 * process restarted: `isPolling` guards against overlap and nothing ever
 * released it. The poll body now races a hard timeout.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

const ensureValidTokenMock = jest.fn();
jest.mock('../services/email-oauth.service', () => ({
  emailOAuthService: { ensureValidToken: (...a: unknown[]) => ensureValidTokenMock(...a) },
}));

const pollForNewEmailsMock = jest.fn();
jest.mock('../services/email-ingest.service', () => ({
  emailIngestService: { pollForNewEmails: (...a: unknown[]) => pollForNewEmailsMock(...a) },
}));

import { emailPollingService, POLL_HARD_TIMEOUT_MS } from '../services/email-polling.service';

const runSafePoll = (trigger: 'scheduled') =>
  (emailPollingService as unknown as { runSafePoll: (t: string) => Promise<void> }).runSafePoll(trigger);

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  ensureValidTokenMock.mockResolvedValue({ valid: true });
});
afterEach(() => jest.useRealTimers());

describe('backup poll hard timeout (O13)', () => {
  it('releases the overlap guard when a poll hangs, so the next interval polls again', async () => {
    pollForNewEmailsMock.mockImplementationOnce(() => new Promise(() => undefined)); // hangs forever
    pollForNewEmailsMock.mockResolvedValue({ processed: 0 });

    const hung = runSafePoll('scheduled');
    await Promise.resolve();
    expect(emailPollingService.getStatus().isCurrentlyPolling).toBe(true);

    // While it hangs, a scheduled poll is skipped (overlap guard)...
    await runSafePoll('scheduled');
    expect(pollForNewEmailsMock).toHaveBeenCalledTimes(1);

    // ...until the hard timeout releases it.
    await jest.advanceTimersByTimeAsync(POLL_HARD_TIMEOUT_MS + 1);
    await hung;
    expect(emailPollingService.getStatus().isCurrentlyPolling).toBe(false);

    await runSafePoll('scheduled');
    expect(pollForNewEmailsMock).toHaveBeenCalledTimes(2);
  });

  it('also bounds a hung token check before the poll', async () => {
    ensureValidTokenMock.mockImplementationOnce(() => new Promise(() => undefined));

    const hung = runSafePoll('scheduled');
    await jest.advanceTimersByTimeAsync(POLL_HARD_TIMEOUT_MS + 1);
    await hung;

    expect(emailPollingService.getStatus().isCurrentlyPolling).toBe(false);
  });

  it('manual polls are bounded too', async () => {
    pollForNewEmailsMock.mockImplementationOnce(() => new Promise(() => undefined));

    const manual = emailPollingService.triggerManualPoll();
    const assertion = expect(manual).rejects.toThrow(/timed out/);
    await jest.advanceTimersByTimeAsync(POLL_HARD_TIMEOUT_MS + 1);
    await assertion;
    expect(emailPollingService.getStatus().isCurrentlyPolling).toBe(false);
  });
});

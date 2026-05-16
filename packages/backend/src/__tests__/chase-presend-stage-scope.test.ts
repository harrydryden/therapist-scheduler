/**
 * Regression test for the chase pre-send "reply on thread" check.
 *
 * Operator-reported false positive (Slack alerts on 2026-05-16): two chase
 * candidates that were sitting at a new checkpoint stage were blocked with
 * "Chase prevented — reply exists on thread", citing the SAME inbound reply
 * that had already advanced the conversation INTO that stage. With
 * per-checkpoint chasers enabled (one chase per stage), every stage past the
 * first one will have an older inbound reply on the thread by definition, so
 * the unconditional "any inbound reply blocks" check is no longer correct.
 *
 * Fix: scope the check to inbound replies with `internalDate >= checkpoint_at`.
 * Older replies are the ones that advanced us into the current stage and
 * have already been accounted for. Newer replies are genuinely concerning —
 * either abandoned after processing failures, or arrived before our processing
 * caught up. The chase is blocked and admins are alerted in that case.
 *
 * If `checkpoint_at` is missing (legacy state), the check falls back to the
 * old safety-first behaviour and blocks on any inbound reply.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils/database', () => ({ prisma: {} }));
jest.mock('../utils/redis', () => ({ redis: {} }));
jest.mock('../core/email', () => ({
  emailMessageProcessorService: {},
  getLastProcessingErrors: jest.fn().mockResolvedValue([]),
}));
jest.mock('../utils/gmail-auth', () => ({
  acquireTokenRefreshLock: jest.fn(),
  releaseTokenRefreshLock: jest.fn(),
}));

const mockThreadsGet = jest.fn();

jest.mock('../services/email-oauth.service', () => ({
  emailOAuthService: {
    ensureGmailClient: jest.fn().mockResolvedValue({
      users: { threads: { get: (...args: unknown[]) => mockThreadsGet(...args) } },
    }),
  },
  executeGmailWithProtection: jest.fn(),
}));

import { emailIngestService } from '../services/email-ingest.service';

function gmailMessage(
  id: string,
  labels: string[],
  internalDateMs: number,
): { id: string; labelIds: string[]; internalDate: string } {
  return { id, labelIds: labels, internalDate: String(internalDateMs) };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('threadContainsInboundReplies — stage-scoped filter', () => {
  const STAGE_ENTERED_MS = new Date('2026-05-15T10:00:00Z').getTime();

  it('ignores inbound replies older than the checkpoint cutoff', async () => {
    // Therapist reply that triggered the current stage transition.
    // Real-world example: an `awaiting_user_slot_selection` chase that
    // shouldn't be blocked by the therapist's availability reply.
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [
          gmailMessage('msg-out', ['SENT'], STAGE_ENTERED_MS - 60 * 60 * 1000),
          gmailMessage('msg-therapist-availability', ['INBOX'], STAGE_ENTERED_MS - 30 * 60 * 1000),
        ],
      },
    });

    const result = await emailIngestService.threadContainsInboundReplies(
      'thread-1',
      'test-trace',
      STAGE_ENTERED_MS,
    );

    expect(result).toBe(false);
  });

  it('blocks chase when a reply arrived AFTER the stage was entered', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [
          gmailMessage('msg-pre-stage', ['INBOX'], STAGE_ENTERED_MS - 60 * 60 * 1000),
          gmailMessage('msg-post-stage', ['INBOX'], STAGE_ENTERED_MS + 60 * 60 * 1000),
        ],
      },
    });

    const result = await emailIngestService.threadContainsInboundReplies(
      'thread-1',
      'test-trace',
      STAGE_ENTERED_MS,
    );

    expect(result).toBe(true);
  });

  it('counts replies AT the cutoff (>= not >) to be defensive against clock equality', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [gmailMessage('msg-edge', ['INBOX'], STAGE_ENTERED_MS)],
      },
    });

    const result = await emailIngestService.threadContainsInboundReplies(
      'thread-1',
      'test-trace',
      STAGE_ENTERED_MS,
    );

    expect(result).toBe(true);
  });

  it('falls back to "any inbound reply blocks" when sinceMs is omitted', async () => {
    // Legacy / missing-checkpoint case: preserve safety-first behaviour.
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [gmailMessage('msg-old', ['INBOX'], STAGE_ENTERED_MS - 10 * 60 * 60 * 1000)],
      },
    });

    const result = await emailIngestService.threadContainsInboundReplies(
      'thread-1',
      'test-trace',
    );

    expect(result).toBe(true);
  });

  it('counts a message with malformed internalDate (safety-first on bad data)', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'msg-bad',
            labelIds: ['INBOX'],
            internalDate: 'not-a-number',
          },
        ],
      },
    });

    const result = await emailIngestService.threadContainsInboundReplies(
      'thread-1',
      'test-trace',
      STAGE_ENTERED_MS,
    );

    expect(result).toBe(true);
  });

  it('ignores outbound (SENT-only) messages regardless of cutoff', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [
          gmailMessage('msg-out-1', ['SENT'], STAGE_ENTERED_MS + 60 * 60 * 1000),
          gmailMessage('msg-out-2', ['SENT'], STAGE_ENTERED_MS + 2 * 60 * 60 * 1000),
        ],
      },
    });

    const result = await emailIngestService.threadContainsInboundReplies(
      'thread-1',
      'test-trace',
      STAGE_ENTERED_MS,
    );

    expect(result).toBe(false);
  });
});

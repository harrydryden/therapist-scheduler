/**
 * Unit tests for processSentinelBatch — the outer loop helper used by
 * every periodic `process*` method in post-booking-followup.service.ts.
 *
 * The helper hides four pieces of invariant scaffolding that each callsite
 * used to repeat by hand:
 *   1. empty-candidates short-circuit
 *   2. tryClaimSentinel + already-being-processed debug log
 *   3. schedule try/catch with releaseSentinelClaim on prep error
 *   4. sent/skipped counters + final "X processing complete" summary log
 *
 * These tests pin each of those contracts so a future change to the helper
 * can't quietly drift the behaviour shared across the four periodic methods.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockTryClaim = jest.fn();
const mockReleaseClaim = jest.fn();

jest.mock('../utils/atomic-sentinel-claim', () => ({
  tryClaimSentinel: (...args: unknown[]) => mockTryClaim(...args),
  releaseSentinelClaim: (...args: unknown[]) => mockReleaseClaim(...args),
}));

import { processSentinelBatch } from '../services/sentinel-batch-runner';
import { logger } from '../utils/logger';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('processSentinelBatch', () => {
  it('returns immediately when fetchCandidates yields an empty list', async () => {
    const schedule = jest.fn();

    await processSentinelBatch({
      checkId: 'tick-1',
      effectName: 'test effect',
      sentinelField: 'reminderSentAt',
      fetchCandidates: async () => [],
      schedule,
    });

    expect(mockTryClaim).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    // Empty batch should NOT emit the summary log — would be noise.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('claims sentinel then calls schedule for each candidate; counts queued as sent', async () => {
    mockTryClaim.mockResolvedValue(true);
    const schedule = jest.fn().mockResolvedValue(undefined);

    await processSentinelBatch({
      checkId: 'tick-1',
      effectName: 'test effect',
      sentinelField: 'reminderSentAt',
      claimPrecondition: { status: 'confirmed' },
      fetchCandidates: async () => [{ id: 'apt-1' }, { id: 'apt-2' }],
      schedule,
    });

    expect(mockTryClaim).toHaveBeenCalledTimes(2);
    expect(mockTryClaim).toHaveBeenNthCalledWith(1, 'apt-1', 'reminderSentAt', {
      extraWhere: { status: 'confirmed' },
    });
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sent: 2, skipped: 0, checked: 2 }),
      'test effect processing complete',
    );
  });

  it('counts schedule returning "skipped" toward skipped, not sent', async () => {
    mockTryClaim.mockResolvedValue(true);
    // First candidate queued, second tombstoned post-claim.
    const schedule = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('skipped');

    await processSentinelBatch({
      checkId: 'tick-1',
      effectName: 'feedback form',
      sentinelField: 'feedbackFormSentAt',
      fetchCandidates: async () => [{ id: 'apt-1' }, { id: 'apt-2' }],
      schedule,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sent: 1, skipped: 1, checked: 2 }),
      'feedback form processing complete',
    );
  });

  it('skips claim + schedule when preCheck returns wait (silent)', async () => {
    const schedule = jest.fn();

    await processSentinelBatch({
      checkId: 'tick-1',
      effectName: 'meeting link check',
      sentinelField: 'meetingLinkCheckSentAt',
      fetchCandidates: async () => [{ id: 'apt-1' }],
      preCheck: async () => ({ kind: 'wait' }),
      schedule,
    });

    expect(mockTryClaim).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    // 'wait' is silent — no summary log because sent=skipped=0.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('counts preCheck "skip" toward skipped and emits debug log if provided', async () => {
    const schedule = jest.fn();

    await processSentinelBatch({
      checkId: 'tick-1',
      effectName: 'meeting link check',
      sentinelField: 'meetingLinkCheckSentAt',
      fetchCandidates: async () => [{ id: 'apt-1' }, { id: 'apt-2' }],
      preCheck: async (c) =>
        c.id === 'apt-1'
          ? { kind: 'skip', debugLog: 'appointment already passed' }
          : { kind: 'proceed' },
      schedule: jest.fn().mockResolvedValue(undefined),
    });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ checkId: 'tick-1', appointmentId: 'apt-1' }),
      'appointment already passed',
    );
    expect(mockTryClaim).toHaveBeenCalledTimes(1);
    expect(mockTryClaim).toHaveBeenCalledWith('apt-2', 'meetingLinkCheckSentAt', expect.anything());
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sent: 1, skipped: 1, checked: 2 }),
      'meeting link check processing complete',
    );
  });

  it('logs a debug line and continues when tryClaimSentinel returns false', async () => {
    mockTryClaim.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const schedule = jest.fn().mockResolvedValue(undefined);

    await processSentinelBatch({
      checkId: 'tick-1',
      effectName: 'feedback reminder',
      sentinelField: 'feedbackReminderSentAt',
      fetchCandidates: async () => [{ id: 'apt-1' }, { id: 'apt-2' }],
      schedule,
    });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: 'apt-1' }),
      'feedback reminder already being processed or precondition changed',
    );
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith({ id: 'apt-2' });
    // apt-1 lost the claim race — not counted as sent or skipped (it'll
    // re-enter the candidate query next tick).
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sent: 1, skipped: 0, checked: 2 }),
      'feedback reminder processing complete',
    );
  });

  it('rolls the sentinel back via releaseSentinelClaim when schedule throws', async () => {
    mockTryClaim.mockResolvedValue(true);
    const renderError = new Error('template render failed');
    const schedule = jest.fn().mockRejectedValueOnce(renderError);

    await processSentinelBatch({
      checkId: 'tick-1',
      effectName: 'session reminder',
      sentinelField: 'reminderSentAt',
      fetchCandidates: async () => [{ id: 'apt-1' }],
      schedule,
    });

    expect(mockReleaseClaim).toHaveBeenCalledWith('apt-1', 'reminderSentAt');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: 'apt-1', error: renderError }),
      'Failed to prepare session reminder email - will retry next cycle',
    );
    // Prep-error path doesn't count toward sent. Summary log should not fire
    // because both counters are still zero.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('continues through the batch even when one candidate throws', async () => {
    mockTryClaim.mockResolvedValue(true);
    const schedule = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom on apt-1'))
      .mockResolvedValueOnce(undefined);

    await processSentinelBatch({
      checkId: 'tick-1',
      effectName: 'feedback reminder',
      sentinelField: 'feedbackReminderSentAt',
      fetchCandidates: async () => [{ id: 'apt-1' }, { id: 'apt-2' }],
      schedule,
    });

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(mockReleaseClaim).toHaveBeenCalledWith('apt-1', 'feedbackReminderSentAt');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sent: 1, skipped: 0, checked: 2 }),
      'feedback reminder processing complete',
    );
  });

  it('omits the summary log when nothing in the batch was acted on', async () => {
    mockTryClaim.mockResolvedValue(false); // every claim loses the race

    await processSentinelBatch({
      checkId: 'tick-1',
      effectName: 'feedback form',
      sentinelField: 'feedbackFormSentAt',
      fetchCandidates: async () => [{ id: 'apt-1' }, { id: 'apt-2' }],
      schedule: jest.fn(),
    });

    expect(logger.info).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for the per-appointment turn lock (appointment-turn-lock.ts).
 *
 * Serializes startScheduling / processEmailReply turns for the same
 * appointment so two overlapping turns can't race on the same
 * conversationState optimistic-lock check-then-write (see
 * docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md). Gated behind
 * `agent.turnSerialization`; these tests cover the lock primitive itself,
 * independent of the setting.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockAcquireLock = jest.fn();
const mockReleaseLock = jest.fn();
jest.mock('../utils/redis-locks', () => ({
  acquireLock: (...a: unknown[]) => mockAcquireLock(...a),
  releaseLock: (...a: unknown[]) => mockReleaseLock(...a),
}));

const mockStop = jest.fn();
let mockIsLockValid = jest.fn(() => true);
const mockCreateLockRenewal = jest.fn((..._args: unknown[]) => ({
  stop: mockStop,
  isLockValid: mockIsLockValid,
}));
jest.mock('../core/email/inbound/lock-renewal', () => ({
  createLockRenewal: (...a: unknown[]) => mockCreateLockRenewal(...a),
  LOCK_TTL_SECONDS: 300,
}));

import { withAppointmentTurnLock } from '../services/appointment-turn-lock';

describe('withAppointmentTurnLock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLockValid = jest.fn(() => true);
    mockCreateLockRenewal.mockImplementation(() => ({
      stop: mockStop,
      isLockValid: mockIsLockValid,
    }));
  });

  it('acquires immediately, runs fn, and releases on success', async () => {
    mockAcquireLock.mockResolvedValue(true);
    const fn = jest.fn().mockResolvedValue('done');

    const result = await withAppointmentTurnLock('apt-1', 'trace-1', fn);

    expect(result).toEqual({ acquired: true, result: 'done' });
    expect(mockAcquireLock).toHaveBeenCalledTimes(1);
    expect(mockAcquireLock).toHaveBeenCalledWith('turn-lock:appointment:apt-1', 'trace-1', 300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledWith(
      'turn-lock:appointment:apt-1',
      'trace-1',
      expect.any(String),
    );
  });

  it('releases fn even when fn throws, then rethrows', async () => {
    mockAcquireLock.mockResolvedValue(true);
    const fn = jest.fn().mockRejectedValue(new Error('turn failed'));

    await expect(withAppointmentTurnLock('apt-1', 'trace-1', fn)).rejects.toThrow('turn failed');

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('does not release when the renewal detected the lock was lost', async () => {
    mockAcquireLock.mockResolvedValue(true);
    mockIsLockValid = jest.fn(() => false);
    mockCreateLockRenewal.mockImplementation(() => ({ stop: mockStop, isLockValid: mockIsLockValid }));
    const fn = jest.fn().mockResolvedValue('done');

    await withAppointmentTurnLock('apt-1', 'trace-1', fn);

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('polls on contention and succeeds once the lock frees up', async () => {
    jest.useFakeTimers();
    mockAcquireLock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const fn = jest.fn().mockResolvedValue('done');

    const promise = withAppointmentTurnLock('apt-1', 'trace-1', fn);
    await jest.advanceTimersByTimeAsync(500);
    await jest.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toEqual({ acquired: true, result: 'done' });
    expect(mockAcquireLock).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });

  it('gives up and returns acquired:false after the wait budget without running fn', async () => {
    jest.useFakeTimers();
    mockAcquireLock.mockResolvedValue(false);
    const fn = jest.fn();

    const promise = withAppointmentTurnLock('apt-1', 'trace-1', fn);
    await jest.advanceTimersByTimeAsync(31_000);
    const result = await promise;

    expect(result).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
    expect(mockCreateLockRenewal).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});

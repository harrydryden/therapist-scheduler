/**
 * Tests for the shared transaction retry helper — in particular the
 * transient-DB-error classification added after a prod incident where
 * a DB latency blip surfaced as "Transaction already closed" (expired
 * interactive transaction) and "Server has closed the connection"
 * during Gmail message processing. Both are safe to retry by
 * re-running the transaction from the top.
 */
// serialization-retry imports sleep from utils/timeout, which pulls in
// the logger and its config validation (process.exit without env vars).
// Mock it out — it also makes the backoff instantaneous.
jest.mock('../utils/timeout', () => ({
  sleep: jest.fn(async () => {}),
}));

import {
  isSerializationError,
  isTransientDbError,
  withSerializationRetry,
} from '../utils/serialization-retry';

function errWithCode(message: string, code?: string): Error {
  const err = new Error(message);
  if (code) (err as Error & { code?: string }).code = code;
  return err;
}

describe('isTransientDbError', () => {
  it('matches Prisma connection-error codes', () => {
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2028']) {
      expect(isTransientDbError(errWithCode('boom', code))).toBe(true);
    }
  });

  it('matches raw driver messages seen in prod', () => {
    expect(isTransientDbError(new Error('Server has closed the connection.'))).toBe(true);
    expect(
      isTransientDbError(
        new Error(
          'Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. ' +
            'The timeout for this transaction was 5000 ms, however 9546 ms passed since the start of the transaction.',
        ),
      ),
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isTransientDbError(new Error('Unique constraint failed'))).toBe(false);
    expect(isTransientDbError(errWithCode('conflict', 'P2002'))).toBe(false);
    expect(isTransientDbError('not an error')).toBe(false);
  });

  it('is disjoint from serialization errors', () => {
    const serialization = errWithCode('could not serialize access', 'P2034');
    expect(isSerializationError(serialization)).toBe(true);
    expect(isTransientDbError(serialization)).toBe(false);
  });
});

describe('withSerializationRetry', () => {
  it('retries a transient connection drop and returns the eventual result', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Server has closed the connection.'))
      .mockResolvedValueOnce('ok');

    await expect(withSerializationRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries an expired interactive transaction (P2028)', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(errWithCode('Transaction already closed', 'P2028'))
      .mockResolvedValueOnce(42);

    await expect(withSerializationRetry(fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates non-retriable errors immediately', async () => {
    const fn = jest.fn().mockRejectedValue(errWithCode('Unique constraint failed', 'P2002'));

    await expect(withSerializationRetry(fn)).rejects.toThrow('Unique constraint failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget and rethrows the last error', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('Server has closed the connection.'));

    await expect(withSerializationRetry(fn)).rejects.toThrow('Server has closed the connection.');
    // MAX_RETRIES = 3 → 1 initial attempt + 3 retries.
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('logs the retry reason distinctly for transient vs serialization errors', async () => {
    const log = jest.fn();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Server has closed the connection.'))
      .mockRejectedValueOnce(errWithCode('could not serialize access', 'P2034'))
      .mockResolvedValueOnce('done');

    await expect(withSerializationRetry(fn, { op: 'test' }, log)).resolves.toBe('done');
    expect(log).toHaveBeenCalledWith(
      'transient DB error — retrying with backoff',
      expect.objectContaining({ op: 'test', attempt: 1 }),
    );
    expect(log).toHaveBeenCalledWith(
      'serialization conflict — retrying with backoff',
      expect.objectContaining({ op: 'test', attempt: 2 }),
    );
  });
});

/**
 * /health/full's unhandled-rejection check uses a rolling one-hour window
 * (review §4.7). It was a lifetime counter, so a single rejection left the
 * probe degraded for the life of the process.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../utils/request-tracing', () => ({
  getTraceContext: jest.fn(),
  runWithTrace: (_ctx: unknown, fn: () => unknown) => fn(),
  generateTraceId: () => 'trace',
}));

import {
  recordUnhandledRejection,
  getUnhandledRejectionStats,
  UNHANDLED_REJECTION_WINDOW_MS,
} from '../utils/background-task';

describe('unhandled rejection stats', () => {
  const t0 = 1_700_000_000_000;

  it('counts a rejection inside the window and forgets it after an hour', () => {
    recordUnhandledRejection(new Error('leaked promise'), t0);

    const during = getUnhandledRejectionStats(t0 + 60_000);
    expect(during.count).toBe(1);
    expect(during.recent[0].reason).toBe('Error: leaked promise');

    const after = getUnhandledRejectionStats(t0 + UNHANDLED_REJECTION_WINDOW_MS + 1);
    expect(after.count).toBe(0);
    // The lifetime total and the sample are still reported for debugging.
    expect(after.total).toBe(1);
    expect(after.recent).toHaveLength(1);
  });

  it('keeps only the rejections still inside the window', () => {
    const t1 = t0 + 10 * UNHANDLED_REJECTION_WINDOW_MS;
    recordUnhandledRejection('first', t1);
    recordUnhandledRejection('second', t1 + 40 * 60_000);

    expect(getUnhandledRejectionStats(t1 + 50 * 60_000).count).toBe(2);
    expect(getUnhandledRejectionStats(t1 + 70 * 60_000).count).toBe(1);
  });
});

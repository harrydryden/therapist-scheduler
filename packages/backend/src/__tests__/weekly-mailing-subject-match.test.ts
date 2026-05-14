/**
 * Pin the subject-match contract for `isWeeklyMailingReply`.
 *
 * Regression test for the audit-driven fix: pre-refactor, the no-
 * "Re:"-prefix case used STRICT equality. A refactor accidentally
 * relaxed it to `.includes()`, which would misroute subjects like
 * "I want to book your therapy session with Spill" to the weekly-
 * mailing inquiry handler instead of appointment matching.
 */

// Mock heavy transitive deps so we can import the module to exercise
// the pure subject-matcher function without booting config / Redis.
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../utils/database', () => ({ prisma: {} }));
jest.mock('../services/thread-fetching.service', () => ({
  threadFetchingService: {
    fetchThreadById: jest.fn(),
    formatThreadForAgent: jest.fn(),
  },
}));
jest.mock('../core/email/inbound/agent-processor', () => ({
  getAgentProcessor: jest.fn(),
  registerAgentProcessor: jest.fn(),
}));

import type { EmailMessage } from '../utils/email-mime-parser';
import { isWeeklyMailingReply } from '../core/email/inbound/weekly-mailing';

function email(subject: string): EmailMessage {
  return {
    id: 'm-1',
    threadId: 't-1',
    from: 'user@example.com',
    to: 'us@example.com',
    cc: [],
    subject,
    body: '',
    inReplyTo: '',
    references: [],
    date: new Date(),
    autoSubmitted: null,
  } as unknown as EmailMessage;
}

describe('isWeeklyMailingReply', () => {
  it('matches the exact bare phrase (no "Re:" prefix)', () => {
    expect(isWeeklyMailingReply(email('Book your therapy session with Spill'))).toBe(true);
    // Case-insensitive
    expect(isWeeklyMailingReply(email('BOOK YOUR THERAPY SESSION WITH SPILL'))).toBe(true);
    // Trimmed
    expect(isWeeklyMailingReply(email('  Book your therapy session with Spill  '))).toBe(true);
  });

  it('matches "Re:"-prefixed variants via includes()', () => {
    expect(isWeeklyMailingReply(email('Re: Book your therapy session with Spill'))).toBe(true);
    expect(isWeeklyMailingReply(email('RE: Book your therapy session with Spill'))).toBe(true);
    expect(isWeeklyMailingReply(email('Re:Book your therapy session with Spill'))).toBe(true);
    // Re: Re: variants — `.includes()` handles them.
    expect(isWeeklyMailingReply(email('Re: Re: Book your therapy session with Spill'))).toBe(true);
    expect(isWeeklyMailingReply(email('Fwd: Re: Book your therapy session with Spill'))).toBe(true);
  });

  it('does NOT match a subject that merely CONTAINS the bare phrase', () => {
    // The regression: pre-refactor used strict equality for the bare
    // phrase. Without the fix, this would misroute to the weekly-
    // mailing inquiry handler.
    expect(
      isWeeklyMailingReply(email('I want to book your therapy session with Spill')),
    ).toBe(false);
    expect(
      isWeeklyMailingReply(email('Hoping to book your therapy session with Spill next week')),
    ).toBe(false);
  });

  it('does NOT match unrelated subjects', () => {
    expect(isWeeklyMailingReply(email('Re: Your appointment'))).toBe(false);
    expect(isWeeklyMailingReply(email('Hello'))).toBe(false);
    expect(isWeeklyMailingReply(email(''))).toBe(false);
  });
});

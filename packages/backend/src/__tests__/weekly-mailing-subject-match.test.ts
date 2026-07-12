/**
 * Pin the subject-match contract for `isWeeklyMailingReply`.
 *
 * The matcher now DERIVES from the admin-editable `email.weeklyMailingSubject`
 * (rather than a hardcoded phrase) so reply-detection can't drift from the
 * subject we actually send. Previously the matcher hardcoded "Book your
 * therapy session with Spill" while the configured subject defaulted to
 * "Your weekly therapy update" — the mismatch silently broke ALL weekly-reply
 * handling, including reply-to-unsubscribe, for any non-matching subject.
 *
 * These cases pin:
 *   - the matcher tracks whatever subject is configured (the fix)
 *   - stacked Re:/Fwd: prefixes are stripped
 *   - STRICT equality for plain subjects (no substring false-positives)
 *   - `{var}` subjects match via an anchored wildcard (recipient name fills it)
 *   - safe fallback (false) on settings-read failure / empty subject
 */

// Mock heavy transitive deps so we can import the module and exercise the
// subject-matcher without booting config / Redis.
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
jest.mock('../domain/scheduling/inbound/agent-processor', () => ({
  getAgentProcessor: jest.fn(),
  registerAgentProcessor: jest.fn(),
}));
jest.mock('../services/settings.service', () => ({ getSettingValue: jest.fn() }));

import type { EmailMessage } from '../utils/email-mime-parser';
import { isWeeklyMailingReply } from '../domain/scheduling/inbound/weekly-mailing';
import { getSettingValue } from '../services/settings.service';

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

function setSubject(subject: string) {
  (getSettingValue as jest.Mock).mockResolvedValue(subject);
}

beforeEach(() => jest.clearAllMocks());

describe('isWeeklyMailingReply — tracks the configured subject', () => {
  it('matches replies to the DEFAULT subject ("Your weekly therapy update") — the case the old hardcoded matcher silently broke', async () => {
    setSubject('Your weekly therapy update');
    expect(await isWeeklyMailingReply(email('Re: Your weekly therapy update'))).toBe(true);
    expect(await isWeeklyMailingReply(email('Your weekly therapy update'))).toBe(true);
    // Case-insensitive + tolerant of surrounding whitespace.
    expect(await isWeeklyMailingReply(email('RE: your weekly therapy update'))).toBe(true);
    expect(await isWeeklyMailingReply(email('  Re:  Your weekly therapy update  '))).toBe(true);
  });

  it('matches replies to a CUSTOM configured subject', async () => {
    setSubject('Book your therapy session with Spill');
    expect(await isWeeklyMailingReply(email('Re: Book your therapy session with Spill'))).toBe(true);
    expect(await isWeeklyMailingReply(email('Book your therapy session with Spill'))).toBe(true);
  });

  it('strips stacked Re:/Fwd:/FW: prefixes', async () => {
    setSubject('Your weekly therapy update');
    expect(await isWeeklyMailingReply(email('Re: Re: Your weekly therapy update'))).toBe(true);
    expect(await isWeeklyMailingReply(email('Fwd: Re: Your weekly therapy update'))).toBe(true);
    expect(await isWeeklyMailingReply(email('FW: Your weekly therapy update'))).toBe(true);
  });
});

describe('isWeeklyMailingReply — false-positive guard (strict equality, no variables)', () => {
  beforeEach(() => setSubject('Book your therapy session with Spill'));

  it('does NOT match a subject that merely CONTAINS the configured phrase', async () => {
    // Regression: a fresh booking email that quotes the phrase must route to
    // appointment matching, not the weekly-mailing inquiry handler.
    expect(
      await isWeeklyMailingReply(email('I want to book your therapy session with Spill')),
    ).toBe(false);
    expect(
      await isWeeklyMailingReply(email('Hoping to book your therapy session with Spill next week')),
    ).toBe(false);
  });

  it('does NOT match unrelated subjects', async () => {
    expect(await isWeeklyMailingReply(email('Re: Your appointment'))).toBe(false);
    expect(await isWeeklyMailingReply(email('Hello'))).toBe(false);
    expect(await isWeeklyMailingReply(email(''))).toBe(false);
  });
});

describe('isWeeklyMailingReply — subjects with template variables', () => {
  it('matches when {userName} is filled by the recipient name (anchored)', async () => {
    setSubject('Your weekly update, {userName}');
    expect(await isWeeklyMailingReply(email('Re: Your weekly update, Alice'))).toBe(true);
    expect(await isWeeklyMailingReply(email('Your weekly update, Bob'))).toBe(true);
  });

  it('does NOT match when the static text is missing or only a substring', async () => {
    setSubject('Your weekly update, {userName}');
    // Missing the variable tail entirely.
    expect(await isWeeklyMailingReply(email('Your weekly update'))).toBe(false);
    // Anchored — a wrapping phrase must not match.
    expect(
      await isWeeklyMailingReply(email('I forwarded Your weekly update, Alice to a friend')),
    ).toBe(false);
  });

  it('refuses a subject that is ONLY a placeholder (its pattern would match everything)', async () => {
    setSubject('{userName}');
    expect(await isWeeklyMailingReply(email('Re: literally anything'))).toBe(false);
  });
});

describe('isWeeklyMailingReply — safe fallbacks', () => {
  it('returns false (does not route as a weekly reply) when the settings read fails', async () => {
    (getSettingValue as jest.Mock).mockRejectedValue(new Error('settings down'));
    expect(await isWeeklyMailingReply(email('Re: Your weekly therapy update'))).toBe(false);
  });

  it('returns false when the configured subject is empty/whitespace', async () => {
    setSubject('   ');
    expect(await isWeeklyMailingReply(email('Re: anything'))).toBe(false);
  });
});

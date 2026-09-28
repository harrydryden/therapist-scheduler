/**
 * §4.3 — "our address" came from three places: EMAIL.FROM_ADDRESS (own-mail
 * skip), the Gmail profile (thread labels) and an undocumented GMAIL_USER
 * env var (divergence detection) that was never set, so the scheduler-CC
 * check was dead code. EMAIL.FROM_ADDRESS (EMAIL_FROM_ADDRESS) is now the
 * single source; a Gmail profile that disagrees is a loud boot warning.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../utils/database', () => ({ prisma: {} }));
jest.mock('../services/slack-notification.service', () => ({ slackNotificationService: { sendAlert: jest.fn() } }));
jest.mock('../utils/gmail-auth', () => ({
  loadGmailCredentials: jest.fn(() => null),
  createOAuth2Client: jest.fn(),
  acquireTokenRefreshLock: jest.fn(),
  releaseTokenRefreshLock: jest.fn(),
  refreshAccessToken: jest.fn(),
}));

import { detectThreadDivergence, type AppointmentContext, type EmailContext } from '../services/thread-divergence.service';
import { checkSchedulerAddressMatches } from '../services/email-oauth.service';
import { EMAIL } from '../constants';
import { logger } from '../utils/logger';

const appointment: AppointmentContext = {
  id: 'apt-1',
  userEmail: 'user@example.com',
  therapistEmail: 'therapist@example.com',
  therapistName: 'Dr. Smith',
  gmailThreadId: 'thread-1',
  therapistGmailThreadId: 'thread-t1',
  initialMessageId: 'init-1',
  status: 'negotiating',
  createdAt: new Date(),
};

function email(overrides: Partial<EmailContext>): EmailContext {
  return {
    threadId: 'thread-1',
    messageId: 'msg-1',
    from: 'user@example.com',
    to: 'therapist@example.com',
    subject: 'Re: Appointment',
    body: 'Tuesday works',
    date: new Date(),
    ...overrides,
  };
}

describe('scheduler address: one source of truth', () => {
  const savedGmailUser = process.env.GMAIL_USER;
  afterEach(() => {
    if (savedGmailUser === undefined) delete process.env.GMAIL_USER;
    else process.env.GMAIL_USER = savedGmailUser;
  });

  it('divergence detection recognises EMAIL.FROM_ADDRESS in CC without any GMAIL_USER', () => {
    delete process.env.GMAIL_USER;
    const result = detectThreadDivergence(
      email({ cc: [EMAIL.FROM_ADDRESS.toUpperCase()] }),
      appointment,
      [appointment],
    );
    expect(result).toMatchObject({ detected: true, type: 'cc_parallel_thread', severity: 'medium' });
  });

  it('ignores a stray GMAIL_USER value', () => {
    process.env.GMAIL_USER = 'someone-else@example.com';
    const result = detectThreadDivergence(email({ cc: ['someone-else@example.com'] }), appointment, [appointment]);
    expect(result.detected).toBe(false);
  });

  it('logs a loud warning when the Gmail profile address differs from EMAIL_FROM_ADDRESS', () => {
    (logger.error as jest.Mock).mockClear();
    expect(checkSchedulerAddressMatches('another-account@gmail.com')).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ configuredFromAddress: EMAIL.FROM_ADDRESS, gmailProfileAddress: 'another-account@gmail.com' }),
      expect.stringContaining('SCHEDULER ADDRESS MISMATCH'),
    );
  });

  it('accepts a case-only difference', () => {
    (logger.error as jest.Mock).mockClear();
    expect(checkSchedulerAddressMatches(EMAIL.FROM_ADDRESS.toUpperCase())).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

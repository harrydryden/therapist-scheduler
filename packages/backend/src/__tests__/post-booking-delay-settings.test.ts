/**
 * postBooking.* timing settings are live (review §4.7 "dead settings").
 *
 * meetingLinkCheckDelayHours, meetingLinkCheckMinBeforeHours and
 * feedbackFormDelayHours were admin-editable but ignored: the follow-up
 * service used hard-coded 24h / 4h / 1h. The tests capture the batch
 * pre-checks the service hands to processSentinelBatch and check that the
 * "due yet?" decision follows the settings.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../config', () => require('./_global-mocks').configMock());
jest.mock('../utils/database', () => ({ prisma: {} }));
jest.mock('../utils/redis-locks', () => ({ acquireLock: jest.fn(), releaseLock: jest.fn(), renewLock: jest.fn() }));
jest.mock('../utils/atomic-sentinel-claim', () => ({ confirmSentinelClaim: jest.fn(), cleanupStuckSentinels: jest.fn() }));
jest.mock('../core/email', () => ({ sendEmail: jest.fn() }));
jest.mock('../domain/scheduling/lifecycle', () => ({ appointmentLifecycleService: {} }));
jest.mock('../core/timezone', () => ({ resolveRecipientTimezone: jest.fn() }));
jest.mock('../services/audit-event.service', () => require('./_global-mocks').auditEventMock());
jest.mock('../services/side-effect-harness', () => ({ runPeriodicTrackedSideEffect: jest.fn() }));
jest.mock('../services/periodic-effect-finalizers', () => ({}));
jest.mock('../services/feedback-email.helper', () => ({ buildFeedbackEmailPayload: jest.fn(), buildFeedbackFormUrl: jest.fn() }));
jest.mock('../utils/email-templates', () => ({ getEmailSubject: jest.fn(), getEmailBody: jest.fn() }));

const settings: Record<string, unknown> = {};
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => settings[key]),
  getSettingValues: jest.fn(),
}));

type PreCheck = (appointment: Record<string, unknown>) => Promise<{ kind: string }>;
const capturedPreChecks: PreCheck[] = [];
jest.mock('../services/sentinel-batch-runner', () => ({
  processSentinelBatch: jest.fn(async (cfg: { preCheck: PreCheck }) => { capturedPreChecks.push(cfg.preCheck); }),
}));

import { postBookingFollowupService } from '../services/post-booking-followup.service';
import { APPOINTMENT_STATUS } from '../constants';

const HOUR = 60 * 60 * 1000;
const hoursFromNow = (h: number) => new Date(Date.now() + h * HOUR);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const service = postBookingFollowupService as any;

async function meetingLinkPreCheck(): Promise<PreCheck> {
  capturedPreChecks.length = 0;
  await service.processMeetingLinkChecks('check');
  return capturedPreChecks[0];
}

async function feedbackPreCheck(): Promise<PreCheck> {
  capturedPreChecks.length = 0;
  await service.processFeedbackForms('check');
  return capturedPreChecks[0];
}

beforeEach(() => {
  Object.assign(settings, {
    'postBooking.sessionReminderHoursBefore': 4,
    'postBooking.meetingLinkCheckDelayHours': 24,
    'postBooking.meetingLinkCheckMinBeforeHours': 4,
    'postBooking.feedbackFormDelayHours': 1,
  });
});

describe('meeting link check timing follows postBooking settings', () => {
  // Confirmed 3h ago for a session 3 days out.
  const appointment = {
    status: APPOINTMENT_STATUS.CONFIRMED,
    confirmedAt: hoursFromNow(-3),
    confirmedDateTimeParsed: hoursFromNow(72),
  };

  it('waits with the default 24h delay', async () => {
    const preCheck = await meetingLinkPreCheck();
    await expect(preCheck(appointment)).resolves.toEqual({ kind: 'wait' });
  });

  it('is due once meetingLinkCheckDelayHours has passed', async () => {
    settings['postBooking.meetingLinkCheckDelayHours'] = 2;
    const preCheck = await meetingLinkPreCheck();
    await expect(preCheck(appointment)).resolves.toEqual({ kind: 'proceed' });
  });

  it('honours meetingLinkCheckMinBeforeHours for a session that is close', async () => {
    // Confirmed 1h ago for a session 20h out: 24h-after-confirmation is too
    // late, so the check moves to minBefore hours before the session.
    const soon = { ...appointment, confirmedAt: hoursFromNow(-1), confirmedDateTimeParsed: hoursFromNow(20) };

    settings['postBooking.meetingLinkCheckMinBeforeHours'] = 4; // due at T-4h → wait
    await expect((await meetingLinkPreCheck())(soon)).resolves.toEqual({ kind: 'wait' });

    settings['postBooking.meetingLinkCheckMinBeforeHours'] = 21; // T-21h already passed → due
    await expect((await meetingLinkPreCheck())(soon)).resolves.toEqual({ kind: 'proceed' });
  });
});

describe('feedback form timing follows postBooking.feedbackFormDelayHours', () => {
  // Session started 2h ago.
  const appointment = { status: APPOINTMENT_STATUS.SESSION_HELD, confirmedDateTimeParsed: hoursFromNow(-2) };

  it('is due after the default 1h', async () => {
    await expect((await feedbackPreCheck())(appointment)).resolves.toEqual({ kind: 'proceed' });
  });

  it('waits when the configured delay has not passed yet', async () => {
    settings['postBooking.feedbackFormDelayHours'] = 3;
    await expect((await feedbackPreCheck())(appointment)).resolves.toEqual({ kind: 'wait' });
  });
});

/**
 * Tests for the stale-check reschedule-overdue watchdog.
 *
 * An appointment that enters rescheduling loses its confirmed datetime and
 * with it any chance of auto-progressing (the lifecycle tick's query
 * requires a parsed datetime). If the reschedule never finalises, generic
 * inactivity staleness misses the row whenever email keeps arriving. The
 * watchdog alerts admins once per stuck reschedule when the ABANDONED slot
 * has been in the past for longer than the grace period, stamping
 * `rescheduleOverdueAlertAt` so the alert can't repeat.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Inert infra base classes — the real ones wire Redis locks on construction,
// which the singleton export would trigger at import time.
jest.mock('../utils/locked-periodic-service', () => ({
  LockedPeriodicService: class {
    protected instanceId = 'test-instance';
    start(): void {}
    stop(): void {}
  },
}));
jest.mock('../utils/locked-task-runner', () => ({
  LockedTaskRunner: class {
    async run(): Promise<{ acquired: boolean }> {
      return { acquired: false };
    }
  },
}));

const findManyMock = jest.fn();
const updateManyMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findMany: (...a: unknown[]) => findManyMock(...a),
      updateMany: (...a: unknown[]) => updateManyMock(...a),
    },
  },
}));

const parseConfirmedDateTimeMock = jest.fn();
jest.mock('../utils/date', () => ({
  parseConfirmedDateTime: (...a: unknown[]) => parseConfirmedDateTimeMock(...a),
}));

const notifyRescheduleOverdueMock = jest.fn().mockResolvedValue(true);
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    notifyRescheduleOverdue: (...a: unknown[]) => notifyRescheduleOverdueMock(...a),
  },
}));

const auditLogMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/audit-event.service', () => ({
  auditEventService: {
    log: (...a: unknown[]) => auditLogMock(...a),
  },
}));

// Unused by checkOverdueReschedules but imported by the module.
jest.mock('../services/therapist-booking-status.service', () => ({
  therapistBookingStatusService: {},
}));
jest.mock('../services/email-queue.service', () => ({
  emailQueueService: {},
}));
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(),
}));
jest.mock('../services/chase-email.service', () => ({
  chaseEmailService: {},
}));

import { staleCheckService } from '../services/stale-check.service';
import { RESCHEDULE_OVERDUE_GRACE_MS } from '../constants';

const runCheck = () =>
  (staleCheckService as unknown as {
    checkOverdueReschedules: (checkId: string) => Promise<number>;
  }).checkOverdueReschedules('test-check');

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apt-1',
    therapistName: 'Susy Putnam',
    previousConfirmedDateTime: 'Fri 23 May, 3:30pm',
    reschedulingInitiatedBy: 'client@example.com',
    ...overrides,
  };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

beforeEach(() => {
  jest.clearAllMocks();
  updateManyMock.mockResolvedValue({ count: 1 });
});

describe('checkOverdueReschedules', () => {
  it('queries only unalerted confirmed rows that are mid-reschedule', async () => {
    findManyMock.mockResolvedValue([]);

    const count = await runCheck();

    expect(count).toBe(0);
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      status: 'confirmed',
      reschedulingInProgress: true,
      rescheduleOverdueAlertAt: null,
    });
  });

  it('flags a reschedule whose abandoned slot passed beyond the grace period', async () => {
    findManyMock.mockResolvedValue([candidate()]);
    parseConfirmedDateTimeMock.mockReturnValue(daysAgo(40));

    const count = await runCheck();

    expect(count).toBe(1);

    // Sentinel stamped with full preconditions so a resolved/raced row
    // can't be alerted.
    const update = updateManyMock.mock.calls[0][0];
    expect(update.where).toEqual({
      id: 'apt-1',
      status: 'confirmed',
      reschedulingInProgress: true,
      rescheduleOverdueAlertAt: null,
    });
    expect(update.data.rescheduleOverdueAlertAt).toBeInstanceOf(Date);

    // Audit trail carries the full context (incl. initiator, which is PII
    // and deliberately NOT sent to Slack).
    expect(auditLogMock).toHaveBeenCalledTimes(1);
    const [aptId, eventType, actor, payload] = auditLogMock.mock.calls[0];
    expect(aptId).toBe('apt-1');
    expect(eventType).toBe('reschedule_overdue');
    expect(actor).toBe('system');
    expect(payload).toMatchObject({
      previousConfirmedDateTime: 'Fri 23 May, 3:30pm',
      reschedulingInitiatedBy: 'client@example.com',
    });

    expect(notifyRescheduleOverdueMock).toHaveBeenCalledWith({
      appointmentId: 'apt-1',
      therapistName: 'Susy Putnam',
      previousConfirmedDateTime: 'Fri 23 May, 3:30pm',
    });
  });

  it('parses the abandoned slot with forwardDate disabled', async () => {
    // The stored string describes a slot booked in the past; the parser's
    // default forward bias would resolve year-less strings to the future
    // and the alert would never fire.
    findManyMock.mockResolvedValue([candidate()]);
    parseConfirmedDateTimeMock.mockReturnValue(daysAgo(40));

    await runCheck();

    const [value, , options] = parseConfirmedDateTimeMock.mock.calls[0];
    expect(value).toBe('Fri 23 May, 3:30pm');
    expect(options).toEqual({ forwardDate: false });
  });

  it('leaves reschedules alone while the abandoned slot is within the grace period', async () => {
    findManyMock.mockResolvedValue([candidate()]);
    parseConfirmedDateTimeMock.mockReturnValue(
      new Date(Date.now() - RESCHEDULE_OVERDUE_GRACE_MS + 60_000),
    );

    const count = await runCheck();

    expect(count).toBe(0);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(notifyRescheduleOverdueMock).not.toHaveBeenCalled();
  });

  it('skips rows whose abandoned slot is missing or unparseable', async () => {
    findManyMock.mockResolvedValue([
      candidate({ id: 'apt-none', previousConfirmedDateTime: null }),
      candidate({ id: 'apt-mush', previousConfirmedDateTime: 'sometime soon' }),
    ]);
    parseConfirmedDateTimeMock.mockReturnValue(null);

    const count = await runCheck();

    expect(count).toBe(0);
    // Null slot short-circuits before parsing; the mush one parses to null.
    expect(parseConfirmedDateTimeMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('stays silent when the sentinel write loses the race (count 0)', async () => {
    findManyMock.mockResolvedValue([candidate()]);
    parseConfirmedDateTimeMock.mockReturnValue(daysAgo(40));
    updateManyMock.mockResolvedValue({ count: 0 });

    const count = await runCheck();

    expect(count).toBe(0);
    expect(auditLogMock).not.toHaveBeenCalled();
    expect(notifyRescheduleOverdueMock).not.toHaveBeenCalled();
  });

  it('continues past a row whose alert fails and still counts the rest', async () => {
    findManyMock.mockResolvedValue([
      candidate({ id: 'apt-bad' }),
      candidate({ id: 'apt-good' }),
    ]);
    parseConfirmedDateTimeMock.mockReturnValue(daysAgo(40));
    updateManyMock
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce({ count: 1 });

    const count = await runCheck();

    expect(count).toBe(1);
    expect(notifyRescheduleOverdueMock).toHaveBeenCalledTimes(1);
    expect(notifyRescheduleOverdueMock.mock.calls[0][0].appointmentId).toBe('apt-good');
  });
});

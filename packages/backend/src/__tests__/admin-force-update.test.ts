/**
 * adminForceUpdate — follow-up sentinel re-arming and graduation record
 * (review §4.4, lifecycle audit L7; review §3 #4).
 *
 *   - Date-only edit that MOVES a confirmed booking: all four follow-up
 *     sentinels reset and the transition generation bumped, so the new
 *     slot gets its meeting-link check / reminder / feedback form and the
 *     generation-scoped post-booking effects don't dedupe against the old
 *     slot's rows. Re-wording the same slot, or correcting the date of a
 *     post-session row, re-arms nothing.
 *   - Reviving a cancelled booking re-arms every sentinel at or after the
 *     target and re-stamps confirmedAt.
 *   - Landing on `completed` writes the durable completed-client row in the
 *     same transaction.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config', () => require('./_global-mocks').configMock());

jest.mock('../domain/scheduling/lifecycle/audit', () => ({
  addAuditMessage: jest.fn().mockResolvedValue(undefined),
  recordStatusChangeEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    onAdminForceUpdate: jest.fn().mockResolvedValue(undefined),
    notifyTransition: jest.fn(),
  },
}));

jest.mock('../services/appointment-event.service', () => ({
  recordAppointmentEvent: jest.fn().mockResolvedValue(undefined),
}));

type Row = Record<string, unknown>;
let lockedRow: Row;
const txUpdate = jest.fn().mockResolvedValue({ id: 'apt-1' });
const txExecuteRaw = jest.fn().mockResolvedValue(1);
const txTherapistFindFirst = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: jest.fn(async () => [lockedRow]),
        $executeRaw: (...a: unknown[]) => txExecuteRaw(...a),
        appointmentRequest: { update: (...a: unknown[]) => txUpdate(...a) },
        therapist: { findFirst: (...a: unknown[]) => txTherapistFindFirst(...a) },
      }),
    ),
  },
}));

import { createHash } from 'crypto';
import { adminForceUpdate } from '../domain/scheduling/lifecycle/admin-force';
import { addAuditMessage } from '../domain/scheduling/lifecycle/audit';

const ALL_SENTINELS_NULL = {
  meetingLinkCheckSentAt: null,
  reminderSentAt: null,
  feedbackFormSentAt: null,
  feedbackReminderSentAt: null,
};

function row(overrides: Row = {}): Row {
  return {
    id: 'apt-1',
    status: 'confirmed',
    confirmed_date_time: 'Tuesday 3 June at 3pm',
    confirmed_date_time_parsed: new Date('2026-06-03T14:00:00Z'),
    confirmed_at: new Date('2026-05-20T09:00:00Z'),
    user_name: 'Alice',
    user_email: 'Alice@Example.com',
    therapist_name: 'Dr T',
    therapist_email: 't@example.com',
    therapist_handle: 'dr-t',
    therapist_id: 'ther-1',
    ...overrides,
  };
}

function writtenData(): Row {
  expect(txUpdate).toHaveBeenCalledTimes(1);
  return txUpdate.mock.calls[0][0].data;
}

const base = { adminId: 'admin-1', bypassStateMachine: true as const, reason: 'fixing' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('date-only edits', () => {
  it('moving a confirmed booking to a new slot re-arms all four follow-ups and bumps the generation', async () => {
    lockedRow = row();

    await adminForceUpdate('apt-1', {
      ...base,
      confirmedDateTime: 'Thursday 5 June at 11am',
      confirmedDateTimeParsed: new Date('2026-06-05T10:00:00Z'),
    });

    const data = writtenData();
    expect(data).toMatchObject(ALL_SENTINELS_NULL);
    expect(data.transitionGeneration).toEqual({ increment: 1 });
    expect(data.confirmedDateTime).toBe('Thursday 5 June at 11am');
    expect((addAuditMessage as jest.Mock).mock.calls[0][2]).toMatch(/Follow-up email flags reset for the new slot/);
  });

  it('re-wording the SAME slot re-arms nothing (no second reminder for one session)', async () => {
    lockedRow = row();

    await adminForceUpdate('apt-1', {
      ...base,
      confirmedDateTime: 'Tue 3rd June, 3:00pm',
      confirmedDateTimeParsed: new Date('2026-06-03T14:00:00Z'),
    });

    const data = writtenData();
    expect(data).not.toHaveProperty('reminderSentAt');
    expect(data).not.toHaveProperty('feedbackFormSentAt');
    expect(data).not.toHaveProperty('transitionGeneration');
  });

  it('a date correction on a post-session row re-arms nothing', async () => {
    lockedRow = row({ status: 'feedback_requested' });

    await adminForceUpdate('apt-1', {
      ...base,
      confirmedDateTime: 'Thursday 5 June at 11am',
      confirmedDateTimeParsed: new Date('2026-06-05T10:00:00Z'),
    });

    const data = writtenData();
    expect(data).not.toHaveProperty('feedbackFormSentAt');
    expect(data).not.toHaveProperty('transitionGeneration');
  });
});

describe('reviving a cancelled booking', () => {
  it('cancelled → confirmed resets every follow-up sentinel and re-stamps confirmedAt', async () => {
    lockedRow = row({ status: 'cancelled' });
    const before = Date.now();

    await adminForceUpdate('apt-1', { ...base, newStatus: 'confirmed' });

    const data = writtenData();
    expect(data).toMatchObject({ status: 'confirmed', ...ALL_SENTINELS_NULL });
    expect((data.confirmedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((addAuditMessage as jest.Mock).mock.calls[0][2]).toMatch(/revived from cancelled/);
  });

  it('cancelled → session_held re-arms the feedback form (it would otherwise never be sent)', async () => {
    lockedRow = row({ status: 'cancelled' });

    await adminForceUpdate('apt-1', { ...base, newStatus: 'session_held' });

    expect(writtenData()).toMatchObject({ feedbackFormSentAt: null, feedbackReminderSentAt: null });
  });
});

describe('landing on completed through the bypass', () => {
  it('records the completed client in the same transaction (appointment FK)', async () => {
    lockedRow = row({ status: 'feedback_requested' });

    await adminForceUpdate('apt-1', { ...base, newStatus: 'completed' });

    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = txExecuteRaw.mock.calls[0];
    expect((sql as TemplateStringsArray).join('?')).toMatch(/INSERT INTO "therapist_completed_clients"/);
    expect((sql as TemplateStringsArray).join('?')).toMatch(/ON CONFLICT .* DO NOTHING/);
    expect(values).toContain('ther-1');
    expect(values).toContain(createHash('sha256').update('alice@example.com').digest('hex'));
  });

  it('resolves a legacy row (no therapist_id) through the handle', async () => {
    lockedRow = row({ status: 'session_held', therapist_id: null });
    txTherapistFindFirst.mockResolvedValueOnce({ id: 'ther-legacy' });

    await adminForceUpdate('apt-1', { ...base, newStatus: 'completed' });

    expect(txTherapistFindFirst).toHaveBeenCalledWith({
      where: { OR: [{ notionId: 'dr-t' }, { id: 'dr-t' }] },
      select: { id: true },
    });
    expect(txExecuteRaw.mock.calls[0]).toContain('ther-legacy');
  });

  it('does not record anything for a non-completed target', async () => {
    lockedRow = row({ status: 'session_held' });

    await adminForceUpdate('apt-1', { ...base, newStatus: 'feedback_requested' });

    expect(txExecuteRaw).not.toHaveBeenCalled();
  });
});

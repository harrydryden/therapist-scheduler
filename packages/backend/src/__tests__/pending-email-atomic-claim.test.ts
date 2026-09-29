/**
 * Review #8 / #9 / E11 — outbound pending-email delivery.
 *
 *   #8  The BullMQ worker and the DB poller both "checked status, then
 *       sent" the same pending_emails rows, so a retry could go out twice.
 *       Every attempt now claims the row atomically (pending → sending,
 *       lease = claim timestamp); stale claims return to pending.
 *   #9  A permanently failed email only appended a note; it now raises an
 *       alert through the registered notifier.
 *   E11 Queued agent emails never re-checked human control / terminal
 *       status and never stored the Gmail thread id on the appointment.
 *
 * Runs the REAL core/email/outbound/queue.ts against an in-memory
 * pending_emails / appointment_requests table whose updateMany honours the
 * same where-clause preconditions Postgres would.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

type Row = Record<string, any>;
const pendingEmails = new Map<string, Row>();
const appointments = new Map<string, Row>();

function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('lt' in cond && !(value instanceof Date && value.getTime() < cond.lt.getTime())) return false;
      if ('lte' in cond && !(value instanceof Date && value.getTime() <= cond.lte.getTime())) return false;
      if ('notIn' in cond && cond.notIn.includes(value)) return false;
      if ('in' in cond && !cond.in.includes(value)) return false;
    } else if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false;
    } else if (cond === null) {
      if (value !== null && value !== undefined) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

// Tables are read lazily (jest.mock factories run before module-level
// initialisers).
function updateMany(table: () => Map<string, Row>) {
  return async ({ where, data }: { where: Row; data: Row }) => {
    let count = 0;
    for (const row of table().values()) {
      if (matches(row, where)) {
        Object.assign(row, data);
        count++;
      }
    }
    return { count };
  };
}

const mockExecuteRaw = jest.fn().mockResolvedValue(1);
jest.mock('../utils/database', () => ({
  prisma: {
    pendingEmail: {
      updateMany: updateMany(() => pendingEmails),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = pendingEmails.get(where.id);
        if (!row) return null;
        const apt = row.appointmentId ? appointments.get(row.appointmentId) : undefined;
        return { ...row, appointment: apt ? { ...apt } : null };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = pendingEmails.get(where.id);
        if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
        Object.assign(row, data);
        return row;
      }),
      count: jest.fn(async () => [...pendingEmails.values()].filter((r) => r.status === 'pending').length),
      findMany: jest.fn(async () =>
        [...pendingEmails.values()]
          .filter((r) => r.status === 'pending' && (!r.nextRetryAt || r.nextRetryAt.getTime() <= Date.now()))
          .map((r) => ({ id: r.id })),
      ),
    },
    appointmentRequest: { updateMany: updateMany(() => appointments) },
    $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a),
  },
}));

const redisGet = jest.fn();
jest.mock('../utils/redis', () => ({
  redis: {
    get: (...a: unknown[]) => redisGet(...a),
    set: jest.fn().mockResolvedValue('OK'),
  },
}));

const sendEmailMock = jest.fn();
jest.mock('../core/email/outbound/send', () => ({
  sendEmail: (...a: unknown[]) => sendEmailMock(...a),
}));

import {
  attemptPendingEmailSend,
  claimPendingEmail,
  expireStaleSendingLeases,
  isAgentConversationEmail,
  processPendingEmails,
  registerEmailAbandonedNotifier,
  SENDING_LEASE_MS,
} from '../core/email/outbound/queue';
import { EMAIL } from '../constants';

const notifier = jest.fn().mockResolvedValue(undefined);

function addEmail(overrides: Row = {}): Row {
  const row: Row = {
    id: overrides.id ?? `pe-${pendingEmails.size + 1}`,
    toEmail: 'client@example.com',
    subject: 'Spill: your session',
    body: 'Hello',
    status: 'pending',
    appointmentId: 'apt-1',
    retryCount: 0,
    lastRetryAt: null,
    nextRetryAt: null,
    sentAt: null,
    errorMessage: null,
    ...overrides,
  };
  pendingEmails.set(row.id, row);
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  pendingEmails.clear();
  appointments.clear();
  appointments.set('apt-1', {
    id: 'apt-1',
    status: 'negotiating',
    humanControlEnabled: false,
    therapistEmail: 'therapist@clinic.example',
    gmailThreadId: null,
    therapistGmailThreadId: null,
    initialMessageId: null,
    trackingCode: 'SPL-1234-5678-1',
    lastActivityAt: null,
  });
  redisGet.mockResolvedValue(null);
  sendEmailMock.mockResolvedValue({ messageId: 'gmail-msg-1', threadId: 'gmail-thread-1' });
  registerEmailAbandonedNotifier(notifier);
});

describe('atomic claim (pending → sending) shared by the BullMQ worker and the DB poller (#8)', () => {
  it('sends a row exactly once when both consumers attempt it concurrently', async () => {
    addEmail({ id: 'pe-race' });
    let release!: () => void;
    sendEmailMock.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ messageId: 'm', threadId: 't' }); }),
    );

    // BullMQ worker and poller hit the same row at the same time.
    const worker = attemptPendingEmailSend('pe-race', 'bullmq:1');
    const poller = attemptPendingEmailSend('pe-race', 'poller');
    await new Promise((r) => setImmediate(r));
    release();

    const outcomes = (await Promise.all([worker, poller])).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['not-claimed', 'sent']);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(pendingEmails.get('pe-race')!.status).toBe('sent');
  });

  it('does not claim rows that are already sent, abandoned or being sent', async () => {
    addEmail({ id: 'sent', status: 'sent' });
    addEmail({ id: 'abandoned', status: 'abandoned' });
    addEmail({ id: 'sending', status: 'sending', lastRetryAt: new Date() });

    for (const id of ['sent', 'abandoned', 'sending']) {
      expect(await claimPendingEmail(id)).toBeNull();
      expect((await attemptPendingEmailSend(id, 't')).outcome).toBe('not-claimed');
    }
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('puts a failed attempt back to pending with the retry schedule and releases the claim', async () => {
    addEmail({ id: 'pe-fail' });
    sendEmailMock.mockRejectedValueOnce(new Error('Gmail 503'));

    const result = await attemptPendingEmailSend('pe-fail', 't');

    expect(result.outcome).toBe('retrying');
    const row = pendingEmails.get('pe-fail')!;
    expect(row).toMatchObject({ status: 'pending', retryCount: 1, errorMessage: 'Gmail 503' });
    expect(row.nextRetryAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    // Now claimable again by either consumer.
    expect(await claimPendingEmail('pe-fail')).toBeInstanceOf(Date);
  });

  it('a holder whose lease expired and was re-claimed cannot overwrite the new holder', async () => {
    addEmail({ id: 'pe-stolen' });
    sendEmailMock.mockImplementationOnce(async () => {
      // While this (hung) holder is mid-send its lease is expired and the
      // row re-claimed by someone else.
      const row = pendingEmails.get('pe-stolen')!;
      row.lastRetryAt = new Date(Date.now() + 1);
      throw new Error('socket hang up');
    });

    await attemptPendingEmailSend('pe-stolen', 't');

    expect(pendingEmails.get('pe-stolen')!).toMatchObject({ status: 'sending', retryCount: 0 });
  });

  it('expires only claims older than the lease back to pending', async () => {
    addEmail({ id: 'stale', status: 'sending', lastRetryAt: new Date(Date.now() - SENDING_LEASE_MS - 1000) });
    addEmail({ id: 'live', status: 'sending', lastRetryAt: new Date(Date.now() - 60_000) });

    expect(await expireStaleSendingLeases()).toBe(1);
    expect(pendingEmails.get('stale')!.status).toBe('pending');
    expect(pendingEmails.get('live')!.status).toBe('sending');
  });

  it('the poller recovers a crashed holder\'s row and sends it', async () => {
    addEmail({ id: 'stale', status: 'sending', lastRetryAt: new Date(Date.now() - SENDING_LEASE_MS - 1000) });

    const result = await processPendingEmails('poll-1');

    expect(result.sent).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(pendingEmails.get('stale')!.status).toBe('sent');
  });

  it('skips the send (DB update only) when the Redis send-guard shows an earlier attempt reached Gmail', async () => {
    addEmail({ id: 'pe-guard' });
    redisGet.mockResolvedValueOnce('sent');

    expect((await attemptPendingEmailSend('pe-guard', 't')).outcome).toBe('already-sent');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(pendingEmails.get('pe-guard')!.status).toBe('sent');
  });
});

describe('permanent failure raises the abandon alert (#9)', () => {
  it('abandons at the retry budget, appends the note and notifies once', async () => {
    addEmail({ id: 'pe-last', retryCount: EMAIL.MAX_RETRIES - 1 });
    sendEmailMock.mockRejectedValueOnce(new Error('invalid_grant'));

    const result = await attemptPendingEmailSend('pe-last', 't');

    expect(result.outcome).toBe('abandoned');
    expect(pendingEmails.get('pe-last')!).toMatchObject({ status: 'abandoned', retryCount: EMAIL.MAX_RETRIES });
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingEmailId: 'pe-last',
        appointmentId: 'apt-1',
        attempts: EMAIL.MAX_RETRIES,
        errorMessage: 'invalid_grant',
      }),
    );
  });

  it('counts attempts from the DB row, so the poller path abandons too', async () => {
    addEmail({ id: 'pe-poll', retryCount: EMAIL.MAX_RETRIES - 1 });
    sendEmailMock.mockRejectedValueOnce(new Error('quota exceeded'));

    const result = await processPendingEmails('poll-1');

    expect(result.failed).toBe(1);
    expect(notifier).toHaveBeenCalledTimes(1);
  });
});

describe('queued agent emails: atomic re-check + thread-id storage (E11)', () => {
  const agentSubject = '[SPL-1234-5678-1] Spill: availability';

  it('identifies agent emails by the appointment\'s own tracking code', () => {
    expect(isAgentConversationEmail(agentSubject, 'SPL-1234-5678-1')).toBe(true);
    expect(isAgentConversationEmail('Spill: your session is confirmed', 'SPL-1234-5678-1')).toBe(false);
    expect(isAgentConversationEmail(agentSubject, 'SPL-9999-9999-1')).toBe(false);
    expect(isAgentConversationEmail(agentSubject, null)).toBe(false);
  });

  it('does not send an agent email once an admin has taken human control', async () => {
    appointments.get('apt-1')!.humanControlEnabled = true;
    addEmail({ id: 'pe-agent', subject: agentSubject });

    expect((await attemptPendingEmailSend('pe-agent', 't')).outcome).toBe('skipped');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(pendingEmails.get('pe-agent')!.status).toBe('skipped');
  });

  it('does not send an agent email to a cancelled appointment', async () => {
    appointments.get('apt-1')!.status = 'cancelled';
    addEmail({ id: 'pe-agent', subject: agentSubject });

    expect((await attemptPendingEmailSend('pe-agent', 't')).outcome).toBe('skipped');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('still sends lifecycle notifications (no tracking code) for cancelled / human-controlled appointments', async () => {
    appointments.get('apt-1')!.status = 'cancelled';
    appointments.get('apt-1')!.humanControlEnabled = true;
    addEmail({ id: 'pe-cancel-notice', subject: 'Spill: your session has been cancelled' });

    expect((await attemptPendingEmailSend('pe-cancel-notice', 't')).outcome).toBe('sent');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('stores the therapist thread id after a queued first email to the therapist', async () => {
    addEmail({ id: 'pe-first', subject: agentSubject, toEmail: 'Therapist@Clinic.example' });

    await attemptPendingEmailSend('pe-first', 't');

    expect(appointments.get('apt-1')!.therapistGmailThreadId).toBe('gmail-thread-1');
    expect(appointments.get('apt-1')!.gmailThreadId).toBeNull();
    // Sent on a new thread: there was none to reply into yet.
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ subject: agentSubject, threadId: undefined });
  });

  it('stores the client thread id and initial message id, and replies into existing threads', async () => {
    addEmail({ id: 'pe-client', subject: agentSubject });
    await attemptPendingEmailSend('pe-client', 't');
    expect(appointments.get('apt-1')!).toMatchObject({
      gmailThreadId: 'gmail-thread-1',
      initialMessageId: 'gmail-msg-1',
    });

    // A later queued email to the client goes into that thread and does not
    // overwrite the stored ids.
    sendEmailMock.mockResolvedValueOnce({ messageId: 'gmail-msg-2', threadId: 'gmail-thread-1' });
    addEmail({ id: 'pe-client-2', subject: agentSubject });
    await attemptPendingEmailSend('pe-client-2', 't');
    expect(sendEmailMock.mock.calls[1][0].threadId).toBe('gmail-thread-1');
    expect(appointments.get('apt-1')!.initialMessageId).toBe('gmail-msg-1');
  });
});

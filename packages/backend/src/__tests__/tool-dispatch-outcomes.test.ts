/**
 * Tool-call outcomes through the real booking dispatcher
 * (domain/scheduling/agent/dispatch.ts) on an in-memory Redis:
 *
 *   A9  idempotency is scoped to the turn — an identical call later in the
 *       SAME turn is skipped, the same call in a LATER turn runs.
 *   A8  handlers must not report success when nothing happened:
 *         - send_email whose email was not sent (human control, terminal
 *           status) or neither sent nor queued;
 *         - update_therapist_availability that saved nothing (no parseable
 *           slots, no therapist record).
 *       A failure also means no idempotency mark, no counter increment and
 *       no checkpoint action.
 *   A11 mark_scheduling_complete prefers the structured datetime over the
 *       freeform one (which is read as UK time) when both are supplied.
 *
 * Plus the outcome sendAppointmentEmail now returns (send.ts).
 */

import type Anthropic from '@anthropic-ai/sdk';

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../config', () => require('./_global-mocks').configMock());
jest.mock('../services/audit-event.service', () => ({
  auditEventService: { log: jest.fn(), logToolExecuted: jest.fn(), logToolFailed: jest.fn(), logEmailSent: jest.fn() },
}));
jest.mock('../services/slack-notification.service', () => require('./_global-mocks').slackNotificationMock());
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => (key === 'general.timezone' ? 'Europe/London' : key === 'agent.fromName' ? 'Justin Time' : undefined)),
}));

const store = new Map<string, string>();
jest.mock('../utils/redis', () => ({
  redis: {
    get: async (k: string) => store.get(k) ?? null,
    getStrict: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    },
    incr: async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    },
    expire: async () => 1,
    del: async (k: string) => store.delete(k),
  },
  cacheManager: { setNX: jest.fn(async () => 'OK') },
}));

jest.mock('../utils/database', () => {
  const client = {
    appointmentRequest: { updateMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    therapist: { findFirst: jest.fn(), update: jest.fn() },
  };
  return { prisma: { ...client, $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(client)) } };
});

const mockSendEmail = jest.fn();
jest.mock('../core/email', () => ({ sendEmail: (...a: unknown[]) => mockSendEmail(...a) }));
const mockEnqueue = jest.fn();
jest.mock('../services/email-queue.service', () => ({ emailQueueService: { enqueue: (...a: unknown[]) => mockEnqueue(...a) } }));

// The handler's view of the send. The real send.ts is exercised separately below.
const mockSendAppointmentEmail = jest.fn();
jest.mock('../domain/scheduling/agent/send', () => ({
  sendAppointmentEmail: (...a: unknown[]) => mockSendAppointmentEmail(...a),
}));

const mockTransitionToConfirmed = jest.fn();
jest.mock('../domain/scheduling/lifecycle', () => ({
  appointmentLifecycleService: { transitionToConfirmed: (...a: unknown[]) => mockTransitionToConfirmed(...a) },
}));
jest.mock('../domain/scheduling/availability/resolver', () => ({
  availabilityResolver: { validateMarkComplete: jest.fn().mockResolvedValue(null) },
}));

import { AIToolExecutorService } from '../domain/scheduling/agent';
import { hashToolCall } from '../core/agent/tools/idempotency';
import { TOOL_EXECUTION } from '../constants';
import type { SchedulingContext } from '../services/scheduling-context.service';

const CONTEXT: SchedulingContext = {
  appointmentRequestId: 'apt-1',
  userName: 'Maria',
  userEmail: 'maria@example.com',
  therapistEmail: 'dr.j@example.com',
  therapistName: 'Jones',
  therapistAvailability: null,
  bookingMethod: 'agent_negotiated',
  userCountry: 'UK',
  therapistCountry: 'UK',
  inboundSender: 'therapist',
  turnId: 'inbound:turn-1',
};

const prisma = () => jest.requireMock('../utils/database').prisma;
const call = (name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock =>
  ({ type: 'tool_use', id: 'tu', name, input }) as Anthropic.ToolUseBlock;
const exec = new AIToolExecutorService('trace');
const idempotencyKeys = () => [...store.keys()].filter((k) => k.startsWith(TOOL_EXECUTION.PREFIX));
const toolCount = () => Number(store.get(`${TOOL_EXECUTION.COUNT_PREFIX}apt-1`) ?? 0);

const EMAIL = { to: 'maria@example.com', subject: 'Following up', body: 'Hi Maria — does Tuesday 3pm still work?', purpose: 'send_options' };

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  prisma().appointmentRequest.updateMany.mockResolvedValue({ count: 1 });
  prisma().appointmentRequest.update.mockResolvedValue({ id: 'apt-1' });
  mockSendAppointmentEmail.mockResolvedValue({ status: 'sent' });
});

describe('idempotency is scoped to the turn', () => {
  it('skips a duplicate within the turn but runs the same call in a later turn', async () => {
    const first = await exec.executeToolCall(call('send_email', EMAIL), CONTEXT);
    const sameTurn = await exec.executeToolCall(call('send_email', EMAIL), CONTEXT);
    const laterTurn = await exec.executeToolCall(call('send_email', EMAIL), { ...CONTEXT, turnId: 'inbound:turn-2' });

    expect(first).toMatchObject({ success: true });
    expect(first.skipped).toBeUndefined();
    expect(sameTurn).toMatchObject({ success: true, skipped: true, skipReason: 'idempotent' });
    expect(laterTurn).toMatchObject({ success: true, checkpointAction: 'sent_availability_to_user' });
    expect(laterTurn.skipped).toBeUndefined();
    expect(mockSendAppointmentEmail).toHaveBeenCalledTimes(2);
  });

  it('hashToolCall: turn ids separate hashes; no turn id keeps the legacy hash', () => {
    const legacy = hashToolCall('apt-1', 'send_email', EMAIL);
    expect(hashToolCall('apt-1', 'send_email', EMAIL, 'a')).not.toBe(hashToolCall('apt-1', 'send_email', EMAIL, 'b'));
    expect(hashToolCall('apt-1', 'send_email', EMAIL, 'a')).not.toBe(legacy);
    expect(hashToolCall('apt-1', 'send_email', EMAIL, undefined)).toBe(legacy);
  });
});

describe('send_email reports what actually happened to the email', () => {
  it.each([
    [{ status: 'not_sent', reason: 'human_control' }, /NOT sent.*admin has taken control/s],
    [{ status: 'not_sent', reason: 'terminal_status' }, /NOT sent.*cancelled or completed/s],
    [{ status: 'failed', error: 'gmail down; queue down' }, /NOT sent.*Sending and queueing both failed/s],
  ])('%j → success:false, no bookkeeping, no checkpoint', async (outcome, message) => {
    mockSendAppointmentEmail.mockResolvedValueOnce(outcome);

    const result = await exec.executeToolCall(call('send_email', EMAIL), CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
    expect(result.checkpointAction).toBeUndefined();
    expect(idempotencyKeys()).toHaveLength(0);
    expect(toolCount()).toBe(0);
  });

  it('a queued email is a success, and says so', async () => {
    mockSendAppointmentEmail.mockResolvedValueOnce({ status: 'queued' });
    const result = await exec.executeToolCall(call('send_email', EMAIL), CONTEXT);
    expect(result.success).toBe(true);
    expect(result.resultMessage).toMatch(/queued/);
    expect(result.checkpointAction).toBe('sent_availability_to_user');
    expect(idempotencyKeys()).toHaveLength(1);
  });
});

describe('update_therapist_availability fails when nothing is saved', () => {
  it('no parseable slots → success:false with an explanation, nothing written', async () => {
    prisma().appointmentRequest.findUnique.mockResolvedValue({ therapistId: 't1', therapistHandle: 'h1' });
    prisma().therapist.findFirst.mockResolvedValue({ id: 't1', country: 'UK', availability: null });

    const result = await exec.executeToolCall(
      call('update_therapist_availability', { availability: { Monday: 'after 3pm' } }),
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/None of the availability could be parsed/);
    expect(result.error).toMatch(/Nothing was saved/);
    expect(result.checkpointAction).toBeUndefined();
    expect(prisma().therapist.update).not.toHaveBeenCalled();
    expect(idempotencyKeys()).toHaveLength(0);
  });

  it('no therapist record → success:false', async () => {
    prisma().appointmentRequest.findUnique.mockResolvedValue({ therapistId: null, therapistHandle: 'h1' });
    prisma().therapist.findFirst.mockResolvedValue(null);

    const result = await exec.executeToolCall(
      call('update_therapist_availability', { availability: { Monday: '09:00-12:00' } }),
      CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/therapist record .* not found/);
  });

  it('a real save → success with the slot count and the checkpoint action', async () => {
    prisma().appointmentRequest.findUnique.mockResolvedValue({ therapistId: 't1', therapistHandle: 'h1' });
    prisma().therapist.findFirst.mockResolvedValue({ id: 't1', country: 'UK', availability: null });
    prisma().therapist.update.mockResolvedValue({ id: 't1' });

    const result = await exec.executeToolCall(
      call('update_therapist_availability', { availability: { Monday: '09:00-12:00, 14:00-17:00' } }),
      CONTEXT,
    );
    expect(result).toMatchObject({ success: true, checkpointAction: 'received_therapist_availability' });
    expect(result.resultMessage).toMatch(/2 weekly slot/);
    expect(prisma().therapist.update).toHaveBeenCalledTimes(1);
  });
});

describe('mark_scheduling_complete with both datetime forms', () => {
  it('uses the structured (timezone-aware) form, not the UK-time freeform string', async () => {
    prisma().appointmentRequest.findUnique.mockResolvedValue({
      status: 'negotiating',
      confirmedDateTime: null,
      humanControlEnabled: false,
      reschedulingInProgress: false,
    });
    mockTransitionToConfirmed.mockResolvedValue({ success: true, skipped: false, atomicSkipped: false });

    const result = await exec.executeToolCall(
      call('mark_scheduling_complete', {
        confirmed_datetime: 'Tuesday 12th January 2027 at 3pm',
        timezone: 'America/New_York',
        year: 2027,
        month: 1,
        day: 12,
        hour: 15,
        minute: 0,
      }),
      { ...CONTEXT, inboundSender: 'user' },
    );

    expect(result.success).toBe(true);
    const params = mockTransitionToConfirmed.mock.calls[0][0];
    expect(params.confirmedDateTime).toBe('2027-01-12T15:00:00-05:00');
    expect(params.confirmedDateTimeParsed.toISOString()).toBe('2027-01-12T20:00:00.000Z');
  });
});

describe('sendAppointmentEmail returns its outcome (send.ts)', () => {
  const { sendAppointmentEmail } = jest.requireActual('../domain/scheduling/agent/send') as typeof import('../domain/scheduling/agent/send');
  const params = { to: 'maria@example.com', subject: 'Spill - Hi', body: 'Hi' };

  beforeEach(() => {
    prisma().appointmentRequest.findUnique.mockResolvedValue({
      gmailThreadId: null,
      therapistGmailThreadId: null,
      therapistEmail: 'dr.j@example.com',
      initialMessageId: null,
      trackingCode: null,
      humanControlEnabled: false,
      status: 'negotiating',
    });
  });

  it('sent', async () => {
    mockSendEmail.mockResolvedValueOnce({ messageId: 'm1', threadId: 't1' });
    await expect(sendAppointmentEmail(params, 'apt-1', 'trace')).resolves.toEqual({ status: 'sent' });
  });

  it('not_sent when human control switched on before the send', async () => {
    prisma().appointmentRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma().appointmentRequest.findUnique
      .mockResolvedValueOnce({ gmailThreadId: null, therapistGmailThreadId: null, therapistEmail: 'dr.j@example.com', trackingCode: null })
      .mockResolvedValueOnce({ humanControlEnabled: true, status: 'negotiating' });
    await expect(sendAppointmentEmail(params, 'apt-1', 'trace')).resolves.toEqual({ status: 'not_sent', reason: 'human_control' });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('queued when Gmail fails but the queue accepts it; failed when both fail', async () => {
    mockSendEmail.mockRejectedValueOnce(new Error('gmail down'));
    mockEnqueue.mockResolvedValueOnce(undefined);
    await expect(sendAppointmentEmail(params, 'apt-1', 'trace')).resolves.toEqual({ status: 'queued' });

    mockSendEmail.mockRejectedValueOnce(new Error('gmail down'));
    mockEnqueue.mockRejectedValueOnce(new Error('db down'));
    const failed = await sendAppointmentEmail(params, 'apt-1', 'trace');
    expect(failed.status).toBe('failed');
  });
});

/**
 * Chase effects are keyed per chase cycle (review §4.4, lifecycle audit L8).
 *
 * The chase side effect used to be keyed "once per party per appointment
 * lifetime" (no scope generation). The second chase to the same party —
 * after a reply moved the stage on and CLEAR_CHASE_STATE re-armed the
 * sentinel — hit the first chase's completed row and was skipped; the
 * sentinel was stranded at the epoch; and closure (which needs a real
 * chaseSentAt) was never recommended.
 *
 * These tests run the REAL chase service, sentinel runner, harness and
 * tracker against an in-memory side_effect_logs table, so the idempotency
 * keys are the real ones.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => ({ 'chase.afterStaleHours': 72 } as Record<string, unknown>)[key]),
}));

// ── appointment_requests: just the chase sentinel ─────────────────────────
const sentinel: Record<string, Date | null> = {};
let candidates: Array<Record<string, unknown>> = [];
const appointmentUpdateMany = jest.fn(
  async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if (!('chaseSentAt' in where)) return { count: 0 }; // stuck-sentinel sweep etc.
    const id = where.id as string;
    const current = sentinel[id] ?? null;
    const gate = where.chaseSentAt as Date | null;
    const ok = gate === null ? current === null : current?.getTime() === gate.getTime();
    if (!ok) return { count: 0 };
    sentinel[id] = data.chaseSentAt as Date | null;
    return { count: 1 };
  },
);

// ── side_effect_logs: keyed by idempotencyKey ─────────────────────────────
type LogRow = { id: string; idempotencyKey: string; status: string; lastAttempt: Date | null; attempts: number };
const logs = new Map<string, LogRow>();
function matchesStatus(row: LogRow, cond: unknown): boolean {
  if (typeof cond === 'string') return row.status === cond;
  const c = cond as { in?: string[] };
  return !!c?.in?.includes(row.status);
}

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findMany: jest.fn(async () => candidates),
      findUnique: jest.fn(async () => null),
      updateMany: (...a: unknown[]) => appointmentUpdateMany(...(a as [{ where: Record<string, unknown>; data: Record<string, unknown> }])),
      update: jest.fn(),
    },
    sideEffectLog: {
      findUnique: jest.fn(async ({ where }: { where: { idempotencyKey: string } }) => logs.get(where.idempotencyKey) ?? null),
      create: jest.fn(async ({ data }: { data: { idempotencyKey: string } }) => {
        const row = { id: `row-${logs.size + 1}`, idempotencyKey: data.idempotencyKey, status: 'pending', lastAttempt: null, attempts: 0 };
        logs.set(data.idempotencyKey, row);
        return row;
      }),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = logs.get(where.idempotencyKey as string);
        if (!row || !matchesStatus(row, where.status)) return { count: 0 };
        if (where.lastAttempt instanceof Date && row.lastAttempt?.getTime() !== where.lastAttempt.getTime()) return { count: 0 };
        row.status = data.status as string;
        if (data.lastAttempt instanceof Date) row.lastAttempt = data.lastAttempt;
        return { count: 1 };
      }),
    },
  },
}));

jest.mock('../services/email-ingest.service', () => ({
  emailIngestService: {
    threadContainsInboundReplies: jest.fn().mockResolvedValue(false),
    checkThreadForUnprocessedReplies: jest.fn().mockResolvedValue(0),
  },
}));
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: jest.fn().mockResolvedValue(undefined) },
}));
const sendEmailMock = jest.fn().mockResolvedValue({ threadId: 't1', messageId: 'm1' });
jest.mock('../core/email', () => ({ sendEmail: (...a: unknown[]) => sendEmailMock(...a) }));
jest.mock('../utils/email-templates', () => ({
  getEmailSubject: jest.fn().mockResolvedValue('Subject'),
  getEmailBody: jest.fn().mockResolvedValue('Body'),
}));
const finalizeChaseMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/periodic-effect-finalizers', () => ({
  finalizeChase: (...a: unknown[]) => finalizeChaseMock(...a),
}));
jest.mock('../domain/scheduling/lifecycle', () => ({ appointmentLifecycleService: {} }));
jest.mock('../services/ai-conversation.service', () => ({ aiConversationService: {} }));
jest.mock('../services/appointment-event.service', () => ({ recordAppointmentEvent: jest.fn() }));

import { chaseEmailService } from '../services/chase-email.service';

function therapistPendingCandidate(lastActivityAt: Date) {
  return {
    id: 'apt-1',
    userName: 'Sam',
    userEmail: 'sam@example.com',
    therapistName: 'Alex',
    therapistEmail: 'alex@example.com',
    checkpointStage: 'awaiting_therapist_availability',
    checkpointAt: new Date('2026-01-01T00:00:00Z'),
    gmailThreadId: null,
    therapistGmailThreadId: 'thread-therapist',
    lastActivityAt,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  jest.clearAllMocks();
  logs.clear();
  for (const k of Object.keys(sentinel)) delete sentinel[k];
});

it('a second chase to the same party in a later cycle is sent (fresh row), not deduped against the first', async () => {
  // Cycle 1: therapist silent since Jan 1.
  candidates = [therapistPendingCandidate(new Date('2026-01-01T00:00:00Z'))];
  await chaseEmailService.sendChaseFollowUps('tick-1');
  await flush();
  expect(sendEmailMock).toHaveBeenCalledTimes(1);

  // The therapist replied (stage moved on → CLEAR_CHASE_STATE re-armed the
  // sentinel), then went quiet again waiting on them.
  sentinel['apt-1'] = null;
  candidates = [therapistPendingCandidate(new Date('2026-02-10T00:00:00Z'))];
  await chaseEmailService.sendChaseFollowUps('tick-2');
  await flush();

  expect(sendEmailMock).toHaveBeenCalledTimes(2);
  expect(logs.size).toBe(2);
  expect([...logs.values()].every((r) => r.status === 'completed')).toBe(true);
});

it('re-running the SAME cycle after its chase landed does not chase again, and reconciles the sentinel', async () => {
  candidates = [therapistPendingCandidate(new Date('2026-01-01T00:00:00Z'))];
  await chaseEmailService.sendChaseFollowUps('tick-1');
  await flush();
  expect(finalizeChaseMock).toHaveBeenCalledTimes(1);

  // The chase went out but was never recorded; the stuck-sentinel sweep
  // released the claim. Same silence → same cycle → same key.
  sentinel['apt-1'] = null;
  await chaseEmailService.sendChaseFollowUps('tick-2');
  await flush();

  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  expect(logs.size).toBe(1);
  // onAlreadyCompleted ran the (epoch-guarded) finaliser instead of
  // leaving the freshly-claimed sentinel stranded.
  expect(finalizeChaseMock).toHaveBeenCalledTimes(2);
  expect(finalizeChaseMock.mock.calls[1][0]).toMatchObject({ appointmentId: 'apt-1', target: 'therapist' });
});

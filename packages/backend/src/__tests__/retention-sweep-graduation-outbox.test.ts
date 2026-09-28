/**
 * Daily retention sweep (stale-check.service.ts cleanupOldData):
 *
 *   - Before it hard-deletes year-old post-booking appointments it
 *     re-asserts their completed-client rows (same hash as the seed
 *     migration, ON CONFLICT no-op) in the same transaction, so retention
 *     can never be what un-graduates a therapist (review §3 #4).
 *   - It now prunes the side-effect outbox: finished (completed /
 *     superseded) rows older than 30 days only — `cleanupOldEffects` used
 *     to have no caller, so side_effect_logs grew without bound (§4.4).
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config', () => require('./_global-mocks').configMock());
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
jest.mock('../services/slack-notification.service', () => ({ slackNotificationService: {} }));
jest.mock('../services/email-queue.service', () => ({ emailQueueService: {} }));
jest.mock('../services/chase-email.service', () => ({ chaseEmailService: {} }));
jest.mock('../services/audit-event.service', () => ({ auditEventService: { log: jest.fn() } }));
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => (key === 'retention.cancelledDays' ? 90 : 365)),
}));

const calls: string[] = [];
const txExecuteRaw = jest.fn(async (..._a: unknown[]) => {
  calls.push('executeRaw');
  return 1;
});
const sideEffectDeleteMany = jest.fn().mockResolvedValue({ count: 4 });
let txFindManyCall = 0;

jest.mock('../utils/database', () => {
  const tx = {
    appointmentRequest: {
      // First transaction = cancelled sweep (nothing old), second = post-booking sweep.
      findMany: jest.fn(async () => (txFindManyCall++ === 0 ? [] : [{ id: 'old-1' }, { id: 'old-2' }])),
      deleteMany: jest.fn(async () => {
        calls.push('deleteAppointments');
        return { count: 2 };
      }),
    },
    pendingEmail: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $executeRaw: (...a: unknown[]) => txExecuteRaw(...a),
  };
  return {
    prisma: {
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      processedGmailMessage: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      pendingEmail: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      unmatchedEmailAttempt: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      messageProcessingFailure: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      appointmentRequest: { count: jest.fn().mockResolvedValue(0) },
      weeklyMailingInquiry: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      sideEffectLog: { deleteMany: (...a: unknown[]) => sideEffectDeleteMany(...a) },
    },
  };
});

import { staleCheckService } from '../services/stale-check.service';

beforeEach(() => {
  calls.length = 0;
  txFindManyCall = 0;
  jest.clearAllMocks();
});

it('re-asserts completed-client rows for the batch BEFORE deleting the appointments', async () => {
  const result = await staleCheckService.cleanupOldData();

  expect(result.completedArchived).toBe(2);
  expect(calls).toEqual(['executeRaw', 'deleteAppointments']);
  const [sql, ...values] = txExecuteRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  const text = sql.join('?');
  expect(text).toMatch(/INSERT INTO "therapist_completed_clients"/);
  expect(text).toMatch(/sha256\(convert_to\(lower\(trim\(a\.user_email\)\), 'UTF8'\)\)/);
  expect(text).toMatch(/a\.status = 'completed'/);
  expect(text).toMatch(/ON CONFLICT \("therapist_id", "client_email_hash"\) DO NOTHING/);
  // Scoped to the batch being deleted (Prisma.join of the ids).
  expect(JSON.stringify(values)).toMatch(/old-1/);
});

it('prunes finished outbox rows older than 30 days', async () => {
  const before = Date.now();
  await staleCheckService.cleanupOldData();

  expect(sideEffectDeleteMany).toHaveBeenCalledTimes(1);
  const { where } = sideEffectDeleteMany.mock.calls[0][0];
  expect(where.status).toEqual({ in: ['completed', 'superseded'] });
  const cutoff = (where.completedAt as { lt: Date }).lt.getTime();
  expect(before - cutoff).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 1000);
  expect(before - cutoff).toBeLessThan(31 * 24 * 60 * 60 * 1000);
});

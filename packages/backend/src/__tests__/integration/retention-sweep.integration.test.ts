/**
 * Integration (real Postgres): the daily retention sweep
 * (stale-check.service.ts cleanupOldData)
 *
 *   - re-asserts the completed-client row of every year-old completed
 *     appointment it deletes (raw SQL — this is where a syntax or hash
 *     mismatch would hide), so retention cannot un-graduate a therapist;
 *   - prunes only finished outbox rows older than 30 days.
 *
 * Runs only when TEST_DATABASE_URL is set; DATABASE_URL must point at the
 * same database.
 */

jest.mock('../../config', () => ({
  config: {
    env: 'test',
    logLevel: 'silent',
    jwtSecret: 'test-secret',
    backendUrl: 'http://localhost:3000',
    webhookSecret: 'test',
    redisUrl: 'redis://localhost:6379',
    anthropicApiKey: 'test',
    timezone: 'Europe/London',
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/locked-periodic-service', () => ({
  LockedPeriodicService: class {
    protected instanceId = 'test-instance';
    start(): void {}
    stop(): void {}
  },
}));
jest.mock('../../utils/locked-task-runner', () => ({
  LockedTaskRunner: class {
    async run(): Promise<{ acquired: boolean }> {
      return { acquired: false };
    }
  },
}));
jest.mock('../../services/slack-notification.service', () => ({ slackNotificationService: {} }));
jest.mock('../../services/email-queue.service', () => ({ emailQueueService: {} }));
jest.mock('../../services/chase-email.service', () => ({ chaseEmailService: {} }));
jest.mock('../../services/audit-event.service', () => ({ auditEventService: { log: jest.fn() } }));
jest.mock('../../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => (key === 'retention.cancelledDays' ? 90 : 365)),
}));

import { PrismaClient } from '@prisma/client';
import { getIntegrationDb, closeIntegrationDb, integrationDescribe } from '../helpers/integration-db';
import { staleCheckService } from '../../services/stale-check.service';
import { hashClientEmail } from '../../domain/scheduling/lifecycle/completed-clients';

let db: PrismaClient;

integrationDescribe('retention sweep (real Postgres)', () => {
  beforeAll(async () => {
    db = await getIntegrationDb();
  }, 60000);

  afterAll(async () => {
    await closeIntegrationDb();
  });

  it('keeps the graduation record of a year-old completed appointment it deletes', async () => {
    const stamp = Date.now();
    const t = await db.therapist.create({
      data: { odId: `${stamp}`.slice(-10), notionId: `ret-${stamp}`, email: `ret-${stamp}@example.com`, name: 'Dr Ret' },
    });
    const apt = await db.appointmentRequest.create({
      data: {
        userEmail: ' Old.Client@Example.com',
        therapistEmail: t.email,
        therapistHandle: t.notionId!,
        therapistName: t.name,
        // Legacy shape: no FK — resolved through the handle.
        therapistId: null,
        status: 'completed',
      },
    });
    // @updatedAt can't be back-dated through Prisma.
    await db.$executeRaw`UPDATE appointment_requests SET updated_at = NOW() - INTERVAL '400 days' WHERE id = ${apt.id}`;
    expect(await db.therapistCompletedClient.count({ where: { therapistId: t.id } })).toBe(0);

    await staleCheckService.cleanupOldData();

    expect(await db.appointmentRequest.findUnique({ where: { id: apt.id } })).toBeNull();
    const rows = await db.therapistCompletedClient.findMany({ where: { therapistId: t.id } });
    expect(rows.map((r) => r.clientEmailHash)).toEqual([hashClientEmail('old.client@example.com')]);
  });

  it('prunes finished outbox rows older than 30 days and keeps everything else', async () => {
    const stamp = Date.now();
    const apt = await db.appointmentRequest.create({
      data: {
        userEmail: `outbox-${stamp}@example.com`,
        therapistEmail: 't@example.com',
        therapistHandle: `h-${stamp}`,
        therapistName: 'Dr O',
        status: 'confirmed',
      },
    });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const row = (key: string, status: string, completedAt: Date | null) => ({
      appointmentId: apt.id,
      effectType: 'slack_notify_confirmed',
      transition: 'confirmed',
      status,
      completedAt,
      idempotencyKey: `${key}-${stamp}`,
      createdAt: old,
    });
    await db.sideEffectLog.createMany({
      data: [
        row('old-completed', 'completed', old),
        row('old-superseded', 'superseded', old),
        row('recent-completed', 'completed', recent),
        row('old-abandoned', 'abandoned', null),
        row('old-failed', 'failed', null),
      ],
    });

    await staleCheckService.cleanupOldData();

    const left = (await db.sideEffectLog.findMany({ where: { appointmentId: apt.id } }))
      .map((r) => r.idempotencyKey.replace(`-${stamp}`, ''))
      .sort();
    expect(left).toEqual(['old-abandoned', 'old-failed', 'recent-completed']);
  });
});

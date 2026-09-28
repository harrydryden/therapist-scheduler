/**
 * Integration (real Postgres) coverage for the September 2026 review fixes
 * in the lifecycle / outbox / email-identity area:
 *
 *   - Graduation survives the appointment row: transitionToCompleted and
 *     the admin force path write therapist_completed_clients in the
 *     completion transaction, with the SAME hash the seed migration and the
 *     retention guard compute in SQL; deleting the appointment (retention /
 *     admin delete) leaves the therapist graduated.
 *   - Outbox leases: the lease tryClaimEffect returns round-trips through
 *     TIMESTAMP(3) exactly (ownership checks match), a stale lease does not.
 *   - The retry query sorts never-attempted rows first (NULLS FIRST).
 *   - getOrCreateUser adopts a legacy mixed-case user instead of creating a
 *     duplicate.
 *
 * Runs only when TEST_DATABASE_URL is set; DATABASE_URL must point at the
 * same database (the services use the app's Prisma singleton).
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

jest.mock('../../services/appointment-notifications.service', () => {
  const actual = jest.requireActual('../../services/appointment-notifications.service');
  return {
    appointmentNotificationsService: {
      notifyAdminForceUpdate: jest.fn().mockResolvedValue(undefined),
      notifyConfirmed: jest.fn().mockResolvedValue(undefined),
      notifyCompleted: jest.fn().mockResolvedValue(undefined),
      notifyCancelled: jest.fn().mockResolvedValue(undefined),
      getNotificationSettings: jest.fn().mockResolvedValue(actual.DEFAULT_NOTIFICATION_SETTINGS),
    },
  };
});

jest.mock('../../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    notifyTransition: jest.fn(),
    onConfirmed: jest.fn().mockResolvedValue(undefined),
    onSessionHeld: jest.fn().mockResolvedValue(undefined),
    onCompleted: jest.fn().mockResolvedValue(undefined),
    onCancelled: jest.fn().mockResolvedValue(undefined),
    onAdminForceUpdate: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../services/appointment-event.service', () => ({
  recordAppointmentEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/settings.service', () => ({
  getSettingValue: jest.fn().mockResolvedValue(2),
}));

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { PrismaClient } from '@prisma/client';
import { getIntegrationDb, closeIntegrationDb, integrationDescribe } from '../helpers/integration-db';
import { appointmentLifecycleService } from '../../domain/scheduling/lifecycle';
import { hashClientEmail } from '../../domain/scheduling/lifecycle/completed-clients';
import { therapistBookingStatusService } from '../../services/therapist-booking-status.service';
import { sideEffectTrackerService } from '../../services/side-effect-tracker.service';
import { getOrCreateUser } from '../../utils/unique-id';

let db: PrismaClient;
let seq = 0;

async function therapist(target = 2) {
  seq++;
  return db.therapist.create({
    data: {
      odId: `${1000000000 + seq}`,
      notionId: `notion-${Date.now()}-${seq}`,
      email: `therapist-${Date.now()}-${seq}@example.com`,
      name: `Dr ${seq}`,
      targetAppointments: target,
    },
  });
}

async function appointment(t: { id: string; notionId: string | null; email: string; name: string }, userEmail: string, status: string, linkTherapist = true) {
  return db.appointmentRequest.create({
    data: {
      userEmail,
      therapistEmail: t.email,
      therapistHandle: t.notionId ?? t.id,
      therapistName: t.name,
      therapistId: linkTherapist ? t.id : null,
      status,
      emailVerifiedAt: new Date(),
    },
  });
}

async function completedRows(therapistId: string) {
  return db.therapistCompletedClient.findMany({ where: { therapistId } });
}

integrationDescribe('graduation, outbox leases and email identity (real Postgres)', () => {
  beforeAll(async () => {
    db = await getIntegrationDb();
  }, 60000);

  afterAll(async () => {
    await closeIntegrationDb();
  });

  it('completion records the client with the same hash the migration/retention SQL computes', async () => {
    const t = await therapist();
    const apt = await appointment(t, 'Alice.Smith@Example.COM', 'feedback_requested');

    await appointmentLifecycleService.transitionToCompleted({ appointmentId: apt.id, source: 'system' });

    const rows = await completedRows(t.id);
    expect(rows).toHaveLength(1);
    const [{ sqlhash }] = await db.$queryRaw<Array<{ sqlhash: string }>>`
      SELECT encode(sha256(convert_to(lower(trim(${'Alice.Smith@Example.COM'}::text)), 'UTF8')), 'hex') AS sqlhash
    `;
    expect(rows[0].clientEmailHash).toBe(sqlhash);
    expect(rows[0].clientEmailHash).toBe(hashClientEmail('alice.smith@example.com'));
  });

  it('a graduated therapist stays graduated after the completed appointments are deleted', async () => {
    const t = await therapist(2);
    const a1 = await appointment(t, 'one@example.com', 'session_held');
    const a2 = await appointment(t, 'two@example.com', 'confirmed');
    // A repeat client (different case) must not count twice.
    const a3 = await appointment(t, 'ONE@example.com', 'feedback_requested');

    for (const a of [a1, a2, a3]) {
      await appointmentLifecycleService.transitionToCompleted({ appointmentId: a.id, source: 'system' });
    }
    expect(await therapistBookingStatusService.getCompletedClientCount(t.notionId!)).toBe(2);

    // Retention / admin delete removes the appointment rows.
    await db.appointmentRequest.deleteMany({ where: { therapistId: t.id } });

    expect(await therapistBookingStatusService.getCompletedClientCount(t.notionId!)).toBe(2);
    const status = await therapistBookingStatusService.canAcceptNewRequest(t.notionId!, 'new@example.com');
    expect(status).toEqual({ canAcceptNewRequests: false, reason: 'target_reached' });
    expect(await therapistBookingStatusService.getUnavailableTherapistIds()).toContain(t.notionId);
  });

  it('legacy rows (no therapist FK) and the admin force path record the client too', async () => {
    const t = await therapist();
    const legacy = await appointment(t, 'legacy@example.com', 'feedback_requested', false);
    const forced = await appointment(t, 'forced@example.com', 'session_held');

    await appointmentLifecycleService.transitionToCompleted({ appointmentId: legacy.id, source: 'system' });
    await appointmentLifecycleService.adminForceUpdate(forced.id, {
      newStatus: 'completed',
      adminId: 'admin-1',
      bypassStateMachine: true,
      reason: 'session happened off-platform',
    });

    const hashes = (await completedRows(t.id)).map((r) => r.clientEmailHash).sort();
    expect(hashes).toEqual([hashClientEmail('forced@example.com'), hashClientEmail('legacy@example.com')].sort());
  });

  it('an unverified active request does not hold the therapist; a verified one does', async () => {
    const t = await therapist(5);
    await db.appointmentRequest.create({
      data: {
        userEmail: 'unverified@example.com',
        therapistEmail: t.email,
        therapistHandle: t.notionId!,
        therapistName: t.name,
        therapistId: t.id,
        status: 'pending',
        emailVerifiedAt: null,
      },
    });
    expect(await therapistBookingStatusService.canAcceptNewRequest(t.notionId!, 'someone@example.com')).toEqual({
      canAcceptNewRequests: true,
      reason: 'available',
    });

    await appointment(t, 'verified@example.com', 'contacted');
    expect(await therapistBookingStatusService.canAcceptNewRequest(t.notionId!, 'someone@example.com')).toEqual({
      canAcceptNewRequests: false,
      reason: 'in_session',
    });
  });

  it('the claim lease round-trips through TIMESTAMP(3); a stale lease cannot write', async () => {
    const t = await therapist();
    const apt = await appointment(t, 'lease@example.com', 'confirmed');
    const [reg] = await sideEffectTrackerService.registerSideEffects(apt.id, 'confirmed', [
      { effectType: 'slack_notify_confirmed' },
    ], 1);

    const stale = await sideEffectTrackerService.tryClaimEffect(reg.idempotencyKey);
    expect(stale).toBeInstanceOf(Date);
    // Simulate lease expiry + re-claim by another worker.
    await db.sideEffectLog.update({
      where: { idempotencyKey: reg.idempotencyKey },
      data: { lastAttempt: new Date(Date.now() - 11 * 60 * 1000) },
    });
    const fresh = await sideEffectTrackerService.tryClaimEffect(reg.idempotencyKey);
    expect(fresh).toBeInstanceOf(Date);

    // The old worker finishes late: its failure must not land.
    expect(await sideEffectTrackerService.markFailed(reg.idempotencyKey, 'late', stale!)).toBe(false);
    // The new owner's completion does.
    expect(await sideEffectTrackerService.markCompleted(reg.idempotencyKey, fresh!)).toBe(true);

    const row = await db.sideEffectLog.findUnique({ where: { idempotencyKey: reg.idempotencyKey } });
    expect(row).toMatchObject({ status: 'completed', transitionGeneration: 1 });
    // The orphan re-claim counted the crashed attempt.
    expect(row!.attempts).toBe(1);
  });

  it('getEffectsToRetry returns never-attempted rows ahead of older failures (NULLS FIRST)', async () => {
    const t = await therapist();
    const apt = await appointment(t, 'order@example.com', 'confirmed');
    const long = new Date(Date.now() - 60 * 60 * 1000);
    await db.sideEffectLog.createMany({
      data: [
        { appointmentId: apt.id, effectType: 'slack_notify_confirmed', transition: 'confirmed', status: 'failed', attempts: 1, lastAttempt: long, idempotencyKey: `failed-${apt.id}`, createdAt: long },
        { appointmentId: apt.id, effectType: 'user_sync', transition: 'confirmed', status: 'pending', attempts: 0, lastAttempt: null, idempotencyKey: `pending-${apt.id}`, createdAt: long },
      ],
    });

    const effects = await sideEffectTrackerService.getEffectsToRetry(5, 60_000, 1);

    expect(effects.map((e) => e.idempotencyKey)).toEqual([`pending-${apt.id}`]);
  });

  it('getOrCreateUser adopts a legacy mixed-case user instead of creating a duplicate', async () => {
    const legacy = await db.user.create({
      data: { email: `Legacy.${Date.now()}@Example.com`, odId: `${2000000000 + seq++}` },
    });

    const user = await getOrCreateUser(legacy.email.toUpperCase());

    expect(user.id).toBe(legacy.id);
    expect(user.email).toBe(legacy.email.toLowerCase());
    expect(await db.user.count({ where: { email: { equals: legacy.email, mode: 'insensitive' } } })).toBe(1);
  });
});

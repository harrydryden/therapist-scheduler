/**
 * Integration test for the 20260507_add_appointment_transition_generation
 * migration. Verifies the migration applies cleanly against a populated
 * `appointment_requests` table — the scenario `prisma db push --force-
 * reset` (used by the rest of the integration suite) doesn't exercise,
 * because db push always rebuilds the schema from scratch with no data.
 *
 * The contract pinned here:
 *   1. ALTER TABLE adds the column without locking-out concurrent reads
 *      for an unbounded time on a populated table (Postgres handles this
 *      because the DEFAULT 0 is constant — no table rewrite).
 *   2. Existing rows get the default value (0) automatically.
 *   3. The column is NOT NULL, so any later INSERT that omits it gets
 *      the default rather than failing.
 *   4. Subsequent UPDATE ... SET transition_generation = transition_generation + 1
 *      works (the lifecycle service relies on this for atomic bumps).
 *
 * Skipped automatically when TEST_DATABASE_URL is unset.
 */

jest.mock('../../config', () => ({
  config: {
    env: 'test',
    logLevel: 'silent',
    jwtSecret: 'test-secret',
    redisUrl: 'redis://localhost:6379',
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { PrismaClient } from '@prisma/client';
import {
  getIntegrationDb,
  closeIntegrationDb,
  integrationDescribe,
} from '../helpers/integration-db';

let prisma: PrismaClient;

integrationDescribe('Migration: 20260507_add_appointment_transition_generation', () => {
  beforeAll(async () => {
    prisma = await getIntegrationDb();
  }, 60_000);

  afterAll(async () => {
    await closeIntegrationDb();
  });

  beforeEach(async () => {
    await prisma.appointmentAuditEvent.deleteMany({});
    await prisma.sideEffectLog.deleteMany({});
    await prisma.appointmentRequest.deleteMany({});
    await prisma.therapist.deleteMany({});
  });

  it('column exists with default 0 (post db push the schema includes it)', async () => {
    // Sanity: the column is present in the schema after db push, so the
    // basic shape is right. The next two tests exercise the migration
    // path explicitly by dropping + re-applying.
    const cols = await prisma.$queryRaw<Array<{ column_name: string; data_type: string; column_default: string | null; is_nullable: string }>>`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'appointment_requests'
        AND column_name = 'transition_generation'
    `;
    expect(cols).toHaveLength(1);
    expect(cols[0].data_type).toBe('integer');
    expect(cols[0].is_nullable).toBe('NO');
    expect(cols[0].column_default).toContain('0');
  });

  it('replays the ALTER TABLE cleanly against a populated table', async () => {
    // Seed a few rows under the current schema.
    const therapist = await prisma.therapist.create({
      data: {
        odId: `od-mig-${Date.now()}`,
        notionId: `notion-mig-${Date.now()}`,
        email: 'mig@example.com',
        name: 'Mig Test',
        country: 'UK',
        active: true,
      },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.appointmentRequest.create({
        data: {
          userEmail: `migration-${i}@example.com`,
          therapistEmail: therapist.email,
          therapistHandle: therapist.notionId!,
          therapistName: therapist.name,
          status: 'pending',
        },
      });
    }
    expect(await prisma.appointmentRequest.count()).toBe(3);

    // Simulate a "pre-migration" world: drop the column, then re-apply
    // the migration's SQL verbatim. If the migration is structured
    // poorly (e.g. NOT NULL without a default on a populated table),
    // the ALTER TABLE would fail here.
    await prisma.$executeRawUnsafe('ALTER TABLE "appointment_requests" DROP COLUMN "transition_generation"');

    // Replay the exact SQL from
    // prisma/migrations/20260507_add_appointment_transition_generation/migration.sql
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "appointment_requests" ADD COLUMN "transition_generation" INTEGER NOT NULL DEFAULT 0',
    );

    // Existing rows should now have the default value.
    const rows = await prisma.$queryRaw<Array<{ transition_generation: number }>>`
      SELECT transition_generation FROM appointment_requests
    `;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.transition_generation).toBe(0);
    }
  });

  it('atomic increment SQL (the lifecycle service contract) works after the migration', async () => {
    // The lifecycle service writes `transitionGeneration: { increment: 1 }`
    // via Prisma — under the hood that's `SET transition_generation =
    // transition_generation + 1`. Verify this works against the migrated
    // schema and the precondition-based update returns the right count.
    const therapist = await prisma.therapist.create({
      data: {
        odId: `od-incr-${Date.now()}`,
        notionId: `notion-incr-${Date.now()}`,
        email: 'incr@example.com',
        name: 'Incr Test',
        country: 'UK',
        active: true,
      },
    });
    const apt = await prisma.appointmentRequest.create({
      data: {
        userEmail: 'incr@example.com',
        therapistEmail: therapist.email,
        therapistHandle: therapist.notionId!,
        therapistName: therapist.name,
        status: 'pending',
      },
    });
    expect(apt.transitionGeneration).toBe(0);

    // Three sequential atomic increments — what the lifecycle service
    // does on each transition.
    for (let i = 1; i <= 3; i++) {
      const result = await prisma.appointmentRequest.updateMany({
        where: { id: apt.id, transitionGeneration: i - 1 },
        data: { transitionGeneration: { increment: 1 } },
      });
      // updateMany.count = 1 confirms the precondition matched and the
      // bump landed atomically. If the column type or default were
      // wrong, the updateMany would mismatch and return 0.
      expect(result.count).toBe(1);
    }

    const final = await prisma.appointmentRequest.findUnique({ where: { id: apt.id } });
    expect(final!.transitionGeneration).toBe(3);
  });
});

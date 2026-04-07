/**
 * Integration test: Prisma client ↔ schema coherence.
 *
 * This test exists because commit 47509cd added `bookingMethod` to
 * schema.prisma without creating a migration. Production was broken for
 * over a week: every `findUnique()` on appointments failed with
 *   The column `appointment_requests.booking_method` does not exist
 * and the only reason we caught it is because a user complained that
 * specific messages weren't being processed.
 *
 * This test class of check would have caught it immediately:
 *   1. Apply schema.prisma to a real Postgres DB (via `db push`)
 *   2. Issue the exact query pattern that failed (findUnique with no select)
 *   3. If the Prisma client expects a column the DB doesn't have (or vice
 *      versa), the query throws and the test fails
 *
 * Runs only when TEST_DATABASE_URL is set — skipped by default so unit
 * test runs aren't blocked on having Postgres available.
 */

import { PrismaClient } from '@prisma/client';
import {
  getIntegrationDb,
  closeIntegrationDb,
  integrationDescribe,
} from '../helpers/integration-db';

integrationDescribe('Prisma client ↔ schema coherence', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = await getIntegrationDb();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  beforeEach(async () => {
    await prisma.appointmentRequest.deleteMany({});
  });

  it('creates and reads an AppointmentRequest using all schema fields', async () => {
    // Use the full model shape — any schema field that doesn't exist in the
    // DB will cause this `create` to throw with
    //   The column `appointment_requests.X` does not exist
    const created = await prisma.appointmentRequest.create({
      data: {
        userName: 'Test User',
        userEmail: 'user@example.com',
        therapistNotionId: 'test-notion-id',
        therapistEmail: 'therapist@example.com',
        therapistName: 'Test Therapist',
        status: 'contacted',
      },
    });

    expect(created.id).toBeTruthy();
    expect(created.bookingMethod).toBe('agent_negotiated');
  });

  // This is the EXACT query that was failing in processEmailReply.
  // No select clause → Prisma SELECTs every column → any schema-DB drift
  // surfaces here as a runtime error.
  it('findUnique with no select reads every column without error', async () => {
    const created = await prisma.appointmentRequest.create({
      data: {
        userEmail: 'user@example.com',
        therapistNotionId: 'test-notion-id',
        therapistEmail: 'therapist@example.com',
        therapistName: 'Test Therapist',
      },
    });

    const found = await prisma.appointmentRequest.findUnique({
      where: { id: created.id },
    });

    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    // If a schema field didn't exist in the DB, the findUnique above would
    // have thrown before reaching this assertion.
    expect(found?.bookingMethod).toBeDefined();
  });

  it('findMany with no select reads every column without error', async () => {
    await prisma.appointmentRequest.create({
      data: {
        userEmail: 'a@example.com',
        therapistNotionId: 't1',
        therapistEmail: 't1@example.com',
        therapistName: 'T1',
      },
    });
    await prisma.appointmentRequest.create({
      data: {
        userEmail: 'b@example.com',
        therapistNotionId: 't2',
        therapistEmail: 't2@example.com',
        therapistName: 'T2',
      },
    });

    const all = await prisma.appointmentRequest.findMany();
    expect(all).toHaveLength(2);
  });

  // Exercises every model in schema.prisma with a create + findMany so that
  // any missing column surfaces immediately. Add new models here as they're
  // added to the schema.
  describe('every model is queryable with all fields', () => {
    const cases: Array<{
      name: string;
      run: () => Promise<unknown>;
    }> = [
      {
        name: 'User',
        run: async () => {
          await prisma.user.create({
            data: { odId: 'user-od-1', email: 'u@example.com' },
          });
          return prisma.user.findMany();
        },
      },
      {
        name: 'Therapist',
        run: async () => {
          await prisma.therapist.create({
            data: {
              odId: 'ther-od-1',
              notionId: 'n1',
              email: 't@example.com',
              name: 'T',
            },
          });
          return prisma.therapist.findMany();
        },
      },
      {
        name: 'AppointmentRequest',
        run: async () => {
          await prisma.appointmentRequest.create({
            data: {
              userEmail: 'u@x',
              therapistNotionId: 'n',
              therapistEmail: 't@x',
              therapistName: 'T',
            },
          });
          return prisma.appointmentRequest.findMany();
        },
      },
      {
        name: 'PendingEmail',
        run: async () => {
          await prisma.pendingEmail.create({
            data: { toEmail: 't@x', subject: 's', body: 'b' },
          });
          return prisma.pendingEmail.findMany();
        },
      },
      {
        name: 'KnowledgeBase',
        run: async () => {
          await prisma.knowledgeBase.create({
            data: { content: 'c', audience: 'both' },
          });
          return prisma.knowledgeBase.findMany();
        },
      },
      {
        name: 'TherapistBookingStatus',
        run: async () => {
          await prisma.therapistBookingStatus.create({
            data: { id: 'tbs-1', therapistName: 'T' },
          });
          return prisma.therapistBookingStatus.findMany();
        },
      },
      {
        name: 'ProcessedGmailMessage',
        run: async () => {
          await prisma.processedGmailMessage.create({ data: { id: 'msg-1' } });
          return prisma.processedGmailMessage.findMany();
        },
      },
      {
        name: 'UnmatchedEmailAttempt',
        run: async () => {
          await prisma.unmatchedEmailAttempt.create({ data: { id: 'msg-2' } });
          return prisma.unmatchedEmailAttempt.findMany();
        },
      },
      {
        name: 'SystemSetting',
        run: async () => {
          await prisma.systemSetting.create({
            data: {
              id: 'test.key',
              value: '"v"',
              category: 'test',
              label: 'L',
              valueType: 'string',
              defaultValue: '"v"',
            },
          });
          return prisma.systemSetting.findMany();
        },
      },
      {
        name: 'WeeklyMailingInquiry',
        run: async () => {
          await prisma.weeklyMailingInquiry.create({
            data: { userEmail: 'u@x' },
          });
          return prisma.weeklyMailingInquiry.findMany();
        },
      },
      {
        name: 'FeedbackFormConfig',
        run: async () => {
          await prisma.feedbackFormConfig.create({ data: { id: 'cfg-1' } });
          return prisma.feedbackFormConfig.findMany();
        },
      },
      {
        name: 'WorkReport',
        run: async () => {
          await prisma.workReport.create({
            data: { periodStart: new Date(), periodEnd: new Date() },
          });
          return prisma.workReport.findMany();
        },
      },
      {
        name: 'VoucherTracking',
        run: async () => {
          await prisma.voucherTracking.create({ data: { id: 'v@x' } });
          return prisma.voucherTracking.findMany();
        },
      },
    ];

    for (const { name, run } of cases) {
      it(`${name}: create + findMany with no select`, async () => {
        await expect(run()).resolves.toBeDefined();
      });
    }
  });
});

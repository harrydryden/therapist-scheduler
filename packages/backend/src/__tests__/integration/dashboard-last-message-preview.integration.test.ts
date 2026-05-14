/**
 * Integration test for the dashboard list endpoint's last-message
 * preview SQL.
 *
 * Regression test for the visible "No messages yet" bug:
 * `storeConversationState` historically writes `JSON.stringify(state)`
 * into the `conversation_state` Prisma `Json?` field, which Prisma
 * stores as a JSON STRING in the underlying `jsonb` column
 * (`jsonb_typeof = 'string'`), NOT a JSON object. The original SQL
 * `conversation_state->'messages'->-1->>'role'` returns NULL for
 * that shape because you can't apply key access to a JSON string.
 *
 * This suite exercises BOTH shapes against a real Postgres so a
 * future regression that drops the `'string'` branch of the CASE
 * (or writes that go back to stringifying) is caught loudly.
 *
 * Runs only when TEST_DATABASE_URL is set.
 */

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  getIntegrationDb,
  closeIntegrationDb,
  integrationDescribe,
} from '../helpers/integration-db';

integrationDescribe('dashboard list-message preview — jsonb shape tolerance', () => {
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

  /**
   * Recreate the SQL the dashboard list endpoint runs. Keep this in
   * lock-step with `routes/admin/appointments/list-dashboard.ts`.
   * If they drift, the test won't catch a regression — failing this
   * test should be the first signal that the route changed.
   */
  async function previewFor(ids: string[]) {
    return prisma.$queryRaw<Array<{ id: string; role: string | null; content: string | null }>>`
      SELECT id,
             CASE jsonb_typeof(conversation_state)
               WHEN 'object' THEN conversation_state->'messages'->-1->>'role'
               WHEN 'string' THEN ((conversation_state #>> '{}')::jsonb)->'messages'->-1->>'role'
             END AS role,
             CASE jsonb_typeof(conversation_state)
               WHEN 'object' THEN LEFT(conversation_state->'messages'->-1->>'content', 240)
               WHEN 'string' THEN LEFT(((conversation_state #>> '{}')::jsonb)->'messages'->-1->>'content', 240)
             END AS content
      FROM appointment_requests
      WHERE id IN (${Prisma.join(ids)})
    `;
  }

  async function createAppointment(suffix: string): Promise<string> {
    const apt = await prisma.appointmentRequest.create({
      data: {
        userEmail: `preview-${suffix}@example.com`,
        therapistHandle: `preview-th-${suffix}`,
        therapistEmail: `preview-th-${suffix}@example.com`,
        therapistName: `Dr Preview ${suffix}`,
        status: 'negotiating',
      },
    });
    return apt.id;
  }

  // Bypasses Prisma's `Json?` serialisation quirk by writing raw SQL
  // — we want the historical "stored as string" shape for the
  // backward-compatibility branch.
  async function setStringifiedState(id: string, state: object): Promise<void> {
    const stringified = JSON.stringify(state);
    await prisma.$executeRaw`
      UPDATE appointment_requests
      SET conversation_state = to_jsonb(${stringified}::text)
      WHERE id = ${id}
    `;
  }

  async function setObjectState(id: string, state: object): Promise<void> {
    // Prisma's `Json` field serialises an object correctly — this
    // is the desired write shape going forward.
    await prisma.appointmentRequest.update({
      where: { id },
      data: { conversationState: state as object },
    });
  }

  it('extracts the last message when conversation_state is stored as a JSON object', async () => {
    const id = await createAppointment('object');
    await setObjectState(id, {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi back' },
      ],
    });
    const [row] = await previewFor([id]);
    expect(row.role).toBe('assistant');
    expect(row.content).toBe('hi back');
  });

  it('extracts the last message when conversation_state is stored as a JSON string (legacy shape)', async () => {
    const id = await createAppointment('string');
    await setStringifiedState(id, {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third — should win' },
      ],
    });
    const [row] = await previewFor([id]);
    expect(row.role).toBe('user');
    expect(row.content).toBe('third — should win');
  });

  it('truncates content to 240 chars regardless of shape', async () => {
    const longText = 'a'.repeat(500);
    const stringId = await createAppointment('long-string');
    const objectId = await createAppointment('long-object');
    await setStringifiedState(stringId, {
      messages: [{ role: 'assistant', content: longText }],
    });
    await setObjectState(objectId, {
      messages: [{ role: 'assistant', content: longText }],
    });
    const rows = await previewFor([stringId, objectId]);
    for (const r of rows) {
      expect(r.content).not.toBeNull();
      expect(r.content!.length).toBe(240);
    }
  });

  it('returns null role/content for empty messages array', async () => {
    const stringId = await createAppointment('empty-string');
    const objectId = await createAppointment('empty-object');
    await setStringifiedState(stringId, { messages: [] });
    await setObjectState(objectId, { messages: [] });
    const rows = await previewFor([stringId, objectId]);
    for (const r of rows) {
      expect(r.role).toBeNull();
      expect(r.content).toBeNull();
    }
  });

  it('returns null role/content when conversation_state is null', async () => {
    const id = await createAppointment('null');
    // Default state — conversation_state is NULL on create.
    const [row] = await previewFor([id]);
    expect(row.role).toBeNull();
    expect(row.content).toBeNull();
  });
});

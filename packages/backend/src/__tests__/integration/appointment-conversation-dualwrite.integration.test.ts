/**
 * Integration test: Phase 3a dual-write invariant.
 *
 * Every writer of `appointment_requests.conversation_state` or
 * `appointment_requests.memory` MUST atomically mirror the new value
 * to the sibling `appointment_conversations` row. This test exercises
 * each writer end-to-end against a real Postgres and asserts both
 * sides match after the write.
 *
 * Runs only when TEST_DATABASE_URL is set — skipped by default so
 * unit-test runs aren't blocked on having Postgres available.
 *
 * The test suite is the primary safety net for the cutover phase —
 * if any writer is added or modified without a corresponding mirror
 * write, this suite is meant to catch it.
 */

import type { PrismaClient } from '@prisma/client';
import {
  getIntegrationDb,
  closeIntegrationDb,
  integrationDescribe,
} from '../helpers/integration-db';

integrationDescribe('Phase 3a dual-write — appointment_conversations', () => {
  let prisma: PrismaClient;
  let appointmentId: string;

  beforeAll(async () => {
    prisma = await getIntegrationDb();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  beforeEach(async () => {
    // Clean slate. Cascade on AppointmentConversation FK so deleting
    // the parent appointment cleans up the mirror automatically.
    await prisma.appointmentRequest.deleteMany({});
    const apt = await prisma.appointmentRequest.create({
      data: {
        userEmail: 'dualwrite-user@example.com',
        therapistHandle: 'dualwrite-th',
        therapistEmail: 'dualwrite-th@example.com',
        therapistName: 'Dr Dualwrite',
        status: 'pending',
      },
    });
    appointmentId = apt.id;
  });

  it('storeConversationState mirrors conversationState to the sibling table', async () => {
    // Import lazily so the test file can be authored without ai-conversation
    // initializing config / etc. at module-eval time.
    const { aiConversationService } = await import('../../services/ai-conversation.service');

    await aiConversationService.storeConversationState(appointmentId, {
      systemPrompt: 'test prompt',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    });

    const [legacyRow, mirrorRow] = await Promise.all([
      prisma.appointmentRequest.findUnique({
        where: { id: appointmentId },
        select: { conversationState: true },
      }),
      prisma.appointmentConversation.findUnique({
        where: { appointmentId },
        select: { conversationState: true },
      }),
    ]);

    expect(legacyRow?.conversationState).toBeTruthy();
    expect(mirrorRow?.conversationState).toBeTruthy();
    expect(mirrorRow?.conversationState).toEqual(legacyRow?.conversationState);
  });

  it('addAuditMessage (raw SQL jsonb_set) mirrors to the sibling table', async () => {
    const { addAuditMessage } = await import('../../domain/scheduling/lifecycle/audit');

    // First write — bootstraps both rows from null/missing.
    await addAuditMessage(appointmentId, 'system', 'first audit message');

    let [legacy, mirror] = await Promise.all([
      prisma.appointmentRequest.findUnique({
        where: { id: appointmentId },
        select: { conversationState: true },
      }),
      prisma.appointmentConversation.findUnique({
        where: { appointmentId },
        select: { conversationState: true },
      }),
    ]);

    expect(mirror?.conversationState).toBeTruthy();
    expect(mirror?.conversationState).toEqual(legacy?.conversationState);

    // Second write — exercises the jsonb_set append branch on both
    // tables. Should produce two messages in each.
    await addAuditMessage(appointmentId, 'system', 'second audit message');

    [legacy, mirror] = await Promise.all([
      prisma.appointmentRequest.findUnique({
        where: { id: appointmentId },
        select: { conversationState: true },
      }),
      prisma.appointmentConversation.findUnique({
        where: { appointmentId },
        select: { conversationState: true },
      }),
    ]);

    const legacyMessages = (legacy?.conversationState as { messages: unknown[] }).messages;
    const mirrorMessages = (mirror?.conversationState as { messages: unknown[] }).messages;
    expect(legacyMessages).toHaveLength(2);
    expect(mirrorMessages).toEqual(legacyMessages);
  });

  it('agent-memory addNote mirrors memory to the sibling table', async () => {
    const { addNote } = await import('../../services/agent-memory.service');

    await addNote(appointmentId, 'preference', 'Client prefers morning sessions');

    const [legacy, mirror] = await Promise.all([
      prisma.appointmentRequest.findUnique({
        where: { id: appointmentId },
        select: { memory: true },
      }),
      prisma.appointmentConversation.findUnique({
        where: { appointmentId },
        select: { memory: true },
      }),
    ]);

    expect(legacy?.memory).toBeTruthy();
    expect(mirror?.memory).toBeTruthy();
    expect(mirror?.memory).toEqual(legacy?.memory);
  });

  it('agent-memory addAvailabilityWindow mirrors memory to the sibling table', async () => {
    const { addAvailabilityWindow } = await import('../../services/agent-memory.service');

    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const end = new Date(future.getTime() + 60 * 60 * 1000);

    await addAvailabilityWindow(appointmentId, {
      startsAt: future.toISOString(),
      endsAt: end.toISOString(),
      status: 'available',
      source: 'therapist',
      quote: 'free next week',
    });

    const [legacy, mirror] = await Promise.all([
      prisma.appointmentRequest.findUnique({
        where: { id: appointmentId },
        select: { memory: true },
      }),
      prisma.appointmentConversation.findUnique({
        where: { appointmentId },
        select: { memory: true },
      }),
    ]);

    expect(legacy?.memory).toBeTruthy();
    expect(mirror?.memory).toEqual(legacy?.memory);
  });

  it('mixing writers preserves both fields on the mirror row', async () => {
    const { aiConversationService } = await import('../../services/ai-conversation.service');
    const { addNote } = await import('../../services/agent-memory.service');

    // First a conversationState write, then a memory write. The
    // mirror row must have BOTH fields set — neither write should
    // wipe the other.
    await aiConversationService.storeConversationState(appointmentId, {
      systemPrompt: 'prompt',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await addNote(appointmentId, 'context', 'New client');

    const mirror = await prisma.appointmentConversation.findUnique({
      where: { appointmentId },
      select: { conversationState: true, memory: true },
    });

    expect(mirror?.conversationState).toBeTruthy();
    expect(mirror?.memory).toBeTruthy();
  });

  it('cascade delete removes the mirror row when the appointment is deleted', async () => {
    const { aiConversationService } = await import('../../services/ai-conversation.service');

    await aiConversationService.storeConversationState(appointmentId, {
      systemPrompt: 'p',
      messages: [],
    });

    expect(
      await prisma.appointmentConversation.findUnique({ where: { appointmentId } }),
    ).not.toBeNull();

    await prisma.appointmentRequest.delete({ where: { id: appointmentId } });

    expect(
      await prisma.appointmentConversation.findUnique({ where: { appointmentId } }),
    ).toBeNull();
  });
});

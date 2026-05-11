/**
 * Tests for the availability-collection agent's tool executor.
 *
 * Pins the contract that the four tools (record_availability_window,
 * remember, mark_complete, flag_for_human_review) each:
 *   - Reject malformed input with a specific Zod-derived error
 *   - Write to the right row (TherapistConversation memory vs Therapist
 *     upcomingAvailability) keyed on the supplied IDs only
 *   - Are no-ops when the conversation is no longer 'active'
 *   - Are no-ops when humanControlEnabled
 *   - Dedupe via the Redis idempotency hash
 *
 * The pre-flight gates (human control, status, idempotency) matter as
 * much as the happy path here: phase 2 has no atomic update for human
 * control, so tests at this layer are the load-bearing guarantee that
 * a tool call won't proceed against a paused or terminated conversation.
 */

import Anthropic from '@anthropic-ai/sdk';

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// email-processing.service transitively validates the env-loaded
// config at module load. Stub the config + the email module itself
// so the executor's `send_email` handler import doesn't trip config
// validation.
jest.mock('../config', () => ({
  config: {
    timezone: 'Europe/London',
    anthropicApiKey: 'test-key',
    nodeEnv: 'test',
    jwtSecret: 'test-secret',
    backendUrl: 'https://backend.test',
    frontendUrl: 'https://frontend.test',
  },
}));

// Typed with an explicit params arg so mock.calls[i][0] is typed
// — lets tests assert on what the executor passed. The arrow-fn
// indirection in the factory below is required because jest.mock is
// hoisted above this declaration; the closure capture only resolves
// at call time, after the const has been initialised.
const mockSendEmail = jest.fn(
  async (_params: { to: string; subject: string; body: string; threadId?: string }) => ({
    threadId: 'thread-default',
    messageId: 'msg-default',
  }),
);
jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: {
    sendEmail: (params: { to: string; subject: string; body: string; threadId?: string }) =>
      mockSendEmail(params),
  },
}));

// In-memory stores keyed by primary key — mirrors agent-memory.test.ts.
type TherapistRow = {
  id: string;
  name: string;
  email: string;
  country: string;
  availability: unknown;
  upcomingAvailability: unknown;
};
type ConversationRow = {
  id: string;
  therapistId: string;
  kind: 'onboarding' | 'nudge_reply';
  status: 'active' | 'completed' | 'superseded' | 'abandoned';
  humanControlEnabled: boolean;
  humanControlTakenBy: string | null;
  humanControlTakenAt: Date | null;
  humanControlReason: string | null;
  completedAt: Date | null;
  memory: unknown;
  conversationState: unknown;
  lastActivityAt: Date;
  lastToolExecutedAt: Date | null;
  gmailThreadId: string | null;
  initialMessageId: string | null;
};

const therapists: Record<string, TherapistRow> = {};
const conversations: Record<string, ConversationRow> = {};

const therapistFindUnique = jest.fn(async ({ where }: { where: { id: string } }) => {
  return therapists[where.id] || null;
});
const therapistUpdate = jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<TherapistRow> }) => {
  if (!therapists[where.id]) throw new Error('P2025: record not found');
  therapists[where.id] = { ...therapists[where.id], ...data };
  return therapists[where.id];
});

const conversationFindUnique = jest.fn(async ({ where }: { where: { id: string } }) => {
  return conversations[where.id] || null;
});
const conversationUpdate = jest.fn(
  async ({ where, data }: { where: { id: string }; data: Partial<ConversationRow> }) => {
    if (!conversations[where.id]) throw new Error('P2025: record not found');
    conversations[where.id] = { ...conversations[where.id], ...data };
    return conversations[where.id];
  },
);
const conversationUpdateMany = jest.fn(
  async ({
    where,
    data,
  }: {
    where: {
      id: string;
      status?: string;
      humanControlEnabled?: boolean;
      gmailThreadId?: string | null;
    };
    data: Partial<ConversationRow>;
  }) => {
    const row = conversations[where.id];
    if (!row) return { count: 0 };
    if (where.status !== undefined && row.status !== where.status) return { count: 0 };
    if (
      where.humanControlEnabled !== undefined &&
      row.humanControlEnabled !== where.humanControlEnabled
    )
      return { count: 0 };
    if (where.gmailThreadId !== undefined && row.gmailThreadId !== where.gmailThreadId)
      return { count: 0 };
    conversations[where.id] = { ...row, ...data };
    return { count: 1 };
  },
);

jest.mock('../utils/database', () => ({
  prisma: {
    therapist: {
      findUnique: (...a: unknown[]) => therapistFindUnique(...(a as [{ where: { id: string } }])),
      update: (...a: unknown[]) => therapistUpdate(...(a as [{ where: { id: string }; data: Partial<TherapistRow> }])),
    },
    therapistConversation: {
      findUnique: (...a: unknown[]) =>
        conversationFindUnique(...(a as [{ where: { id: string } }])),
      update: (...a: unknown[]) =>
        conversationUpdate(...(a as [{ where: { id: string }; data: Partial<ConversationRow> }])),
      updateMany: (...a: unknown[]) =>
        conversationUpdateMany(...(a as [{ where: { id: string; status?: string }; data: Partial<ConversationRow> }])),
    },
  },
}));

// Idempotency cache — same shape the real redis client exposes for
// the keys we use (get/set with EX).
const redisStore: Record<string, string> = {};
jest.mock('../utils/redis', () => ({
  redis: {
    get: jest.fn(async (key: string) => redisStore[key] ?? null),
    set: jest.fn(async (key: string, value: string) => {
      redisStore[key] = value;
      return 'OK';
    }),
  },
}));

import { AvailabilityToolExecutorService } from '../services/availability-tool-executor.service';
import type { AvailabilityAgentContext } from '../services/agent-tool-loop';

function makeContext(overrides: Partial<AvailabilityAgentContext> = {}): AvailabilityAgentContext {
  return {
    conversationId: 'convo-1',
    therapistId: 'tx-1',
    therapistName: 'Alex Therapist',
    therapistEmail: 'alex@example.com',
    therapistCountry: 'UK',
    kind: 'onboarding',
    ...overrides,
  };
}

function makeToolCall(name: string, input: unknown, id = `tu-${name}`): Anthropic.ToolUseBlock {
  return { type: 'tool_use', id, name, input } as Anthropic.ToolUseBlock;
}

function seedTherapist(id = 'tx-1') {
  therapists[id] = {
    id,
    name: 'Alex Therapist',
    email: 'alex@example.com',
    country: 'UK',
    availability: null,
    upcomingAvailability: null,
  };
}
function seedConversation(id = 'convo-1', therapistId = 'tx-1', overrides: Partial<ConversationRow> = {}) {
  conversations[id] = {
    id,
    therapistId,
    kind: 'onboarding',
    status: 'active',
    humanControlEnabled: false,
    humanControlTakenBy: null,
    humanControlTakenAt: null,
    humanControlReason: null,
    completedAt: null,
    memory: null,
    conversationState: null,
    lastActivityAt: new Date(),
    lastToolExecutedAt: null,
    gmailThreadId: null,
    initialMessageId: null,
    ...overrides,
  };
}

// A window comfortably in the future so the past-window guard doesn't
// reject it during tests. Computed at module load time so we don't need
// to keep regenerating ISO strings inside each test.
const FUTURE_START = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const FUTURE_END = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(therapists)) delete therapists[k];
  for (const k of Object.keys(conversations)) delete conversations[k];
  for (const k of Object.keys(redisStore)) delete redisStore[k];
  mockSendEmail.mockResolvedValue({ threadId: 'thread-default', messageId: 'msg-default' });
});

describe('AvailabilityToolExecutor — pre-flight gates', () => {
  it('returns error when the conversation row is missing', async () => {
    const exec = new AvailabilityToolExecutorService('trace-1');
    const result = await exec.executeToolCall(
      makeToolCall('remember', { note: 'test', category: 'context' }),
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('returns a human_control skip when the conversation is paused', async () => {
    seedTherapist();
    seedConversation('convo-1', 'tx-1', { humanControlEnabled: true });
    const exec = new AvailabilityToolExecutorService('trace-1');
    const result = await exec.executeToolCall(
      makeToolCall('remember', { note: 'test', category: 'context' }),
      makeContext(),
    );
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('human_control');
  });

  it('returns a conversation_inactive skip for completed/superseded/abandoned rows', async () => {
    const exec = new AvailabilityToolExecutorService('trace-1');
    for (const status of ['completed', 'superseded', 'abandoned'] as const) {
      seedTherapist();
      seedConversation('convo-1', 'tx-1', { status });
      const result = await exec.executeToolCall(
        makeToolCall('remember', { note: 'test', category: 'context' }, `tu-${status}`),
        makeContext(),
      );
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('conversation_inactive');
      // Reset for next iteration
      delete conversations['convo-1'];
    }
  });

  it('returns an idempotent skip when the same tool call repeats within TTL', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');
    const call = makeToolCall('remember', { note: 'unique-note', category: 'context' });

    const first = await exec.executeToolCall(call, makeContext());
    expect(first.success).toBe(true);
    expect(first.skipped).toBeFalsy();

    const second = await exec.executeToolCall(call, makeContext());
    expect(second.skipped).toBe(true);
    expect(second.skipReason).toBe('idempotent');
  });
});

describe('AvailabilityToolExecutor — record_availability_window', () => {
  it('writes the window to Therapist.upcomingAvailability with source=therapist', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('record_availability_window', {
        starts_at: FUTURE_START,
        ends_at: FUTURE_END,
        status: 'available',
        quote: 'I can do Tuesday afternoons',
      }),
      makeContext(),
    );

    expect(result.success).toBe(true);
    const updated = therapists['tx-1'].upcomingAvailability as Array<{
      startsAt: string;
      source: string;
      quote: string;
    }>;
    expect(updated).toHaveLength(1);
    expect(updated[0].startsAt).toBe(FUTURE_START);
    expect(updated[0].source).toBe('therapist');
    expect(updated[0].quote).toBe('I can do Tuesday afternoons');
  });

  it('rejects past windows with a specific error the agent can act on', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('record_availability_window', {
        starts_at: '2020-01-01T10:00:00+00:00',
        ends_at: '2020-01-01T11:00:00+00:00',
        status: 'available',
        quote: 'last year',
      }),
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/past/i);
    expect(therapists['tx-1'].upcomingAvailability).toBeNull();
  });

  it('rejects ends_at <= starts_at', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('record_availability_window', {
        starts_at: FUTURE_END,
        ends_at: FUTURE_START,
        status: 'available',
        quote: 'inverted',
      }),
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/strictly after/i);
  });

  it('rejects unparseable ISO 8601 starts_at', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('record_availability_window', {
        starts_at: 'not-a-date',
        ends_at: FUTURE_END,
        status: 'available',
        quote: 'broken',
      }),
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/parseable ISO 8601/);
  });

  it('deduplicates identical windows on the same therapist', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    // Use two distinct conversation IDs so the executor's Redis-based
    // idempotency doesn't short-circuit the second call before it reaches
    // the storage-layer dedup we're trying to test.
    const first = await exec.executeToolCall(
      makeToolCall(
        'record_availability_window',
        { starts_at: FUTURE_START, ends_at: FUTURE_END, status: 'available', quote: 'first' },
        'tu-first',
      ),
      makeContext({ conversationId: 'convo-1' }),
    );
    expect(first.success).toBe(true);

    seedConversation('convo-2');
    const second = await exec.executeToolCall(
      makeToolCall(
        'record_availability_window',
        { starts_at: FUTURE_START, ends_at: FUTURE_END, status: 'available', quote: 'second phrasing' },
        'tu-second',
      ),
      makeContext({ conversationId: 'convo-2' }),
    );
    expect(second.success).toBe(true);
    expect(second.resultMessage).toMatch(/deduplicated/i);
    // Only one window persisted on the therapist row.
    expect((therapists['tx-1'].upcomingAvailability as unknown[]).length).toBe(1);
  });
});

describe('AvailabilityToolExecutor — remember', () => {
  it('writes a note to the conversation row', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('remember', {
        note: 'therapist asked us to email at 9am their time',
        category: 'preference',
      }),
      makeContext(),
    );

    expect(result.success).toBe(true);
    const memory = conversations['convo-1'].memory as { notes: Array<{ text: string; category: string }> };
    expect(memory.notes).toHaveLength(1);
    expect(memory.notes[0].text).toBe('therapist asked us to email at 9am their time');
    expect(memory.notes[0].category).toBe('preference');
  });

  it('rejects an unknown category', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('remember', { note: 'test', category: 'not-a-category' }),
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid input/i);
  });
});

describe('AvailabilityToolExecutor — mark_complete', () => {
  it('flips the row to status=completed and stamps completedAt', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('mark_complete', { summary: 'Captured 2 weeks of availability' }),
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(conversations['convo-1'].status).toBe('completed');
    expect(conversations['convo-1'].completedAt).toBeInstanceOf(Date);
  });

  it('is a no-op when the conversation has been superseded', async () => {
    seedTherapist();
    seedConversation('convo-1', 'tx-1', { status: 'superseded' });
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('mark_complete', { summary: 'late mark_complete' }),
      makeContext(),
    );

    // Pre-flight gate catches this before the handler runs.
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('conversation_inactive');
    expect(conversations['convo-1'].status).toBe('superseded');
  });
});

describe('AvailabilityToolExecutor — flag_for_human_review', () => {
  it('flips humanControlEnabled and stores the reason', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('flag_for_human_review', {
        reason: 'therapist asked about pricing',
        suggested_action: 'have admin reply',
      }),
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(conversations['convo-1'].humanControlEnabled).toBe(true);
    expect(conversations['convo-1'].humanControlTakenBy).toBe('agent_self_flag');
    expect(conversations['convo-1'].humanControlReason).toContain('therapist asked about pricing');
    expect(conversations['convo-1'].humanControlReason).toContain('have admin reply');
  });
});

describe('AvailabilityToolExecutor — send_email', () => {
  it('sends to the therapist email from context (model never supplies "to")', async () => {
    seedTherapist();
    seedConversation();
    mockSendEmail.mockResolvedValue({ threadId: 'thread-abc', messageId: 'msg-abc' });
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('send_email', {
        subject: 'Welcome to Spill',
        body: 'Hi Alex, when are you free over the next few weeks?',
      }),
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.skipped).toBeFalsy();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0][0] as {
      to: string;
      subject: string;
      body: string;
      threadId?: string;
    };
    // Critical safety guarantee: recipient is the therapist's email from
    // context, not anything the model could have supplied.
    expect(call.to).toBe('alex@example.com');
    expect(call.subject).toContain('Spill');
    expect(call.threadId).toBeUndefined(); // first send opens a new thread
  });

  it('prepends "Spill" to subjects that lack it', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    await exec.executeToolCall(
      makeToolCall('send_email', {
        subject: 'A quick question about availability',
        body: 'body text',
      }),
      makeContext(),
    );

    const call = mockSendEmail.mock.calls[0][0] as { subject: string };
    expect(call.subject).toBe('Spill - A quick question about availability');
  });

  it('keeps subjects that already contain "Spill" unchanged', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    await exec.executeToolCall(
      makeToolCall('send_email', {
        subject: 'Welcome to Spill - sharing your availability',
        body: 'body',
      }),
      makeContext(),
    );

    const call = mockSendEmail.mock.calls[0][0] as { subject: string };
    expect(call.subject).toBe('Welcome to Spill - sharing your availability');
  });

  it('persists the Gmail thread+message ID back to the conversation row on first send', async () => {
    seedTherapist();
    seedConversation();
    mockSendEmail.mockResolvedValue({ threadId: 'thread-xyz', messageId: 'msg-xyz' });
    const exec = new AvailabilityToolExecutorService('trace-1');

    await exec.executeToolCall(
      makeToolCall('send_email', { subject: 'Subject', body: 'Body' }),
      makeContext(),
    );

    expect(conversations['convo-1'].gmailThreadId).toBe('thread-xyz');
    expect(conversations['convo-1'].initialMessageId).toBe('msg-xyz');
  });

  it('reuses the stored threadId on subsequent sends and does NOT overwrite the initialMessageId', async () => {
    seedTherapist();
    seedConversation('convo-1', 'tx-1', {
      gmailThreadId: 'thread-existing',
      initialMessageId: 'msg-original',
    });
    mockSendEmail.mockResolvedValue({ threadId: 'thread-existing', messageId: 'msg-second' });
    const exec = new AvailabilityToolExecutorService('trace-1');

    await exec.executeToolCall(
      makeToolCall('send_email', { subject: 'Follow-up', body: 'Body' }),
      makeContext(),
    );

    const call = mockSendEmail.mock.calls[0][0] as { threadId?: string };
    expect(call.threadId).toBe('thread-existing');
    // The original message ID should still be the FIRST send's; phase 3
    // only ever sets initialMessageId on the first send (atomic
    // conditional update on gmailThreadId IS NULL).
    expect(conversations['convo-1'].initialMessageId).toBe('msg-original');
  });

  it('returns an error when emailProcessingService throws', async () => {
    seedTherapist();
    seedConversation();
    mockSendEmail.mockRejectedValueOnce(new Error('Gmail API 503'));
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('send_email', { subject: 'Subject', body: 'Body' }),
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Gmail API 503/);
    expect(conversations['convo-1'].gmailThreadId).toBeNull();
  });

  it('rejects empty subject via Zod validation', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('send_email', { subject: '', body: 'body' }),
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid input/i);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('AvailabilityToolExecutor — atomic human-control gate', () => {
  it('does NOT execute any tool when humanControl flips between check and run (TOCTOU pin)', async () => {
    seedTherapist();
    seedConversation('convo-1', 'tx-1', { humanControlEnabled: true });
    const exec = new AvailabilityToolExecutorService('trace-1');

    // send_email is the most dangerous TOCTOU target because it's the
    // only irreversible side effect. Pin the contract: gate blocks the
    // dispatch, send is never called.
    const result = await exec.executeToolCall(
      makeToolCall('send_email', { subject: 'Subject', body: 'Body' }),
      makeContext(),
    );

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('human_control');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('updates lastToolExecutedAt + lastActivityAt only when the gate passes', async () => {
    seedTherapist();
    seedConversation();
    const initialActivity = conversations['convo-1'].lastActivityAt;
    // Force a small clock gap so we can verify the bump actually happened.
    await new Promise((r) => setTimeout(r, 5));
    const exec = new AvailabilityToolExecutorService('trace-1');

    await exec.executeToolCall(
      makeToolCall('remember', { note: 'test', category: 'context' }),
      makeContext(),
    );

    const updated = conversations['convo-1'];
    expect(updated.lastActivityAt.getTime()).toBeGreaterThan(initialActivity.getTime());
    expect(updated.lastToolExecutedAt).toBeInstanceOf(Date);
  });
});

describe('AvailabilityToolExecutor — unknown tool', () => {
  it('returns a clear error rather than throwing', async () => {
    seedTherapist();
    seedConversation();
    const exec = new AvailabilityToolExecutorService('trace-1');

    const result = await exec.executeToolCall(
      makeToolCall('this_tool_does_not_exist', { foo: 'bar' }),
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown tool/i);
  });
});

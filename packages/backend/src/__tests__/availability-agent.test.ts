/**
 * Integration-shaped tests for the AvailabilityAgentService.
 *
 * These exercise the full path: orchestrator → loop → executor → DB.
 * The Anthropic SDK is mocked at the client level with scripted
 * responses so each test can deterministically drive the agent to a
 * particular branch (no tool calls, record_window then mark_complete,
 * flag_for_human_review, etc.) without depending on a live API.
 *
 * What we're pinning here:
 *   - startCollection creates a TherapistConversation row, runs the
 *     initial turn, and persists state.
 *   - record_availability_window calls from inside the loop land on
 *     Therapist.upcomingAvailability.
 *   - mark_complete from inside the loop flips status to 'completed'.
 *   - processReply on a superseded conversation is a silent skip.
 *   - processReply under human control appends the inbound but doesn't
 *     invoke the agent (the [Received while paused] line is the tell).
 */

import Anthropic from '@anthropic-ai/sdk';

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// utils/date pulls config at module load; mock the env-validated config
// to avoid process.exit(1) on missing required fields.
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

// In-memory Prisma store. Shared between the executor under test and
// our assertions — same shape as the executor test, plus a `create`
// hook for the conversation row that startCollection writes.
type TherapistRow = {
  id: string;
  name: string;
  email: string;
  country: string;
  availability: unknown;
  upcomingAvailability: unknown;
  bookingLink: string | null;
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
  messageCount: number;
  lastActivityAt: Date;
  // Optimistic-lock version. Real Prisma manages this via @updatedAt;
  // the mock bumps it on every update so the agent's
  // persistStateWithLock predicate can detect concurrent writes.
  updatedAt: Date;
  gmailThreadId: string | null;
  initialMessageId: string | null;
  supersededAckSent: boolean;
  supersededAt: Date | null;
  supersededByAppointmentId: string | null;
  therapist?: TherapistRow;
};

const therapists: Record<string, TherapistRow> = {};
const conversations: Record<string, ConversationRow> = {};
let nextConversationId = 1;

const therapistFindUnique = jest.fn(async ({ where }: { where: { id: string } }) => {
  return therapists[where.id] || null;
});
const therapistUpdate = jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<TherapistRow> }) => {
  if (!therapists[where.id]) throw new Error('P2025: record not found');
  therapists[where.id] = { ...therapists[where.id], ...data };
  return therapists[where.id];
});

const conversationCreate = jest.fn(async ({ data }: { data: Partial<ConversationRow> & { therapistId: string } }) => {
  const id = `convo-${nextConversationId++}`;
  const now = new Date();
  const row: ConversationRow = {
    id,
    therapistId: data.therapistId,
    kind: (data.kind as 'onboarding' | 'nudge_reply') || 'onboarding',
    status: 'active',
    humanControlEnabled: false,
    humanControlTakenBy: null,
    humanControlTakenAt: null,
    humanControlReason: null,
    completedAt: null,
    memory: null,
    conversationState: data.conversationState ?? null,
    messageCount: data.messageCount ?? 0,
    lastActivityAt: now,
    updatedAt: now,
    gmailThreadId: data.gmailThreadId ?? null,
    initialMessageId: data.initialMessageId ?? null,
    supersededAckSent: false,
    supersededAt: null,
    supersededByAppointmentId: null,
  };
  conversations[id] = row;
  return row;
});
const conversationFindUnique = jest.fn(
  async ({
    where,
    include,
    select,
  }: {
    where: { id: string };
    include?: { therapist?: unknown };
    select?: { therapist?: unknown };
  }) => {
    const row = conversations[where.id];
    if (!row) return null;
    // Always eagerly attach the therapist relation when the caller's
    // include OR select asks for it. The real Prisma client returns
    // shaped projections, but our tests don't depend on shape — just
    // on the relation being present (or not) for the
    // `if (!row.therapist)` guards in the service code.
    if (include?.therapist || select?.therapist) {
      return { ...row, therapist: therapists[row.therapistId] };
    }
    return row;
  },
);
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
      id?: string;
      status?: string;
      humanControlEnabled?: boolean;
      gmailThreadId?: string | null;
      supersededAckSent?: boolean;
      therapistId?: string;
      kind?: string;
      // Optimistic-lock predicate used by persistStateWithLock.
      updatedAt?: Date;
    };
    data: Partial<ConversationRow>;
  }) => {
    // Cover both the "where: { id }" case (most calls) and the
    // "where: { therapistId, status: 'active' }" supersession case
    // (no id). Iterate rather than direct lookup so both work.
    let matched = 0;
    for (const row of Object.values(conversations)) {
      if (where.id !== undefined && row.id !== where.id) continue;
      if (where.status !== undefined && row.status !== where.status) continue;
      if (
        where.humanControlEnabled !== undefined &&
        row.humanControlEnabled !== where.humanControlEnabled
      )
        continue;
      if (where.gmailThreadId !== undefined && row.gmailThreadId !== where.gmailThreadId) continue;
      if (
        where.supersededAckSent !== undefined &&
        row.supersededAckSent !== where.supersededAckSent
      )
        continue;
      if (where.therapistId !== undefined && row.therapistId !== where.therapistId) continue;
      if (where.kind !== undefined && row.kind !== where.kind) continue;
      // Optimistic-lock check: predicate must match the row's current
      // updatedAt exactly. Real Prisma compares Date instances by
      // getTime so we match that here.
      if (
        where.updatedAt !== undefined &&
        row.updatedAt.getTime() !== where.updatedAt.getTime()
      )
        continue;
      // We DON'T auto-bump updatedAt here even though real Prisma
      // does via @updatedAt. Reason: the agent's gate + tool writes
      // omit updatedAt from their `data`, but the persistStateWithLock
      // writes ALWAYS pass an explicit `updatedAt`. Auto-bumping on
      // the gate/tool writes makes the persistStateWithLock predicate
      // probabilistically miss when the test runs across a millisecond
      // boundary (faster on isolated runs, slower under load), which
      // turns deterministic flow tests into flaky ones. Tests that
      // need to exercise a real updatedAt drift (the optimistic-lock
      // conflict test) mutate `conversations[id].updatedAt` directly.
      conversations[row.id] = data.updatedAt !== undefined
        ? { ...row, ...data, updatedAt: data.updatedAt }
        : { ...row, ...data };
      matched++;
    }
    return { count: matched };
  },
);

// $transaction forwards through to the same mocks so the assertions
// can observe writes regardless of whether they go through the
// direct prisma client or the transactional one. Defined inside the
// factory (rather than as a top-level const + spread) because
// jest.mock is hoisted above module-scope `const`s — a hoisted
// reference would fire before the const is initialised.
jest.mock('../utils/database', () => {
  const client = {
    therapist: {
      findUnique: (...a: unknown[]) => therapistFindUnique(...(a as [{ where: { id: string } }])),
      update: (...a: unknown[]) =>
        therapistUpdate(...(a as [{ where: { id: string }; data: Partial<TherapistRow> }])),
    },
    therapistConversation: {
      create: (...a: unknown[]) =>
        conversationCreate(
          ...(a as [{ data: Partial<ConversationRow> & { therapistId: string } }]),
        ),
      findUnique: (...a: unknown[]) =>
        conversationFindUnique(
          ...(a as [
            {
              where: { id: string };
              include?: { therapist?: unknown };
              select?: { therapist?: unknown };
            },
          ]),
        ),
      update: (...a: unknown[]) =>
        conversationUpdate(
          ...(a as [{ where: { id: string }; data: Partial<ConversationRow> }]),
        ),
      updateMany: (...a: unknown[]) =>
        conversationUpdateMany(
          ...(a as [
            { where: { id?: string; status?: string }; data: Partial<ConversationRow> },
          ]),
        ),
    },
    // No-op for the row-lock SELECT used by addUpcomingAvailability —
    // the in-test scheduler is single-threaded so the lock is moot,
    // but the production code expects $queryRaw to exist on the tx.
    $queryRaw: jest.fn(async () => []),
  };
  return {
    prisma: {
      ...client,
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(client)),
    },
  };
});

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

// Anthropic SDK — script the response queue per test. Each call shifts
// one response off the head of the array; tests fail loudly if the
// agent makes more calls than scripted (so we notice unexpected extra
// iterations rather than silently returning whatever last response
// happened to be sitting around).
let scriptedResponses: Anthropic.Message[] = [];
const messagesCreate = jest.fn(async () => {
  if (scriptedResponses.length === 0) {
    throw new Error('messagesCreate called more times than test scripted');
  }
  return scriptedResponses.shift()!;
});

jest.mock('../utils/anthropic-client', () => ({
  anthropicClient: {
    // Mock ignores args (scripted-response queue drives output), so no
    // need to forward — keeps TS happy without a typed Parameters<…>.
    messages: { create: () => messagesCreate() },
  },
  isTransientError: () => false,
}));

// Pass-through resilientCall — the production version retries on
// transient errors, but for unit tests the scripted client is
// deterministic and we want to see what it returns.
jest.mock('../utils/resilient-call', () => ({
  resilientCall: async (fn: () => Promise<unknown>) => fn(),
}));

// Circuit breaker isn't load-bearing here.
jest.mock('../utils/circuit-breaker', () => ({
  circuitBreakerRegistry: { getOrCreate: () => ({}) },
  CIRCUIT_BREAKER_CONFIGS: { CLAUDE_API: {} },
}));

// Content sanitizer in passthrough mode — tests don't depend on
// injection wrapping.
jest.mock('../utils/content-sanitizer', () => ({
  checkForInjection: () => ({ injectionDetected: false, detectedPatterns: [] }),
  wrapUntrustedContent: (s: string) => s,
}));

// Settings service isn't exercised by the prompt builder we use
// (availabilities are inlined directly), but jest's hoister still
// pulls in the module. Stub it.
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn().mockResolvedValue(undefined),
  getSettingValues: jest.fn().mockResolvedValue(new Map()),
}));

// ai-conversation.service imports the entire email-processing chain
// transitively (which in turn validates config at module load). The
// only symbol the availability agent imports from it is the slim
// `truncateMessageContent` helper — short-circuit the chain by mocking
// the module with just that helper.
jest.mock('../services/ai-conversation.service', () => ({
  truncateMessageContent: (s: string) => s,
}));

// Outbound email mock for the send_email tool path.
// Arrow-fn indirection in the factory is required because jest.mock
// is hoisted above this declaration; only call-time resolves the
// reference correctly.
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

import {
  AvailabilityAgentService,
  supersedeActiveTherapistConversationInTx,
} from '../services/availability-agent.service';

// ─── Helpers to build scripted Anthropic.Message responses ──────────────────

function textOnlyResponse(text: string): Anthropic.Message {
  return {
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text, citations: null } as unknown as Anthropic.TextBlock],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: 'standard',
    },
  } as Anthropic.Message;
}

function toolUseResponse(toolName: string, input: unknown, text = ''): Anthropic.Message {
  const blocks: unknown[] = [];
  if (text) blocks.push({ type: 'text', text, citations: null });
  blocks.push({
    type: 'tool_use',
    id: `tu-${toolName}-${Math.random().toString(36).slice(2, 8)}`,
    name: toolName,
    input,
  });
  return {
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    content: blocks as Anthropic.ContentBlock[],
    model: 'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: 'standard',
    },
  } as Anthropic.Message;
}

function seedTherapist(overrides: Partial<TherapistRow> = {}): TherapistRow {
  const row: TherapistRow = {
    id: 'tx-1',
    name: 'Alex Therapist',
    email: 'alex@example.com',
    country: 'UK',
    availability: null,
    upcomingAvailability: null,
    bookingLink: null,
    ...overrides,
  };
  therapists[row.id] = row;
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(therapists)) delete therapists[k];
  for (const k of Object.keys(conversations)) delete conversations[k];
  for (const k of Object.keys(redisStore)) delete redisStore[k];
  scriptedResponses = [];
  nextConversationId = 1;
  mockSendEmail.mockResolvedValue({ threadId: 'thread-default', messageId: 'msg-default' });
});

describe('AvailabilityAgentService.startCollection', () => {
  it('creates a TherapistConversation row, fires send_email, and persists the thread ID', async () => {
    seedTherapist();
    mockSendEmail.mockResolvedValue({ threadId: 'thread-onboarding', messageId: 'msg-1' });
    // Script: agent calls send_email for the introductory email, then exits.
    scriptedResponses = [
      toolUseResponse('send_email', {
        subject: 'Welcome to Spill',
        body: 'Hi Alex, when are you free over the next few weeks?',
      }),
      textOnlyResponse("I've sent the introductory email."),
    ];

    const service = new AvailabilityAgentService('trace-1');
    const result = await service.startCollection({ therapistId: 'tx-1', kind: 'onboarding' });

    expect(result.success).toBe(true);
    expect(result.conversationId).toBe('convo-1');
    expect(conversations['convo-1']).toBeDefined();
    expect(conversations['convo-1'].status).toBe('active');
    expect(conversations['convo-1'].kind).toBe('onboarding');
    // Email was actually sent — recipient is the therapist's email from
    // the row, never anything the model could have supplied.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const emailCall = mockSendEmail.mock.calls[0][0] as { to: string; subject: string };
    expect(emailCall.to).toBe('alex@example.com');
    expect(emailCall.subject).toContain('Spill');
    // Gmail thread is now stashed back so phase-4 inbound dispatch can
    // match the therapist's reply to this conversation.
    expect(conversations['convo-1'].gmailThreadId).toBe('thread-onboarding');
    expect(conversations['convo-1'].initialMessageId).toBe('msg-1');
  });

  it('still creates the row when the agent exits with text only (no send_email)', async () => {
    seedTherapist();
    // Some prompt configurations may produce a text-only turn before
    // committing to an outbound — the row should still exist and be
    // resumable. Pins that startCollection doesn't require an outbound.
    scriptedResponses = [textOnlyResponse("Drafting your introductory message...")];

    const service = new AvailabilityAgentService('trace-1');
    const result = await service.startCollection({ therapistId: 'tx-1', kind: 'onboarding' });

    expect(result.success).toBe(true);
    expect(conversations['convo-1']).toBeDefined();
    expect(conversations['convo-1'].gmailThreadId).toBeNull();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('abandons any prior active onboarding row for the therapist before creating a new one', async () => {
    seedTherapist();
    // Pre-existing active onboarding (simulates a retry or duplicate
    // ingestion). Phase-6 robustness pins that startCollection
    // enforces the same single-active-row invariant the nudge service
    // does — without this, two onboarding rows would both match
    // future inbound replies by therapistId and create ambiguity.
    conversations['old-onboarding'] = {
      id: 'old-onboarding',
      therapistId: 'tx-1',
      kind: 'onboarding',
      status: 'active',
      humanControlEnabled: false,
      humanControlTakenBy: null,
      humanControlTakenAt: null,
      humanControlReason: null,
      completedAt: null,
      memory: null,
      conversationState: { messages: [] },
      messageCount: 0,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      gmailThreadId: 'thread-old',
      initialMessageId: 'msg-old',
      supersededAckSent: false,
      supersededAt: null,
      supersededByAppointmentId: null,
    };
    scriptedResponses = [textOnlyResponse('first turn')];

    const service = new AvailabilityAgentService('trace-1');
    await service.startCollection({ therapistId: 'tx-1', kind: 'onboarding' });

    // Old row abandoned, not deleted — audit preserved.
    expect(conversations['old-onboarding'].status).toBe('abandoned');
    // Exactly one active row remains.
    const active = Object.values(conversations).filter(
      (c) => c.therapistId === 'tx-1' && c.status === 'active',
    );
    expect(active).toHaveLength(1);
    expect(active[0].id).not.toBe('old-onboarding');
  });

  it('persists the gmailThreadId when supplied', async () => {
    seedTherapist();
    scriptedResponses = [textOnlyResponse('Hi!')];

    const service = new AvailabilityAgentService('trace-1');
    await service.startCollection({
      therapistId: 'tx-1',
      kind: 'onboarding',
      gmailThreadId: 'thread-abc',
      initialMessageId: 'msg-abc',
    });

    expect(conversations['convo-1'].gmailThreadId).toBe('thread-abc');
    expect(conversations['convo-1'].initialMessageId).toBe('msg-abc');
  });
});

describe('AvailabilityAgentService.processReply', () => {
  it('routes a record_availability_window tool call to the therapist row', async () => {
    seedTherapist();
    // Pre-create an active conversation as if startCollection had run.
    conversations['convo-pre'] = {
      id: 'convo-pre',
      therapistId: 'tx-1',
      kind: 'onboarding',
      status: 'active',
      humanControlEnabled: false,
      humanControlTakenBy: null,
      humanControlTakenAt: null,
      humanControlReason: null,
      completedAt: null,
      memory: null,
      conversationState: { messages: [{ role: 'assistant', content: 'Hi Alex!' }] },
      messageCount: 1,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      gmailThreadId: null,
      initialMessageId: null,
      supersededAckSent: false,
      supersededAt: null,
      supersededByAppointmentId: null,
    };

    const futureStart = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const futureEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString();

    // First Claude call: records a window.
    // Second Claude call: marks complete.
    // Third Claude call: no tool, loop exits.
    scriptedResponses = [
      toolUseResponse('record_availability_window', {
        starts_at: futureStart,
        ends_at: futureEnd,
        status: 'available',
        quote: 'I can do Tuesdays 2-4pm',
      }),
      toolUseResponse('mark_complete', { summary: 'Captured Tuesday afternoons' }),
    ];

    const service = new AvailabilityAgentService('trace-1');
    const result = await service.processReply({
      conversationId: 'convo-pre',
      emailContent: 'I can do Tuesdays 2-4pm for the next month',
      fromEmail: 'alex@example.com',
    });

    expect(result.success).toBe(true);
    // Window landed on the therapist row.
    const windows = therapists['tx-1'].upcomingAvailability as Array<{ startsAt: string; source: string }>;
    expect(windows).toHaveLength(1);
    expect(windows[0].startsAt).toBe(futureStart);
    expect(windows[0].source).toBe('therapist');
    // mark_complete fired, so the conversation transitioned.
    expect(conversations['convo-pre'].status).toBe('completed');
    expect(conversations['convo-pre'].completedAt).toBeInstanceOf(Date);
  });

  it('skips agent processing without invoking Claude when conversation is superseded', async () => {
    seedTherapist();
    conversations['convo-pre'] = {
      id: 'convo-pre',
      therapistId: 'tx-1',
      kind: 'onboarding',
      status: 'superseded',
      humanControlEnabled: false,
      humanControlTakenBy: null,
      humanControlTakenAt: null,
      humanControlReason: null,
      completedAt: null,
      memory: null,
      conversationState: { messages: [] },
      messageCount: 0,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      gmailThreadId: null,
      initialMessageId: null,
      supersededAckSent: false,
      supersededAt: null,
      supersededByAppointmentId: null,
    };

    const service = new AvailabilityAgentService('trace-1');
    const result = await service.processReply({
      conversationId: 'convo-pre',
      emailContent: 'still here',
      fromEmail: 'alex@example.com',
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('conversation_superseded');
    // Critical: Claude was never called for a superseded conversation.
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('appends inbound to state but skips Claude when humanControlEnabled', async () => {
    seedTherapist();
    conversations['convo-pre'] = {
      id: 'convo-pre',
      therapistId: 'tx-1',
      kind: 'onboarding',
      status: 'active',
      humanControlEnabled: true,
      humanControlTakenBy: 'admin',
      humanControlTakenAt: new Date(),
      humanControlReason: 'admin takeover',
      completedAt: null,
      memory: null,
      conversationState: { messages: [] },
      messageCount: 0,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      gmailThreadId: null,
      initialMessageId: null,
      supersededAckSent: false,
      supersededAt: null,
      supersededByAppointmentId: null,
    };

    const service = new AvailabilityAgentService('trace-1');
    const result = await service.processReply({
      conversationId: 'convo-pre',
      emailContent: 'still here',
      fromEmail: 'alex@example.com',
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('human_control');
    expect(messagesCreate).not.toHaveBeenCalled();
    // Inbound landed in state for the admin to see.
    const state = conversations['convo-pre'].conversationState as { messages: Array<{ content: string }> };
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toMatch(/Received while paused/);
  });

  it('also fires sendSupersessionAck when explicitly invoked', () => {
    // Bridge test — the sendSupersessionAck path is exercised
    // thoroughly in the dedicated describe block below; this stub
    // just documents that the orchestrator surface has it.
    expect(typeof new AvailabilityAgentService('trace-1').sendSupersessionAck).toBe('function');
  });

  it('detects a concurrent state write via optimistic locking and surfaces the conflict in the result', async () => {
    seedTherapist();
    conversations['convo-pre'] = {
      id: 'convo-pre',
      therapistId: 'tx-1',
      kind: 'onboarding',
      status: 'active',
      humanControlEnabled: false,
      humanControlTakenBy: null,
      humanControlTakenAt: null,
      humanControlReason: null,
      completedAt: null,
      memory: null,
      conversationState: { messages: [] },
      messageCount: 0,
      lastActivityAt: new Date(),
      updatedAt: new Date('2026-05-11T10:00:00Z'),
      gmailThreadId: 'thread-1',
      initialMessageId: null,
      supersededAckSent: false,
      supersededAt: null,
      supersededByAppointmentId: null,
    };
    // Agent's reply with no tool calls — easiest case, we still get
    // to the final persistStateWithLock call where the lock check
    // matters.
    scriptedResponses = [textOnlyResponse('thanks for the info')];

    // Simulate a concurrent write happening BEFORE the final persist:
    // bump updatedAt on the row directly so the optimistic-lock
    // predicate fails when processReply tries to save. The
    // try/finally restores the default implementation so the swap
    // doesn't leak into other tests (jest.clearAllMocks clears
    // call history but NOT mockImplementation).
    const originalCb = (conversationUpdateMany as jest.Mock).getMockImplementation()!;
    let agentCalled = false;
    (conversationUpdateMany as jest.Mock).mockImplementation(async (arg: unknown) => {
      // Right before the final update fires, mutate the row out from
      // under it so the predicate doesn't match. We detect "the agent's
      // final save attempt" by checking for the conversationState data
      // payload.
      const a = arg as { where: { id?: string; updatedAt?: Date }; data: { conversationState?: unknown } };
      if (a.data.conversationState && a.where.updatedAt && !agentCalled) {
        agentCalled = true;
        // Drift the row's updatedAt so the predicate misses
        conversations['convo-pre'].updatedAt = new Date('2026-05-11T11:00:00Z');
      }
      return originalCb(arg);
    });

    try {
      const service = new AvailabilityAgentService('trace-1');
      const result = await service.processReply({
        conversationId: 'convo-pre',
        emailContent: 'I am free Tuesdays',
        fromEmail: 'alex@example.com',
      });

      // Conflict detected and surfaced — tools (if any) still fired,
      // but the state save lost the race.
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/state save conflicted/i);
    } finally {
      (conversationUpdateMany as jest.Mock).mockImplementation(originalCb);
    }
  });

  it('flags for human review when the agent escalates', async () => {
    seedTherapist();
    conversations['convo-pre'] = {
      id: 'convo-pre',
      therapistId: 'tx-1',
      kind: 'onboarding',
      status: 'active',
      humanControlEnabled: false,
      humanControlTakenBy: null,
      humanControlTakenAt: null,
      humanControlReason: null,
      completedAt: null,
      memory: null,
      conversationState: { messages: [] },
      messageCount: 0,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      gmailThreadId: null,
      initialMessageId: null,
      supersededAckSent: false,
      supersededAt: null,
      supersededByAppointmentId: null,
    };
    scriptedResponses = [
      toolUseResponse('flag_for_human_review', {
        reason: 'therapist asked about pricing',
        suggested_action: 'admin reply',
      }),
    ];

    const service = new AvailabilityAgentService('trace-1');
    const result = await service.processReply({
      conversationId: 'convo-pre',
      emailContent: 'Quick question on pricing',
      fromEmail: 'alex@example.com',
    });

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/human review/i);
    expect(conversations['convo-pre'].humanControlEnabled).toBe(true);
    expect(conversations['convo-pre'].humanControlReason).toMatch(/pricing/);
  });
});

describe('AvailabilityAgentService.sendSupersessionAck', () => {
  function seedSupersededConversation(overrides: Partial<ConversationRow> = {}) {
    seedTherapist();
    conversations['convo-superseded'] = {
      id: 'convo-superseded',
      therapistId: 'tx-1',
      kind: 'onboarding',
      status: 'superseded',
      humanControlEnabled: false,
      humanControlTakenBy: null,
      humanControlTakenAt: null,
      humanControlReason: null,
      completedAt: null,
      memory: null,
      conversationState: { messages: [] },
      messageCount: 0,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      gmailThreadId: 'thread-old',
      initialMessageId: 'msg-old',
      supersededAckSent: false,
      supersededAt: new Date(),
      supersededByAppointmentId: 'appt-new',
      ...overrides,
    };
  }

  beforeEach(() => {
    // Configure settings mock to return an ack template that uses the
    // {therapistFirstName} variable, so the substitution path is
    // exercised.
    const settingsMod = jest.requireMock('../services/settings.service') as {
      getSettingValues: jest.Mock;
    };
    settingsMod.getSettingValues.mockResolvedValue(
      new Map([
        ['email.availabilitySupersededAckSubject', 'Thanks - we have your booking in hand'],
        ['email.availabilitySupersededAckBody', 'Hi {therapistFirstName}, ack body.'],
      ]),
    );
  });

  it('claims the flag, sends the ack on the existing thread, and reports emailSent=true', async () => {
    seedSupersededConversation();
    mockSendEmail.mockResolvedValue({ threadId: 'thread-old', messageId: 'msg-ack' });

    const result = await new AvailabilityAgentService('trace-1').sendSupersessionAck(
      'convo-superseded',
    );

    expect(result.success).toBe(true);
    expect(result.alreadySent).toBe(false);
    expect(result.emailSent).toBe(true);
    // Flag flipped (no rollback because send succeeded).
    expect(conversations['convo-superseded'].supersededAckSent).toBe(true);
    // Ack went on the SAME thread as the original conversation so the
    // therapist sees a single inline reply, not a new thread.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const sent = mockSendEmail.mock.calls[0][0];
    expect(sent.threadId).toBe('thread-old');
    expect(sent.to).toBe('alex@example.com');
    expect(sent.subject).toContain('Spill');
    expect(sent.body).toContain('Alex'); // substituted from "Alex Therapist"
  });

  it('is a no-op when the ack has already been sent (alreadySent=true)', async () => {
    seedSupersededConversation({ supersededAckSent: true });
    const result = await new AvailabilityAgentService('trace-1').sendSupersessionAck(
      'convo-superseded',
    );
    expect(result.alreadySent).toBe(true);
    expect(result.emailSent).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('rolls the flag back to false when the outbound email fails', async () => {
    seedSupersededConversation();
    mockSendEmail.mockRejectedValueOnce(new Error('Gmail 503'));

    const result = await new AvailabilityAgentService('trace-1').sendSupersessionAck(
      'convo-superseded',
    );

    expect(result.success).toBe(false);
    expect(result.emailSent).toBe(false);
    // Critical: flag must be back to false so a later inbound on the
    // same thread can re-trigger the ack rather than be silently
    // dropped forever.
    expect(conversations['convo-superseded'].supersededAckSent).toBe(false);
  });

  it('does not send when the row has flipped away from superseded mid-race', async () => {
    // Row is now 'completed' (e.g. admin manually closed it) — the CAS
    // predicate guards against acking on a non-superseded row.
    seedSupersededConversation({ status: 'completed' });
    const result = await new AvailabilityAgentService('trace-1').sendSupersessionAck(
      'convo-superseded',
    );
    expect(result.alreadySent).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('supersedeActiveTherapistConversationInTx', () => {
  // Cast our mock as the full TransactionClient surface — only the
  // therapistConversation.updateMany method is exercised here, so
  // the rest stays unimplemented.
  const txStub = {
    therapistConversation: {
      updateMany: (...a: unknown[]) =>
        conversationUpdateMany(
          ...(a as [
            {
              where: {
                id: string;
                status?: string;
                humanControlEnabled?: boolean;
                gmailThreadId?: string | null;
                supersededAckSent?: boolean;
                therapistId?: string;
              };
              data: Partial<ConversationRow>;
            },
          ]),
        ),
    },
  } as unknown as Parameters<typeof supersedeActiveTherapistConversationInTx>[0];

  it('flips all active conversations for the therapist to superseded', async () => {
    seedTherapist();
    conversations['convo-active-1'] = {
      id: 'convo-active-1',
      therapistId: 'tx-1',
      kind: 'onboarding',
      status: 'active',
      humanControlEnabled: false,
      humanControlTakenBy: null,
      humanControlTakenAt: null,
      humanControlReason: null,
      completedAt: null,
      memory: null,
      conversationState: { messages: [] },
      messageCount: 0,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      gmailThreadId: 'thread-a',
      initialMessageId: null,
      supersededAckSent: false,
      supersededAt: null,
      supersededByAppointmentId: null,
    };

    const count = await supersedeActiveTherapistConversationInTx(txStub, 'tx-1', 'appt-new');

    expect(count).toBe(1);
    expect(conversations['convo-active-1'].status).toBe('superseded');
    expect(conversations['convo-active-1'].supersededAt).toBeInstanceOf(Date);
    expect(conversations['convo-active-1'].supersededByAppointmentId).toBe('appt-new');
  });

  it('does not touch already-completed/superseded/abandoned rows', async () => {
    seedTherapist();
    conversations['convo-completed'] = {
      id: 'convo-completed',
      therapistId: 'tx-1',
      kind: 'onboarding',
      status: 'completed',
      humanControlEnabled: false,
      humanControlTakenBy: null,
      humanControlTakenAt: null,
      humanControlReason: null,
      completedAt: new Date(),
      memory: null,
      conversationState: { messages: [] },
      messageCount: 0,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      gmailThreadId: null,
      initialMessageId: null,
      supersededAckSent: false,
      supersededAt: null,
      supersededByAppointmentId: null,
    };

    const count = await supersedeActiveTherapistConversationInTx(txStub, 'tx-1', 'appt-new');

    expect(count).toBe(0);
    expect(conversations['convo-completed'].status).toBe('completed');
    expect(conversations['convo-completed'].supersededAt).toBeNull();
  });

  it('returns 0 when no conversation exists for the therapist', async () => {
    seedTherapist();
    const count = await supersedeActiveTherapistConversationInTx(txStub, 'tx-1', 'appt-new');
    expect(count).toBe(0);
  });
});

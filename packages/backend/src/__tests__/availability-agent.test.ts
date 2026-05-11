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
  gmailThreadId: string | null;
  initialMessageId: string | null;
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
    lastActivityAt: new Date(),
    gmailThreadId: data.gmailThreadId ?? null,
    initialMessageId: data.initialMessageId ?? null,
  };
  conversations[id] = row;
  return row;
});
const conversationFindUnique = jest.fn(
  async ({ where, include }: { where: { id: string }; include?: { therapist?: unknown } }) => {
    const row = conversations[where.id];
    if (!row) return null;
    if (include?.therapist) {
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
      create: (...a: unknown[]) => conversationCreate(...(a as [{ data: Partial<ConversationRow> & { therapistId: string } }])),
      findUnique: (...a: unknown[]) =>
        conversationFindUnique(...(a as [{ where: { id: string }; include?: { therapist?: unknown } }])),
      update: (...a: unknown[]) =>
        conversationUpdate(...(a as [{ where: { id: string }; data: Partial<ConversationRow> }])),
      updateMany: (...a: unknown[]) =>
        conversationUpdateMany(...(a as [{ where: { id: string; status?: string }; data: Partial<ConversationRow> }])),
    },
  },
}));

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
const mockSendEmail = jest.fn(async () => ({
  threadId: 'thread-default',
  messageId: 'msg-default',
}));
jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: {
    sendEmail: (...a: unknown[]) =>
      (mockSendEmail as (...x: unknown[]) => Promise<{ threadId: string; messageId: string }>)(
        ...a,
      ),
  },
}));

import { AvailabilityAgentService } from '../services/availability-agent.service';

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
      gmailThreadId: null,
      initialMessageId: null,
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
      gmailThreadId: null,
      initialMessageId: null,
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
      gmailThreadId: null,
      initialMessageId: null,
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
      gmailThreadId: null,
      initialMessageId: null,
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

/**
 * Response-level guards shared by both agent loops (agent-tool-loop.ts):
 *
 *   - stop_reason 'max_tokens': the truncated response's tool calls are
 *     never executed; the loop re-asks once with the larger cap and
 *     escalates if that is cut off too. Before: a truncated tool_use ran
 *     as-is (or a truncated text reply counted as a natural finish).
 *   - stop_reason 'refusal' and an empty response with nothing done this
 *     turn escalate to human review. Before: both passed as "finished".
 *   - prompt caching: cache_control on the system block (tools + system)
 *     and on the final message of each request, without breakpoints
 *     accumulating across iterations.
 *   - per-turn token usage is summed onto the result.
 *   - the daily token budget: exhausted → escalate without calling Claude.
 */

import type Anthropic from '@anthropic-ai/sdk';

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config', () => ({ config: { logLevel: 'silent', env: 'test' } }));
jest.mock('../config/models', () => ({
  CLAUDE_MODELS: { AGENT: 'claude-test' },
  MODEL_CONFIG: { agent: { maxTokens: 4096, maxTokensOnTruncation: 8192, requestTimeoutMs: 1000 } },
}));

let scripted: Anthropic.Message[] = [];
const messagesCreate = jest.fn(async (_body: Anthropic.MessageCreateParamsNonStreaming, _opts?: unknown) => {
  if (scripted.length === 0) throw new Error('messagesCreate called more times than scripted');
  return scripted.shift()!;
});
jest.mock('../utils/anthropic-client', () => ({
  anthropicClient: {
    messages: {
      create: (body: Anthropic.MessageCreateParamsNonStreaming, opts?: unknown) => messagesCreate(body, opts),
    },
  },
  isTransientError: () => false,
}));
jest.mock('../utils/resilient-call', () => ({
  resilientCall: async (fn: () => Promise<unknown>) => fn(),
}));
jest.mock('../utils/circuit-breaker', () => ({
  circuitBreakerRegistry: { getOrCreate: () => ({}) },
  CIRCUIT_BREAKER_CONFIGS: { CLAUDE_API: {} },
}));

// Redis: token-budget counter (GET) + INCRBY script (eval) + alert guard.
const redisGet = jest.fn(async (_key: string): Promise<string | null> => null);
const redisEval = jest.fn(async (..._a: unknown[]): Promise<unknown> => 0);
const setNX = jest.fn(async (..._a: unknown[]): Promise<'OK' | 'EXISTS'> => 'OK');
jest.mock('../utils/redis', () => ({
  redis: {
    get: (key: string) => redisGet(key),
    eval: (...a: unknown[]) => redisEval(...a),
  },
  cacheManager: { setNX: (...a: unknown[]) => setNX(...a) },
}));

const settings: Record<string, unknown> = {};
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => settings[key]),
}));
const sendAlert = jest.fn();
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: (...a: unknown[]) => sendAlert(...a) },
}));
jest.mock('../services/ai-conversation.service', () => ({
  truncateMessageContent: (s: string) => s,
}));
jest.mock('../services/audit-event.service', () => ({
  auditEventService: { logToolExecuted: jest.fn() },
}));
jest.mock('../services/tools-for-stage', () => ({ getToolsForStage: () => [] }));

import { runToolLoop, runAvailabilityToolLoop } from '../services/agent-tool-loop';
import { recordTokenUsage, getDailyTokenBudgetStatus } from '../services/agent-token-budget';
import type { SchedulingContext, ToolExecutionResult } from '../services/scheduling-context.service';
import type { ConversationState } from '../types';

const CONTEXT = {
  appointmentRequestId: 'apt-guard',
  userName: 'Maria',
  userEmail: 'maria@example.com',
  therapistEmail: 'dr@example.com',
  therapistName: 'Dr',
  therapistAvailability: null,
  bookingMethod: 'agent_negotiated',
  userCountry: 'UK',
  therapistCountry: 'UK',
} as SchedulingContext;

function usage(input = 100, output = 20, cacheRead = 0, cacheWrite = 0): Anthropic.Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  } as Anthropic.Usage;
}

function reply(
  stopReason: Anthropic.Message['stop_reason'],
  opts: { text?: string; tools?: Array<{ name: string; input: unknown }>; usage?: Anthropic.Usage } = {},
): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  if (opts.text) content.push({ type: 'text', text: opts.text, citations: null } as Anthropic.TextBlock);
  for (const t of opts.tools ?? []) {
    content.push({ type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2)}`, name: t.name, input: t.input } as Anthropic.ToolUseBlock);
  }
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: opts.usage ?? usage(),
  } as Anthropic.Message;
}

function run(executeToolCall: jest.Mock, flagForHumanReview = jest.fn(), state?: ConversationState) {
  const conversationState = state ?? { systemPrompt: '', messages: [] };
  return {
    conversationState,
    flagForHumanReview,
    promise: runToolLoop(
      'SYSTEM PROMPT',
      [{ role: 'user', content: 'New email from the client' }],
      conversationState,
      CONTEXT,
      { executeToolCall, flagForHumanReview },
      'trace-guard',
      'test',
    ),
  };
}

const ok = (name: string): ToolExecutionResult => ({ success: true, toolName: name });

beforeEach(() => {
  jest.clearAllMocks();
  scripted = [];
  for (const k of Object.keys(settings)) delete settings[k];
  redisGet.mockResolvedValue(null);
  redisEval.mockResolvedValue(0);
  setNX.mockResolvedValue('OK');
});

describe('stop_reason: max_tokens', () => {
  it('never executes a truncated response; retries once with the larger cap and acts on that', async () => {
    scripted = [
      reply('max_tokens', { tools: [{ name: 'send_email', input: { to: 'maria@example.com', body: 'Hi Maria, the times are' } }] }),
      reply('tool_use', { tools: [{ name: 'send_email', input: { to: 'maria@example.com', body: 'Hi Maria, the times are Tue 3pm.' } }] }),
      reply('end_turn', { text: 'Sent.' }),
    ];
    const exec = jest.fn(async (tc: Anthropic.ToolUseBlock) => ok(tc.name));
    const { promise, flagForHumanReview } = run(exec);
    const { result } = await promise;

    expect(exec).toHaveBeenCalledTimes(1);
    expect((exec.mock.calls[0][0] as Anthropic.ToolUseBlock).input).toEqual({
      to: 'maria@example.com',
      body: 'Hi Maria, the times are Tue 3pm.',
    });
    expect(messagesCreate.mock.calls[0][0].max_tokens).toBe(4096);
    expect(messagesCreate.mock.calls[1][0].max_tokens).toBe(8192);
    expect(flagForHumanReview).not.toHaveBeenCalled();
    expect(result.flaggedForHumanReview).toBe(false);
  });

  it('escalates (and runs nothing) when the retry is cut off too', async () => {
    scripted = [
      reply('max_tokens', { tools: [{ name: 'send_email', input: { body: 'cut' } }] }),
      reply('max_tokens', { tools: [{ name: 'send_email', input: { body: 'cut again' } }] }),
    ];
    const exec = jest.fn(async (tc: Anthropic.ToolUseBlock) => ok(tc.name));
    const { promise, flagForHumanReview, conversationState } = run(exec);
    const { result } = await promise;

    expect(exec).not.toHaveBeenCalled();
    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/cut off at the output-token limit twice/);
    expect(result.flaggedForHumanReview).toBe(true);
    expect(conversationState.messages.some((m) => m.role === 'admin' && /cut off/.test(m.content))).toBe(true);
    // The truncated text never lands in the conversation log.
    expect(conversationState.messages.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('a truncated text-only reply is not a natural finish', async () => {
    scripted = [reply('max_tokens', { text: 'I will now email the therap' }), reply('max_tokens', { text: 'I will now' })];
    const { promise, flagForHumanReview } = run(jest.fn());
    const { result } = await promise;
    expect(result.flaggedForHumanReview).toBe(true);
    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
  });
});

describe('stop_reason: refusal and empty responses', () => {
  it('a refusal flags for human review instead of passing as finished', async () => {
    scripted = [reply('refusal', { text: '' })];
    const exec = jest.fn();
    const { promise, flagForHumanReview } = run(exec);
    const { result } = await promise;
    expect(exec).not.toHaveBeenCalled();
    expect(result.flaggedForHumanReview).toBe(true);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/declined to respond/);
  });

  it('an empty first response (nothing done this turn) flags for human review', async () => {
    scripted = [reply('end_turn', {})];
    const { promise, flagForHumanReview } = run(jest.fn());
    const { result } = await promise;
    expect(result.flaggedForHumanReview).toBe(true);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/empty response/);
  });

  it('an empty end_turn AFTER a successful tool call is a natural finish', async () => {
    scripted = [reply('tool_use', { tools: [{ name: 'send_email', input: { to: 'x' } }] }), reply('end_turn', {})];
    const exec = jest.fn(async (tc: Anthropic.ToolUseBlock) => ok(tc.name));
    const { promise, flagForHumanReview } = run(exec);
    const { result } = await promise;
    expect(result.flaggedForHumanReview).toBe(false);
    expect(flagForHumanReview).not.toHaveBeenCalled();
    expect(result.executedTools).toHaveLength(1);
  });

  it('the availability loop applies the same guard (refusal → flagged)', async () => {
    scripted = [reply('refusal', {})];
    const flagForHumanReview = jest.fn();
    const { result } = await runAvailabilityToolLoop(
      'SYSTEM',
      [{ role: 'user', content: 'hi' }],
      { messages: [] },
      {
        conversationId: 'conv-1',
        therapistId: 'th-1',
        therapistName: 'Dr',
        therapistEmail: 'dr@example.com',
        therapistCountry: 'UK',
        kind: 'onboarding',
      },
      { executeToolCall: jest.fn(), flagForHumanReview },
      'trace',
      'test',
    );
    expect(result.flaggedForHumanReview).toBe(true);
    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
  });
});

describe('prompt caching and token usage', () => {
  it('caches tools+system and the latest message, without accumulating breakpoints', async () => {
    scripted = [
      reply('tool_use', { tools: [{ name: 'remember', input: { note: 'a' } }], usage: usage(1000, 50, 0, 900) }),
      reply('tool_use', { tools: [{ name: 'remember', input: { note: 'b' } }], usage: usage(80, 40, 900, 60) }),
      reply('end_turn', { text: 'done', usage: usage(60, 10, 960, 40) }),
    ];
    const exec = jest.fn(async (tc: Anthropic.ToolUseBlock) => ok(tc.name));
    const { promise } = run(exec);
    const { result } = await promise;

    expect(messagesCreate).toHaveBeenCalledTimes(3);
    for (const [body] of messagesCreate.mock.calls) {
      expect(body.system).toEqual([{ type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } }]);
      const breakpoints = JSON.stringify(body.messages).split('"cache_control"').length - 1;
      expect(breakpoints).toBe(1);
      const last = body.messages[body.messages.length - 1];
      const blocks = last.content as Array<{ cache_control?: unknown }>;
      expect(blocks[blocks.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    }
    // Per-request timeout passed with the raised max_tokens.
    expect(messagesCreate.mock.calls[0][1]).toEqual({ timeout: 1000 });

    expect(result.usage).toEqual({
      calls: 3,
      inputTokens: 1140,
      outputTokens: 100,
      cacheReadInputTokens: 1860,
      cacheCreationInputTokens: 1000,
    });
  });
});

describe('daily token budget', () => {
  it('escalates WITHOUT calling Claude once the budget is exhausted', async () => {
    settings['agent.dailyTokenBudget'] = 1000;
    redisGet.mockResolvedValue('1000');
    const exec = jest.fn();
    const { promise, flagForHumanReview } = run(exec);
    const { result } = await promise;

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(result.flaggedForHumanReview).toBe(true);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/Daily Claude token budget exhausted/);
  });

  it('records every response against the budget counter', async () => {
    scripted = [reply('end_turn', { text: 'ok', usage: usage(100, 20, 300, 40) })];
    await run(jest.fn()).promise;
    expect(redisEval).toHaveBeenCalledTimes(1);
    const [, numKeys, key, tokens] = redisEval.mock.calls[0];
    expect(numKeys).toBe(1);
    expect(key).toMatch(/^agent:token-budget:\d{4}-\d{2}-\d{2}$/);
    expect(tokens).toBe(460);
  });

  it('alerts once when 80% is crossed, and once more at 100%', async () => {
    settings['agent.dailyTokenBudget'] = 1000;
    const seen = new Set<string>();
    setNX.mockImplementation(async (key: unknown) => {
      if (seen.has(String(key))) return 'EXISTS';
      seen.add(String(key));
      return 'OK';
    });
    const now = new Date('2026-09-28T12:00:00Z');

    redisEval.mockResolvedValueOnce(700);
    await recordTokenUsage(usage(700, 0), { traceId: 't', context: 'c' }, now);
    expect(sendAlert).not.toHaveBeenCalled();

    redisEval.mockResolvedValueOnce(850);
    await recordTokenUsage(usage(150, 0), { traceId: 't', context: 'c' }, now);
    redisEval.mockResolvedValueOnce(900);
    await recordTokenUsage(usage(50, 0), { traceId: 't', context: 'c' }, now);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0][0].title).toMatch(/80% used/);

    redisEval.mockResolvedValueOnce(1200);
    await recordTokenUsage(usage(300, 0), { traceId: 't', context: 'c' }, now);
    expect(sendAlert).toHaveBeenCalledTimes(2);
    expect(sendAlert.mock.calls[1][0].title).toMatch(/exhausted/);
  });

  it('fails open when Redis cannot be read, and 0 disables the budget', async () => {
    settings['agent.dailyTokenBudget'] = 10;
    redisGet.mockRejectedValue(new Error('redis down'));
    expect((await getDailyTokenBudgetStatus()).exhausted).toBe(false);

    settings['agent.dailyTokenBudget'] = 0;
    redisGet.mockResolvedValue('999999999');
    expect(await getDailyTokenBudgetStatus()).toEqual({ exhausted: false, used: 0, budget: 0 });
  });
});

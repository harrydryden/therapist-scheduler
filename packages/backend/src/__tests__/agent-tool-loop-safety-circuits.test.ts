/**
 * End-to-end tests for the four runaway-protection circuits inside the two
 * agent tool loops — `runToolLoop` (booking) and `runAvailabilityToolLoop`
 * (availability). The helper builders that produce the message strings are
 * pinned by tool-loop-helpers.test.ts, but until this file existed there was
 * no test that drove the loops with a scripted Claude and asserted the wiring
 * between a tripped circuit and the `flagForHumanReview` callback.
 *
 * Both loops share the same per-turn guard arithmetic (budget + same-hash);
 * the availability scenarios at the bottom lock that loop's behaviour before
 * the shared `ToolTurnGuard` extraction so the refactor is provably
 * behaviour-preserving for both callers.
 *
 * The wiring matters because a refactor in any of these four pathways
 * — the turn-budget gate, the same-hash guard, the error-breaker, the
 * iteration ceiling — would silently break the "agent never goes quiet
 * to admins" invariant the system depends on for pilot operability.
 * That has happened before: the MAX_TOOL_ITERATIONS dead-signal bug
 * (fixed in PR #262) shipped because the wire-up itself wasn't tested.
 *
 * Each circuit has its own scenario:
 *   - Turn-tool budget exhausted (TURN_TOOL_BUDGET = 12)
 *   - Same-hash abort (SAME_HASH_TURN_ABORT = 3)
 *   - Error breaker (TURN_ERROR_LIMIT = 3)
 *   - Max iterations ceiling (MAX_TOOL_ITERATIONS = 8)
 *   - Natural finish on the last allowed iteration (must NOT flag)
 *   - `flag_for_human_review` tool emitted by the agent itself
 *
 * Each scenario asserts: (a) `flagForHumanReview` was called with the
 * expected reason substring; (b) `result.flaggedForHumanReview === true`;
 * (c) an admin message was pushed onto `conversationState.messages` so
 * the conversation log records the pause; (d) the negative case (natural
 * finish at iteration MAX) does NOT flag.
 */

import type Anthropic from '@anthropic-ai/sdk';

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { logLevel: 'silent', env: 'test' },
}));

jest.mock('../config/models', () => ({
  CLAUDE_MODELS: { AGENT: 'claude-test' },
  MODEL_CONFIG: { agent: { maxTokens: 1024 } },
}));

// Scripted Claude — each scenario pushes responses into this queue
// before invoking runToolLoop. Pattern mirrors availability-agent.test.ts.
let scriptedResponses: Anthropic.Message[] = [];
const messagesCreate = jest.fn(async () => {
  if (scriptedResponses.length === 0) {
    throw new Error('messagesCreate called more times than test scripted');
  }
  return scriptedResponses.shift()!;
});

jest.mock('../utils/anthropic-client', () => ({
  anthropicClient: {
    messages: { create: () => messagesCreate() },
  },
  isTransientError: () => false,
}));

// Pass-through resilientCall — production retries on transient errors,
// but the scripted client is deterministic.
jest.mock('../utils/resilient-call', () => ({
  resilientCall: async (fn: () => Promise<unknown>) => fn(),
}));

jest.mock('../utils/circuit-breaker', () => ({
  circuitBreakerRegistry: { getOrCreate: () => ({}) },
  CIRCUIT_BREAKER_CONFIGS: { CLAUDE_API: {} },
}));

// Stage gating off — keeps the tool surface stable across iterations
// so the same-hash and budget arithmetic stays predictable.
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/ai-conversation.service', () => ({
  truncateMessageContent: (s: string) => s,
}));

const mockLogToolExecuted = jest.fn();
jest.mock('../services/audit-event.service', () => ({
  auditEventService: {
    logToolExecuted: (...args: unknown[]) => mockLogToolExecuted(...args),
  },
}));

jest.mock('../services/tools-for-stage', () => ({
  getToolsForStage: () => [],
}));

import {
  runToolLoop,
  runAvailabilityToolLoop,
  type AvailabilityAgentContext,
  type AvailabilityConversationState,
} from '../services/agent-tool-loop';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../services/scheduling-context.service';
import type { ConversationState } from '../types';

// ─── Test fixtures ────────────────────────────────────────────────

function makeContext(overrides: Partial<SchedulingContext> = {}): SchedulingContext {
  // Minimal happy-path context — only the required fields. Optional
  // fields (userTimezone, therapistTimezone, inboundSender, etc.) are
  // omitted because the safety-circuit code paths never read them; if a
  // future scenario does, override here.
  return {
    appointmentRequestId: 'apt-test',
    userName: 'Test User',
    userEmail: 'user@test.com',
    therapistEmail: 'therapist@test.com',
    therapistName: 'Dr Test',
    therapistAvailability: null,
    bookingMethod: 'agent_negotiated',
    userCountry: 'UK',
    therapistCountry: 'UK',
    ...overrides,
  } as SchedulingContext;
}

function makeConversationState(): ConversationState {
  return {
    systemPrompt: 'test',
    messages: [],
  };
}

function makeAvailabilityContext(
  overrides: Partial<AvailabilityAgentContext> = {},
): AvailabilityAgentContext {
  return {
    conversationId: 'conv-test',
    therapistId: 'th-test',
    therapistName: 'Dr Test',
    therapistEmail: 'therapist@test.com',
    therapistCountry: 'UK',
    kind: 'onboarding',
    ...overrides,
  };
}

function makeAvailabilityState(): AvailabilityConversationState {
  return { messages: [] };
}

/** Build a Claude response with one or more tool_use blocks (and optional text). */
function scriptToolResponse(
  tools: Array<{ name: string; input: unknown; id?: string }>,
  text?: string,
): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  if (text) {
    content.push({ type: 'text', text, citations: null } as Anthropic.TextBlock);
  }
  for (const t of tools) {
    content.push({
      type: 'tool_use',
      id: t.id ?? `tu_${Math.random().toString(36).slice(2)}`,
      name: t.name,
      input: t.input,
    } as Anthropic.ToolUseBlock);
  }
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage,
  } as Anthropic.Message;
}

/** Build a Claude response with text only — the natural "done" signal. */
function scriptTextOnly(text: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text, citations: null } as Anthropic.TextBlock],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage,
  } as Anthropic.Message;
}

beforeEach(() => {
  scriptedResponses = [];
  jest.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('runToolLoop — safety circuit wiring', () => {
  it('TURN_TOOL_BUDGET trip flags for human review and stops the loop', async () => {
    // 13 distinct tool_use blocks in a single response — the 13th finds
    // toolsThisTurn === 12 and trips the budget. The loop then escalates
    // post-for-loop. Inputs must differ so the same-hash guard doesn't
    // fire first.
    const tools = Array.from({ length: 13 }, (_, i) => ({
      name: 'remember',
      input: { fact: `fact-${i}` },
    }));
    scriptedResponses = [scriptToolResponse(tools)];

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => {
      return { success: true, toolName: toolCall.name };
    });
    const flagForHumanReview = jest.fn();
    const state = makeConversationState();

    const { result } = await runToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeContext(),
      { executeToolCall, flagForHumanReview },
      'trace-1',
      'test-budget',
    );

    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/budget exhausted/i);
    expect(result.flaggedForHumanReview).toBe(true);
    expect(state.messages.some((m) => m.role === 'admin' && m.content.includes('budget'))).toBe(
      true,
    );
  });

  it('SAME_HASH_TURN_ABORT trip flags for human review and stops the loop', async () => {
    // 3 identical (name, input) tool_use blocks in one response. The 1st
    // executes (count=1), 2nd is short-circuited as same-hash blocked
    // (count=2), 3rd hits SAME_HASH_TURN_ABORT === 3 and aborts.
    const tool = { name: 'remember', input: { fact: 'duplicate' } };
    scriptedResponses = [scriptToolResponse([tool, tool, tool])];

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => {
      return { success: true, toolName: toolCall.name };
    });
    const flagForHumanReview = jest.fn();
    const state = makeConversationState();

    const { result } = await runToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeContext(),
      { executeToolCall, flagForHumanReview },
      'trace-2',
      'test-same-hash',
    );

    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/same tool called/i);
    expect(result.flaggedForHumanReview).toBe(true);
    expect(state.messages.some((m) => m.role === 'admin')).toBe(true);
  });

  it('TURN_ERROR_LIMIT trip flags for human review when tools keep failing', async () => {
    // 3 distinct tool calls (avoiding same-hash trip), all returning
    // success:false. After the for-loop, totalToolErrors === 3 trips
    // the error breaker.
    const tools = [
      { name: 'remember', input: { fact: 'a' } },
      { name: 'remember', input: { fact: 'b' } },
      { name: 'remember', input: { fact: 'c' } },
    ];
    scriptedResponses = [scriptToolResponse(tools)];

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => {
      return { success: false, toolName: toolCall.name, error: 'boom' };
    });
    const flagForHumanReview = jest.fn();
    const state = makeConversationState();

    const { result } = await runToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeContext(),
      { executeToolCall, flagForHumanReview },
      'trace-3',
      'test-error-breaker',
    );

    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/error circuit breaker/i);
    expect(result.flaggedForHumanReview).toBe(true);
    expect(result.totalToolErrors).toBeGreaterThanOrEqual(3);
  });

  it('MAX_TOOL_ITERATIONS hit flags for human review when the agent was still working (PR #262 wiring)', async () => {
    // 8 iterations all with a tool_use block → while loop falls through
    // after iteration 8 without natural finish. The post-loop check
    // should fire flagForHumanReview. This pins the wiring shipped in
    // PR #262 — before that fix this case exited silently with only a
    // logger.warn.
    for (let i = 0; i < 8; i++) {
      scriptedResponses.push(
        scriptToolResponse([{ name: 'remember', input: { fact: `iter-${i}` } }]),
      );
    }

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => {
      return { success: true, toolName: toolCall.name };
    });
    const flagForHumanReview = jest.fn();
    const state = makeConversationState();

    const { result } = await runToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeContext(),
      { executeToolCall, flagForHumanReview },
      'trace-4',
      'test-max-iter',
    );

    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/iteration ceiling/i);
    expect(result.flaggedForHumanReview).toBe(true);
    expect(result.hitMaxIterations).toBe(true);
    expect(state.messages.some((m) => m.role === 'admin' && /ceiling/i.test(m.content))).toBe(
      true,
    );
  });

  it('natural finish on iteration MAX does NOT flag (loopFinishedNaturally exemption)', async () => {
    // 7 iterations with tool calls, 8th iteration is a text-only response
    // (natural "done"). iteration ends at 8 but loopFinishedNaturally
    // exempts it from the iteration-ceiling escalation. Critical
    // regression case for the PR #262 fix.
    for (let i = 0; i < 7; i++) {
      scriptedResponses.push(
        scriptToolResponse([{ name: 'remember', input: { fact: `iter-${i}` } }]),
      );
    }
    scriptedResponses.push(scriptTextOnly("I'm done — your appointment is confirmed."));

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => {
      return { success: true, toolName: toolCall.name };
    });
    const flagForHumanReview = jest.fn();
    const state = makeConversationState();

    const { result } = await runToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeContext(),
      { executeToolCall, flagForHumanReview },
      'trace-5',
      'test-natural-finish-at-max',
    );

    expect(flagForHumanReview).not.toHaveBeenCalled();
    expect(result.flaggedForHumanReview).toBe(false);
    // hitMaxIterations IS true (iteration === 5) but that alone shouldn't
    // escalate without loopFinishedNaturally.
    expect(result.hitMaxIterations).toBe(true);
  });

  it('flag_for_human_review tool call from the agent flags + stops + does not re-fire post-loop', async () => {
    // Agent explicitly calls flag_for_human_review. The dispatcher (which
    // we proxy here via executeToolCall returning checkpointAction-less
    // success) handles the side effect; the loop sets flaggedForHumanReview
    // and stops. The post-loop circuit checks should NOT also fire.
    scriptedResponses = [
      scriptToolResponse([
        { name: 'flag_for_human_review', input: { reason: 'I am confused.' } },
      ]),
    ];

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => {
      // Match the production dispatcher's behaviour for flag_for_human_review:
      // success, no checkpointAction. The loop's tool-name check on
      // 'flag_for_human_review' / 'recommend_cancel_match' branches into
      // the explicit stop path (agent-tool-loop.ts:~789).
      return { success: true, toolName: toolCall.name };
    });
    const flagForHumanReview = jest.fn();
    const state = makeConversationState();

    const { result } = await runToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeContext(),
      { executeToolCall, flagForHumanReview },
      'trace-6',
      'test-agent-flag',
    );

    // The agent's own flag_for_human_review tool fires its handler (we
    // proxy that side effect to the executor); the loop's `callbacks
    // .flagForHumanReview` callback is only invoked by the runaway-loop
    // post-loop circuits, NOT by an explicit agent flag — so it should
    // remain uncalled here.
    expect(flagForHumanReview).not.toHaveBeenCalled();
    expect(result.flaggedForHumanReview).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.hitMaxIterations).toBe(false);
  });

  it('an admin enabling human control mid-turn (dispatch human_control skip) stops the loop without re-flagging', async () => {
    // Only ONE response is scripted. dispatch.ts's atomic human-control
    // gate returns {success:true, skipped:true, skipReason:'human_control'}
    // when an admin took control between the model's decision and tool
    // execution. Without the loop-break fix, the loop would push a skip
    // message and call messagesCreate again for a 2nd iteration — which
    // would throw here ("called more times than test scripted"), failing
    // the test. Reaching the assertions below proves the loop stopped
    // after the skip instead of consuming a 2nd scripted response.
    scriptedResponses = [
      scriptToolResponse([{ name: 'send_email', input: { to: 'user@test.com', body: 'hi' } }]),
    ];

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => {
      return { success: true, toolName: toolCall.name, skipped: true, skipReason: 'human_control' };
    });
    const flagForHumanReview = jest.fn();
    const state = makeConversationState();

    const { result } = await runToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeContext(),
      { executeToolCall, flagForHumanReview },
      'trace-human-control-skip',
      'test-human-control-skip',
    );

    // Human control was enabled by an admin, not by the agent's own
    // flag_for_human_review — the loop must not re-flag (that would
    // overwrite the admin's takeover record) or call the callback.
    expect(flagForHumanReview).not.toHaveBeenCalled();
    expect(result.flaggedForHumanReview).toBe(false);
    expect(result.iterations).toBe(1);
  });

  it('error breaker takes precedence over max-iterations when both would fire', async () => {
    // MAX_TOOL_ITERATIONS-worth of iterations scripted, each returning
    // one tool call that fails. After iteration 3, totalToolErrors === 3
    // trips the error breaker and the loop stops via stopLoop. The
    // post-loop max-iter check should NOT also flag (already flagged).
    // This pins the !flaggedForHumanReview guard on the iteration-ceiling
    // branch.
    for (let i = 0; i < 8; i++) {
      scriptedResponses.push(
        scriptToolResponse([{ name: 'remember', input: { fact: `iter-${i}` } }]),
      );
    }

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => {
      return { success: false, toolName: toolCall.name, error: 'always fails' };
    });
    const flagForHumanReview = jest.fn();
    const state = makeConversationState();

    const { result } = await runToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeContext(),
      { executeToolCall, flagForHumanReview },
      'trace-7',
      'test-error-precedence',
    );

    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
    // The reason should be the error breaker, NOT the iteration ceiling.
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/error circuit breaker/i);
    expect(flagForHumanReview.mock.calls[0][0]).not.toMatch(/iteration ceiling/i);
    expect(result.flaggedForHumanReview).toBe(true);
  });
});

describe('runAvailabilityToolLoop — safety circuit wiring', () => {
  // The availability loop has no appointment-scoped audit table, so it
  // surfaces skip buckets via structured logging rather than
  // auditEventService — but the budget / same-hash / error / iteration
  // circuits and their flagForHumanReview wiring are identical to the
  // booking loop. These scenarios lock that behaviour. `remember` is a
  // non-terminal, non-pure tool here; `mark_complete` is terminal.

  it('TURN_TOOL_BUDGET trip flags for human review and stops the loop', async () => {
    const tools = Array.from({ length: 13 }, (_, i) => ({
      name: 'remember',
      input: { note: `note-${i}`, category: 'context' },
    }));
    scriptedResponses = [scriptToolResponse(tools)];

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => ({
      success: true,
      toolName: toolCall.name,
    }));
    const flagForHumanReview = jest.fn();
    const state = makeAvailabilityState();

    const { result } = await runAvailabilityToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeAvailabilityContext(),
      { executeToolCall, flagForHumanReview },
      'av-trace-1',
      'test-av-budget',
    );

    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/budget exhausted/i);
    expect(result.flaggedForHumanReview).toBe(true);
    expect(state.messages.some((m) => m.role === 'admin' && m.content.includes('budget'))).toBe(
      true,
    );
  });

  it('SAME_HASH_TURN_ABORT trip flags for human review and stops the loop', async () => {
    const tool = { name: 'remember', input: { note: 'dup', category: 'context' } };
    scriptedResponses = [scriptToolResponse([tool, tool, tool])];

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => ({
      success: true,
      toolName: toolCall.name,
    }));
    const flagForHumanReview = jest.fn();
    const state = makeAvailabilityState();

    const { result } = await runAvailabilityToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeAvailabilityContext(),
      { executeToolCall, flagForHumanReview },
      'av-trace-2',
      'test-av-same-hash',
    );

    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/same tool called/i);
    expect(result.flaggedForHumanReview).toBe(true);
    expect(state.messages.some((m) => m.role === 'admin')).toBe(true);
  });

  it('TURN_ERROR_LIMIT trip flags for human review when tools keep failing', async () => {
    const tools = [
      { name: 'remember', input: { note: 'a', category: 'context' } },
      { name: 'remember', input: { note: 'b', category: 'context' } },
      { name: 'remember', input: { note: 'c', category: 'context' } },
    ];
    scriptedResponses = [scriptToolResponse(tools)];

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => ({
      success: false,
      toolName: toolCall.name,
      error: 'boom',
    }));
    const flagForHumanReview = jest.fn();
    const state = makeAvailabilityState();

    const { result } = await runAvailabilityToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeAvailabilityContext(),
      { executeToolCall, flagForHumanReview },
      'av-trace-3',
      'test-av-error-breaker',
    );

    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/error circuit breaker/i);
    expect(result.flaggedForHumanReview).toBe(true);
    expect(result.totalToolErrors).toBeGreaterThanOrEqual(3);
  });

  it('MAX_TOOL_ITERATIONS hit flags for human review when the agent was still working', async () => {
    for (let i = 0; i < 8; i++) {
      scriptedResponses.push(
        scriptToolResponse([{ name: 'remember', input: { note: `iter-${i}`, category: 'context' } }]),
      );
    }

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => ({
      success: true,
      toolName: toolCall.name,
    }));
    const flagForHumanReview = jest.fn();
    const state = makeAvailabilityState();

    const { result } = await runAvailabilityToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeAvailabilityContext(),
      { executeToolCall, flagForHumanReview },
      'av-trace-4',
      'test-av-max-iter',
    );

    expect(flagForHumanReview).toHaveBeenCalledTimes(1);
    expect(flagForHumanReview.mock.calls[0][0]).toMatch(/iteration ceiling/i);
    expect(result.flaggedForHumanReview).toBe(true);
    expect(result.hitMaxIterations).toBe(true);
    expect(state.messages.some((m) => m.role === 'admin' && /ceiling/i.test(m.content))).toBe(
      true,
    );
  });

  it('mark_complete terminal tool stops the loop and does NOT flag', async () => {
    scriptedResponses = [
      scriptToolResponse([{ name: 'mark_complete', input: { summary: 'Captured 3 windows' } }]),
    ];

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => ({
      success: true,
      toolName: toolCall.name,
    }));
    const flagForHumanReview = jest.fn();
    const state = makeAvailabilityState();

    const { result } = await runAvailabilityToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeAvailabilityContext(),
      { executeToolCall, flagForHumanReview },
      'av-trace-5',
      'test-av-mark-complete',
    );

    expect(flagForHumanReview).not.toHaveBeenCalled();
    expect(result.markedComplete).toBe(true);
    expect(result.flaggedForHumanReview).toBe(false);
    expect(result.iterations).toBe(1);
  });

  it('natural finish on iteration MAX does NOT flag', async () => {
    for (let i = 0; i < 7; i++) {
      scriptedResponses.push(
        scriptToolResponse([{ name: 'remember', input: { note: `iter-${i}`, category: 'context' } }]),
      );
    }
    scriptedResponses.push(scriptTextOnly('All your availability is on file — thanks!'));

    const executeToolCall = jest.fn(async (toolCall): Promise<ToolExecutionResult> => ({
      success: true,
      toolName: toolCall.name,
    }));
    const flagForHumanReview = jest.fn();
    const state = makeAvailabilityState();

    const { result } = await runAvailabilityToolLoop(
      'system',
      [{ role: 'user', content: 'hi' }],
      state,
      makeAvailabilityContext(),
      { executeToolCall, flagForHumanReview },
      'av-trace-6',
      'test-av-natural-finish',
    );

    expect(flagForHumanReview).not.toHaveBeenCalled();
    expect(result.flaggedForHumanReview).toBe(false);
    expect(result.markedComplete).toBe(false);
    expect(result.hitMaxIterations).toBe(true);
  });
});

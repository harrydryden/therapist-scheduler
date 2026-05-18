/**
 * Integration test for the `purpose` field's effect on the agent loop's
 * `wouldRegress` guard.
 *
 * The original guard was added (correctly) to prevent send_email from
 * accidentally flipping the stage backward when the agent sent a
 * courtesy email to the therapist after forwarding slots to the user.
 * That guard, with no way to distinguish intent, also blocked the
 * LEGITIMATE backward transition when the user rejected all slots and
 * the agent went back to the therapist for more availability.
 *
 * With `purpose: 'request_more_availability'`:
 *   - The send-email handler emits `checkpointAction: 'received_user_slot_rejection'`
 *     (which maps to stage `awaiting_therapist_availability`).
 *   - The dispatcher echoes `emailPurpose` back on the ToolExecutionResult.
 *   - The agent loop's regression check exempts this specific purpose,
 *     letting the stage flip from `awaiting_user_slot_selection`
 *     (order 2) → `awaiting_therapist_availability` (order 1) even
 *     though that's a backward move in `STAGE_PROGRESS_ORDER`.
 *
 * This test scripts a Claude response containing the send_email call,
 * mocks the executeToolCall callback to return the dispatcher's shape,
 * and asserts the post-loop checkpoint state.
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

let scriptedResponses: Anthropic.Message[] = [];
const messagesCreate = jest.fn(async () => {
  if (scriptedResponses.length === 0) {
    throw new Error('messagesCreate called more times than test scripted');
  }
  return scriptedResponses.shift()!;
});

jest.mock('../utils/anthropic-client', () => ({
  anthropicClient: { messages: { create: () => messagesCreate() } },
  isTransientError: () => false,
}));

jest.mock('../utils/resilient-call', () => ({
  resilientCall: async (fn: () => Promise<unknown>) => fn(),
}));

jest.mock('../utils/circuit-breaker', () => ({
  circuitBreakerRegistry: { getOrCreate: () => ({}) },
  CIRCUIT_BREAKER_CONFIGS: { CLAUDE_API: {} },
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/ai-conversation.service', () => ({
  truncateMessageContent: (s: string) => s,
}));

jest.mock('../services/audit-event.service', () => ({
  auditEventService: { logToolExecuted: jest.fn() },
}));

jest.mock('../services/tools-for-stage', () => ({
  getToolsForStage: () => [],
}));

import { runToolLoop } from '../services/agent-tool-loop';
import {
  createCheckpoint,
  type ConversationCheckpoint,
} from '../services/conversation-checkpoint.service';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../services/scheduling-context.service';
import type { ConversationState } from '../types';

function makeContext(): SchedulingContext {
  return {
    appointmentRequestId: 'apt-test',
    userName: 'Maria',
    userEmail: 'maria@example.com',
    therapistEmail: 'ashleigh@example.com',
    therapistName: 'Ashleigh',
    therapistAvailability: null,
    bookingMethod: 'agent_negotiated',
    userCountry: 'UK',
    therapistCountry: 'UK',
  } as SchedulingContext;
}

function makeStateAtStage(stage: 'awaiting_user_slot_selection'): ConversationState {
  return {
    systemPrompt: 'test',
    messages: [],
    checkpoint: createCheckpoint(stage, 'sent_availability_to_user'),
  };
}

function scriptToolUse(
  toolName: string,
  input: Record<string, unknown>,
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [
      {
        type: 'tool_use',
        id: 'tu_' + Math.random().toString(36).slice(2),
        name: toolName,
        input,
      } as Anthropic.ToolUseBlock,
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage,
  } as Anthropic.Message;
}

function scriptDone(): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text: 'done', citations: null } as Anthropic.TextBlock],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage,
  } as Anthropic.Message;
}

beforeEach(() => {
  scriptedResponses = [];
  jest.clearAllMocks();
});

describe('agent loop — purpose=request_more_availability bypasses wouldRegress', () => {
  it('flips stage from awaiting_user_slot_selection back to awaiting_therapist_availability', async () => {
    // Script: one iteration where Claude calls send_email with the
    // intent-declaring purpose, then a text-only "done" to exit naturally.
    scriptedResponses = [
      scriptToolUse('send_email', {
        to: 'ashleigh@example.com',
        subject: 'Spill — more availability',
        body: 'Hi Ashleigh, could you share additional times?',
        purpose: 'request_more_availability',
      }),
      scriptDone(),
    ];

    // Simulate the dispatcher's shape for a send_email call with purpose.
    const executeToolCall = jest.fn(
      async (toolCall: Anthropic.ToolUseBlock): Promise<ToolExecutionResult> => {
        // Pin: the dispatcher echoes `purpose` back on the result so
        // the loop's regression-exemption check can see it.
        return {
          success: true,
          toolName: toolCall.name,
          // Mapped by handler from purpose='request_more_availability'.
          checkpointAction: 'received_user_slot_rejection',
          emailSentTo: 'therapist',
          emailPurpose: 'request_more_availability',
        };
      },
    );

    const state = makeStateAtStage('awaiting_user_slot_selection');
    const beforeStage = state.checkpoint?.stage;

    const { result } = await runToolLoop(
      'system',
      [{ role: 'user', content: "None of those times work" }],
      state,
      makeContext(),
      { executeToolCall, flagForHumanReview: jest.fn() },
      'trace-rejection',
      'test-purpose-exemption',
    );

    expect(beforeStage).toBe('awaiting_user_slot_selection');
    // The key assertion: the stage advanced backward (in
    // STAGE_PROGRESS_ORDER terms) BECAUSE the purpose declared the
    // regression as intentional. Without the exemption, this would
    // stay at 'awaiting_user_slot_selection'.
    expect(state.checkpoint?.stage).toBe('awaiting_therapist_availability');
    expect(state.checkpoint?.lastSuccessfulAction).toBe('received_user_slot_rejection');
    expect(result.flaggedForHumanReview).toBe(false);
  });

  it('without purpose, the same send_email call to the therapist would NOT bypass wouldRegress', async () => {
    // Negative case: the agent forgot to pass purpose. Legacy fallback
    // kicks in (recipient-based action = sent_initial_email_to_therapist
    // → stage awaiting_therapist_availability). The loop's regression
    // guard blocks the stage change — confirming that the exemption is
    // gated on the explicit purpose declaration, not just the action.
    scriptedResponses = [
      scriptToolUse('send_email', {
        to: 'ashleigh@example.com',
        subject: 'Spill',
        body: 'asking for more',
        // no purpose
      }),
      scriptDone(),
    ];

    const executeToolCall = jest.fn(
      async (toolCall: Anthropic.ToolUseBlock): Promise<ToolExecutionResult> => {
        return {
          success: true,
          toolName: toolCall.name,
          // Fallback: recipient-based action.
          checkpointAction: 'sent_initial_email_to_therapist',
          emailSentTo: 'therapist',
          // No emailPurpose echoed — agent didn't declare one.
        };
      },
    );

    const state = makeStateAtStage('awaiting_user_slot_selection');

    await runToolLoop(
      'system',
      [{ role: 'user', content: 'reply' }],
      state,
      makeContext(),
      { executeToolCall, flagForHumanReview: jest.fn() },
      'trace-rejection-nopurpose',
      'test-no-purpose-blocked',
    );

    // wouldRegress blocked the stage change. lastEmailSentTo context
    // was still updated for downstream chase routing.
    expect(state.checkpoint?.stage).toBe('awaiting_user_slot_selection');
    expect(state.checkpoint?.context?.lastEmailSentTo).toBe('therapist');
  });

  it('purpose=acknowledge: stage unchanged, but lastEmailSentTo context IS recorded', async () => {
    // Courtesy reply. The handler returns checkpointAction=undefined
    // so the loop's stage-advance block is skipped — but we still
    // record `lastEmailSentTo` on the existing checkpoint's context.
    // This keeps the legacy chase-fallback inference path (which
    // looks at context.lastEmailSentTo for `initial_contact`/`stalled`
    // / no-checkpoint stages) accurate, and keeps the dashboard's
    // "last emailed" labels in sync after a courtesy email.
    scriptedResponses = [
      scriptToolUse('send_email', {
        to: 'maria@example.com',
        subject: 'Spill',
        body: 'No problem',
        purpose: 'acknowledge',
      }),
      scriptDone(),
    ];

    const executeToolCall = jest.fn(
      async (toolCall: Anthropic.ToolUseBlock): Promise<ToolExecutionResult> => {
        return {
          success: true,
          toolName: toolCall.name,
          // Critical: acknowledge → no action emitted by the handler.
          checkpointAction: undefined,
          emailSentTo: 'user',
          emailPurpose: 'acknowledge',
        };
      },
    );

    const state = makeStateAtStage('awaiting_user_slot_selection');
    const beforeCheckpoint: ConversationCheckpoint = { ...state.checkpoint! };

    await runToolLoop(
      'system',
      [{ role: 'user', content: 'ok thanks' }],
      state,
      makeContext(),
      { executeToolCall, flagForHumanReview: jest.fn() },
      'trace-ack',
      'test-acknowledge-context-only',
    );

    // Stage + last action unchanged — the structurally-correct
    // courtesy-reply outcome.
    expect(state.checkpoint?.stage).toBe(beforeCheckpoint.stage);
    expect(state.checkpoint?.lastSuccessfulAction).toBe(beforeCheckpoint.lastSuccessfulAction);
    // But context now records the recipient so chase-fallback / dashboard
    // labels know who we last reached out to.
    expect(state.checkpoint?.context?.lastEmailSentTo).toBe('user');
  });
});

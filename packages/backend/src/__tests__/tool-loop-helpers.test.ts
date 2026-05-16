/**
 * Unit tests for the pure helpers used by the booking and availability
 * tool loops. Both functions ship behaviour that the loops rely on at
 * critical control points (skip messaging shown to the model on
 * idempotent retries, per-turn hash key for the same-hash guard) so
 * pinning them here protects against silent drift.
 */

import type Anthropic from '@anthropic-ai/sdk';
import {
  appendToolRoundTrip,
  buildBudgetExhaustedMessage,
  buildErrorBreakerAdminMessage,
  buildErrorBreakerFlagReason,
  buildMaxIterationsAdminMessage,
  buildMaxIterationsFlagReason,
  buildSameHashAbortMessage,
  buildSameHashBlockedMessage,
  buildSkipMessage,
  buildTurnBreakerReason,
  computeTurnHash,
  parseClaudeResponse,
} from '../services/tool-loop-helpers';

describe('buildSkipMessage', () => {
  it('names the outcome for idempotent skips and directs the model to the next step', () => {
    const msg = buildSkipMessage('send_email', 'idempotent');
    expect(msg).toContain('already completed earlier');
    expect(msg).toContain('not an error');
    expect(msg).toContain('continue with the next step');
    expect(msg).toContain('flag_for_human_review');
  });

  it('tells the model to stop responding for human-control skips', () => {
    const msg = buildSkipMessage('mark_scheduling_complete', 'human_control');
    expect(msg).toContain('human control');
    expect(msg).toContain('Stop responding');
    expect(msg).toContain('admin will take over');
  });

  it('falls back to the generic message for an unrecognised skipReason', () => {
    const msg = buildSkipMessage('send_email', 'something_new');
    expect(msg).toBe('Tool send_email skipped: something_new');
  });

  it('falls back to "unknown reason" when skipReason is omitted', () => {
    const msg = buildSkipMessage('send_email');
    expect(msg).toBe('Tool send_email skipped: unknown reason');
  });

  it('includes the tool name in every variant', () => {
    expect(buildSkipMessage('cancel_appointment', 'idempotent')).toContain('cancel_appointment');
    expect(buildSkipMessage('cancel_appointment', 'human_control')).toContain('cancel_appointment');
    expect(buildSkipMessage('cancel_appointment', 'other')).toContain('cancel_appointment');
    expect(buildSkipMessage('cancel_appointment')).toContain('cancel_appointment');
  });
});

describe('computeTurnHash', () => {
  it('returns the same hash for the same (name, input)', () => {
    const a = computeTurnHash('send_email', { to: 'x@y', subject: 's', body: 'b' });
    const b = computeTurnHash('send_email', { to: 'x@y', subject: 's', body: 'b' });
    expect(a).toBe(b);
  });

  it('returns different hashes for different tool names with the same input', () => {
    const input = { to: 'x@y' };
    expect(computeTurnHash('send_email', input)).not.toBe(computeTurnHash('mark_scheduling_complete', input));
  });

  it('returns different hashes for the same tool with different input', () => {
    const a = computeTurnHash('send_email', { to: 'a@y', subject: 's', body: 'b' });
    const b = computeTurnHash('send_email', { to: 'b@y', subject: 's', body: 's' });
    expect(a).not.toBe(b);
  });

  it('is sensitive to input key order (JSON.stringify preserves insertion order)', () => {
    // The same-hash guard is a deliberate exact-arguments match; if the
    // model emits the same logical call with different key order JS treats
    // them as distinct hashes. That's the intended behaviour — we'd rather
    // miss a near-duplicate than block a legitimate retry that happens
    // to serialise differently. This test pins that contract so a future
    // "canonicalise input first" change is a conscious choice.
    const a = computeTurnHash('send_email', { to: 'x', subject: 's' });
    const b = computeTurnHash('send_email', { subject: 's', to: 'x' });
    expect(a).not.toBe(b);
  });

  it('handles null and undefined input deterministically', () => {
    expect(computeTurnHash('flag_for_human_review', null)).toBe('flag_for_human_review:null');
    expect(computeTurnHash('flag_for_human_review', undefined)).toBe('flag_for_human_review:undefined');
  });

  it('produces stable strings for nested objects', () => {
    const a = computeTurnHash('record_availability_window', {
      starts_at: '2026-01-01T10:00:00+00:00',
      ends_at: '2026-01-01T11:00:00+00:00',
      status: 'available',
    });
    const b = computeTurnHash('record_availability_window', {
      starts_at: '2026-01-01T10:00:00+00:00',
      ends_at: '2026-01-01T11:00:00+00:00',
      status: 'available',
    });
    expect(a).toBe(b);
    expect(a).toContain('record_availability_window');
    expect(a).toContain('2026-01-01T10:00:00');
  });
});

describe('parseClaudeResponse', () => {
  function makeResponse(
    content: Anthropic.ContentBlock[],
  ): Anthropic.Message {
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage,
    } as unknown as Anthropic.Message;
  }

  it('separates tool_use blocks from text blocks', () => {
    const response = makeResponse([
      { type: 'text', text: 'Thinking out loud.' } as Anthropic.TextBlock,
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'send_email',
        input: { to: 'x@y' },
      } as Anthropic.ToolUseBlock,
    ]);

    const parsed = parseClaudeResponse(response);

    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe('send_email');
    expect(parsed.assistantText).toBe('Thinking out loud.');
  });

  it('joins multiple text blocks with newlines', () => {
    const response = makeResponse([
      { type: 'text', text: 'First.' } as Anthropic.TextBlock,
      { type: 'text', text: 'Second.' } as Anthropic.TextBlock,
    ]);

    expect(parseClaudeResponse(response).assistantText).toBe('First.\nSecond.');
  });

  it('returns empty toolCalls + empty text for a response with no recognised blocks', () => {
    const parsed = parseClaudeResponse(makeResponse([]));
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.assistantText).toBe('');
  });

  it('returns an empty string (not undefined) when only tool_use blocks are present', () => {
    const response = makeResponse([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'remember',
        input: {},
      } as Anthropic.ToolUseBlock,
    ]);
    const parsed = parseClaudeResponse(response);
    expect(parsed.assistantText).toBe('');
    expect(parsed.toolCalls).toHaveLength(1);
  });
});

describe('turn-guard message builders', () => {
  // The loops emit these strings verbatim into tool_result `content` and
  // admin `messages.push` bodies. Pin the exact format so a wording
  // change is a conscious test update, not silent drift between loops.

  describe('buildBudgetExhaustedMessage', () => {
    it('names the tool, the budget, and the next action', () => {
      const msg = buildBudgetExhaustedMessage('send_email', 12);
      expect(msg).toBe(
        'Tool send_email not executed: turn tool budget exhausted (12 calls). The conversation is being paused for admin review.',
      );
    });
  });

  describe('buildSameHashAbortMessage', () => {
    it('names the tool, the repeat count, and the abort outcome', () => {
      const msg = buildSameHashAbortMessage('record_availability_window', 3);
      expect(msg).toBe(
        'Tool record_availability_window attempted 3 times with identical arguments in this turn — aborting to prevent a loop. An admin will review.',
      );
    });
  });

  describe('buildSameHashBlockedMessage', () => {
    it('tells the model to pivot or escalate on a 2nd-occurrence skip', () => {
      const msg = buildSameHashBlockedMessage('send_email');
      expect(msg).toBe(
        'Tool send_email with these exact arguments was already attempted earlier in this turn. Try a different approach, change the arguments, or call flag_for_human_review.',
      );
    });
  });

  describe('buildTurnBreakerReason', () => {
    it('formats the budget-exhausted variant with the limit number', () => {
      const reason = buildTurnBreakerReason('budget', {
        budget: 12,
        sameHashAbortLimit: 3,
      });
      expect(reason).toBe(
        'Turn tool budget exhausted (12 tool calls in one inbound trigger). Agent paused for admin review.',
      );
    });

    it('formats the same-hash variant with the abort limit', () => {
      const reason = buildTurnBreakerReason('same_hash', {
        budget: 12,
        sameHashAbortLimit: 3,
      });
      expect(reason).toBe(
        'Same tool called 3+ times with identical arguments in one turn — agent thrashing on a duplicate call. Paused for review.',
      );
    });
  });

  describe('error breaker messages', () => {
    it('admin message names the total failure count', () => {
      expect(buildErrorBreakerAdminMessage(3)).toBe(
        '[System: 3 tool failures in this turn — pausing for admin review.]',
      );
    });

    it('flag reason names the total failure count', () => {
      expect(buildErrorBreakerFlagReason(3)).toBe(
        'Tool error circuit breaker tripped (3 failures in one turn). Agent paused for review.',
      );
    });
  });

  describe('max iterations messages', () => {
    it('admin message names the iteration ceiling', () => {
      expect(buildMaxIterationsAdminMessage(5)).toBe(
        '[System: Hit the 5-iteration ceiling with the agent still working — pausing for admin review.]',
      );
    });

    it('flag reason names the iteration ceiling and clarifies non-natural exit', () => {
      const reason = buildMaxIterationsFlagReason(5);
      expect(reason).toContain('5-iteration ceiling');
      expect(reason).toContain('not a natural completion');
      expect(reason).toContain('Agent paused for review');
    });
  });
});

describe('appendToolRoundTrip', () => {
  it('appends an assistant message (response content) and a user message (tool results) in order', () => {
    const prior: Anthropic.MessageParam[] = [
      { role: 'user', content: 'hello' },
    ];
    const response = {
      content: [{ type: 'text', text: 'hi' } as Anthropic.TextBlock],
    } as Anthropic.Message;
    const toolResults: Anthropic.ToolResultBlockParam[] = [
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'ok',
        is_error: false,
      },
    ];

    const next = appendToolRoundTrip(prior, response, toolResults);

    expect(next).toHaveLength(3);
    expect(next[0]).toEqual({ role: 'user', content: 'hello' });
    expect(next[1]).toEqual({ role: 'assistant', content: response.content });
    expect(next[2]).toEqual({ role: 'user', content: toolResults });
  });

  it('does not mutate the input array', () => {
    const prior: Anthropic.MessageParam[] = [{ role: 'user', content: 'a' }];
    const before = prior.slice();
    appendToolRoundTrip(prior, { content: [] } as unknown as Anthropic.Message, []);
    expect(prior).toEqual(before);
  });
});

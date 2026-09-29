/**
 * Tests for trimConversationState's head+tail strategy.
 * Verifies that long conversations preserve both the initial booking
 * context and the most recent activity, with a placeholder for the
 * dropped middle.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils/database', () => ({
  prisma: {},
}));

jest.mock('../utils/anthropic-client', () => ({
  anthropicClient: {},
}));

jest.mock('../config/models', () => ({
  CLAUDE_MODELS: {},
  MODEL_CONFIG: {},
}));

jest.mock('../core/email', () => ({}));

jest.mock('../services/email-queue.service', () => ({
  emailQueueService: {},
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(),
}));

import { AIConversationService } from '../services/ai-conversation.service';
import { CONVERSATION_LIMITS } from '../constants';

describe('trimConversationState (head+tail strategy)', () => {
  const service = new AIConversationService('test');

  function makeMessages(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));
  }

  it('returns state unchanged when below limits', () => {
    const messages = makeMessages(10);
    const result = service.trimConversationState({ messages });
    expect(result.messages).toBe(messages); // same reference, no trim
  });

  it('preserves both head and tail when trimming a long conversation', () => {
    const totalCount = CONVERSATION_LIMITS.MAX_MESSAGES + 50;
    const messages = makeMessages(totalCount);
    const result = service.trimConversationState({ messages });

    expect(result.messages.length).toBe(CONVERSATION_LIMITS.TRIM_TO_MESSAGES);

    // First TRIM_KEEP_FIRST messages preserved (the initial booking context)
    const keepFirst = CONVERSATION_LIMITS.TRIM_KEEP_FIRST;
    for (let i = 0; i < keepFirst; i++) {
      expect(result.messages[i].content).toBe(`message ${i}`);
    }

    // Placeholder right after the head
    expect(result.messages[keepFirst].content).toContain('[System Note:');
    expect(result.messages[keepFirst].content).toContain('trimmed');

    // Last messages preserved (recent activity)
    const keepLast = CONVERSATION_LIMITS.TRIM_TO_MESSAGES - keepFirst - 1;
    const lastMessageIndex = totalCount - 1;
    for (let i = 0; i < keepLast; i++) {
      const expectedOriginalIndex = lastMessageIndex - (keepLast - 1 - i);
      const resultIndex = keepFirst + 1 + i;
      expect(result.messages[resultIndex].content).toBe(`message ${expectedOriginalIndex}`);
    }
  });

  it('produces output below MAX_MESSAGES on excess input', () => {
    const messages = makeMessages(500);
    const result = service.trimConversationState({ messages });
    expect(result.messages.length).toBeLessThanOrEqual(CONVERSATION_LIMITS.TRIM_TO_MESSAGES);
  });

  it('preserves systemPrompt across trimming', () => {
    const messages = makeMessages(CONVERSATION_LIMITS.MAX_MESSAGES + 10);
    const result = service.trimConversationState({
      systemPrompt: 'test prompt',
      messages,
    });
    expect(result.systemPrompt).toBe('test prompt');
  });

  it('placeholder reports the actual dropped count', () => {
    const totalCount = CONVERSATION_LIMITS.MAX_MESSAGES + 100;
    const messages = makeMessages(totalCount);
    const result = service.trimConversationState({ messages });

    const expectedDropped =
      totalCount - CONVERSATION_LIMITS.TRIM_KEEP_FIRST -
      (CONVERSATION_LIMITS.TRIM_TO_MESSAGES - CONVERSATION_LIMITS.TRIM_KEEP_FIRST - 1);
    const placeholder = result.messages[CONVERSATION_LIMITS.TRIM_KEEP_FIRST];
    expect(placeholder.content).toContain(String(expectedDropped));
  });

  // Regression for A1: the trimmed state used to be rebuilt as
  // `{ systemPrompt, messages }`, wiping checkpoint / facts /
  // responseTracking on exactly the long conversations that need them.
  it('carries every non-message field over when it trims', () => {
    const messages = makeMessages(CONVERSATION_LIMITS.MAX_MESSAGES + 10);
    const checkpoint = {
      stage: 'awaiting_therapist_confirmation' as const,
      lastSuccessfulAction: 'received_user_slot_selection' as const,
      pendingAction: 'Waiting for therapist to confirm',
      checkpoint_at: '2026-09-20T10:00:00.000Z',
      context: { lastEmailSentTo: 'therapist' as const },
    };
    const facts = {
      proposedTimes: ['Tuesday at 3pm'],
      therapistPreferences: [],
      userPreferences: [],
      blockers: [],
      specialNotes: [],
      updatedAt: '2026-09-20T10:00:00.000Z',
    };
    const responseTracking = { lastEmailSentToTherapist: '2026-09-19T09:00:00.000Z', events: [] };

    const result = service.trimConversationState({
      systemPrompt: '',
      messages,
      checkpoint,
      facts,
      responseTracking,
    });

    expect(result.messages.length).toBe(CONVERSATION_LIMITS.TRIM_TO_MESSAGES);
    expect(result.checkpoint).toEqual(checkpoint);
    expect(result.facts).toEqual(facts);
    expect(result.responseTracking).toEqual(responseTracking);
    expect(Object.keys(result).sort()).toEqual(
      ['checkpoint', 'facts', 'messages', 'responseTracking', 'systemPrompt'],
    );
  });

  it('does not trim when total messages would not exceed the trim target', () => {
    // Just at the boundary
    const messages = makeMessages(CONVERSATION_LIMITS.TRIM_TO_MESSAGES);
    const result = service.trimConversationState({ messages });
    expect(result.messages.length).toBe(CONVERSATION_LIMITS.TRIM_TO_MESSAGES);
    // No placeholder should appear
    const hasPlaceholder = result.messages.some((m) => m.content.includes('[System Note:'));
    expect(hasPlaceholder).toBe(false);
  });
});

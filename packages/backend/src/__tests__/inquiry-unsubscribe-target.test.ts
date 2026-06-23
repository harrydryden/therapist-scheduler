/**
 * Security/robustness contract for the weekly-mailing inquiry agent's
 * `unsubscribe_user` tool.
 *
 * The handler must unsubscribe the VERIFIED sender of the inquiry
 * (`inquiry.userEmail`, set from the matched inbound) and NEVER an address
 * supplied by the model. A model-supplied email could be hallucinated or
 * lifted from the email body to target a third party — so we ignore it.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils/anthropic-client', () => ({
  anthropicClient: { messages: { create: jest.fn() } },
}));

jest.mock('../config/models', () => ({
  CLAUDE_MODELS: { AGENT: 'claude-test' },
  MODEL_CONFIG: { agent: { maxTokens: 1024 } },
}));

jest.mock('../utils/resilient-call', () => ({
  // Run the supplied fn directly — no retry/breaker logic in the test.
  resilientCall: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock('../utils/circuit-breaker', () => ({
  circuitBreakerRegistry: { getOrCreate: jest.fn(() => ({})) },
  CIRCUIT_BREAKER_CONFIGS: { CLAUDE_API: {} },
}));

jest.mock('../utils/database', () => ({
  prisma: {
    weeklyMailingInquiry: { findUnique: jest.fn(), update: jest.fn() },
    user: { updateMany: jest.fn() },
  },
}));

jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: { sendEmail: jest.fn() },
}));
jest.mock('../services/email-queue.service', () => ({
  emailQueueService: { enqueue: jest.fn() },
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn((key: string) => {
    const vals: Record<string, unknown> = {
      'weeklyMailing.webAppUrl': 'https://app.test/book',
      'agent.fromName': 'Justin',
      'agent.sessionDurationMinutes': 50,
    };
    return Promise.resolve(vals[key]);
  }),
}));

import { AIConversationService } from '../services/ai-conversation.service';
import { anthropicClient } from '../utils/anthropic-client';
import { prisma } from '../utils/database';

const VERIFIED_SENDER = 'subscriber@example.com';

describe('processInquiryReply — unsubscribe targets the verified sender', () => {
  const service = new AIConversationService('test');

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.weeklyMailingInquiry.findUnique as jest.Mock).mockResolvedValue({
      id: 'inq-1',
      userEmail: VERIFIED_SENDER,
      userName: 'Subscriber',
      gmailThreadId: 'thread-1',
      conversationState: null,
      humanControlEnabled: false,
      status: 'active',
    });
    (prisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.weeklyMailingInquiry.update as jest.Mock).mockResolvedValue({});
  });

  it('unsubscribes inquiry.userEmail and IGNORES a model-supplied email', async () => {
    // The model emits unsubscribe_user with a DIFFERENT email in its input —
    // the handler must not act on it.
    (anthropicClient.messages.create as jest.Mock).mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'tu-1',
          name: 'unsubscribe_user',
          input: { email: 'victim@elsewhere.com', reason: 'stop emailing me' },
        },
      ],
    });

    const res = await service.processInquiryReply('inq-1', 'please unsubscribe me', VERIFIED_SENDER);

    expect(res.success).toBe(true);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);

    const call = (prisma.user.updateMany as jest.Mock).mock.calls[0][0];
    expect(call.where.email).toBe(VERIFIED_SENDER);
    expect(call.where.email).not.toBe('victim@elsewhere.com');
    expect(call.where.subscribed).toBe(true);
    expect(call.data.subscribed).toBe(false);

    // Inquiry is marked resolved after a successful unsubscribe.
    expect(prisma.weeklyMailingInquiry.update as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'resolved' }) }),
    );
  });

  it('still targets the verified sender when the model omits an email entirely', async () => {
    (anthropicClient.messages.create as jest.Mock).mockResolvedValue({
      content: [
        { type: 'tool_use', id: 'tu-2', name: 'unsubscribe_user', input: { reason: 'done' } },
      ],
    });

    await service.processInquiryReply('inq-1', 'remove me', VERIFIED_SENDER);

    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect((prisma.user.updateMany as jest.Mock).mock.calls[0][0].where.email).toBe(VERIFIED_SENDER);
  });
});

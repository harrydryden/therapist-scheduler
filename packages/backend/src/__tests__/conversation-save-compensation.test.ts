/**
 * Regression test for the state-save compensation path.
 *
 * When `storeConversationStateWithRetry` exhausts all retries, it writes
 * a compensation note to the appointment IF an email was actually sent
 * during the turn — otherwise a state-save failure with no outbound
 * email is just a dropped turn, not something requiring manual recovery.
 *
 * The email-tool filter previously matched tool names
 * ('send_user_email' / 'send_therapist_email') the agent has never
 * produced (the real tool is 'send_email'), so the compensation branch
 * was dead code — this pins the filter against the real tool name.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config', () => ({
  config: { jwtSecret: 'test', frontendUrl: 'https://test', backendUrl: 'https://test' },
}));
jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
    $transaction: async () => {
      throw new Error('DB unavailable');
    },
  },
}));

import { aiConversationService } from '../services/ai-conversation.service';

describe('storeConversationStateWithRetry: compensation on exhausted retries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUnique.mockResolvedValue({ checkpointStage: null, notes: null });
    mockUpdate.mockResolvedValue({ id: 'apt-1' });
  });

  const state = { systemPrompt: '', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('writes a compensation note when a send_email tool ran before the save failed', async () => {
    const executedTools = [
      { toolName: 'send_email', emailSentTo: 'user' as const, timestamp: new Date().toISOString() },
    ];

    const result = await aiConversationService.storeConversationStateWithRetry(
      'apt-1',
      state,
      new Date(),
      executedTools,
    );

    expect(result.success).toBe(false);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'apt-1' },
        data: expect.objectContaining({
          notes: expect.stringContaining('COMPENSATION'),
        }),
      }),
    );
  });

  it('does not write a compensation note when no email tool ran', async () => {
    const executedTools = [
      { toolName: 'record_availability_window', timestamp: new Date().toISOString() },
    ];

    const result = await aiConversationService.storeConversationStateWithRetry(
      'apt-1',
      state,
      new Date(),
      executedTools,
    );

    expect(result.success).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

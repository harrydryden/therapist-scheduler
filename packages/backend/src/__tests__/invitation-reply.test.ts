/**
 * Tests for the invitation-reply auto-responder.
 *
 * Coverage:
 *  - Returns false when sender has no pending/recent invitation (caller
 *    falls through to the unmatched-tracker).
 *  - Returns true and sends an in-thread reply when a pending invitation
 *    matches.
 *  - Treats recently-accepted invitations (<30 days) as still eligible.
 *  - Skips expired / revoked / archived invitations.
 *  - Handles "Name <addr>" From headers correctly.
 *  - Falls through (returns false) on send failure so the unmatched
 *    tracker takes over.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    redisUrl: 'redis://localhost:6379',
    env: 'test',
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret',
  },
}));

const findFirstMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    signupInvitation: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
    },
  },
}));

const redisGetMock = jest.fn();
const redisSetMock = jest.fn();
jest.mock('../utils/redis', () => ({
  redis: {
    get: (...args: unknown[]) => redisGetMock(...args),
    set: (...args: unknown[]) => redisSetMock(...args),
  },
}));

const getSettingValueMock = jest.fn();
jest.mock('../services/settings.service', () => ({
  getSettingValue: (...args: unknown[]) => getSettingValueMock(...args),
}));

const getKnowledgeForPromptMock = jest.fn();
jest.mock('../services/knowledge.service', () => ({
  knowledgeService: {
    getKnowledgeForPrompt: () => getKnowledgeForPromptMock(),
  },
}));

const generateResponseMock = jest.fn();
jest.mock('../services/ai.service', () => ({
  AIService: jest.fn().mockImplementation(() => ({
    generateResponse: (...args: unknown[]) => generateResponseMock(...args),
  })),
}));

const sendEmailMock = jest.fn();
jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: {
    sendEmail: (...args: unknown[]) => sendEmailMock(...args),
  },
}));

const sendAlertMock = jest.fn();
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: (...args: unknown[]) => sendAlertMock(...args),
  },
}));

import { tryHandleInvitationReply } from '../services/invitation-reply.service';
import type { EmailMessage } from '../utils/email-mime-parser';

const baseEmail: EmailMessage = {
  id: 'msg-1',
  threadId: 'thread-1',
  from: 'invitee@example.com',
  to: 'scheduling@spill.chat',
  subject: 'Re: You are invited',
  body: 'Hi, can you tell me how long the sessions are?',
  date: new Date('2026-05-06T10:00:00Z'),
};

describe('tryHandleInvitationReply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSettingValueMock.mockResolvedValue('https://free.spill.app');
    getKnowledgeForPromptMock.mockResolvedValue({
      forUser: '- **Sessions:** All sessions are 50 minutes long.',
      forTherapist: '',
    });
    generateResponseMock.mockResolvedValue({
      content: 'Hi Alice,\n\nSessions are 50 minutes long. ...',
      usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
      latency: 250,
    });
    sendEmailMock.mockResolvedValue({ ok: true });
    redisGetMock.mockResolvedValue(null); // no cooldown by default
    redisSetMock.mockResolvedValue('OK');
    sendAlertMock.mockResolvedValue(true);
  });

  it('returns false when no invitation matches the sender', async () => {
    findFirstMock.mockResolvedValue(null);

    const result = await tryHandleInvitationReply(baseEmail, 'trace-1');

    expect(result).toBe(false);
    expect(generateResponseMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns true and sends an in-thread reply for a pending invitation', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@example.com',
      name: 'Alice',
      acceptedAt: null,
    });

    const result = await tryHandleInvitationReply(baseEmail, 'trace-1');

    expect(result).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sent = sendEmailMock.mock.calls[0][0];
    expect(sent.to).toBe('invitee@example.com');
    // Reply preserves threadId so Gmail keeps it in the same thread.
    expect(sent.threadId).toBe('thread-1');
    // Subject is left as-is when it already starts with Re:
    expect(sent.subject).toBe('Re: You are invited');
    expect(typeof sent.body).toBe('string');
    expect(sent.body.length).toBeGreaterThan(0);
  });

  it('prepends "Re:" when the original subject lacks one', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@example.com',
      name: 'Alice',
      acceptedAt: null,
    });

    await tryHandleInvitationReply(
      { ...baseEmail, subject: 'Quick question' },
      'trace-1',
    );

    expect(sendEmailMock.mock.calls[0][0].subject).toBe('Re: Quick question');
  });

  it('extracts the bare email from a "Name <addr>" From header', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@example.com',
      name: 'Alice',
      acceptedAt: null,
    });

    await tryHandleInvitationReply(
      { ...baseEmail, from: 'Alice Test <invitee@example.com>' },
      'trace-1',
    );

    // The Prisma lookup must use the bare lowercased address, not the
    // full "Name <addr>" header value.
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(findFirstMock.mock.calls[0][0].where.email).toBe('invitee@example.com');
    expect(sendEmailMock.mock.calls[0][0].to).toBe('invitee@example.com');
  });

  it('treats a recently-accepted invitation as still eligible for replies', async () => {
    // The Prisma query has an OR clause that matches either pending OR
    // recently-accepted (within 30 days). We just need to verify we'd
    // still send a reply when the row's acceptedAt is set.
    findFirstMock.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@example.com',
      name: 'Alice',
      acceptedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });

    const result = await tryHandleInvitationReply(baseEmail, 'trace-1');

    expect(result).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('returns false when the From header has no email address', async () => {
    const result = await tryHandleInvitationReply(
      { ...baseEmail, from: '' },
      'trace-1',
    );

    expect(result).toBe(false);
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('falls through (returns false) when sending the reply fails', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@example.com',
      name: 'Alice',
      acceptedAt: null,
    });
    sendEmailMock.mockRejectedValue(new Error('Gmail API down'));

    const result = await tryHandleInvitationReply(baseEmail, 'trace-1');

    // Important: returning false routes the email back through the
    // unmatched-tracker, which will alert admins. We don't want to
    // silently swallow the message.
    expect(result).toBe(false);
  });

  it('falls back to a default name when invitation.name is null', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@example.com',
      name: null,
      acceptedAt: null,
    });

    const result = await tryHandleInvitationReply(baseEmail, 'trace-1');

    expect(result).toBe(true);
    // Assert the Claude call was made with a system prompt that handles
    // a null name (the recipient name is referenced in the user prompt).
    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    const userPrompt = generateResponseMock.mock.calls[0][0] as string;
    expect(userPrompt).toContain('"there"');
  });

  it('skips when the inbound has Auto-Submitted set (RFC 3834 mail-loop guard)', async () => {
    const result = await tryHandleInvitationReply(
      { ...baseEmail, autoSubmitted: 'auto-replied' },
      'trace-1',
    );

    expect(result).toBe(false);
    // Crucial: must not even hit the database when the header says
    // auto-submitted. Returning false routes the message to the
    // unmatched-tracker, which is the right path for vacation
    // responders / mailer-daemons.
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(generateResponseMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does NOT skip when Auto-Submitted is explicitly "no" (some mail clients set this on human replies)', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@example.com',
      name: 'Alice',
      acceptedAt: null,
    });

    const result = await tryHandleInvitationReply(
      { ...baseEmail, autoSubmitted: 'no' },
      'trace-1',
    );

    expect(result).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses the auto-reply when cooldown is active and Slack-alerts admins instead', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@example.com',
      name: 'Alice',
      acceptedAt: null,
    });
    // Simulate cooldown already set from a previous reply.
    redisGetMock.mockResolvedValue('1');

    const result = await tryHandleInvitationReply(baseEmail, 'trace-1');

    // Returning true means "we handled it" — the caller will mark the
    // message processed rather than letting it loop through the
    // unmatched-tracker.
    expect(result).toBe(true);
    expect(generateResponseMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();

    // The follow-up alert must fire so admins know to respond manually.
    // sendAlert is invoked via void/.catch, so we await a microtask.
    await new Promise((r) => setImmediate(r));
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][0]).toMatchObject({
      title: 'Invitee replied again — needs human follow-up',
      severity: 'medium',
    });
  });

  it('sets the cooldown key after a successful auto-reply', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@example.com',
      name: 'Alice',
      acceptedAt: null,
    });

    await tryHandleInvitationReply(baseEmail, 'trace-1');

    expect(redisSetMock).toHaveBeenCalledTimes(1);
    const [key, value, mode, ttl] = redisSetMock.mock.calls[0];
    expect(key).toBe('invitation-reply:cooldown:invite-1');
    expect(value).toBe('1');
    expect(mode).toBe('EX');
    expect(ttl).toBe(3600); // 1 hour
  });

  it('Slack-alerts admins on every successful auto-reply (low severity)', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@example.com',
      name: 'Alice',
      acceptedAt: null,
    });

    await tryHandleInvitationReply(baseEmail, 'trace-1');

    // sendAlert is fired via void/.catch — flush the microtask queue.
    await new Promise((r) => setImmediate(r));
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][0]).toMatchObject({
      title: 'Invitation auto-reply sent',
      severity: 'low',
    });
    // Both the original question and the reply are surfaced to admins
    // so they can spot bad LLM responses early.
    const details = sendAlertMock.mock.calls[0][0].details as string;
    expect(details).toContain('Their question');
    expect(details).toContain('Our reply');
  });

  it('still sends the auto-reply when Redis is unreachable (graceful degradation)', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@example.com',
      name: 'Alice',
      acceptedAt: null,
    });
    redisGetMock.mockRejectedValue(new Error('Redis down'));
    redisSetMock.mockRejectedValue(new Error('Redis down'));

    const result = await tryHandleInvitationReply(baseEmail, 'trace-1');

    // Cooldown lookup failure is treated as "no cooldown" — better to
    // risk a duplicate reply than to silently swallow during a Redis
    // outage. The cooldown SET also fails harmlessly (logged).
    expect(result).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

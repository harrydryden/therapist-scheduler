/**
 * Conversation-state growth, the byte cap, the trim settings, mid-turn
 * audit notes and the per-turn idempotency id — run through the real
 * JustinTimeService + AIConversationService + lifecycle/audit.ts on the
 * stateful in-memory Prisma fake (same shape as
 * conversation-state-persistence.test.ts: predicates applied, increments
 * applied, Json stored as given).
 *
 * Pinned regressions:
 *   #10  every inbound stored a full copy of the Gmail thread in the
 *        state, so a long thread grew it without bound (and, as a JSON
 *        string row, past the 500KB read limit → "Conversation state not
 *        found" on every later turn); the byte cap was only checked above
 *        ~256 messages; agent.maxMessages / agent.trimToMessages were
 *        never read; a thread longer than 50KB pushed the NEW email out of
 *        the truncated prompt.
 *   R1   (previous round's residual risk #1) a lifecycle audit note
 *        appended mid-turn didn't bump conversationVersion, so the turn's
 *        final save overwrote it.
 *   A9   tool idempotency had no turn scope.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config', () => ({
  config: { env: 'test', jwtSecret: 'test', frontendUrl: 'https://test', backendUrl: 'https://test', timezone: 'Europe/London' },
}));
jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn(), getStrict: jest.fn(), set: jest.fn(), del: jest.fn() },
  cacheManager: { setNX: jest.fn() },
}));
jest.mock('../utils/anthropic-client', () => ({ anthropicClient: {} }));
jest.mock('../core/email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/email-queue.service', () => ({ emailQueueService: { enqueue: jest.fn() } }));

// ─── Stateful Prisma fake ───────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string; updatedAt: Date };
const rows: Record<string, Row> = {};

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
function rowMatches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}
function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) {
      row[key] = ((row[key] as number | undefined) ?? 0) + (value as { increment: number }).increment;
    } else {
      row[key] = key === 'conversationState' ? clone(value) : value;
    }
  }
  if (data.updatedAt === undefined) row.updatedAt = new Date(row.updatedAt.getTime() + 1);
}
const readRow = (row: Row): Row => ({ ...row, conversationState: clone(row.conversationState) });

const appointmentRequest = {
  findUnique: jest.fn(async ({ where, include }: { where: { id: string }; include?: unknown }) => {
    const row = rows[where.id];
    if (!row) return null;
    const out = readRow(row);
    if (include) {
      out.user = { country: 'UK', timezone: null };
      out.therapist = { country: 'UK', timezone: null };
    }
    return out;
  }),
  update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = rows[where.id];
    if (!row) throw new Error('P2025');
    applyData(row, data);
    return readRow(row);
  }),
  updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const row of Object.values(rows)) {
      if (!rowMatches(row, where)) continue;
      applyData(row, data);
      count++;
    }
    return { count };
  }),
};
jest.mock('../utils/database', () => {
  const client = {
    appointmentRequest: {
      findUnique: (...a: unknown[]) => (appointmentRequest.findUnique as jest.Mock)(...a),
      update: (...a: unknown[]) => (appointmentRequest.update as jest.Mock)(...a),
      updateMany: (...a: unknown[]) => (appointmentRequest.updateMany as jest.Mock)(...a),
    },
  };
  return { prisma: { ...client, $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(client) } };
});

// ─── Collaborators ──────────────────────────────────────────────────────────

const runToolLoopMock = jest.fn();
jest.mock('../services/agent-tool-loop', () => ({ runToolLoop: (...a: unknown[]) => runToolLoopMock(...a) }));
jest.mock('../services/post-reply-status', () => ({ reconcileStatusAfterReply: jest.fn() }));
jest.mock('../services/system-prompt-builder', () => ({ buildSystemPrompt: jest.fn().mockResolvedValue('SYSTEM') }));
jest.mock('../domain/scheduling/agent', () => ({
  AIToolExecutorService: jest.fn().mockImplementation(() => ({ executeToolCall: jest.fn(), flagForHumanReviewFromLoop: jest.fn() })),
}));
jest.mock('../services/slack-notification.service', () => ({ slackNotificationService: { sendAlert: jest.fn() } }));
jest.mock('../services/audit-event.service', () => ({
  auditEventService: { logEmailReceived: jest.fn(), logFactsExtracted: jest.fn(), log: jest.fn() },
}));
jest.mock('../domain/scheduling/lifecycle', () => ({
  appointmentLifecycleService: { transitionToContacted: jest.fn(), transitionToNegotiating: jest.fn() },
}));
jest.mock('../services/email-classifier.service', () => ({
  classifyEmail: jest.fn(),
  needsSpecialHandling: () => ({ needsAttention: false }),
  formatClassificationForPrompt: () => 'CLASSIFICATION',
}));
jest.mock('../utils/content-sanitizer', () => ({
  checkForInjection: () => ({ injectionDetected: false, detectedPatterns: [] }),
  wrapUntrustedContent: (s: string) => s,
}));
jest.mock('../utils/background-task', () => ({ runBackgroundTask: (fn: () => unknown) => void fn() }));
const settings: Record<string, unknown> = {};
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => settings[key]),
}));
jest.mock('../services/appointment-turn-lock', () => ({ withAppointmentTurnLock: jest.fn() }));

import { JustinTimeService } from '../services/justin-time.service';
import { AIConversationService } from '../services/ai-conversation.service';
import { addAuditMessage } from '../domain/scheduling/lifecycle/audit';
import { CONVERSATION_LIMITS } from '../constants';
import type { EmailClassification } from '../services/email-classifier.service';
import type { SchedulingContext } from '../services/scheduling-context.service';
import type { ConversationState } from '../types';

const APT = 'apt-growth';
const USER_EMAIL = 'client@example.com';
const CLASSIFICATION = { intent: 'general', isFromTherapist: false, extractedSlots: [] } as unknown as EmailClassification;

function seed(state: unknown = { systemPrompt: '', messages: [{ role: 'user', content: 'A new appointment request.' }], checkpoint: {
  stage: 'awaiting_user_slot_selection',
  lastSuccessfulAction: 'sent_availability_to_user',
  pendingAction: null,
  checkpoint_at: '2026-09-20T10:00:00.000Z',
} }, extra: Record<string, unknown> = {}): Row {
  rows[APT] = {
    id: APT,
    status: 'negotiating',
    userName: 'Alice',
    userEmail: USER_EMAIL,
    therapistEmail: 'therapist@example.com',
    therapistName: 'Dr Taylor',
    therapistHandle: 'dr-taylor',
    humanControlEnabled: false,
    bookingMethod: 'agent_negotiated',
    therapistAvailability: null,
    userId: 'u-1',
    therapistId: 'th-1',
    notes: null,
    conversationState: clone(state),
    checkpointStage: 'awaiting_user_slot_selection',
    checkpointAt: null,
    chaseSentAt: null,
    chaseSentTo: null,
    messageCount: 1,
    conversationVersion: 3,
    updatedAt: new Date('2026-09-20T10:00:00.000Z'),
    ...extra,
  };
  return rows[APT];
}

const LOOP_RESULT = {
  iterations: 1,
  totalToolErrors: 0,
  executedTools: [],
  flaggedForHumanReview: false,
  hitMaxIterations: false,
};

type Captured = { messages?: Array<{ role: string; content: string }>; context?: SchedulingContext };

/** A plain text-only turn that records what the loop was given. */
function playTextTurn(captured: Captured = {}) {
  runToolLoopMock.mockImplementation(async (_s: string, messages: Array<{ role: string; content: string }>, state: ConversationState, context: SchedulingContext) => {
    captured.messages = clone(messages);
    captured.context = context;
    state.messages.push({ role: 'assistant', content: 'Replied to the client.' });
    return { messages: [], result: LOOP_RESULT };
  });
  return captured;
}

const storedState = () => rows[APT].conversationState as ConversationState;
const storedBytes = () => Buffer.byteLength(JSON.stringify(rows[APT].conversationState), 'utf8');

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(rows)) delete rows[k];
  for (const k of Object.keys(settings)) delete settings[k];
});

// ─── #10: thread context is prompt-only ─────────────────────────────────────

describe('thread history is supplied to Claude for the turn, not stored', () => {
  it('stores only the new email plus a short reference', async () => {
    seed();
    const captured = playTextTurn();
    const thread = `=== COMPLETE EMAIL THREAD HISTORY ===\n${'older message text '.repeat(2000)}`;

    await new JustinTimeService('t').processEmailReply(APT, 'Tuesday at 3pm works', USER_EMAIL, thread, CLASSIFICATION);

    const inbound = storedState().messages.find((m) => m.content.includes('Tuesday at 3pm works'))!;
    expect(inbound.content).not.toContain('older message text');
    expect(inbound.content).toContain(`thread history (${thread.length} characters)`);
    expect(inbound.content.length).toBeLessThan(1000);

    const prompt = captured.messages![captured.messages!.length - 1].content;
    expect(prompt).toContain('older message text');
    expect(prompt).toContain('Tuesday at 3pm works');
  });

  it('a long thread no longer makes the stored state grow with every turn', async () => {
    seed();
    playTextTurn();
    const thread = 'x'.repeat(45_000);
    for (let i = 0; i < 20; i++) {
      await new JustinTimeService('t').processEmailReply(APT, `Reply number ${i}`, USER_EMAIL, thread, CLASSIFICATION);
    }
    // 20 turns × a 45KB thread used to store ~900KB. Now: the emails.
    expect(storedBytes()).toBeLessThan(20_000);
    expect(storedState().messages.filter((m) => m.content.includes('Reply number'))).toHaveLength(20);
  });

  it('does not store the per-turn system prompt (rebuilt every turn, never read back)', async () => {
    seed();
    playTextTurn();
    await new JustinTimeService('t').processEmailReply(APT, 'Hi', USER_EMAIL, undefined, CLASSIFICATION);
    expect(storedState().systemPrompt).toBe('');
    expect(runToolLoopMock.mock.calls[0][0]).toBe('SYSTEM');
  });

  it('the new email survives a thread longer than the per-message cap', async () => {
    seed();
    const captured = playTextTurn();
    const thread = 'T'.repeat(CONVERSATION_LIMITS.MAX_MESSAGE_LENGTH * 4);

    await new JustinTimeService('t').processEmailReply(APT, 'THE NEW EMAIL BODY', USER_EMAIL, thread, CLASSIFICATION);

    const prompt = captured.messages![captured.messages!.length - 1].content;
    expect(prompt).toContain('THE NEW EMAIL BODY');
    expect(prompt).toContain('Earlier thread history omitted');
  });
});

// ─── #10: byte cap + settings ───────────────────────────────────────────────

describe('trimConversationState / storeConversationState limits', () => {
  const svc = new AIConversationService('trim');
  const big = (i: number) => ({ role: 'user' as const, content: `${i}:${'y'.repeat(45_000)}` });

  it('enforces the byte cap well below the message-count limit', () => {
    const messages = Array.from({ length: 20 }, (_, i) => big(i));
    const trimmed = svc.trimConversationState({ systemPrompt: '', messages });

    expect(Buffer.byteLength(JSON.stringify(trimmed), 'utf8')).toBeLessThanOrEqual(CONVERSATION_LIMITS.MAX_STATE_BYTES);
    // Newest kept, head kept, placeholder in between.
    expect(trimmed.messages[trimmed.messages.length - 1].content.startsWith('19:')).toBe(true);
    expect(trimmed.messages[0].content.startsWith('0:')).toBe(true);
    expect(trimmed.messages.some((m) => m.content.includes('[System Note:'))).toBe(true);
  });

  it('every save lands under the cap', async () => {
    seed({ systemPrompt: '', messages: [] });
    const messages = Array.from({ length: 15 }, (_, i) => big(i));
    await svc.storeConversationState(APT, { systemPrompt: '', messages }, 3);
    expect(storedBytes()).toBeLessThanOrEqual(CONVERSATION_LIMITS.MAX_STATE_BYTES);
    expect(storedState().messages[storedState().messages.length - 1].content.startsWith('14:')).toBe(true);
  });

  it('reads agent.maxMessages / agent.trimToMessages instead of the constants', async () => {
    settings['agent.maxMessages'] = 30;
    settings['agent.trimToMessages'] = 20;
    seed({ systemPrompt: '', messages: [] });
    const messages = Array.from({ length: 35 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));

    await svc.storeConversationState(APT, { systemPrompt: '', messages }, 3);

    expect(storedState().messages).toHaveLength(20);
    expect(storedState().messages[storedState().messages.length - 1].content).toBe('m34');
  });

  it('clamps a trimToMessages above maxMessages (trimming still happens)', async () => {
    settings['agent.maxMessages'] = 25;
    settings['agent.trimToMessages'] = 200;
    seed({ systemPrompt: '', messages: [] });
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));

    await svc.storeConversationState(APT, { systemPrompt: '', messages }, 3);
    expect(storedState().messages).toHaveLength(25);
  });
});

// ─── R1: mid-turn audit notes survive the turn's saves ──────────────────────

describe('lifecycle audit notes appended mid-turn', () => {
  it('survive the next checkpoint save and the final save (rebased, in order)', async () => {
    seed();
    runToolLoopMock.mockImplementation(async (_s: string, _m: unknown, state: ConversationState, _c: SchedulingContext, callbacks: { checkpointBeforeSideEffects: () => Promise<void> }) => {
      await callbacks.checkpointBeforeSideEffects(); // iteration 1, before mark_scheduling_complete
      await addAuditMessage(APT, 'agent', 'Appointment confirmed for Tuesday 3pm'); // the transition's note
      state.messages.push({ role: 'assistant', content: 'Confirmed with both parties.' });
      await callbacks.checkpointBeforeSideEffects(); // iteration 2, before send_email
      state.messages.push({ role: 'assistant', content: 'All done.' });
      return { messages: [], result: LOOP_RESULT };
    });

    const result = await new JustinTimeService('t').processEmailReply(APT, 'Tuesday works', USER_EMAIL, undefined, CLASSIFICATION);

    expect(result.success).toBe(true);
    const contents = storedState().messages.map((m) => m.content);
    const note = contents.findIndex((c) => c === '[System: agent] Appointment confirmed for Tuesday 3pm');
    expect(note).toBeGreaterThan(-1);
    expect(contents.indexOf('Confirmed with both parties.')).toBeGreaterThan(note);
    expect(contents[contents.length - 1]).toBe('All done.');
    expect(contents.filter((c) => c.includes('Tuesday works'))).toHaveLength(1);
    expect(rows[APT].notes).toBeNull(); // no COMPENSATION
  });

  it('a note appended after the last checkpoint is kept by the final save', async () => {
    seed();
    runToolLoopMock.mockImplementation(async (_s: string, _m: unknown, state: ConversationState) => {
      await addAuditMessage(APT, 'agent', 'Appointment cancelled');
      state.messages.push({ role: 'assistant', content: 'Let both parties know.' });
      return { messages: [], result: LOOP_RESULT };
    });

    await new JustinTimeService('t').processEmailReply(APT, 'Please cancel', USER_EMAIL, undefined, CLASSIFICATION);

    const contents = storedState().messages.map((m) => m.content);
    expect(contents).toContain('[System: agent] Appointment cancelled');
    expect(contents[contents.length - 1]).toBe('Let both parties know.');
  });

  it('bumps conversationVersion, and on a row with no state creates one without touching the stage/chase columns', async () => {
    const chaseSentAt = new Date('2026-09-19T00:00:00.000Z');
    seed(null, { checkpointStage: 'awaiting_therapist_availability', chaseSentAt, chaseSentTo: 'therapist', conversationVersion: 0 });

    await addAuditMessage(APT, 'admin', 'Status forced to contacted', 'admin-1');

    expect(storedState().messages).toEqual([{ role: 'admin', content: '[Admin: admin-1] Status forced to contacted' }]);
    expect(rows[APT].conversationVersion).toBe(1);
    expect(rows[APT].checkpointStage).toBe('awaiting_therapist_availability');
    expect(rows[APT].chaseSentAt).toEqual(chaseSentAt);
    expect(rows[APT].chaseSentTo).toBe('therapist');
  });
});

// ─── A9: per-turn idempotency scope ─────────────────────────────────────────

describe('turnId on the scheduling context', () => {
  it('is stable for a redelivered email and differs for a new one', async () => {
    seed();
    const first = playTextTurn();
    await new JustinTimeService('t').processEmailReply(APT, 'Can we do Tuesday?', USER_EMAIL, undefined, CLASSIFICATION);
    const again = playTextTurn();
    await new JustinTimeService('t').processEmailReply(APT, 'Can we do Tuesday?', USER_EMAIL, undefined, CLASSIFICATION);
    const later = playTextTurn();
    await new JustinTimeService('t').processEmailReply(APT, 'Actually, Wednesday?', USER_EMAIL, undefined, CLASSIFICATION);

    expect(first.context!.turnId).toMatch(/^inbound:/);
    expect(again.context!.turnId).toBe(first.context!.turnId);
    expect(later.context!.turnId).not.toBe(first.context!.turnId);
  });

  it('startScheduling scopes the kickoff to the appointment', async () => {
    seed(null, { status: 'pending' });
    const captured = playTextTurn();
    await new JustinTimeService('t').startScheduling({
      appointmentRequestId: APT,
      userName: 'Alice',
      userEmail: USER_EMAIL,
      therapistEmail: 'therapist@example.com',
      therapistName: 'Dr Taylor',
      therapistAvailability: null,
      bookingMethod: 'agent_negotiated',
      userCountry: 'UK',
      therapistCountry: 'UK',
    });
    expect(captured.context!.turnId).toBe(`start:${APT}`);
  });
});

/**
 * End-to-end regression tests for booking-agent conversation-state
 * persistence, run against a stateful in-memory Prisma fake that behaves
 * like the real thing where it matters:
 *
 *   - every write bumps `updatedAt` (Prisma's @updatedAt) — including
 *     writes that don't mention it, such as dispatch's human-control gate
 *     `updateMany({ data: { lastToolExecutedAt } })`;
 *   - `where` predicates are applied (so an optimistic-lock CAS can miss);
 *   - `{ increment: n }` is applied arithmetically;
 *   - Json column values are stored as given (so a JSON *string* stays a
 *     string, like jsonb_typeof = 'string' in Postgres) and deep-copied on
 *     read.
 *
 * Pinned regressions:
 *   A1  parseConversationState stripped checkpoint / facts /
 *       responseTracking, so every turn started at initial_contact with
 *       empty facts and no response tracking.
 *   L1  the CAS version was `updatedAt`, which the turn's own tool writes
 *       bump, so the end-of-turn save threw ConcurrentModificationError on
 *       nearly every tool-using turn (turn state lost, COMPENSATION note).
 *   JSON-string storage — conversationState must be written as an object.
 *   A5  a sender that is neither the client nor the therapist was treated
 *       as the therapist.
 *
 * The real JustinTimeService + AIConversationService run; only the Claude
 * tool loop (runToolLoop) and unrelated collaborators are mocked. The
 * runToolLoop mock plays a realistic turn: pre-tool checkpoint save, then
 * the tool writes that bump the row, then an in-memory checkpoint advance.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config', () => ({
  config: { jwtSecret: 'test', frontendUrl: 'https://test', backendUrl: 'https://test', timezone: 'Europe/London' },
}));
jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn(), getStrict: jest.fn(), set: jest.fn(), del: jest.fn() },
}));
jest.mock('../utils/anthropic-client', () => ({ anthropicClient: {} }));
jest.mock('../core/email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/email-queue.service', () => ({ emailQueueService: { enqueue: jest.fn() } }));

// ─── Stateful Prisma fake ───────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string; updatedAt: Date };

const appointmentRows: Record<string, Row> = {};

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function valueEquals(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
}

function rowMatches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => valueEquals(row[key], expected));
}

function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) {
      row[key] = ((row[key] as number | undefined) ?? 0) + (value as { increment: number }).increment;
    } else if (key === 'conversationState') {
      row[key] = clone(value);
    } else {
      row[key] = value;
    }
  }
  // Prisma's @updatedAt: bumped by EVERY write unless set explicitly.
  // Strictly later than before so an updatedAt CAS deterministically
  // misses after an intervening write.
  if (data.updatedAt === undefined) {
    row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
  }
}

function readRow(row: Row): Row {
  return { ...row, conversationState: clone(row.conversationState) };
}

const appointmentRequestFake = {
  findUnique: jest.fn(async ({ where, include }: { where: { id: string }; include?: Record<string, unknown> }) => {
    const row = appointmentRows[where.id];
    if (!row) return null;
    const out = readRow(row);
    if (include) {
      out.user = { country: 'UK', timezone: null };
      out.therapist = { country: 'UK', timezone: null };
    }
    return out;
  }),
  update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = appointmentRows[where.id];
    if (!row) throw new Error('P2025: record not found');
    applyData(row, data);
    return readRow(row);
  }),
  updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const row of Object.values(appointmentRows)) {
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
      findUnique: (...a: unknown[]) => (appointmentRequestFake.findUnique as jest.Mock)(...a),
      update: (...a: unknown[]) => (appointmentRequestFake.update as jest.Mock)(...a),
      updateMany: (...a: unknown[]) => (appointmentRequestFake.updateMany as jest.Mock)(...a),
    },
  };
  return {
    prisma: {
      ...client,
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(client),
    },
  };
});

// ─── The rest of JustinTimeService's collaborators ──────────────────────────

const runToolLoopMock = jest.fn();
jest.mock('../services/agent-tool-loop', () => ({
  runToolLoop: (...a: unknown[]) => runToolLoopMock(...a),
}));
jest.mock('../services/post-reply-status', () => ({
  reconcileStatusAfterReply: jest.fn().mockResolvedValue(undefined),
}));
const buildSystemPromptMock = jest.fn();
jest.mock('../services/system-prompt-builder', () => ({
  buildSystemPrompt: (...a: unknown[]) => buildSystemPromptMock(...a),
}));
jest.mock('../domain/scheduling/agent', () => ({
  AIToolExecutorService: jest.fn().mockImplementation(() => ({
    executeToolCall: jest.fn(),
    flagForHumanReviewFromLoop: jest.fn(),
  })),
}));
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { sendAlert: jest.fn() },
}));
jest.mock('../services/audit-event.service', () => ({
  auditEventService: { logEmailReceived: jest.fn(), logFactsExtracted: jest.fn() },
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
jest.mock('../utils/background-task', () => ({
  runBackgroundTask: (fn: () => unknown) => {
    void fn();
  },
}));
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn().mockResolvedValue(false),
}));
jest.mock('../services/appointment-turn-lock', () => ({
  withAppointmentTurnLock: jest.fn(),
}));

import { JustinTimeService } from '../services/justin-time.service';
import { AIConversationService } from '../services/ai-conversation.service';
import { updateCheckpoint, type ConversationCheckpoint } from '../services/conversation-checkpoint.service';
import { classifyInboundSender, type SchedulingContext } from '../services/scheduling-context.service';
import type { EmailClassification } from '../services/email-classifier.service';
import type { ConversationState } from '../types';

const APT = 'apt-persist';
const USER_EMAIL = 'client@example.com';
const THERAPIST_EMAIL = 'therapist@example.com';

const CLASSIFICATION = {
  intent: 'general',
  sentiment: 'neutral',
  urgencyLevel: 'low',
  isFromTherapist: false,
  extractedSlots: [],
  therapistConfirmation: undefined,
} as unknown as EmailClassification;

const STORED_CHECKPOINT: ConversationCheckpoint = {
  stage: 'awaiting_user_slot_selection',
  lastSuccessfulAction: 'sent_availability_to_user',
  pendingAction: 'Waiting for user to select a time slot',
  checkpoint_at: '2026-09-20T10:00:00.000Z',
  context: { lastEmailSentTo: 'user' },
};

function storedState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    systemPrompt: '',
    messages: [
      { role: 'user', content: 'A new appointment request has been received.' },
      { role: 'assistant', content: 'Sent Tuesday 3pm and Wednesday 10am to the client.' },
    ],
    checkpoint: STORED_CHECKPOINT,
    facts: {
      proposedTimes: ['Tuesday at 3pm', 'Wednesday at 10am'],
      therapistPreferences: [],
      userPreferences: [],
      blockers: [],
      specialNotes: [],
      updatedAt: '2026-09-20T10:00:00.000Z',
    },
    responseTracking: {
      lastEmailSentToTherapist: '2026-09-19T09:00:00.000Z',
      pendingSince: '2026-09-19T09:00:00.000Z',
      emailType: 'availability_request',
      events: [],
    },
    ...overrides,
  };
}

function seedAppointment(opts: {
  state?: unknown;
  checkpointStage?: string | null;
  conversationVersion?: number;
} = {}): Row {
  const row: Row = {
    id: APT,
    status: 'negotiating',
    userName: 'Alice',
    userEmail: USER_EMAIL,
    therapistEmail: THERAPIST_EMAIL,
    therapistName: 'Dr Taylor',
    therapistHandle: 'dr-taylor',
    humanControlEnabled: false,
    humanControlTakenBy: null,
    confirmedDateTime: null,
    reschedulingInProgress: false,
    bookingMethod: 'agent_negotiated',
    therapistAvailability: null,
    userId: 'u-1',
    therapistId: 'th-1',
    notes: null,
    conversationState: clone(opts.state === undefined ? storedState() : opts.state),
    checkpointStage: opts.checkpointStage === undefined ? STORED_CHECKPOINT.stage : opts.checkpointStage,
    checkpointAt: null,
    messageCount: 2,
    conversationVersion: opts.conversationVersion ?? 5,
    lastToolExecutedAt: null,
    lastActivityAt: new Date('2026-09-20T10:00:00.000Z'),
    updatedAt: new Date('2026-09-20T10:00:00.000Z'),
  };
  appointmentRows[APT] = row;
  return row;
}

/** What the tool loop would do on a turn that calls send_email: pre-tool
 *  checkpoint save, then the dispatch gate + send.ts writes to the row
 *  (both bump @updatedAt), then the in-memory checkpoint advance and the
 *  assistant's closing text. */
function playToolUsingTurn(captured: {
  state?: ConversationState;
  context?: SchedulingContext;
  messages?: Array<{ role: string; content: unknown }>;
}) {
  runToolLoopMock.mockImplementation(async (
    _systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    state: ConversationState,
    context: SchedulingContext,
    callbacks: { checkpointBeforeSideEffects?: () => Promise<void> },
  ) => {
    captured.state = clone(state);
    captured.context = context;
    captured.messages = clone(messages);
    await callbacks.checkpointBeforeSideEffects?.();
    // dispatch.ts human-control gate
    await appointmentRequestFake.updateMany({
      where: { id: APT, humanControlEnabled: false },
      data: { lastToolExecutedAt: new Date() },
    });
    // send.ts outbound stamp
    await appointmentRequestFake.update({ where: { id: APT }, data: { lastActivityAt: new Date() } });
    state.checkpoint = updateCheckpoint(state.checkpoint ?? null, 'received_user_slot_selection', null, {
      lastEmailSentTo: 'therapist',
    });
    state.messages.push({ role: 'assistant', content: 'Asked the therapist to confirm Tuesday 3pm.' });
    return {
      messages: [],
      result: {
        iterations: 2,
        totalToolErrors: 0,
        executedTools: [{ toolName: 'send_email', emailSentTo: 'therapist', timestamp: new Date().toISOString() }],
        flaggedForHumanReview: false,
        hitMaxIterations: false,
      },
    };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(appointmentRows)) delete appointmentRows[k];
  buildSystemPromptMock.mockResolvedValue('SYSTEM');
});

// ─── storeConversationState / getConversationState ─────────────────────────

describe('conversation-state CAS uses conversationVersion, not updatedAt', () => {
  it('a turn-shaped sequence (read → checkpoint save → tool writes → final save) succeeds', async () => {
    seedAppointment({ conversationVersion: 5 });
    const svc = new AIConversationService('trace-cas');

    const read = await svc.getConversationState(APT);
    expect(read!._version).toBe(5);
    const { _version, ...state } = read!;

    // Pre-tool checkpoint save.
    const afterCheckpoint = await svc.storeConversationState(APT, state, _version);
    expect(afterCheckpoint).toBe(6);

    // The turn's own tool writes — bump updatedAt, not the version.
    await appointmentRequestFake.updateMany({
      where: { id: APT, humanControlEnabled: false },
      data: { lastToolExecutedAt: new Date() },
    });
    await appointmentRequestFake.update({ where: { id: APT }, data: { lastActivityAt: new Date() } });

    state.messages.push({ role: 'assistant', content: 'done' });
    const result = await svc.storeConversationStateWithRetry(APT, state, { version: afterCheckpoint, persistedCount: state.messages.length - 1 }, [
      { toolName: 'send_email', emailSentTo: 'user', timestamp: new Date().toISOString() },
    ]);

    expect(result).toEqual({ success: true, retriesUsed: 0 });
    expect(appointmentRows[APT].conversationVersion).toBe(7);
    expect(appointmentRows[APT].notes).toBeNull(); // no COMPENSATION note
  });

  it('still detects a genuine concurrent conversation-state writer', async () => {
    seedAppointment({ conversationVersion: 2 });
    const svc = new AIConversationService('trace-cas');
    const read = await svc.getConversationState(APT);
    const { _version, ...state } = read!;

    // An admin appends a message in between (a conversation writer).
    await svc.appendConversationMessage(APT, { role: 'admin', content: 'admin note' });
    expect(appointmentRows[APT].conversationVersion).toBe(3);

    await expect(svc.storeConversationState(APT, state, _version)).rejects.toThrow(/modified by another process/);
  });

  it('treats version 0 as a real version (CAS branch, not the unversioned one)', async () => {
    seedAppointment({ conversationVersion: 0 });
    const svc = new AIConversationService('trace-cas');
    appointmentRows[APT].conversationVersion = 1; // someone else wrote

    await expect(
      svc.storeConversationState(APT, { systemPrompt: '', messages: [] }, 0),
    ).rejects.toThrow(/modified by another process/);
  });

  it('writes conversationState as a JSON object (not a JSON string)', async () => {
    seedAppointment({ state: null, conversationVersion: 0 });
    const svc = new AIConversationService('trace-json');

    await svc.storeConversationState(APT, storedState()); // unversioned first write
    expect(typeof appointmentRows[APT].conversationState).toBe('object');
    expect(appointmentRows[APT].conversationVersion).toBe(1);

    await svc.storeConversationState(APT, storedState(), 1); // CAS write
    expect(typeof appointmentRows[APT].conversationState).toBe('object');

    await svc.applyCheckpointAction(APT, 'sent_chase_followup');
    expect(typeof appointmentRows[APT].conversationState).toBe('object');
    expect(appointmentRows[APT].conversationVersion).toBe(3);
  });

  it('reads legacy string-typed rows and rewrites them as objects on the next save', async () => {
    seedAppointment({ state: JSON.stringify(storedState()), conversationVersion: 4 });
    const svc = new AIConversationService('trace-json');

    const read = await svc.getConversationState(APT);
    expect(read!.checkpoint).toEqual(STORED_CHECKPOINT);
    const { _version, ...state } = read!;
    await svc.storeConversationState(APT, state, _version);

    expect(typeof appointmentRows[APT].conversationState).toBe('object');
    expect((appointmentRows[APT].conversationState as ConversationState).checkpoint).toEqual(STORED_CHECKPOINT);
  });

  it('applyCheckpointUpdate sees (and keeps) the stored checkpoint context and facts', async () => {
    seedAppointment({ conversationVersion: 9 });
    const svc = new AIConversationService('trace-chk');

    let seen: ConversationCheckpoint | null = null;
    const res = await svc.applyCheckpointUpdate(APT, (current) => {
      seen = current;
      return { ...current!, pendingAction: 'chased' };
    });

    expect(res.applied).toBe(true);
    expect(seen).toEqual(STORED_CHECKPOINT);
    const saved = appointmentRows[APT].conversationState as ConversationState;
    expect(saved.checkpoint!.context).toEqual({ lastEmailSentTo: 'user' });
    expect(saved.facts!.proposedTimes).toEqual(['Tuesday at 3pm', 'Wednesday at 10am']);
    expect(saved.responseTracking!.lastEmailSentToTherapist).toBe('2026-09-19T09:00:00.000Z');
    expect(appointmentRows[APT].conversationVersion).toBe(10);
  });
});

// ─── processEmailReply — a whole turn ──────────────────────────────────────

describe('processEmailReply turn persistence', () => {
  it('starts the turn from the stored checkpoint + facts (not initial_contact / empty)', async () => {
    seedAppointment();
    const captured: { state?: ConversationState } = {};
    playToolUsingTurn(captured);

    await new JustinTimeService('trace-turn').processEmailReply(
      APT,
      'Tuesday at 3pm works for me',
      USER_EMAIL,
      undefined,
      CLASSIFICATION,
    );

    expect(captured.state!.checkpoint!.stage).toBe('awaiting_user_slot_selection');
    expect(captured.state!.checkpoint!.context).toEqual({ lastEmailSentTo: 'user' });
    expect(captured.state!.facts!.proposedTimes).toEqual(
      expect.arrayContaining(['Tuesday at 3pm', 'Wednesday at 10am']),
    );
    // The prompt was built from the stored stage too.
    const [, promptCheckpoint, promptFacts] = buildSystemPromptMock.mock.calls[0];
    expect(promptCheckpoint.stage).toBe('awaiting_user_slot_selection');
    expect(promptFacts.proposedTimes).toEqual(expect.arrayContaining(['Wednesday at 10am']));
  });

  it("persists the turn's end state even though its tool calls wrote the row mid-turn", async () => {
    seedAppointment({ conversationVersion: 5 });
    playToolUsingTurn({});

    const result = await new JustinTimeService('trace-turn').processEmailReply(
      APT,
      'Tuesday at 3pm works for me',
      USER_EMAIL,
      undefined,
      CLASSIFICATION,
    );

    expect(result.success).toBe(true);
    const row = appointmentRows[APT];
    const saved = row.conversationState as ConversationState;
    // Final save landed: advanced checkpoint + the closing assistant text.
    expect(saved.checkpoint!.stage).toBe('awaiting_therapist_confirmation');
    expect(saved.checkpoint!.context!.lastEmailSentTo).toBe('therapist');
    expect(saved.messages[saved.messages.length - 1].content).toBe('Asked the therapist to confirm Tuesday 3pm.');
    expect(saved.messages.some((m) => m.content.includes('Tuesday at 3pm works for me'))).toBe(true);
    // Denormalised column follows the JSON; no compensation note.
    expect(row.checkpointStage).toBe('awaiting_therapist_confirmation');
    expect(row.notes).toBeNull();
    // Checkpoint save + final save.
    expect(row.conversationVersion).toBe(7);
    // Facts + response tracking survived the round trip.
    expect(saved.facts!.proposedTimes).toEqual(expect.arrayContaining(['Wednesday at 10am']));
    expect(saved.responseTracking!.lastEmailSentToTherapist).toBe('2026-09-19T09:00:00.000Z');
    expect(typeof row.conversationState).toBe('object');
  });

  it('records therapist response time on a therapist reply and keeps it through the turn', async () => {
    seedAppointment();
    playToolUsingTurn({});

    await new JustinTimeService('trace-turn').processEmailReply(
      APT,
      'I can confirm Tuesday 3pm',
      THERAPIST_EMAIL,
      undefined,
      CLASSIFICATION,
    );

    const saved = appointmentRows[APT].conversationState as ConversationState;
    expect(saved.responseTracking!.events).toHaveLength(1);
    expect(saved.responseTracking!.pendingSince).toBeNull();
    expect(saved.responseTracking!.lastResponseAt).toEqual(expect.any(String));
  });

  it('seeds a state with no checkpoint from the checkpointStage column', async () => {
    seedAppointment({
      state: { systemPrompt: '', messages: [{ role: 'assistant', content: '[System: agent] audit note' }] },
      checkpointStage: 'awaiting_therapist_confirmation',
    });
    const captured: { state?: ConversationState } = {};
    playToolUsingTurn(captured);

    await new JustinTimeService('trace-seed').processEmailReply(APT, 'Hi', USER_EMAIL, undefined, CLASSIFICATION);

    expect(captured.state!.checkpoint!.stage).toBe('awaiting_therapist_confirmation');
    expect(buildSystemPromptMock.mock.calls[0][1].stage).toBe('awaiting_therapist_confirmation');
  });

  it('does not seed from an unknown column value (the loop bootstrap floor applies instead)', async () => {
    seedAppointment({
      state: { systemPrompt: '', messages: [] },
      checkpointStage: 'not_a_stage',
    });
    const captured: { state?: ConversationState } = {};
    playToolUsingTurn(captured);

    await new JustinTimeService('trace-seed').processEmailReply(APT, 'Hi', USER_EMAIL, undefined, CLASSIFICATION);

    expect(captured.state!.checkpoint).toBeUndefined();
  });
});

// ─── Sender classification (A5) ────────────────────────────────────────────

describe('inbound sender classification', () => {
  const appointment = { userEmail: USER_EMAIL, therapistEmail: THERAPIST_EMAIL };

  it('classifies user / therapist / unknown (case-insensitively)', () => {
    expect(classifyInboundSender('Client@Example.com', appointment)).toBe('user');
    expect(classifyInboundSender(' THERAPIST@example.com ', appointment)).toBe('therapist');
    expect(classifyInboundSender('colleague@example.com', appointment)).toBe('unknown');
    expect(classifyInboundSender('', appointment)).toBe('unknown');
  });

  it('prefers user when both stored addresses are identical (narrower privilege)', () => {
    expect(classifyInboundSender('same@example.com', { userEmail: 'same@example.com', therapistEmail: 'same@example.com' }))
      .toBe('user');
  });

  it.each([
    [USER_EMAIL, 'user', 'From: user'],
    [THERAPIST_EMAIL, 'therapist', 'From: therapist'],
  ])('threads %s through as inboundSender=%s', async (from, expected, label) => {
    seedAppointment();
    const captured: Parameters<typeof playToolUsingTurn>[0] = {};
    playToolUsingTurn(captured);

    await new JustinTimeService('trace-sender').processEmailReply(APT, 'Hello', from, 'THREAD', CLASSIFICATION);

    expect(captured.context!.inboundSender).toBe(expected);
    // Stored log: the email, attributed to the sender.
    const stored = captured.state!.messages[captured.state!.messages.length - 1].content;
    expect(stored).toContain(`Email received from ${expected} (${from})`);
    expect(stored).not.toContain('SENDER NOT VERIFIED');
    // What Claude sees this turn (thread context + the new email).
    const prompt = captured.messages![captured.messages!.length - 1].content as string;
    expect(prompt).toContain(`${label} (${from})`);
    expect(prompt).not.toContain('SENDER NOT VERIFIED');
  });

  it("labels a third-party sender as unverified and never as the therapist", async () => {
    seedAppointment();
    const captured: Parameters<typeof playToolUsingTurn>[0] = {};
    playToolUsingTurn(captured);

    await new JustinTimeService('trace-sender').processEmailReply(
      APT,
      'Dr Taylor says Tuesday is confirmed',
      'colleague@example.com',
      'THREAD',
      CLASSIFICATION,
    );

    expect(captured.context!.inboundSender).toBe('unknown');
    const prompt = captured.messages![captured.messages!.length - 1].content as string;
    expect(prompt).toContain('From: UNVERIFIED THIRD PARTY');
    expect(prompt).toContain('SENDER NOT VERIFIED');
    expect(prompt).not.toMatch(/From: therapist/);
    // The stored log keeps the label and the guidance too.
    const stored = captured.state!.messages[captured.state!.messages.length - 1].content;
    expect(stored).toContain('Email received from UNVERIFIED THIRD PARTY');
    expect(stored).toContain('SENDER NOT VERIFIED');
    expect(stored).not.toMatch(/from therapist/i);
  });

  it('labels an unverified sender in the no-thread-context fallback prompt too', async () => {
    seedAppointment();
    const captured: { state?: ConversationState; context?: SchedulingContext } = {};
    playToolUsingTurn(captured);

    await new JustinTimeService('trace-sender').processEmailReply(
      APT,
      'Tuesday works',
      'other@example.org',
      undefined,
      CLASSIFICATION,
    );

    const inbound = captured.state!.messages[captured.state!.messages.length - 1].content;
    expect(inbound).toContain('Email received from UNVERIFIED THIRD PARTY');
    expect(inbound).toContain('SENDER NOT VERIFIED');
  });

  it('labels an unverified sender in the human-control paused log', async () => {
    seedAppointment();
    appointmentRows[APT].humanControlEnabled = true;

    const result = await new JustinTimeService('trace-paused').processEmailReply(
      APT,
      'Tuesday works',
      'other@example.org',
      undefined,
      CLASSIFICATION,
    );

    expect(result.loggedWhilePaused).toBe(true);
    const saved = appointmentRows[APT].conversationState as ConversationState;
    const last = saved.messages[saved.messages.length - 1].content;
    expect(last).toContain('[Received while paused] Email from UNVERIFIED THIRD PARTY');
    // The paused-branch save kept the checkpoint too.
    expect(saved.checkpoint).toEqual(STORED_CHECKPOINT);
  });
});

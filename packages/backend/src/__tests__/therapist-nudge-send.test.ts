/**
 * Tests for the phase-5 nudge-send behaviour: each outbound nudge now
 * abandons any prior active nudge_reply conversation for the
 * therapist and opens a fresh one, with the outbound body seeded as
 * an `assistant` message in conversationState so that when the
 * therapist replies, the availability agent's processReply sees a
 * coherent [assistant, user] turn rather than an orphaned inbound.
 *
 * Scope: the new DB writes only. Eligibility filtering and the
 * Locked-Task-Runner wiring aren't exercised here — those predate
 * phase 5 and have their own integration coverage.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    timezone: 'Europe/London',
    anthropicApiKey: 'test-key',
    nodeEnv: 'test',
    jwtSecret: 'test-secret',
    backendUrl: 'https://backend.test',
    frontendUrl: 'https://frontend.test',
  },
}));

// In-memory store for the rows the service touches.
type TherapistRow = {
  id: string;
  name: string;
  email: string;
  lastNudgeAt: Date | null;
  lastNudgeThreadId: string | null;
};
type ConversationRow = {
  id: string;
  therapistId: string;
  kind: 'onboarding' | 'nudge_reply';
  status: 'active' | 'completed' | 'superseded' | 'abandoned';
  gmailThreadId: string | null;
  initialMessageId: string | null;
  conversationState: unknown;
  messageCount: number;
};

const therapists: Record<string, TherapistRow> = {};
const conversations: Record<string, ConversationRow> = {};
let nextConvoId = 1;

const therapistFindMany = jest.fn();
const therapistUpdate = jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<TherapistRow> }) => {
  if (!therapists[where.id]) throw new Error('P2025');
  therapists[where.id] = { ...therapists[where.id], ...data };
  return therapists[where.id];
});
const appointmentFindMany = jest.fn().mockResolvedValue([]);
const conversationUpdateMany = jest.fn(
  async ({
    where,
    data,
  }: {
    where: { therapistId?: string; kind?: string; status?: string };
    data: Partial<ConversationRow>;
  }) => {
    let count = 0;
    for (const row of Object.values(conversations)) {
      if (where.therapistId !== undefined && row.therapistId !== where.therapistId) continue;
      if (where.kind !== undefined && row.kind !== where.kind) continue;
      if (where.status !== undefined && row.status !== where.status) continue;
      conversations[row.id] = { ...row, ...data };
      count++;
    }
    return { count };
  },
);
const conversationCreate = jest.fn(
  async ({ data }: { data: Partial<ConversationRow> & { therapistId: string; kind: string } }) => {
    const id = `convo-${nextConvoId++}`;
    const row: ConversationRow = {
      id,
      therapistId: data.therapistId,
      kind: data.kind as 'onboarding' | 'nudge_reply',
      status: (data.status as ConversationRow['status']) ?? 'active',
      gmailThreadId: data.gmailThreadId ?? null,
      initialMessageId: data.initialMessageId ?? null,
      conversationState: data.conversationState ?? null,
      messageCount: data.messageCount ?? 0,
    };
    conversations[id] = row;
    return row;
  },
);

jest.mock('../utils/database', () => ({
  prisma: {
    therapist: {
      findMany: (...a: unknown[]) => therapistFindMany(...a),
      update: (...a: unknown[]) => therapistUpdate(...(a as [{ where: { id: string }; data: Partial<TherapistRow> }])),
      // Inter-tick claim path: the service uses updateMany to atomically
      // advance lastNudgeAt only if it was null OR <= cutoff. For this
      // test we just route the update through the same update() mock
      // and return a count of 1 so the claim succeeds.
      updateMany: jest.fn(async (args: { where: { id: string }; data: Partial<TherapistRow> }) => {
        const row = therapists[args.where.id];
        if (!row) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      }),
    },
    appointmentRequest: {
      findMany: (...a: unknown[]) => appointmentFindMany(...a),
    },
    therapistConversation: {
      updateMany: (...a: unknown[]) => conversationUpdateMany(...(a as [{ where: Record<string, unknown>; data: Partial<ConversationRow> }])),
      create: (...a: unknown[]) => conversationCreate(...(a as [{ data: Partial<ConversationRow> & { therapistId: string; kind: string } }])),
    },
    // $transaction in service code runs its callback with a tx that has
    // the same shape as `prisma` itself. Forward through to the same
    // mocks so the assertions can observe the writes regardless of
    // whether the service uses prisma directly or the tx variant.
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        therapist: {
          update: (...a: unknown[]) =>
            therapistUpdate(...(a as [{ where: { id: string }; data: Partial<TherapistRow> }])),
        },
        therapistConversation: {
          updateMany: (...a: unknown[]) =>
            conversationUpdateMany(
              ...(a as [{ where: Record<string, unknown>; data: Partial<ConversationRow> }]),
            ),
          create: (...a: unknown[]) =>
            conversationCreate(
              ...(a as [{ data: Partial<ConversationRow> & { therapistId: string; kind: string } }]),
            ),
        },
      }),
    ),
  },
}));

// Settings: return scripted values for the keys sendNudges asks for.
const settingsMap: Record<string, unknown> = {
  'therapistNudge.enabled': true,
  'therapistNudge.intervalWeeks': 2,
  'agent.fromName': 'Justin Time',
  'email.therapistNudgeSubject': 'Spill update - still finding you a client',
  'email.therapistNudgeBody': 'Hi {therapistFirstName}, share your availability please. — {agentFirstName}',
};
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => settingsMap[key]),
  getSettingValues: jest.fn().mockResolvedValue(new Map()),
}));

const mockSendEmail = jest.fn(
  async (_params: { to: string; subject: string; body: string; threadId?: string }) => ({
    threadId: 'thread-nudge-1',
    messageId: 'msg-nudge-1',
  }),
);
jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: {
    sendEmail: (params: { to: string; subject: string; body: string; threadId?: string }) =>
      mockSendEmail(params),
  },
}));

// Renderer is pure; let the real implementation run so we exercise
// the {therapistFirstName} / {agentFirstName} substitution.
jest.mock('../utils/email-templates', () => ({
  renderTemplate: (tpl: string, vars: Record<string, string>) =>
    tpl.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? `{${k}}`),
}));

jest.mock('../services/therapist-booking-status.service', () => ({
  therapistBookingStatusService: {
    getUnavailableTherapistIds: jest.fn().mockResolvedValue([]),
  },
}));

// LockedTaskRunner's constructor wires into redis-locks → redis-client,
// which opens a real Redis connection on module load. Stub the runner
// entirely — the test calls sendNudges() directly rather than going
// through runSafe()/start(), so the runner is never used.
jest.mock('../utils/locked-task-runner', () => ({
  LockedTaskRunner: class {
    async run() {
      /* unused in this test */
    }
  },
}));

// The nudge service hands its send + transaction to
// runPeriodicTrackedSideEffect with a therapist scope, which wraps it
// in runBackgroundTask (fire-and-forget). For tests we run the task
// synchronously and capture any promise so the test can await it.
const backgroundTaskPromises: Promise<unknown>[] = [];
jest.mock('../utils/background-task', () => ({
  runBackgroundTask: (task: () => Promise<unknown>) => {
    backgroundTaskPromises.push(task());
  },
}));

// Stub the harness's side-effect-log registration. The phase-5 test
// is about the email + conversation rows, not the harness's tracking
// row, so we hand back a "pending" registration that lets execute run.
jest.mock('../services/side-effect-tracker.service', () => {
  const actual = jest.requireActual('../services/side-effect-tracker.service');
  return {
    ...actual,
    sideEffectTrackerService: {
      registerTherapistSideEffects: jest.fn().mockResolvedValue([
        { id: 'log-stub', effectType: 'email_therapist_nudge', idempotencyKey: 'stub-key', status: 'pending' },
      ]),
      markCompleted: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    },
  };
});

import { therapistNudgeService } from '../services/therapist-nudge.service';
import { sideEffectTrackerService } from '../services/side-effect-tracker.service';

function seedTherapist(overrides: Partial<TherapistRow> = {}): TherapistRow {
  const row: TherapistRow = {
    id: 'tx-1',
    name: 'Alex Therapist',
    email: 'alex@example.com',
    lastNudgeAt: null,
    lastNudgeThreadId: null,
    ...overrides,
  };
  therapists[row.id] = row;
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  backgroundTaskPromises.length = 0;
  for (const k of Object.keys(therapists)) delete therapists[k];
  for (const k of Object.keys(conversations)) delete conversations[k];
  nextConvoId = 1;
  appointmentFindMany.mockResolvedValue([]);
  // Default: one eligible therapist, ingested long ago, never nudged.
  // therapistFindMany is called TWICE — first for `active: true`
  // (used to build the active-handle set), second for the actual
  // eligibility query. Configure both calls in order.
  therapistFindMany
    .mockResolvedValueOnce([{ id: 'tx-1', notionId: null }]) // active set
    .mockResolvedValueOnce([
      {
        id: 'tx-1',
        notionId: null,
        name: 'Alex Therapist',
        email: 'alex@example.com',
      },
    ]); // candidates
  mockSendEmail.mockResolvedValue({ threadId: 'thread-nudge-1', messageId: 'msg-nudge-1' });
});

describe('therapistNudgeService — phase 5 conversation-row creation', () => {
  it('opens a fresh nudge_reply TherapistConversation after each successful send', async () => {
    seedTherapist();

    // Call the private sendNudges directly (the public start() wires
    // it through a setTimeout + interval which the test doesn't want
    // to drive).
    await (therapistNudgeService as unknown as { sendNudges: (l: () => boolean) => Promise<void> }).sendNudges(
      () => true,
    );
    // sendNudges hands the send+txn to the harness via runBackgroundTask
    // — drain those background tasks before asserting their side effects.
    await Promise.all(backgroundTaskPromises);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    // Row stamped with thread id + activity timestamp.
    expect(therapists['tx-1'].lastNudgeThreadId).toBe('thread-nudge-1');
    expect(therapists['tx-1'].lastNudgeAt).toBeInstanceOf(Date);

    // New TherapistConversation row created on the same Gmail thread,
    // with kind='nudge_reply' and conversationState seeded with the
    // outbound body so the inbound flow has [assistant, user] context.
    const rows = Object.values(conversations).filter((c) => c.therapistId === 'tx-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('nudge_reply');
    expect(rows[0].status).toBe('active');
    expect(rows[0].gmailThreadId).toBe('thread-nudge-1');
    expect(rows[0].initialMessageId).toBe('msg-nudge-1');

    const state = rows[0].conversationState as { messages: Array<{ role: string; content: string }> };
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('assistant');
    // Body went through the renderer — substituted {therapistFirstName}
    // and {agentFirstName}.
    expect(state.messages[0].content).toContain('Alex');
    expect(state.messages[0].content).toContain('share your availability');
  });

  it('passes claimedAt.getTime() as the cycle generation to the harness', async () => {
    // Pins the contract that protects therapist-nudge from permanent
    // failure: each cron cycle must produce a distinct idempotency
    // key, otherwise a single 5-retry burst that ends in `abandoned`
    // blocks all future cycles for this therapist. The cycle key is
    // the claim timestamp (Date.now() at the moment the inter-tick
    // updateMany claims the sentinel), passed as the third arg to
    // registerTherapistSideEffects. Without this arg the harness
    // hashes a static "therapist:{id}:periodic:{type}" key and the
    // cycle-isolation guarantee disappears silently — TS allows
    // `undefined` for the param, so a regression wouldn't trip the
    // type checker.
    //
    // The harness (in side-effect-harness.ts) imports
    // sideEffectTrackerService from the tracker module. Because the
    // tracker module is mocked at file scope (see the jest.mock
    // factory above), the harness sees that mock object when it calls
    // registerTherapistSideEffects — so we can assert directly on the
    // mock's call history.
    seedTherapist();

    const registerMock =
      sideEffectTrackerService.registerTherapistSideEffects as jest.Mock;

    const beforeRun = Date.now();
    await (therapistNudgeService as unknown as { sendNudges: (l: () => boolean) => Promise<void> }).sendNudges(
      () => true,
    );
    await Promise.all(backgroundTaskPromises);
    const afterRun = Date.now();

    expect(registerMock).toHaveBeenCalledTimes(1);
    const [therapistId, effects, scopeGen] = registerMock.mock.calls[0];
    expect(therapistId).toBe('tx-1');
    expect(effects).toEqual([
      expect.objectContaining({ effectType: 'email_therapist_nudge' }),
    ]);
    expect(typeof scopeGen).toBe('number');
    // The claim happens before the harness's runBackgroundTask fires,
    // so the cycle gen falls in the window between sendNudges entry
    // and the awaited drain returning.
    expect(scopeGen).toBeGreaterThanOrEqual(beforeRun);
    expect(scopeGen).toBeLessThanOrEqual(afterRun);
  });

  it('abandons any prior active nudge_reply row for the therapist when sending a fresh nudge', async () => {
    seedTherapist();
    // Pre-existing active nudge_reply from a previous nudge cycle.
    conversations['old-convo'] = {
      id: 'old-convo',
      therapistId: 'tx-1',
      kind: 'nudge_reply',
      status: 'active',
      gmailThreadId: 'thread-old',
      initialMessageId: 'msg-old',
      conversationState: { messages: [{ role: 'assistant', content: 'old body' }] },
      messageCount: 1,
    };

    await (therapistNudgeService as unknown as { sendNudges: (l: () => boolean) => Promise<void> }).sendNudges(
      () => true,
    );
    await Promise.all(backgroundTaskPromises);

    // Old row was abandoned, not deleted — audit trail preserved.
    expect(conversations['old-convo'].status).toBe('abandoned');

    // The new row is the active one.
    const active = Object.values(conversations).filter(
      (c) => c.therapistId === 'tx-1' && c.status === 'active',
    );
    expect(active).toHaveLength(1);
    expect(active[0].gmailThreadId).toBe('thread-nudge-1');
  });
});

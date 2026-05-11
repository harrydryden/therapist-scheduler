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

import { therapistNudgeService } from '../services/therapist-nudge.service';

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

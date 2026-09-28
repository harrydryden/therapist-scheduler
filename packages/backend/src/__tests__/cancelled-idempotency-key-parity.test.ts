/**
 * Regression test for lifecycle audit L6 — "Slack 'cancelled' is sent twice
 * on every cancellation (key mismatch)".
 *
 * transitionToCancelled pre-registers its side-effect rows inside the
 * transition transaction (register-in-tx). The post-commit dispatch
 * (appointmentNotificationsService.notifyCancelled → side-effect harness →
 * registerSideEffects) must hash EXACTLY the same idempotency key for each
 * effect so it finds and claims the in-tx row. For slack_notify_cancelled the
 * in-tx registration omitted the transition generation while notifyCancelled
 * passed it, so the post-commit path created and completed its own row, the
 * in-tx row stayed `pending`, and the retry runner posted a second
 * "Appointment cancelled" Slack message ~10 minutes later.
 *
 * Unlike register-in-tx-cancelled-completed.test.ts (which mocks the
 * notifications service and only inspects the in-tx rows), this drives the
 * REAL notifyCancelled + harness + tracker and compares the keys the two
 * writers actually produce.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config', () => ({
  config: { jwtSecret: 'test', frontendUrl: 'https://test', backendUrl: 'https://test' },
}));
jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  cacheManager: { getString: jest.fn(), set: jest.fn() },
}));
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: jest.fn(),
    notifyAppointmentCancelled: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    onCancelled: jest.fn().mockResolvedValue(undefined),
    notifyTransition: jest.fn(),
  },
}));
jest.mock('../services/ai-conversation.service', () => ({ aiConversationService: {} }));
jest.mock('../services/audit-event.service', () => ({
  auditEventService: { logAdminAction: jest.fn(), log: jest.fn() },
}));
jest.mock('../services/appointment-event.service', () => ({
  appointmentEventService: { emit: jest.fn() },
}));
// All notification toggles fall back to their defaults (enabled).
jest.mock('../services/settings.service', () => ({
  getSettingValues: jest.fn().mockResolvedValue(new Map()),
  getSettingValue: jest.fn(),
}));
jest.mock('../core/email', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/transition-email-renderers', () => ({
  renderClientConfirmationEmail: jest.fn(),
  renderTherapistConfirmationEmail: jest.fn(),
  renderClientCancellationEmail: jest.fn().mockResolvedValue({ to: 'alex@example.com', subject: 's', body: 'b' }),
  renderTherapistCancellationEmail: jest.fn().mockResolvedValue({ to: 't@example.com', subject: 's', body: 'b' }),
}));

// Run each background task immediately and keep a handle so the test can
// await the whole post-commit chain.
const backgroundTasks: Promise<unknown>[] = [];
jest.mock('../utils/background-task', () => ({
  runBackgroundTask: (task: () => Promise<unknown>) => {
    backgroundTasks.push(task().catch(() => undefined));
  },
}));

/** effectType → key, as written by the in-tx upsert. */
const inTxKeys = new Map<string, string>();
/** Keys looked up by the post-commit registerSideEffects call. */
const postCommitLookups: string[] = [];

const CANCELLED_ROW = {
  id: 'apt-1',
  status: 'confirmed',
  user_name: 'Alex',
  user_email: 'alex@example.com',
  therapist_name: 'Dr. T',
  therapist_email: 't@example.com',
  therapist_handle: 'dr-t',
  human_control_enabled: false,
  notes: null,
  confirmed_date_time: '2026-06-01T10:00:00Z',
  confirmed_date_time_parsed: new Date('2026-06-01T10:00:00Z'),
  gmail_thread_id: 'thread-c',
  therapist_gmail_thread_id: 'thread-t',
  transition_generation: 6,
};

const tx = {
  $queryRaw: jest.fn().mockResolvedValue([CANCELLED_ROW]),
  appointmentRequest: { update: jest.fn().mockResolvedValue({ id: 'apt-1' }) },
  appointmentAuditEvent: { create: jest.fn().mockResolvedValue(undefined) },
  sideEffectLog: {
    upsert: jest.fn(async (args: { create: { effectType: string; idempotencyKey: string } }) => {
      inTxKeys.set(args.create.effectType, args.create.idempotencyKey);
      return { id: `row-${args.create.effectType}`, ...args.create, status: 'pending' };
    }),
  },
};

jest.mock('../utils/database', () => ({
  prisma: {
    $transaction: jest.fn(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (t: unknown) => unknown)(tx) : [],
    ),
    $executeRaw: jest.fn().mockResolvedValue(0),
    sideEffectLog: {
      findUnique: jest.fn(async (args: { where: { idempotencyKey: string } }) => {
        postCommitLookups.push(args.where.idempotencyKey);
        // Behave like the real table: a key written in-tx is found.
        const found = [...inTxKeys.entries()].find(([, key]) => key === args.where.idempotencyKey);
        return found ? { id: `row-${found[0]}`, status: 'pending' } : null;
      }),
      create: jest.fn(async (args: { data: { effectType: string } }) => ({
        id: `dup-${args.data.effectType}`,
        status: 'pending',
      })),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

import { prisma } from '../utils/database';
import { slackNotificationService } from '../services/slack-notification.service';
import { transitionToCancelled } from '../domain/scheduling/lifecycle/transitions/cancelled';

async function flushPostCommitDispatch(): Promise<void> {
  // notifyCancelled is fire-and-forget: let its settings await resolve and
  // its background tasks get scheduled, then await those tasks.
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(backgroundTasks);
}

describe('transitionToCancelled — in-tx and post-commit idempotency keys match (L6)', () => {
  beforeAll(async () => {
    await transitionToCancelled({
      appointmentId: 'apt-1',
      reason: 'Client asked to cancel',
      cancelledBy: 'client',
      source: 'admin',
      adminId: 'admin-7',
    });
    await flushPostCommitDispatch();
  });

  it.each(['slack_notify_cancelled', 'email_client_cancellation', 'email_therapist_cancellation'])(
    '%s: notifyCancelled looks up the exact key registered in the transaction',
    (effectType) => {
      const inTxKey = inTxKeys.get(effectType);
      expect(inTxKey).toBeDefined();
      expect(postCommitLookups).toContain(inTxKey);
    },
  );

  it('the post-commit path never creates a second (duplicate) row', () => {
    expect(prisma.sideEffectLog.create).not.toHaveBeenCalled();
  });

  it('the Slack notification is sent exactly once, via the in-tx row', () => {
    expect(slackNotificationService.notifyAppointmentCancelled).toHaveBeenCalledTimes(1);
    // markCompleted is a lease-checked updateMany.
    const completedKeys = (prisma.sideEffectLog.updateMany as jest.Mock).mock.calls
      .filter(([args]) => args.data.status === 'completed')
      .map(([args]) => args.where.idempotencyKey);
    // The in-tx row is the one marked completed, so the retry runner has
    // nothing left pending to re-send.
    expect(completedKeys).toContain(inTxKeys.get('slack_notify_cancelled'));
  });
});

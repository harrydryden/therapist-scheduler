/**
 * Pins the register-in-tx wiring in cancelled.ts / completed.ts (see
 * docs/agent-harness-review/register-in-tx-design.md) — which side-effect
 * intent rows get pre-registered atomically with the status commit, under
 * which settings/skipNotifications scenarios, and with or without a
 * `transitionGeneration` in the idempotency-key inputs. Getting the
 * generation-or-not choice wrong per effect type would create a duplicate
 * row instead of the post-commit dispatch code finding this one (see the
 * design doc §6 table) — these tests exist specifically to catch that.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config', () => ({
  config: { jwtSecret: 'test', frontendUrl: 'https://test', backendUrl: 'https://test' },
}));
jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn(), getStrict: jest.fn(), set: jest.fn(), del: jest.fn() },
}));
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: jest.fn(),
    notifyAppointmentCancelled: jest.fn(),
    notifyAppointmentCompleted: jest.fn(),
  },
}));
jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    onCancelled: jest.fn().mockResolvedValue(undefined),
    onCompleted: jest.fn().mockResolvedValue(undefined),
    notifyTransition: jest.fn(),
  },
}));
jest.mock('../services/ai-conversation.service', () => ({
  aiConversationService: {},
}));
jest.mock('../services/audit-event.service', () => ({
  auditEventService: { logAdminAction: jest.fn() },
}));
jest.mock('../services/appointment-event.service', () => ({
  appointmentEventService: { emit: jest.fn() },
}));

const getNotificationSettingsMock = jest.fn();
jest.mock('../services/appointment-notifications.service', () => ({
  appointmentNotificationsService: {
    notifyCancelled: jest.fn().mockResolvedValue(undefined),
    notifyCompleted: jest.fn().mockResolvedValue(undefined),
    getNotificationSettings: (...args: unknown[]) => getNotificationSettingsMock(...args),
  },
}));

const ALL_ENABLED = {
  slack: { requested: true, confirmed: true, completed: true, cancelled: true, escalation: true },
  email: {
    clientConfirmation: true,
    therapistConfirmation: true,
    sessionReminder: true,
    feedbackForm: true,
    clientCancellation: true,
    therapistCancellation: true,
  },
};

interface CapturedCreate {
  data: {
    appointmentId: string;
    effectType: string;
    transition: string;
    idempotencyKey: string;
    payload?: unknown;
  };
}

let captured: CapturedCreate[] = [];
// registerInTransaction upserts rather than creates, so the intent row lives
// under `create` on the upsert args. Normalised back to `{ data }` here so the
// per-effect-type and idempotency-key assertions below read unchanged.
const sideEffectUpsertMock = jest
  .fn()
  .mockImplementation(async (args: { where: unknown; create: CapturedCreate['data'] }) => {
    captured.push({ data: args.create });
    return { id: `row-${captured.length}`, ...args.create, status: 'pending' };
  });
const sideEffectFindUniqueMock = jest.fn().mockResolvedValue(null);

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
  transition_generation: 1,
};

const COMPLETED_ROW = {
  id: 'apt-1',
  status: 'session_held',
  user_name: 'Alex',
  user_email: 'alex@example.com',
  therapist_name: 'Dr. T',
  therapist_handle: 'dr-t',
  notes: null,
  transition_generation: 1,
};

const mockTransaction = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

import { transitionToCancelled } from '../domain/scheduling/lifecycle/transitions/cancelled';
import { transitionToCompleted } from '../domain/scheduling/lifecycle/transitions/completed';
import { appointmentNotificationsService } from '../services/appointment-notifications.service';
import { sideEffectTrackerService } from '../services/side-effect-tracker.service';

beforeEach(() => {
  jest.clearAllMocks();
  captured = [];
  sideEffectFindUniqueMock.mockResolvedValue(null);
  getNotificationSettingsMock.mockResolvedValue(ALL_ENABLED);
});

function makeTx(row: Record<string, unknown>) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([row]),
    appointmentRequest: {
      update: jest.fn().mockResolvedValue({ id: 'apt-1' }),
    },
    appointmentAuditEvent: {
      create: jest.fn().mockResolvedValue(undefined),
    },
    sideEffectLog: {
      upsert: (...args: unknown[]) =>
        sideEffectUpsertMock(...(args as [{ where: unknown; create: CapturedCreate['data'] }])),
      findUnique: (...args: unknown[]) => sideEffectFindUniqueMock(...args),
    },
  };
}

function effectTypesRegistered(): string[] {
  return captured.map((c) => c.data.effectType).sort();
}

describe('transitionToCancelled — register-in-tx intent registration', () => {
  beforeEach(() => {
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback(makeTx(CANCELLED_ROW)),
    );
  });

  it('registers all four rows when settings are enabled and the therapist thread exists', async () => {
    await transitionToCancelled({
      appointmentId: 'apt-1',
      reason: 'Test',
      cancelledBy: 'therapist',
      source: 'admin',
      adminId: 'admin-7',
    });

    expect(effectTypesRegistered()).toEqual([
      'email_client_cancellation',
      'email_therapist_cancellation',
      'slack_notify_cancelled',
      'therapist_unfreeze_sync',
    ]);
  });

  it('registers only therapist_unfreeze_sync when skipNotifications is true', async () => {
    await transitionToCancelled({
      appointmentId: 'apt-1',
      reason: 'Bounced',
      cancelledBy: 'system',
      source: 'system',
      skipNotifications: true,
    });

    expect(effectTypesRegistered()).toEqual(['therapist_unfreeze_sync']);
    // getNotificationSettings shouldn't even be fetched when notifications
    // are skipped entirely.
    expect(getNotificationSettingsMock).not.toHaveBeenCalled();
  });

  it('skips the therapist cancellation email when there is no therapist Gmail thread', async () => {
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback(makeTx({ ...CANCELLED_ROW, therapist_gmail_thread_id: null })),
    );

    await transitionToCancelled({
      appointmentId: 'apt-1',
      reason: 'Test',
      cancelledBy: 'admin',
      source: 'admin',
      adminId: 'admin-7',
    });

    expect(effectTypesRegistered()).toEqual([
      'email_client_cancellation',
      'slack_notify_cancelled',
      'therapist_unfreeze_sync',
    ]);
  });

  it('keys slack + both emails WITH the post-update generation (matching notifyCancelled) and unfreeze WITHOUT one', async () => {
    await transitionToCancelled({
      appointmentId: 'apt-1',
      reason: 'Test',
      cancelledBy: 'client',
      source: 'admin',
      adminId: 'admin-7',
    });

    // The post-commit writer is notifyCancelled, which hashes every one of
    // its three effects with the generation it is handed. Pin both halves:
    // what the in-tx rows were keyed with, and what notifyCancelled was
    // handed — they must be the same generation or the post-commit path
    // creates a duplicate row and the in-tx one is re-sent by the retry
    // runner (lifecycle audit L6: a second Slack "cancelled" message).
    const postUpdateGeneration = CANCELLED_ROW.transition_generation + 1;
    expect(appointmentNotificationsService.notifyCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ transitionGeneration: postUpdateGeneration }),
    );
    const keyFor = (effectType: string, generation?: number) =>
      (sideEffectTrackerService as unknown as {
        generateIdempotencyKey: (a: string, t: string, e: string, g?: number) => string;
      }).generateIdempotencyKey('apt-1', 'cancelled', effectType, generation);
    const keys = new Map(captured.map((c) => [c.data.effectType, c.data.idempotencyKey]));
    expect(keys.get('slack_notify_cancelled')).toBe(keyFor('slack_notify_cancelled', postUpdateGeneration));
    expect(keys.get('email_client_cancellation')).toBe(keyFor('email_client_cancellation', postUpdateGeneration));
    expect(keys.get('email_therapist_cancellation')).toBe(keyFor('email_therapist_cancellation', postUpdateGeneration));
    // transitionSideEffectsService.onCancelled registers unfreeze without a generation.
    expect(keys.get('therapist_unfreeze_sync')).toBe(keyFor('therapist_unfreeze_sync'));
  });

  it('attaches the {cancelledBy, reason} render context only to the two email rows', async () => {
    await transitionToCancelled({
      appointmentId: 'apt-1',
      reason: 'Test',
      cancelledBy: 'client',
      source: 'admin',
      adminId: 'admin-7',
    });

    // Key derivation is pinned by the previous test. Here: only the
    // cancellation emails carry the {cancelledBy, reason} render context;
    // slack/unfreeze carry no payload at all.
    const byType = new Map(captured.map((c) => [c.data.effectType, c.data]));
    expect(byType.get('email_client_cancellation')?.payload).toEqual({
      cancelledBy: 'client',
      reason: 'Test',
    });
    expect(byType.get('email_therapist_cancellation')?.payload).toEqual({
      cancelledBy: 'client',
      reason: 'Test',
    });
    expect(byType.get('slack_notify_cancelled')?.payload).toBeUndefined();
    expect(byType.get('therapist_unfreeze_sync')?.payload).toBeUndefined();
  });

  it('registers nothing when the therapist has no handle and notifications are skipped', async () => {
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback(makeTx({ ...CANCELLED_ROW, therapist_handle: null })),
    );

    await transitionToCancelled({
      appointmentId: 'apt-1',
      reason: 'Test',
      cancelledBy: 'system',
      source: 'system',
      skipNotifications: true,
    });

    expect(captured).toHaveLength(0);
  });
});

describe('transitionToCompleted — register-in-tx intent registration', () => {
  beforeEach(() => {
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback(makeTx(COMPLETED_ROW)),
    );
  });

  it('registers slack_notify_completed + therapist_unfreeze_sync when the setting is enabled', async () => {
    await transitionToCompleted({ appointmentId: 'apt-1', source: 'system' });

    expect(effectTypesRegistered()).toEqual(['slack_notify_completed', 'therapist_unfreeze_sync']);
  });

  it('still registers slack_notify_completed when the setting is off but feedback is attached', async () => {
    getNotificationSettingsMock.mockResolvedValue({
      ...ALL_ENABLED,
      slack: { ...ALL_ENABLED.slack, completed: false },
    });

    await transitionToCompleted({
      appointmentId: 'apt-1',
      source: 'system',
      feedbackSubmissionId: 'fb-1',
    });

    expect(effectTypesRegistered()).toEqual(['slack_notify_completed', 'therapist_unfreeze_sync']);
  });

  it('does not register slack_notify_completed when the setting is off and no feedback is attached', async () => {
    getNotificationSettingsMock.mockResolvedValue({
      ...ALL_ENABLED,
      slack: { ...ALL_ENABLED.slack, completed: false },
    });

    await transitionToCompleted({ appointmentId: 'apt-1', source: 'system' });

    expect(effectTypesRegistered()).toEqual(['therapist_unfreeze_sync']);
  });
});

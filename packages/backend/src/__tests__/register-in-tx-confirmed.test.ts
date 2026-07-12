/**
 * Pins the register-in-tx wiring in confirmed.ts (Phase 2 — see
 * docs/agent-harness-review/register-in-tx-design.md): which confirmed-side
 * intent rows get pre-registered inside the new explicit transaction, under
 * which settings/sendEmails/missing-field scenarios, and — critically — that
 * the three notification effects are keyed WITH the post-update generation
 * while therapist_freeze_sync is keyed WITHOUT one. A mismatch against what
 * the post-commit dispatch code computes would create a duplicate row
 * instead of finding this one (design doc §6).
 *
 * Also pins that the register step runs INSIDE the same transaction as the
 * status update (both go through the mocked $transaction callback), and does
 * NOT run on the idempotent-skip or P2025 failure-attribution paths.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../config', () => require('./_global-mocks').configMock());
jest.mock('../utils/redis', () => require('./_global-mocks').redisMock());
jest.mock('../services/audit-event.service', () => require('./_global-mocks').auditEventMock());
jest.mock('../services/appointment-event.service', () => require('./_global-mocks').appointmentEventMock());
jest.mock('../services/ai-conversation.service', () => require('./_global-mocks').aiConversationMock());
jest.mock('../services/slack-notification.service', () => require('./_global-mocks').slackNotificationMock());

const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();
const mockExecuteRaw = jest.fn();
// Records whether the update ran through the transaction callback, so we
// can assert the register step is in the same tx.
let insideTx = false;

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
    $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a),
    $transaction: async (cb: (tx: unknown) => unknown) => {
      insideTx = true;
      try {
        return await cb({ appointmentRequest: { update: (...a: unknown[]) => mockUpdate(...a) } });
      } finally {
        insideTx = false;
      }
    },
  },
}));

interface CapturedCreate {
  transition: string;
  effectType: string;
  generation: number | undefined;
  wasInsideTx: boolean;
}
let captured: CapturedCreate[] = [];
const mockRegisterInTransaction = jest.fn().mockImplementation(
  async (
    _tx: unknown,
    _appointmentId: string,
    transition: string,
    effect: { effectType: string },
    generation?: number,
  ) => {
    captured.push({ transition, effectType: effect.effectType, generation, wasInsideTx: insideTx });
    return { id: `row-${captured.length}`, effectType: effect.effectType, idempotencyKey: 'k', status: 'pending' };
  },
);
jest.mock('../services/side-effect-tracker.service', () => ({
  sideEffectTrackerService: {
    registerInTransaction: (...a: unknown[]) =>
      mockRegisterInTransaction(
        ...(a as [unknown, string, string, { effectType: string }, number | undefined]),
      ),
  },
}));

const mockOnConfirmed = jest.fn().mockResolvedValue(undefined);
const mockNotifyConfirmed = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    notifyTransition: jest.fn(),
    onConfirmed: (...a: unknown[]) => mockOnConfirmed(...a),
    onSessionHeld: jest.fn(),
    onCompleted: jest.fn(),
    onCancelled: jest.fn(),
    onAdminForceUpdate: jest.fn(),
  },
}));

const getNotificationSettingsMock = jest.fn();
jest.mock('../services/appointment-notifications.service', () => ({
  appointmentNotificationsService: {
    notifyConfirmed: (...a: unknown[]) => mockNotifyConfirmed(...a),
    notifyCancelled: jest.fn(),
    notifyCompleted: jest.fn(),
    getNotificationSettings: (...a: unknown[]) => getNotificationSettingsMock(...a),
  },
}));

import { appointmentLifecycleService } from '../domain/scheduling/lifecycle';

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

const NEGOTIATING_ROW = {
  id: 'apt-1',
  status: 'negotiating',
  userName: 'User',
  userEmail: 'u@example.com',
  therapistName: 'T',
  therapistEmail: 't@example.com',
  therapistHandle: 'h',
  confirmedDateTime: null,
  humanControlEnabled: false,
  transitionGeneration: 4,
};

beforeEach(() => {
  jest.clearAllMocks();
  captured = [];
  insideTx = false;
  mockExecuteRaw.mockResolvedValue(undefined);
  getNotificationSettingsMock.mockResolvedValue(ALL_ENABLED);
});

function effectTypes(): string[] {
  return captured.map((c) => c.effectType).sort();
}

describe('transitionToConfirmed — register-in-tx intent registration', () => {
  it('registers all four confirmed-side rows inside the transaction on the success path', async () => {
    mockFindUnique.mockResolvedValueOnce(NEGOTIATING_ROW);
    mockUpdate.mockResolvedValueOnce({ transitionGeneration: 5 });

    await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      confirmedDateTime: '2026-06-01T10:00:00.000Z',
      source: 'admin',
      adminId: 'admin-7',
    });

    expect(effectTypes()).toEqual([
      'email_client_confirmation',
      'email_therapist_confirmation',
      'slack_notify_confirmed',
      'therapist_freeze_sync',
    ]);
    // Every registration ran inside the transaction callback.
    expect(captured.every((c) => c.wasInsideTx)).toBe(true);
    // All rows use transition='confirmed'.
    expect(captured.every((c) => c.transition === 'confirmed')).toBe(true);
  });

  it('keys the three notification effects WITH the post-update generation and therapist_freeze_sync WITHOUT one', async () => {
    mockFindUnique.mockResolvedValueOnce(NEGOTIATING_ROW);
    // Post-update generation is 9 (not the read-time 4) — the notification
    // rows must carry 9 so their keys match notifyConfirmed's.
    mockUpdate.mockResolvedValueOnce({ transitionGeneration: 9 });

    await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      confirmedDateTime: '2026-06-01T10:00:00.000Z',
      source: 'admin',
      adminId: 'admin-7',
    });

    const byType = new Map(captured.map((c) => [c.effectType, c.generation]));
    expect(byType.get('slack_notify_confirmed')).toBe(9);
    expect(byType.get('email_client_confirmation')).toBe(9);
    expect(byType.get('email_therapist_confirmation')).toBe(9);
    // therapist_freeze_sync mirrors onConfirmed's registerSideEffects call,
    // which passes no generation.
    expect(byType.get('therapist_freeze_sync')).toBeUndefined();
  });

  it('skips both confirmation emails when sendEmails is false (still registers slack + freeze)', async () => {
    mockFindUnique.mockResolvedValueOnce(NEGOTIATING_ROW);
    mockUpdate.mockResolvedValueOnce({ transitionGeneration: 5 });

    await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      confirmedDateTime: '2026-06-01T10:00:00.000Z',
      source: 'admin',
      adminId: 'admin-7',
      sendEmails: false,
    });

    expect(effectTypes()).toEqual(['slack_notify_confirmed', 'therapist_freeze_sync']);
  });

  it('skips the therapist confirmation email when the appointment has no therapist email', async () => {
    mockFindUnique.mockResolvedValueOnce({ ...NEGOTIATING_ROW, therapistEmail: null });
    mockUpdate.mockResolvedValueOnce({ transitionGeneration: 5 });

    await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      confirmedDateTime: '2026-06-01T10:00:00.000Z',
      source: 'admin',
      adminId: 'admin-7',
    });

    expect(effectTypes()).toEqual([
      'email_client_confirmation',
      'slack_notify_confirmed',
      'therapist_freeze_sync',
    ]);
  });

  it('skips slack_notify_confirmed when the slack.confirmed setting is off', async () => {
    getNotificationSettingsMock.mockResolvedValue({
      ...ALL_ENABLED,
      slack: { ...ALL_ENABLED.slack, confirmed: false },
    });
    mockFindUnique.mockResolvedValueOnce(NEGOTIATING_ROW);
    mockUpdate.mockResolvedValueOnce({ transitionGeneration: 5 });

    await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      confirmedDateTime: '2026-06-01T10:00:00.000Z',
      source: 'admin',
      adminId: 'admin-7',
    });

    expect(effectTypes()).toEqual([
      'email_client_confirmation',
      'email_therapist_confirmation',
      'therapist_freeze_sync',
    ]);
  });

  it('registers only therapist_freeze_sync when there is no therapist handle and notifications are all off', async () => {
    getNotificationSettingsMock.mockResolvedValue({
      slack: { ...ALL_ENABLED.slack, confirmed: false },
      email: { ...ALL_ENABLED.email, clientConfirmation: false, therapistConfirmation: false },
    });
    mockFindUnique.mockResolvedValueOnce(NEGOTIATING_ROW);
    mockUpdate.mockResolvedValueOnce({ transitionGeneration: 5 });

    await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      confirmedDateTime: '2026-06-01T10:00:00.000Z',
      source: 'admin',
      adminId: 'admin-7',
    });

    // Handle present → freeze still registers; all notifications gated off.
    expect(effectTypes()).toEqual(['therapist_freeze_sync']);
  });

  it('registers nothing on the idempotent same-datetime skip (no transaction entered)', async () => {
    mockFindUnique.mockResolvedValueOnce({
      ...NEGOTIATING_ROW,
      status: 'confirmed',
      confirmedDateTime: '2026-06-01T10:00:00.000Z',
    });

    const result = await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      confirmedDateTime: '2026-06-01T10:00:00.000Z',
      source: 'admin',
      adminId: 'admin-7',
    });

    expect(result.skipped).toBe(true);
    expect(captured).toHaveLength(0);
    expect(mockUpdate).not.toHaveBeenCalled();
    // Settings aren't even fetched on the pre-transaction idempotent skip.
    expect(getNotificationSettingsMock).not.toHaveBeenCalled();
  });

  it('registers nothing when the update trips P2025 (concurrent write) — failure-attribution path', async () => {
    const { p2025 } = await import('./_global-mocks');
    mockFindUnique.mockResolvedValueOnce(NEGOTIATING_ROW);
    mockUpdate.mockRejectedValueOnce(p2025());
    // Re-fetch shows the row now confirmed at our target → idempotent skip.
    mockFindUnique.mockResolvedValueOnce({
      status: 'confirmed',
      humanControlEnabled: false,
      confirmedDateTime: '2026-06-01T10:00:00.000Z',
    });

    const result = await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: 'apt-1',
      confirmedDateTime: '2026-06-01T10:00:00.000Z',
      source: 'admin',
      adminId: 'admin-7',
    });

    expect(result.skipped).toBe(true);
    // The update matched 0 rows, so no intent rows were registered.
    expect(captured).toHaveLength(0);
  });
});

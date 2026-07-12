/**
 * Unit tests for `notifyCancelled` template-selection branching.
 *
 * Verifies that for a given `cancelledBy` value the correct email
 * template key is requested for each party. This is the contract
 * the user spec hangs on:
 *   - therapist-initiated → client gets the apology+voucher template,
 *     therapist gets the neutral template.
 *   - client-initiated → therapist gets the apology+reassurance
 *     template, client gets the neutral template.
 *   - admin / system → both parties get the neutral templates
 *     (preserves the pre-change behaviour for callers that don't
 *     attribute the cancellation).
 *
 * Mocks `loadEmailTemplate` (captures the requested template key),
 * `runReplayableTrackedSideEffect` (invokes the supplied
 * renderPayload immediately so the captures land), and the voucher
 * helpers (the test doesn't care about URL contents).
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { jwtSecret: 'test', frontendUrl: 'https://test.example.com', backendUrl: 'https://test.example.com' },
}));

jest.mock('../utils/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

// loadEmailTemplate is the assertion target. Returns a deterministic
// subject/body so the rest of the flow doesn't fail downstream.
const mockLoadEmailTemplate = jest.fn();
jest.mock('../utils/email-templates', () => ({
  loadEmailTemplate: (templateKey: string, ...rest: unknown[]) =>
    mockLoadEmailTemplate(templateKey, ...rest),
}));

// Capture renderPayload + execute so we can drive the email build
// to completion (and thus the loadEmailTemplate call).
//
// The real `runReplayableTrackedSideEffect` is fire-and-forget —
// the caller doesn't await. Tracking pending promises here so the
// test can flush them before asserting, otherwise the async
// loadEmailTemplate calls don't land in time.
const pendingSideEffects: Promise<void>[] = [];
const mockReplayableSideEffect = jest.fn();
const mockTrackedSideEffect = jest.fn();
jest.mock('../services/side-effect-harness', () => ({
  runReplayableTrackedSideEffect: (...args: unknown[]) =>
    mockReplayableSideEffect(...args),
  runTrackedSideEffect: (...args: unknown[]) => mockTrackedSideEffect(...args),
}));

async function flushPendingSideEffects(): Promise<void> {
  while (pendingSideEffects.length > 0) {
    const batch = pendingSideEffects.splice(0);
    await Promise.all(batch);
  }
}

jest.mock('../core/email', () => ({
  sendEmail: jest.fn().mockResolvedValue({ messageId: 'm1', threadId: 't1' }),
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: jest.fn(),
    notifyAppointmentCancelled: jest.fn(),
    notifyAppointmentConfirmed: jest.fn(),
    notifyAppointmentCompleted: jest.fn(),
  },
}));

// Notification-settings: enable both client + therapist cancellation
// emails so the branching code runs end-to-end.
const mockGetSettingValues = jest.fn();
jest.mock('../services/settings.service', () => ({
  getSettingValues: (...args: unknown[]) => mockGetSettingValues(...args),
  getSettingValue: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/date', () => ({
  formatEmailDateFromSettings: jest.fn().mockResolvedValue('Monday 1 June at 10:00'),
}));

jest.mock('../core/timezone', () => ({
  resolveRecipientTimezone: jest.fn().mockResolvedValue('Europe/London'),
}));

const mockEnsureVoucherUrl = jest.fn();
const mockResolveBookingUrl = jest.fn();
jest.mock('../services/voucher-url.service', () => ({
  ensureVoucherUrlForUser: (...args: unknown[]) => mockEnsureVoucherUrl(...args),
  resolveBookingUrl: (...args: unknown[]) => mockResolveBookingUrl(...args),
}));

import { appointmentNotificationsService } from '../services/appointment-notifications.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSettingValues.mockResolvedValue(
    new Map(
      Object.entries({
        'notifications.slack.cancelled': true,
        'notifications.email.clientCancellation': true,
        'notifications.email.therapistCancellation': true,
      }),
    ),
  );
  mockLoadEmailTemplate.mockResolvedValue({ subject: 'Subj', body: 'Body' });
  mockEnsureVoucherUrl.mockResolvedValue('https://book.example.com?voucher=xxx');
  mockResolveBookingUrl.mockResolvedValue('https://fallback.example.com');

  // Replayable side effect: invoke the renderPayload + execute,
  // tracking the promise so the test can flush before asserting.
  // The real helper is fire-and-forget; without tracking, the
  // async loadEmailTemplate calls don't land in time.
  pendingSideEffects.length = 0;
  mockReplayableSideEffect.mockImplementation(
    (
      _appointmentId: string,
      _phase: string,
      _key: string,
      handlers: { renderPayload: () => Promise<unknown>; execute: (p: unknown) => Promise<void> },
    ) => {
      const promise = (async () => {
        const payload = await handlers.renderPayload();
        await handlers.execute(payload);
      })();
      pendingSideEffects.push(promise);
    },
  );
});

async function runAndFlush(
  params: Parameters<typeof appointmentNotificationsService.notifyCancelled>[0],
): Promise<void> {
  await appointmentNotificationsService.notifyCancelled(params);
  await flushPendingSideEffects();
}

function baseParams(
  overrides: Partial<Parameters<typeof appointmentNotificationsService.notifyCancelled>[0]> = {},
) {
  return {
    appointmentId: 'apt-1',
    source: 'admin' as const,
    adminId: 'admin-1',
    cancelledBy: 'admin' as const,
    reason: 'Test reason',
    userName: 'Alex Client',
    userEmail: 'alex@example.com',
    therapistName: 'Dr. Therapist',
    therapistEmail: 'dr@example.com',
    confirmedDateTime: '2026-06-01T10:00:00Z',
    confirmedDateTimeParsed: new Date('2026-06-01T10:00:00Z'),
    gmailThreadId: 'thread-client',
    therapistGmailThreadId: 'thread-therapist',
    transitionGeneration: 1,
    ...overrides,
  };
}

describe('notifyCancelled — template selection by cancelledBy', () => {
  it("cancelledBy='therapist' uses the apology+voucher template for the client", async () => {
    await runAndFlush(
      baseParams({ cancelledBy: 'therapist' }),
    );
    const clientCall = mockLoadEmailTemplate.mock.calls.find((c) =>
      String(c[0]).startsWith('clientCancellation'),
    );
    expect(clientCall?.[0]).toBe('clientCancellationByTherapist');
    // {voucherLine} should always render as a markdown link so the
    // HTML conversion downstream produces a clickable anchor.
    const bodyVars = clientCall?.[2] as Record<string, string>;
    expect(bodyVars.voucherLine).toMatch(/^\[.*\]\(https:\/\/.*\)$/);
  });

  it("cancelledBy='therapist' uses the neutral template for the therapist", async () => {
    await runAndFlush(
      baseParams({ cancelledBy: 'therapist' }),
    );
    const therapistCall = mockLoadEmailTemplate.mock.calls.find((c) =>
      String(c[0]).startsWith('therapistCancellation'),
    );
    expect(therapistCall?.[0]).toBe('therapistCancellation');
  });

  it("cancelledBy='client' uses the apology+reassurance template for the therapist", async () => {
    await runAndFlush(
      baseParams({ cancelledBy: 'client' }),
    );
    const therapistCall = mockLoadEmailTemplate.mock.calls.find((c) =>
      String(c[0]).startsWith('therapistCancellation'),
    );
    expect(therapistCall?.[0]).toBe('therapistCancellationByClient');
  });

  it("cancelledBy='client' uses the neutral template for the client", async () => {
    await runAndFlush(
      baseParams({ cancelledBy: 'client' }),
    );
    const clientCall = mockLoadEmailTemplate.mock.calls.find((c) =>
      String(c[0]).startsWith('clientCancellation'),
    );
    expect(clientCall?.[0]).toBe('clientCancellation');
  });

  it("cancelledBy='admin' uses the neutral templates for both parties", async () => {
    await runAndFlush(
      baseParams({ cancelledBy: 'admin' }),
    );
    expect(mockLoadEmailTemplate).toHaveBeenCalledWith(
      'clientCancellation',
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockLoadEmailTemplate).toHaveBeenCalledWith(
      'therapistCancellation',
      expect.any(Object),
      expect.any(Object),
    );
    const apologyCalls = mockLoadEmailTemplate.mock.calls.filter((c) =>
      String(c[0]).endsWith('ByTherapist') || String(c[0]).endsWith('ByClient'),
    );
    expect(apologyCalls).toHaveLength(0);
  });

  it("cancelledBy='system' uses the neutral templates for both parties", async () => {
    await runAndFlush(
      baseParams({ cancelledBy: 'system', source: 'system' }),
    );
    const apologyCalls = mockLoadEmailTemplate.mock.calls.filter((c) =>
      String(c[0]).endsWith('ByTherapist') || String(c[0]).endsWith('ByClient'),
    );
    expect(apologyCalls).toHaveLength(0);
  });

  it('therapist-initiated falls back to the booking URL when voucher issuance returns null', async () => {
    mockEnsureVoucherUrl.mockResolvedValue(null);
    await runAndFlush(
      baseParams({ cancelledBy: 'therapist' }),
    );
    const clientCall = mockLoadEmailTemplate.mock.calls.find((c) =>
      String(c[0]).startsWith('clientCancellation'),
    );
    const bodyVars = clientCall?.[2] as Record<string, string>;
    expect(bodyVars.voucherLine).toContain('https://fallback.example.com');
    expect(bodyVars.voucherLine).toMatch(/^\[.*\]\(https:\/\/.*\)$/);
  });

  it('therapist email is skipped when no therapistGmailThreadId exists', async () => {
    // Pre-existing guard: don't surface a cancellation to a
    // therapist we never reached out to.
    await runAndFlush(
      baseParams({ cancelledBy: 'admin', therapistGmailThreadId: null }),
    );
    const therapistCalls = mockLoadEmailTemplate.mock.calls.filter((c) =>
      String(c[0]).startsWith('therapistCancellation'),
    );
    expect(therapistCalls).toHaveLength(0);
  });
});

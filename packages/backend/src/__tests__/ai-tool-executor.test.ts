/**
 * Tests for the agent's tool executor — the dispatch layer between
 * Claude's tool_use blocks and the system actions they trigger.
 *
 * This is the security-critical surface where the C2/C3/M1 fixes
 * landed. The tests pin those gates directly rather than only via the
 * lifecycle integration paths:
 *
 *   - Human-control TOCTOU lock (H1): every tool checks humanControlEnabled
 *     atomically; if it's true, the call is skipped.
 *   - C2 — `issue_voucher_code` ignores any email argument and uses
 *     context.userEmail. Prompt-injection can't redirect vouchers.
 *   - C3 — `update_therapist_availability` is rejected unless the
 *     inbound email was from the therapist.
 *   - M1 — per-appointment tool-call ceiling. Above the limit, all
 *     subsequent calls are skipped + the appointment is flipped into
 *     human control.
 *   - send_email recipient validation: only the appointment's user
 *     and therapist addresses are accepted.
 *   - Per-call idempotency: same (appointment, tool, input) hash within
 *     the TTL is skipped.
 *
 * What we deliberately don't test here: the downstream lifecycle
 * service calls (markComplete, cancelAppointment, initiateReschedule).
 * Those have dedicated tests; here we just verify the dispatch.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../config', () => require('./_global-mocks').configMock());
jest.mock('../services/audit-event.service', () => require('./_global-mocks').auditEventMock());
jest.mock('../services/slack-notification.service', () => require('./_global-mocks').slackNotificationMock());
jest.mock('../services/settings.service', () => require('./_global-mocks').settingsServiceMock());

// --- prisma mock with directly-accessible jest.fn() per method --------------
//
// Jest hoists `jest.mock(...)` ABOVE every other top-level statement, so we
// can't define `jest.fn()` outside and reference it inside the factory.
// Define the fns inside the factory and pull them back out via
// `jest.requireMock(...)` in the tests / setup.
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      updateMany: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    voucherTracking: {
      upsert: jest.fn(),
    },
    therapist: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  },
}));

// --- redis mock for tool-call idempotency + per-appointment counter ----------
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisIncr = jest.fn();
const mockRedisExpire = jest.fn();

jest.mock('../utils/redis', () => ({
  redis: {
    get: (...a: unknown[]) => mockRedisGet(...(a as [unknown])),
    set: (...a: unknown[]) => mockRedisSet(...(a as [unknown])),
    incr: (...a: unknown[]) => mockRedisIncr(...(a as [unknown])),
    expire: (...a: unknown[]) => mockRedisExpire(...(a as [unknown])),
    del: jest.fn(),
  },
}));

// --- downstream side-effecting services - shallow mocks ----------------------
const mockSendEmail = jest.fn();
jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: {
    sendEmail: (...a: unknown[]) => mockSendEmail(...(a as [unknown])),
  },
}));

jest.mock('../services/email-queue.service', () => ({
  emailQueueService: { enqueue: jest.fn() },
}));

const mockTransitionToConfirmed = jest.fn();
const mockTransitionToCancelled = jest.fn();
jest.mock('../services/appointment-lifecycle.service', () => ({
  appointmentLifecycleService: {
    transitionToConfirmed: (...a: unknown[]) => mockTransitionToConfirmed(...(a as [unknown])),
    transitionToCancelled: (...a: unknown[]) => mockTransitionToCancelled(...(a as [unknown])),
  },
}));

jest.mock('../services/availability-resolver.service', () => ({
  availabilityResolver: {
    validateMarkComplete: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../services/recipient-timezone.service', () => ({
  resolveRecipientTimezone: jest.fn().mockResolvedValue('Europe/London'),
}));

jest.mock('../services/availability-day-parser', () => ({
  parseDayStringsToSlots: jest.fn().mockReturnValue([]),
  buildPersistedAvailability: jest.fn().mockReturnValue({}),
}));

import { AIToolExecutorService } from '../services/ai-tool-executor.service';
import type { SchedulingContext } from '../services/scheduling-context.service';
import type Anthropic from '@anthropic-ai/sdk';

const baseContext: SchedulingContext = {
  appointmentRequestId: 'apt-1',
  userName: 'Maria',
  userEmail: 'maria@example.com',
  therapistEmail: 'dr.j@example.com',
  therapistName: 'Doctor Jones',
  therapistAvailability: null,
  bookingMethod: 'agent_negotiated',
  userCountry: 'UK',
  therapistCountry: 'UK',
  inboundSender: 'user',
};

function toolCall(name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock {
  return { type: 'tool_use', id: 'tu-1', name, input } as Anthropic.ToolUseBlock;
}

function getPrismaMock() {
  return jest.requireMock('../utils/database').prisma;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: human control NOT enabled, so the TOCTOU lock succeeds.
  getPrismaMock().appointmentRequest.updateMany.mockResolvedValue({ count: 1 });
  getPrismaMock().appointmentRequest.update.mockResolvedValue({ id: 'apt-1' });
  // Default: not previously executed (idempotency miss).
  mockRedisGet.mockResolvedValue(null);
  // Default: per-appointment counter is small.
  mockRedisIncr.mockResolvedValue(1);
  mockRedisExpire.mockResolvedValue(1);
  // Default: lifecycle transitions succeed.
  mockTransitionToConfirmed.mockResolvedValue({ skipped: false, atomicSkipped: false });
  mockTransitionToCancelled.mockResolvedValue({ skipped: false, atomicSkipped: false });
});

// =============================================================================
// H1 — atomic human-control lock
// =============================================================================

describe('TOCTOU lock — humanControlEnabled', () => {
  it('skips every tool call when humanControlEnabled is true at execution time', async () => {
    // updateMany returns count=0, meaning the WHERE clause didn't match
    // because humanControlEnabled flipped to true between checks.
    getPrismaMock().appointmentRequest.updateMany.mockResolvedValueOnce({ count: 0 });

    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('send_email', {
        to: 'maria@example.com',
        subject: 'Spill - Test',
        body: 'Hello',
      }),
      baseContext,
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        skipped: true,
        skipReason: 'human_control',
      }),
    );
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// =============================================================================
// M1 — per-appointment tool ceiling
// =============================================================================

describe('per-appointment tool ceiling', () => {
  it('flips into human control + skips once the Redis counter exceeds the limit', async () => {
    // Counter just over the limit (50). The first call past the limit
    // should not actually execute send_email.
    mockRedisIncr.mockResolvedValueOnce(51);

    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('send_email', {
        to: 'maria@example.com',
        subject: 'Spill - Test',
        body: 'Hello',
      }),
      baseContext,
    );

    expect(result).toEqual(
      expect.objectContaining({ success: true, skipped: true, skipReason: 'human_control' }),
    );
    expect(mockSendEmail).not.toHaveBeenCalled();

    // The ceiling path should also flip the appointment into human
    // control by calling appointmentRequest.update with a payload
    // that includes humanControlEnabled: true.
    const updateCalls = getPrismaMock().appointmentRequest.update.mock.calls;
    const flipCall = updateCalls.find(
      (c: unknown[]) =>
        (c[0] as { data?: { humanControlEnabled?: boolean } })?.data?.humanControlEnabled === true,
    );
    expect(flipCall).toBeDefined();
  });

  it('proceeds normally when the counter is below the limit', async () => {
    mockRedisIncr.mockResolvedValueOnce(10);

    const exec = new AIToolExecutorService('test');
    await exec.executeToolCall(
      toolCall('send_email', {
        to: 'maria@example.com',
        subject: 'Spill - Test',
        body: 'Hello',
      }),
      baseContext,
    );

    expect(mockSendEmail).toHaveBeenCalled();
  });
});

// =============================================================================
// send_email — recipient validation
// =============================================================================

describe('send_email recipient gate', () => {
  it('accepts the appointment user as recipient', async () => {
    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('send_email', {
        to: 'maria@example.com',
        subject: 'Spill - Hello',
        body: 'Body',
      }),
      baseContext,
    );
    expect(result.success).toBe(true);
    expect(mockSendEmail).toHaveBeenCalled();
  });

  it('accepts the appointment therapist as recipient', async () => {
    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('send_email', {
        to: 'dr.j@example.com',
        subject: 'Spill - Hello',
        body: 'Body',
      }),
      baseContext,
    );
    expect(result.success).toBe(true);
    expect(mockSendEmail).toHaveBeenCalled();
  });

  it('rejects an arbitrary third-party email even if it parses as valid', async () => {
    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('send_email', {
        to: 'attacker@evil.example',
        subject: 'Spill - Hello',
        body: 'Body',
      }),
      baseContext,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a recognized email/);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('matches recipient case-insensitively', async () => {
    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('send_email', {
        to: 'MARIA@EXAMPLE.COM',
        subject: 'Spill - Hello',
        body: 'Body',
      }),
      baseContext,
    );
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// C2 — issue_voucher_code email gate
// =============================================================================

describe('C2 — issue_voucher_code email is forced to context.userEmail', () => {
  beforeEach(() => {
    // Mock voucher-tracking upsert
    getPrismaMock().voucherTracking.upsert.mockResolvedValue({});
    // Mock settings used by the voucher path
    const settingsService = jest.requireMock('../services/settings.service');
    settingsService.getSettingValue.mockImplementation(async (key: string) => {
      if (key === 'voucher.expiryDays') return 14;
      if (key === 'weeklyMailing.webAppUrl') return 'https://app.test';
      return undefined;
    });
  });

  it("uses context.userEmail even when the agent passes a different address", async () => {
    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('issue_voucher_code', { email: 'attacker@evil.example' }),
      baseContext,
    );

    expect(result.success).toBe(true);
    const upsertCall = getPrismaMock().voucherTracking.upsert.mock.calls[0]?.[0];
    expect(upsertCall.where.id).toBe('maria@example.com');
    expect(upsertCall.create.id).toBe('maria@example.com');
    // The attacker-supplied address must NEVER appear as the voucher key.
    expect(JSON.stringify(upsertCall)).not.toContain('attacker@evil.example');
  });

  it('uses context.userEmail when the agent passes the same email (no override drama)', async () => {
    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('issue_voucher_code', { email: 'maria@example.com' }),
      baseContext,
    );

    expect(result.success).toBe(true);
    const upsertCall = getPrismaMock().voucherTracking.upsert.mock.calls[0]?.[0];
    expect(upsertCall.where.id).toBe('maria@example.com');
  });
});

// =============================================================================
// C3 — update_therapist_availability sender gate
// =============================================================================

describe('C3 — update_therapist_availability sender gate', () => {
  it('rejects the call when the inbound email was from the user', async () => {
    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('update_therapist_availability', { availability: { Monday: '09:00-17:00' } }),
      { ...baseContext, inboundSender: 'user' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/only allowed when the inbound email was from the therapist/);
  });

  it('rejects the call when there was no inbound email (startScheduling)', async () => {
    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('update_therapist_availability', { availability: { Monday: '09:00-17:00' } }),
      { ...baseContext, inboundSender: undefined },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inbound sender: none/i);
  });

  it('proceeds when the inbound email was from the therapist', async () => {
    getPrismaMock().appointmentRequest.findUnique.mockResolvedValueOnce({
      therapistId: 't1',
      therapistHandle: 'h1',
    });
    getPrismaMock().therapist.findFirst.mockResolvedValueOnce({
      id: 't1',
      country: 'UK',
      availability: null,
    });

    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('update_therapist_availability', { availability: { Monday: '09:00-17:00' } }),
      { ...baseContext, inboundSender: 'therapist' },
    );
    // The call doesn't get rejected on the C3 gate. It may succeed or
    // fail for other reasons (e.g. day-string parser), but specifically
    // it must NOT carry the gate's rejection message.
    if (result.error) {
      expect(result.error).not.toMatch(/inbound email was from the therapist/);
    }
  });
});

// =============================================================================
// remember tool — appointment-id scoping
// =============================================================================

describe('remember tool — strict appointment-ID scoping', () => {
  it('writes notes via the agent-memory service for the appointment in context', async () => {
    // The remember tool's contract is enforced inside agent-memory.service
    // (which has its own isolation tests). Here we just verify the
    // executor passes context.appointmentRequestId through unchanged.
    getPrismaMock().appointmentRequest.findUnique.mockResolvedValueOnce({ memory: null });
    getPrismaMock().appointmentRequest.update.mockResolvedValueOnce({ id: 'apt-1' });

    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('remember', {
        note: 'user prefers afternoons',
        category: 'preference',
      }),
      baseContext,
    );

    expect(result.success).toBe(true);
    // The update call's `where.id` MUST equal context.appointmentRequestId.
    const updateCall = getPrismaMock().appointmentRequest.update.mock.calls.find(
      (c: unknown[]) => (c[0] as { data?: { memory?: unknown } })?.data?.memory !== undefined,
    );
    expect(updateCall).toBeDefined();
    expect(updateCall?.[0]?.where).toEqual({ id: 'apt-1' });
  });
});

// =============================================================================
// idempotency
// =============================================================================

describe('per-call idempotency', () => {
  it('skips the tool call when the same hash exists in Redis', async () => {
    // Pre-populate the idempotency cache
    mockRedisGet.mockResolvedValueOnce('previous-trace-id');

    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('send_email', {
        to: 'maria@example.com',
        subject: 'Spill - Hello',
        body: 'Body',
      }),
      baseContext,
    );

    expect(result).toEqual(
      expect.objectContaining({ success: true, skipped: true, skipReason: 'idempotent' }),
    );
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// =============================================================================
// unknown tool — fail explicitly
// =============================================================================

describe('unknown tool', () => {
  it('returns failure for a tool the executor does not recognise', async () => {
    const exec = new AIToolExecutorService('test');
    const result = await exec.executeToolCall(
      toolCall('not_a_real_tool', { foo: 'bar' }),
      baseContext,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown tool: not_a_real_tool/);
  });
});

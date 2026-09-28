/**
 * Booking email verification (review §3 #3): the token, the send, the
 * verify/activation path, the 24 h expiry sweep and the per-address limiter.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    jwtSecret: 'test-secret-key-for-unit-tests',
    backendUrl: 'https://backend.test',
    frontendUrl: 'https://frontend.test',
    env: 'test',
  },
}));

jest.mock('../utils/database', () => {
  const appointmentRequest = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  };
  const prismaMock: Record<string, unknown> = {
    appointmentRequest,
    user: { findUnique: jest.fn().mockResolvedValue({ country: 'IE' }) },
    therapist: { findUnique: jest.fn().mockResolvedValue({ country: 'UK', bookingLink: null }) },
  };
  prismaMock.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(prismaMock));
  return { prisma: prismaMock };
});

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => {
    const values: Record<string, unknown> = {
      'email.bookingVerificationSubject': 'Confirm your session request with {therapistName}',
      'email.bookingVerificationBody': 'Hi {userName}, [Confirm my request]({verificationUrl}) within {expiryHours} hours.',
      'agent.fromName': 'Justin Time',
      'general.maxActiveThreadsPerUser': 2,
      'notifications.slack.requested': true,
    };
    return values[key];
  }),
}));

jest.mock('../core/email', () => ({ sendEmail: jest.fn().mockResolvedValue({ messageId: 'm1', threadId: 't1' }) }));

jest.mock('../services/therapist-booking-status.service', () => ({
  therapistBookingStatusService: {
    canAcceptNewRequest: jest.fn().mockResolvedValue({ canAcceptNewRequests: true, reason: 'available' }),
    recordNewRequest: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/side-effect-tracker.service', () => ({
  sideEffectTrackerService: {
    registerInTransaction: jest.fn().mockResolvedValue({ idempotencyKey: 'effect-key' }),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { notifyAppointmentCreated: jest.fn().mockResolvedValue(true) },
}));

const startScheduling = jest.fn().mockResolvedValue({ success: true, message: 'ok' });
jest.mock('../services/justin-time.service', () => ({
  JustinTimeService: jest.fn().mockImplementation(() => ({ startScheduling })),
}));

jest.mock('../domain/scheduling/availability/agent/service', () => ({
  supersedeActiveTherapistConversationInTx: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/redis', () => ({
  cacheManager: { eval: jest.fn().mockRejectedValue(new Error('Redis not available')) },
}));

import { prisma } from '../utils/database';
import { sendEmail } from '../core/email';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { sideEffectTrackerService } from '../services/side-effect-tracker.service';
import { cacheManager } from '../utils/redis';
import { signTimestampedToken } from '../utils/hmac-token';
import { generateVoucherToken } from '../utils/voucher-token';
import {
  bookingVerificationService,
  checkBookingVerificationToken,
  consumeAddressQuota,
  generateBookingVerificationToken,
  resetAddressQuotaMemory,
} from '../services/booking-verification.service';

const apt = prisma.appointmentRequest as unknown as Record<string, jest.Mock>;
const HOUR = 60 * 60 * 1000;

const ROW = {
  id: 'apt-1',
  userName: 'Jamie Doe',
  userEmail: 'jamie@example.com',
  userId: 'user-1',
  therapistId: 'ther-1',
  therapistHandle: 'handle-1',
  therapistName: 'Dr Rivers',
  therapistEmail: 'rivers@example.com',
  therapistAvailability: null,
  bookingMethod: 'agent_negotiated',
  status: 'pending',
  emailVerifiedAt: null as Date | null,
};

beforeEach(() => {
  jest.clearAllMocks();
  resetAddressQuotaMemory();
  apt.findUnique.mockResolvedValue({ ...ROW });
  apt.findFirst.mockResolvedValue(null);
  apt.findMany.mockResolvedValue([]);
  apt.updateMany.mockResolvedValue({ count: 1 });
  (therapistBookingStatusService.canAcceptNewRequest as jest.Mock).mockResolvedValue({
    canAcceptNewRequests: true,
    reason: 'available',
  });
  (cacheManager.eval as jest.Mock).mockRejectedValue(new Error('Redis not available'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('booking verification token', () => {
  it('is valid for its own appointment and address (address case-insensitive)', () => {
    const token = generateBookingVerificationToken('apt-1', 'Jamie@Example.com');
    expect(checkBookingVerificationToken(token, 'apt-1', 'jamie@example.com')).toBe('valid');
  });

  it('is invalid for another appointment, another address, or when tampered with', () => {
    const token = generateBookingVerificationToken('apt-1', 'jamie@example.com');
    expect(checkBookingVerificationToken(token, 'apt-2', 'jamie@example.com')).toBe('invalid');
    expect(checkBookingVerificationToken(token, 'apt-1', 'someone@example.com')).toBe('invalid');
    expect(checkBookingVerificationToken(`${token}x`, 'apt-1', 'jamie@example.com')).toBe('invalid');
    expect(checkBookingVerificationToken('garbage', 'apt-1', 'jamie@example.com')).toBe('invalid');
  });

  it('is purpose-scoped: a voucher or other-context signature never validates', () => {
    const voucher = generateVoucherToken('jamie@example.com').token;
    expect(checkBookingVerificationToken(voucher, 'apt-1', 'jamie@example.com')).toBe('invalid');
    const otherContext = signTimestampedToken({
      context: 'feedback-token-v1',
      version: 'v1',
      payload: 'apt-1\njamie@example.com',
    });
    expect(checkBookingVerificationToken(otherContext, 'apt-1', 'jamie@example.com')).toBe('invalid');
  });

  it('expires after 24 hours', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-28T10:00:00Z'));
    const token = generateBookingVerificationToken('apt-1', 'jamie@example.com');
    jest.setSystemTime(new Date('2026-09-29T09:59:00Z'));
    expect(checkBookingVerificationToken(token, 'apt-1', 'jamie@example.com')).toBe('valid');
    jest.setSystemTime(new Date('2026-09-29T10:01:00Z'));
    expect(checkBookingVerificationToken(token, 'apt-1', 'jamie@example.com')).toBe('expired');
  });
});

describe('sendVerification', () => {
  it('claims emailVerificationSentAt, then emails a link to the verify route', async () => {
    const result = await bookingVerificationService.sendVerification('apt-1');

    expect(result).toEqual({ sent: true });
    expect(apt.updateMany).toHaveBeenCalledWith({
      where: { id: 'apt-1', emailVerifiedAt: null },
      data: { emailVerificationSentAt: expect.any(Date) },
    });
    const email = (sendEmail as jest.Mock).mock.calls[0][0];
    expect(email.to).toBe('jamie@example.com');
    expect(email.subject).toBe('Confirm your session request with Dr Rivers');
    expect(email.body).toContain('https://backend.test/api/appointments/apt-1/verify?token=');
    expect(email.body).toContain('within 24 hours');
  });

  it('does not re-send inside the resend interval', async () => {
    apt.updateMany.mockResolvedValue({ count: 0 });
    const result = await bookingVerificationService.sendVerification('apt-1', { minIntervalMs: 120_000 });
    expect(result).toEqual({ sent: false, reason: 'too_soon' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('skips a request that is already verified', async () => {
    apt.findUnique.mockResolvedValue({ ...ROW, emailVerifiedAt: new Date() });
    const result = await bookingVerificationService.sendVerification('apt-1');
    expect(result).toEqual({ sent: false, reason: 'already_verified' });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('verify', () => {
  const token = () => generateBookingVerificationToken('apt-1', 'jamie@example.com');

  it('stamps emailVerifiedAt, then activates: outbox row, agent kickoff', async () => {
    const outcome = await bookingVerificationService.verify('apt-1', token());

    expect(outcome.status).toBe('verified');
    expect(apt.updateMany).toHaveBeenCalledWith({
      where: { id: 'apt-1', emailVerifiedAt: null },
      data: { emailVerifiedAt: expect.any(Date), lastActivityAt: expect.any(Date) },
    });
    expect(sideEffectTrackerService.registerInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'apt-1',
      'requested',
      { effectType: 'justintime_start' },
    );
    // Serial-guard re-check without the "same client continuation" email.
    expect(therapistBookingStatusService.canAcceptNewRequest).toHaveBeenCalledWith('handle-1', '', expect.anything());
    await new Promise((r) => setImmediate(r));
    expect(startScheduling).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentRequestId: 'apt-1', userEmail: 'jamie@example.com', userCountry: 'IE' }),
    );
  });

  it('is idempotent: a second click reports success and runs nothing again', async () => {
    apt.findUnique.mockResolvedValue({ ...ROW, emailVerifiedAt: new Date() });
    const outcome = await bookingVerificationService.verify('apt-1', token());

    expect(outcome.status).toBe('already_verified');
    expect(apt.updateMany).not.toHaveBeenCalled();
    expect(sideEffectTrackerService.registerInTransaction).not.toHaveBeenCalled();
    expect(startScheduling).not.toHaveBeenCalled();
  });

  it('treats a lost concurrent claim as already verified', async () => {
    apt.updateMany.mockResolvedValue({ count: 0 });
    const outcome = await bookingVerificationService.verify('apt-1', token());
    expect(outcome.status).toBe('already_verified');
    expect(sideEffectTrackerService.registerInTransaction).not.toHaveBeenCalled();
  });

  it('refuses an expired link and activates nothing', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-28T10:00:00Z'));
    const t = token();
    jest.setSystemTime(new Date('2026-09-29T11:00:00Z'));
    const outcome = await bookingVerificationService.verify('apt-1', t);
    expect(outcome.status).toBe('expired');
    expect(apt.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a token for another appointment without touching the database', async () => {
    const other = generateBookingVerificationToken('apt-2', 'jamie@example.com');
    const outcome = await bookingVerificationService.verify('apt-1', other);
    expect(outcome.status).toBe('invalid');
    expect(apt.findUnique).not.toHaveBeenCalled();
  });

  it('does not activate when the therapist was taken by a verified request meanwhile', async () => {
    (therapistBookingStatusService.canAcceptNewRequest as jest.Mock).mockResolvedValue({
      canAcceptNewRequests: false,
      reason: 'in_session',
    });
    const outcome = await bookingVerificationService.verify('apt-1', token());
    expect(outcome.status).toBe('therapist_unavailable');
    expect(apt.updateMany).not.toHaveBeenCalled();
    expect(startScheduling).not.toHaveBeenCalled();
  });

  it('enforces the per-user thread limit counting only verified requests', async () => {
    apt.findMany.mockResolvedValue([
      { id: 'a', therapistName: 'A' },
      { id: 'b', therapistName: 'B' },
    ]);
    const outcome = await bookingVerificationService.verify('apt-1', token());
    expect(outcome).toMatchObject({ status: 'thread_limit', maxAllowed: 2, activeCount: 2 });
    const where = apt.findMany.mock.calls[0][0].where;
    expect(where.emailVerifiedAt).toEqual({ not: null });
    expect(where.id).toEqual({ not: 'apt-1' });
  });
});

describe('expireUnverifiedBookings', () => {
  it('deletes only requests unverified for more than 24 hours, re-asserting the predicate', async () => {
    const now = new Date('2026-09-28T12:00:00Z');
    apt.findMany.mockResolvedValue([{ id: 'old-1', therapistHandle: 'h', createdAt: new Date(now.getTime() - 25 * HOUR) }]);
    apt.deleteMany.mockResolvedValue({ count: 1 });

    const result = await bookingVerificationService.expireUnverifiedBookings(now);

    expect(result).toEqual({ expired: 1 });
    const cutoff = new Date(now.getTime() - 24 * HOUR);
    expect(apt.findMany.mock.calls[0][0].where).toEqual({ emailVerifiedAt: null, createdAt: { lt: cutoff } });
    expect(apt.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-1'] }, emailVerifiedAt: null, createdAt: { lt: cutoff } },
    });
  });

  it('does nothing when there is nothing to expire', async () => {
    apt.findMany.mockResolvedValue([]);
    expect(await bookingVerificationService.expireUnverifiedBookings()).toEqual({ expired: 0 });
    expect(apt.deleteMany).not.toHaveBeenCalled();
  });
});

describe('consumeAddressQuota', () => {
  it('uses the Redis counter and reports the remaining window when over the cap', async () => {
    (cacheManager.eval as jest.Mock).mockResolvedValue([6, 1234]);
    expect(await consumeAddressQuota('booking', 'Jamie@Example.com')).toEqual({ allowed: false, retryAfterSeconds: 1234 });
    const [, , key] = (cacheManager.eval as jest.Mock).mock.calls[0];
    // The key holds a hash, never the address itself.
    expect(key).toMatch(/^ratelimit:address:booking:[0-9a-f]{64}$/);
  });

  it('falls back to an in-memory counter when Redis is down (case-insensitive address)', async () => {
    const limit = { max: 2, windowSeconds: 60 };
    expect((await consumeAddressQuota('signup', 'a@example.com', limit)).allowed).toBe(true);
    expect((await consumeAddressQuota('signup', 'A@example.com', limit)).allowed).toBe(true);
    const third = await consumeAddressQuota('signup', 'a@example.com', limit);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
    // Separate scope, separate budget.
    expect((await consumeAddressQuota('booking', 'a@example.com', limit)).allowed).toBe(true);
  });
});

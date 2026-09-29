/**
 * POST /api/appointments/request — the two paths (review §3 #3):
 *   - no voucher: stored unverified, confirmation emailed, NOTHING else
 *     happens (no outbox row, no agent, no Slack) until the link is used;
 *     a duplicate gets the identical response (no oracle, §4.1);
 *   - valid voucher for the same address: activated immediately as before.
 * Plus the per-address limit and the GET/POST verify endpoints.
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
  const prismaMock: Record<string, unknown> = {
    appointmentRequest: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    therapist: { findFirst: jest.fn() },
    voucherTracking: { findUnique: jest.fn(), upsert: jest.fn() },
  };
  prismaMock.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(prismaMock));
  return { prisma: prismaMock };
});

const settings: Record<string, unknown> = {};
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => settings[key]),
}));

jest.mock('../utils/email-validator', () => ({ validateEmail: jest.fn() }));

jest.mock('../services/therapist-booking-status.service', () => ({
  therapistBookingStatusService: {
    canAcceptNewRequest: jest.fn(),
    recordNewRequest: jest.fn(),
  },
}));

jest.mock('../services/tracking-code.service', () => ({
  getOrCreateTrackingCode: jest.fn().mockResolvedValue('SPL42'),
}));

jest.mock('../utils/unique-id', () => ({
  getOrCreateUser: jest.fn().mockResolvedValue({ id: 'user-1', country: 'UK' }),
}));

// Heavy transitive dependencies of the real verification module.
jest.mock('../services/justin-time.service', () => ({ JustinTimeService: jest.fn() }));
jest.mock('../services/side-effect-tracker.service', () => ({ sideEffectTrackerService: {} }));
jest.mock('../services/slack-notification.service', () => ({ slackNotificationService: {} }));
jest.mock('../domain/scheduling/availability/agent/service', () => ({
  supersedeActiveTherapistConversationInTx: jest.fn(),
}));
jest.mock('../core/email', () => ({ sendEmail: jest.fn() }));

jest.mock('../services/booking-verification.service', () => {
  const actual = jest.requireActual('../services/booking-verification.service');
  return {
    ...actual,
    bookingVerificationService: {
      sendVerification: jest.fn().mockResolvedValue({ sent: true }),
      verify: jest.fn(),
      describeConfirmation: jest.fn(),
    },
    consumeAddressQuota: jest.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
    activateBookingInTx: jest.fn().mockResolvedValue({ idempotencyKey: 'effect-key' }),
    runPostActivationEffects: jest.fn(),
  };
});

import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../utils/database';
import { validateEmail } from '../utils/email-validator';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import {
  activateBookingInTx,
  bookingVerificationService,
  consumeAddressQuota,
  runPostActivationEffects,
} from '../services/booking-verification.service';
import { generateVoucherToken } from '../utils/voucher-token';
import { appointmentsRoutes } from '../routes/appointments.routes';

const apt = prisma.appointmentRequest as unknown as Record<string, jest.Mock>;
const flush = () => new Promise((r) => setImmediate(r));

/** An existing active request for the pair (not an idempotency-key hit). */
function duplicateOf(row: { id: string; emailVerifiedAt: Date | null }) {
  apt.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    'idempotencyKey' in where ? null : row,
  );
}

const PAYLOAD = {
  userName: 'Jamie',
  userEmail: 'Jamie@Example.com',
  therapistHandle: 'handle-1',
};

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  Object.assign(settings, {
    'voucher.enabled': true,
    'voucher.required': false,
    'voucher.expiryDays': 14,
    'general.maxActiveThreadsPerUser': 2,
    'agent.fromName': 'Justin Time',
  });
  (validateEmail as jest.Mock).mockResolvedValue({
    isValid: true,
    errors: [],
    warnings: [],
    suggestions: [],
    suggestedEmail: null,
  });
  (therapistBookingStatusService.canAcceptNewRequest as jest.Mock).mockResolvedValue({
    canAcceptNewRequests: true,
    reason: 'available',
  });
  (prisma.therapist.findFirst as jest.Mock).mockResolvedValue({
    id: 'ther-1',
    notionId: 'handle-1',
    name: 'Dr Rivers',
    email: 'rivers@example.com',
    active: true,
    availability: null,
    country: 'UK',
  });
  (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);
  apt.findFirst.mockResolvedValue(null);
  apt.findMany.mockResolvedValue([]);
  apt.count.mockResolvedValue(0);
  apt.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...data }));
  (consumeAddressQuota as jest.Mock).mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  app = Fastify();
  await app.register(appointmentsRoutes);
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/appointments/request without a voucher', () => {
  it('stores the request unverified, emails a link, and starts nothing else', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/appointments/request', payload: PAYLOAD });

    expect(res.statusCode).toBe(202);
    expect(res.json().data).toEqual({
      verificationRequired: true,
      status: 'awaiting_verification',
      email: 'jamie@example.com',
      expiresInHours: 24,
      suggestedEmail: null,
      message: expect.stringContaining('jamie@example.com'),
    });
    // No appointment id in the response (see the duplicate test).
    expect(res.json().data).not.toHaveProperty('appointmentRequestId');

    const created = apt.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ userEmail: 'jamie@example.com', status: 'pending', emailVerifiedAt: null });
    await flush();
    expect(bookingVerificationService.sendVerification).toHaveBeenCalledWith(created.id, { minIntervalMs: 0 });
    // The old create path's side effects all wait for verification.
    expect(activateBookingInTx).not.toHaveBeenCalled();
    expect(runPostActivationEffects).not.toHaveBeenCalled();
  });

  it('checks the therapist without the same-client exemption (no oracle)', async () => {
    await app.inject({ method: 'POST', url: '/api/appointments/request', payload: PAYLOAD });
    expect(therapistBookingStatusService.canAcceptNewRequest).toHaveBeenCalledWith('handle-1', '');
  });

  it('answers a duplicate exactly like a new request and re-sends the link', async () => {
    const fresh = await app.inject({ method: 'POST', url: '/api/appointments/request', payload: PAYLOAD });
    await flush();
    jest.clearAllMocks();
    duplicateOf({ id: 'existing', emailVerifiedAt: null });

    const dup = await app.inject({ method: 'POST', url: '/api/appointments/request', payload: PAYLOAD });

    expect(dup.statusCode).toBe(fresh.statusCode);
    expect(dup.json()).toEqual(fresh.json());
    expect(apt.create).not.toHaveBeenCalled();
    await flush();
    expect(bookingVerificationService.sendVerification).toHaveBeenCalledWith('existing', { minIntervalMs: 120_000 });
  });

  it('gives the same answer when the address already has a verified request', async () => {
    const fresh = await app.inject({ method: 'POST', url: '/api/appointments/request', payload: PAYLOAD });
    await flush();
    jest.clearAllMocks();
    duplicateOf({ id: 'existing', emailVerifiedAt: new Date() });

    const dup = await app.inject({ method: 'POST', url: '/api/appointments/request', payload: PAYLOAD });

    expect(dup.json()).toEqual(fresh.json());
    await flush();
    expect(bookingVerificationService.sendVerification).not.toHaveBeenCalled();
  });

  it('passes the typo suggestion through', async () => {
    (validateEmail as jest.Mock).mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: ['Possible typo detected'],
      suggestions: ['Did you mean jamie@gmail.com?'],
      suggestedEmail: 'jamie@gmail.com',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/appointments/request',
      payload: { ...PAYLOAD, userEmail: 'jamie@gmial.com' },
    });
    expect(res.json().data.suggestedEmail).toBe('jamie@gmail.com');
  });

  it('rate-limits per address with a Retry-After the UI can show', async () => {
    (consumeAddressQuota as jest.Mock).mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const res = await app.inject({ method: 'POST', url: '/api/appointments/request', payload: PAYLOAD });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
    expect(res.json()).toMatchObject({ code: 'ADDRESS_RATE_LIMITED', retryAfter: 42 });
    expect(consumeAddressQuota).toHaveBeenCalledWith('booking', 'jamie@example.com');
    expect(apt.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/appointments/request with a valid voucher for the same address', () => {
  it('skips verification and activates immediately, as before', async () => {
    const { token } = generateVoucherToken('jamie@example.com', 14);
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue({ lastVoucherToken: token });

    const res = await app.inject({
      method: 'POST',
      url: '/api/appointments/request',
      payload: { ...PAYLOAD, voucherToken: token },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ verificationRequired: false, status: 'pending' });
    expect(res.json().data.appointmentRequestId).toEqual(expect.any(String));
    expect(apt.create.mock.calls[0][0].data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(activateBookingInTx).toHaveBeenCalledTimes(1);
    expect(runPostActivationEffects).toHaveBeenCalledWith(
      expect.objectContaining({ justinTimeEffectKey: 'effect-key' }),
    );
    expect(bookingVerificationService.sendVerification).not.toHaveBeenCalled();
    // Continuation rule still applies on this path.
    expect(therapistBookingStatusService.canAcceptNewRequest).toHaveBeenCalledWith('handle-1', 'jamie@example.com');
  });

  it('uses a generic duplicate message', async () => {
    const { token } = generateVoucherToken('jamie@example.com', 14);
    (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue({ lastVoucherToken: token });
    duplicateOf({ id: 'existing', emailVerifiedAt: new Date() });

    const res = await app.inject({
      method: 'POST',
      url: '/api/appointments/request',
      payload: { ...PAYLOAD, voucherToken: token },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).not.toMatch(/already have an appointment with this therapist/i);
    expect(res.json().error).toMatch(/If you already have a request/);
  });
});

describe('/api/appointments/:id/verify', () => {
  it('GET only shows a confirm button (mail scanners must not verify)', async () => {
    (bookingVerificationService.describeConfirmation as jest.Mock).mockResolvedValue({
      status: 'confirm',
      therapistName: 'Dr <Rivers>',
      email: 'jamie@example.com',
    });
    const res = await app.inject({ method: 'GET', url: '/api/appointments/apt-1/verify?token=abc' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<form method="post"');
    expect(res.body).toContain('Dr &lt;Rivers&gt;');
    expect(res.body).toContain('https://frontend.test');
    expect(bookingVerificationService.verify).not.toHaveBeenCalled();
  });

  it('POST verifies and shows the success page with a link back to the site', async () => {
    (bookingVerificationService.verify as jest.Mock).mockResolvedValue({
      status: 'verified',
      appointmentId: 'apt-1',
      therapistName: 'Dr Rivers',
      bookingMethod: 'agent_negotiated',
      bookingLink: null,
    });
    const res = await app.inject({ method: 'POST', url: '/api/appointments/apt-1/verify?token=abc' });

    expect(res.statusCode).toBe(200);
    expect(bookingVerificationService.verify).toHaveBeenCalledWith('apt-1', 'abc', expect.any(String));
    expect(res.body).toContain('your request is confirmed');
    expect(res.body).toContain('Justin Time');
    expect(res.body).toContain('href="https://frontend.test"');
  });

  it('a second click shows the same success page', async () => {
    (bookingVerificationService.describeConfirmation as jest.Mock).mockResolvedValue({
      status: 'already_verified',
      appointmentId: 'apt-1',
      therapistName: 'Dr Rivers',
      bookingMethod: 'direct_link',
      bookingLink: 'javascript:alert(1)',
    });
    const res = await app.inject({ method: 'GET', url: '/api/appointments/apt-1/verify?token=abc' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('your request is confirmed');
    // Only http(s) calendar links are ever rendered.
    expect(res.body).not.toContain('javascript:');
  });

  it('explains an expired link', async () => {
    (bookingVerificationService.verify as jest.Mock).mockResolvedValue({ status: 'expired' });
    const res = await app.inject({ method: 'POST', url: '/api/appointments/apt-1/verify?token=abc' });
    expect(res.statusCode).toBe(410);
    expect(res.body).toContain('This link has expired');
  });
});

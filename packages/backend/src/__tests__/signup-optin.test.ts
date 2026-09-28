/**
 * Public signup (review §4.6 / §4.1): weekly emails are an explicit
 * opt-in, the unverified form can't flip an existing address's
 * subscription, signups are rate-limited per address, and the country
 * goes through the shared validator.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: { jwtSecret: 'test-secret-key-for-unit-tests', backendUrl: 'https://backend.test', frontendUrl: 'https://frontend.test' },
}));

jest.mock('../utils/database', () => {
  const prismaMock: Record<string, unknown> = {
    user: { findFirst: jest.fn(), update: jest.fn() },
  };
  prismaMock.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(prismaMock));
  return { prisma: prismaMock };
});

jest.mock('../utils/email-validator', () => ({
  validateEmail: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [], suggestions: [], suggestedEmail: null }),
}));
jest.mock('../utils/unique-id', () => ({
  getOrCreateUser: jest.fn().mockResolvedValue({ id: 'user-1', email: 'jamie@example.com' }),
}));
jest.mock('../services/signup-invitation.service', () => ({ findInvitationByToken: jest.fn(), markAccepted: jest.fn() }));
jest.mock('../services/slack-notification.service', () => ({ slackNotificationService: { notifyInvitationAccepted: jest.fn() } }));
jest.mock('../services/voucher-issuance.service', () => ({
  issueWelcomeVoucher: jest.fn().mockResolvedValue({ tokenIssued: true, emailSent: true }),
}));
jest.mock('../services/booking-verification.service', () => ({
  consumeAddressQuota: jest.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));

import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../utils/database';
import { getOrCreateUser } from '../utils/unique-id';
import { issueWelcomeVoucher } from '../services/voucher-issuance.service';
import { consumeAddressQuota } from '../services/booking-verification.service';
import { signupRoutes } from '../routes/signup.routes';

const PAYLOAD = {
  name: 'Jamie Doe',
  email: 'jamie@example.com',
  priorTherapy: true,
  acknowledgedRealSession: true,
  agreedToFeedback: true,
};

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.user.update as jest.Mock).mockResolvedValue({
    id: 'user-1', odId: '1', email: 'jamie@example.com', name: 'Jamie Doe', consentGivenAt: new Date(),
  });
  (consumeAddressQuota as jest.Mock).mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  app = Fastify();
  await app.register(signupRoutes);
});

afterEach(async () => {
  await app.close();
});

const updateData = () => (prisma.user.update as jest.Mock).mock.calls[0][0].data;

describe('weekly-email opt-in', () => {
  it('a new user who did not tick the box is NOT subscribed', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(201);
    expect(updateData().subscribed).toBe(false);
    expect(res.json().data.weeklyEmails).toBe(false);
    expect((issueWelcomeVoucher as jest.Mock).mock.calls[0][0].optedIn).toBe(false);
  });

  it('a new user who ticked the box is subscribed', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/signup', payload: { ...PAYLOAD, weeklyEmails: true } });
    expect(res.statusCode).toBe(201);
    expect(updateData().subscribed).toBe(true);
    expect((issueWelcomeVoucher as jest.Mock).mock.calls[0][0].optedIn).toBe(true);
  });

  it('never re-subscribes an existing address that opted out, even when ticked', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'user-1', subscribed: false });
    const res = await app.inject({ method: 'POST', url: '/api/signup', payload: { ...PAYLOAD, weeklyEmails: true } });
    expect(res.statusCode).toBe(201);
    expect(updateData()).not.toHaveProperty('subscribed');
    expect(res.json().data.weeklyEmails).toBe(false);
    // Voucher issuance must not clear the opt-out either.
    expect((issueWelcomeVoucher as jest.Mock).mock.calls[0][0].optedIn).toBe(false);
  });

  it('never unsubscribes an existing subscriber who left the box unticked', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'user-1', subscribed: true });
    await app.inject({ method: 'POST', url: '/api/signup', payload: PAYLOAD });
    expect(updateData()).not.toHaveProperty('subscribed');
  });
});

describe('per-address rate limit', () => {
  it('answers 429 with Retry-After and writes nothing', async () => {
    (consumeAddressQuota as jest.Mock).mockResolvedValue({ allowed: false, retryAfterSeconds: 3600 });
    const res = await app.inject({ method: 'POST', url: '/api/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3600');
    expect(consumeAddressQuota).toHaveBeenCalledWith('signup', 'jamie@example.com');
    expect(getOrCreateUser).not.toHaveBeenCalled();
    expect(issueWelcomeVoucher).not.toHaveBeenCalled();
  });
});

describe('country', () => {
  it('normalises a lower-case supported code', async () => {
    await app.inject({ method: 'POST', url: '/api/signup', payload: { ...PAYLOAD, country: 'us' } });
    expect(getOrCreateUser).toHaveBeenCalledWith('jamie@example.com', 'Jamie Doe', 'US');
  });

  it('rejects an unknown code instead of storing it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/signup', payload: { ...PAYLOAD, country: 'USA' } });
    expect(res.statusCode).toBe(400);
    expect(getOrCreateUser).not.toHaveBeenCalled();
  });
});

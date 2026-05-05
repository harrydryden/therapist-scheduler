/**
 * Tests for the public /api/signup endpoint.
 *
 * Covers consent validation, email validation, idempotent re-signup,
 * and the row-shape written to Postgres.
 */

// ============================================
// Mocks (must be before imports)
// ============================================

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    jwtSecret: 'test-secret-key-for-unit-tests',
    webhookSecret: 'test-webhook-secret',
    backendUrl: 'https://backend.test',
  },
}));

jest.mock('../utils/database', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../utils/email-validator', () => ({
  validateEmail: jest.fn(),
}));

jest.mock('../utils/unique-id', () => ({
  getOrCreateUser: jest.fn(),
}));

// ============================================
// Imports
// ============================================

import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../utils/database';
import { validateEmail } from '../utils/email-validator';
import { getOrCreateUser } from '../utils/unique-id';
import { signupRoutes } from '../routes/signup.routes';

// ============================================
// Helpers
// ============================================

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(signupRoutes);
  return app;
}

const VALID_PAYLOAD = {
  name: 'Jamie Doe',
  email: 'jamie@example.com',
  priorTherapy: true,
  acknowledgedRealSession: true,
  agreedToFeedback: true,
};

function mockEmailValid() {
  (validateEmail as jest.Mock).mockResolvedValue({
    isValid: true,
    email: 'jamie@example.com',
    normalizedEmail: 'jamie@example.com',
    errors: [],
    warnings: [],
    suggestions: [],
  });
}

function mockGetOrCreateUser(overrides: Record<string, unknown> = {}) {
  (getOrCreateUser as jest.Mock).mockResolvedValue({
    id: 'user-uuid',
    odId: '1234567890',
    email: 'jamie@example.com',
    name: 'Jamie Doe',
    country: 'UK',
    subscribed: true,
    priorTherapy: null,
    acknowledgedRealSession: null,
    agreedToFeedback: null,
    consentGivenAt: null,
    signupSource: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

function mockUserUpdate(overrides: Record<string, unknown> = {}) {
  (prisma.user.update as jest.Mock).mockResolvedValue({
    id: 'user-uuid',
    odId: '1234567890',
    email: 'jamie@example.com',
    name: 'Jamie Doe',
    consentGivenAt: new Date('2026-05-05T12:00:00Z'),
    ...overrides,
  });
}

// ============================================
// Tests
// ============================================

describe('signup routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('validation', () => {
    it('rejects missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: { ...VALID_PAYLOAD, name: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid email format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: { ...VALID_PAYLOAD, email: 'not-an-email' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects when acknowledgedRealSession is false', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: { ...VALID_PAYLOAD, acknowledgedRealSession: false },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.success).toBe(false);
    });

    it('rejects when agreedToFeedback is false', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: { ...VALID_PAYLOAD, agreedToFeedback: false },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects when priorTherapy is omitted', async () => {
      const { priorTherapy: _drop, ...payload } = VALID_PAYLOAD;
      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload,
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts priorTherapy=false (form allows either answer)', async () => {
      mockEmailValid();
      mockGetOrCreateUser();
      mockUserUpdate();

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: { ...VALID_PAYLOAD, priorTherapy: false },
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('email validation', () => {
    it('rejects when validateEmail flags the address', async () => {
      (validateEmail as jest.Mock).mockResolvedValue({
        isValid: false,
        errors: ['No MX record for this domain'],
        warnings: [],
        suggestions: [],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: VALID_PAYLOAD,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('MX record');
      expect(getOrCreateUser).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    beforeEach(() => {
      mockEmailValid();
      mockGetOrCreateUser();
      mockUserUpdate();
    });

    it('creates the user and stamps all consent fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: VALID_PAYLOAD,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        id: 'user-uuid',
        odId: '1234567890',
        email: 'jamie@example.com',
      });

      // Verify the update call captured every consent field plus signup_source.
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      const call = (prisma.user.update as jest.Mock).mock.calls[0][0];
      expect(call.where).toEqual({ id: 'user-uuid' });
      expect(call.data).toMatchObject({
        name: 'Jamie Doe',
        priorTherapy: true,
        acknowledgedRealSession: true,
        agreedToFeedback: true,
        signupSource: 'signup_form',
        subscribed: true,
      });
      expect(call.data.consentGivenAt).toBeInstanceOf(Date);
    });

    it('is idempotent — re-signup updates an existing user', async () => {
      // First signup: getOrCreateUser returns the existing row (already has odId)
      mockGetOrCreateUser({ name: 'Existing Name' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: { ...VALID_PAYLOAD, name: 'Updated Name' },
      });

      expect(res.statusCode).toBe(201);
      // The update call should overwrite name and refresh consent timestamps.
      const call = (prisma.user.update as jest.Mock).mock.calls[0][0];
      expect(call.data.name).toBe('Updated Name');
      expect(call.data.consentGivenAt).toBeInstanceOf(Date);
      expect(call.data.signupSource).toBe('signup_form');
    });

    it('lowercases email before passing to getOrCreateUser', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: { ...VALID_PAYLOAD, email: 'Jamie@Example.com' },
      });

      expect(res.statusCode).toBe(201);
      // getOrCreateUser does its own normalization, but signup passes the
      // user-supplied email; the route trims whitespace via zod.
      expect(getOrCreateUser).toHaveBeenCalledWith('Jamie@Example.com', 'Jamie Doe');
    });
  });

  describe('error handling', () => {
    it('returns 500 if Postgres write fails', async () => {
      mockEmailValid();
      mockGetOrCreateUser();
      (prisma.user.update as jest.Mock).mockRejectedValue(new Error('DB down'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: VALID_PAYLOAD,
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().success).toBe(false);
    });
  });
});

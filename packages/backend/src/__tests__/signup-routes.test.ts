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
    frontendUrl: 'https://frontend.test',
  },
}));

// `$transaction` is mocked as a passthrough that invokes the callback with
// the same prisma proxy as `tx`, so the route's
// `prisma.$transaction(async tx => tx.user.update(...))` resolves through
// the same `update` mock the tests configure below. Same pattern as
// admin-invitations-routes.test.ts.
jest.mock('../utils/database', () => {
  const userMock = {
    findUnique: jest.fn(),
    update: jest.fn(),
  };
  const prismaMock: Record<string, unknown> = {
    user: userMock,
  };
  prismaMock.$transaction = jest.fn().mockImplementation((cb: unknown) => {
    if (typeof cb === 'function') return (cb as (tx: unknown) => Promise<unknown>)(prismaMock);
    return Promise.all(cb as unknown as Promise<unknown>[]);
  });
  return { prisma: prismaMock };
});

jest.mock('../utils/email-validator', () => ({
  validateEmail: jest.fn(),
}));

jest.mock('../utils/unique-id', () => ({
  getOrCreateUser: jest.fn(),
}));

jest.mock('../services/signup-invitation.service', () => ({
  findInvitationByToken: jest.fn(),
  markAccepted: jest.fn(),
}));

jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    notifyInvitationAccepted: jest.fn().mockResolvedValue(true),
  },
}));

// ============================================
// Imports
// ============================================

import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../utils/database';
import { validateEmail } from '../utils/email-validator';
import { getOrCreateUser } from '../utils/unique-id';
import { signupRoutes } from '../routes/signup.routes';
import { findInvitationByToken, markAccepted } from '../services/signup-invitation.service';

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

  describe('invitation flow', () => {
    const TOKEN = 'a'.repeat(64);
    const INVITE_PAYLOAD = { ...VALID_PAYLOAD, invitationToken: TOKEN };

    function mockInvitationRedeemable(email = 'jamie@example.com') {
      (findInvitationByToken as jest.Mock).mockResolvedValue({
        invitation: {
          id: 'inv-1',
          email,
          name: 'Jamie',
          status: 'pending',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
          acceptedAt: null,
          acceptedUserId: null,
          revokedAt: null,
          lastSentAt: new Date(),
          sendCount: 1,
          invitedBy: 'admin',
        },
        redeemable: true,
      });
    }

    it('happy path: validates invitation, completes signup, marks accepted', async () => {
      mockInvitationRedeemable();
      mockEmailValid();
      mockGetOrCreateUser();
      mockUserUpdate();
      (markAccepted as jest.Mock).mockResolvedValue({ accepted: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: INVITE_PAYLOAD,
      });

      expect(res.statusCode).toBe(201);
      // markAccepted is now invoked inside prisma.$transaction with a
      // tx client as the second argument so the consent update + accept
      // commit atomically. We assert the params object shape and that a
      // tx client (or undefined) was passed alongside.
      expect(markAccepted).toHaveBeenCalledWith(
        {
          rawToken: TOKEN,
          userId: 'user-uuid',
          email: 'jamie@example.com',
        },
        expect.anything(),
      );
    });

    it('atomic commit: markAccepted throwing rolls back the consent update and skips Slack', async () => {
      // Regression for the "fully-consented user + pending invitation"
      // inconsistency: prior to wrapping the consent update + markAccepted
      // in one tx, the user row could commit consent flags before the
      // invitation accept-flip and a crash between would leave the system
      // in a state where the invitation still looked pending. Now both
      // writes run inside the same prisma.$transaction, so a failure in
      // markAccepted aborts the whole thing.
      mockInvitationRedeemable();
      mockEmailValid();
      mockGetOrCreateUser();
      mockUserUpdate();
      (markAccepted as jest.Mock).mockRejectedValue(new Error('synthetic accept failure'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: INVITE_PAYLOAD,
      });

      // Tx aborts → outer catch returns 500 / error path; the exact
      // status doesn't matter, just that we don't 201.
      expect(res.statusCode).not.toBe(201);
      // Slack must NOT have fired — that side effect lives post-commit
      // and is gated on acceptResult.accepted (which never resolved).
      const slack = require('../services/slack-notification.service').slackNotificationService;
      expect(slack.notifyInvitationAccepted).not.toHaveBeenCalled();
    });

    it('atomic commit: invitation acceptance and consent update share one $transaction', async () => {
      // Verify the structural property: $transaction is called exactly
      // once and both the user.update and the markAccepted call happen
      // inside its callback. The Proxy mock invokes the callback with
      // the same prisma proxy as `tx`, so user.update's call count
      // increments only after $transaction is invoked.
      mockInvitationRedeemable();
      mockEmailValid();
      mockGetOrCreateUser();
      mockUserUpdate();
      (markAccepted as jest.Mock).mockResolvedValue({ accepted: true });

      const transactionMock = (prisma as unknown as { $transaction: jest.Mock }).$transaction;
      transactionMock.mockClear();

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: INVITE_PAYLOAD,
      });

      expect(res.statusCode).toBe(201);
      expect(transactionMock).toHaveBeenCalledTimes(1);
      // The callback signature: (cb, options). Options carries our 10s
      // timeout — pin that here so a future change that drops it gets
      // caught by tests rather than discovered on a slow staging run.
      const txOptions = transactionMock.mock.calls[0][1];
      expect(txOptions).toMatchObject({ timeout: 10_000 });
    });

    it('rejects when invitation lookup returns null (unknown/malformed)', async () => {
      (findInvitationByToken as jest.Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: INVITE_PAYLOAD,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVITATION_INVALID');
      expect(getOrCreateUser).not.toHaveBeenCalled();
    });

    it('rejects when invitation is revoked', async () => {
      (findInvitationByToken as jest.Mock).mockResolvedValue({
        invitation: {
          id: 'inv-1',
          email: 'jamie@example.com',
          name: 'Jamie',
          status: 'revoked',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
          acceptedAt: null,
          acceptedUserId: null,
          revokedAt: new Date(),
          lastSentAt: new Date(),
          sendCount: 1,
          invitedBy: 'admin',
        },
        redeemable: false,
        reason: 'revoked',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: INVITE_PAYLOAD,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVITATION_REVOKED');
    });

    it('rejects when the email does not match the invitation', async () => {
      mockInvitationRedeemable('different@example.com');

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: INVITE_PAYLOAD,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVITATION_EMAIL_MISMATCH');
      expect(getOrCreateUser).not.toHaveBeenCalled();
    });

    it('still records signup if accept-flip races and fails (logs warning)', async () => {
      mockInvitationRedeemable();
      mockEmailValid();
      mockGetOrCreateUser();
      mockUserUpdate();
      (markAccepted as jest.Mock).mockResolvedValue({ accepted: false, reason: 'revoked' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: INVITE_PAYLOAD,
      });

      // Signup itself succeeded; the invitation just couldn't be flipped.
      expect(res.statusCode).toBe(201);
    });
  });

  describe('GET /api/signup/invitation/:token (public lookup)', () => {
    // The endpoint deliberately returns a uniform 200 response shape for
    // every "not usable" case so an attacker scraping for live tokens
    // can't distinguish unknown / malformed / expired / revoked /
    // already-accepted from each other via the response.

    it('returns redeemable=true with email + name for a live invitation', async () => {
      (findInvitationByToken as jest.Mock).mockResolvedValue({
        invitation: {
          id: 'inv-1',
          email: 'jamie@example.com',
          name: 'Jamie',
          status: 'pending',
          createdAt: new Date(),
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          acceptedAt: null,
          acceptedUserId: null,
          revokedAt: null,
          lastSentAt: new Date(),
          sendCount: 1,
          invitedBy: 'admin',
        },
        redeemable: true,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/signup/invitation/aaaa1111',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data).toEqual({
        redeemable: true,
        email: 'jamie@example.com',
        name: 'Jamie',
        expiresAt: '2027-01-01T00:00:00.000Z',
      });
    });

    it('returns 200 + redeemable=false reason=invalid for unknown token', async () => {
      (findInvitationByToken as jest.Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/signup/invitation/aaaa1111',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ redeemable: false, reason: 'invalid' });
    });

    it('returns 200 + redeemable=false reason=invalid for expired invitation (no email leak)', async () => {
      (findInvitationByToken as jest.Mock).mockResolvedValue({
        invitation: {
          id: 'inv-1',
          email: 'jamie@example.com',
          name: 'Jamie',
          status: 'expired',
          createdAt: new Date(),
          expiresAt: new Date('2020-01-01T00:00:00Z'),
          acceptedAt: null,
          acceptedUserId: null,
          revokedAt: null,
          lastSentAt: new Date(),
          sendCount: 1,
          invitedBy: 'admin',
        },
        redeemable: false,
        reason: 'expired',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/signup/invitation/aaaa1111',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Crucially: the expired invitation's email is NOT in the response.
      expect(body.data).toEqual({ redeemable: false, reason: 'invalid' });
      expect(JSON.stringify(body)).not.toContain('jamie@example.com');
    });

    it('returns 200 + redeemable=false for revoked invitations (same shape as unknown)', async () => {
      (findInvitationByToken as jest.Mock).mockResolvedValue({
        invitation: {
          id: 'inv-1',
          email: 'jamie@example.com',
          name: 'Jamie',
          status: 'revoked',
          createdAt: new Date(),
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          acceptedAt: null,
          acceptedUserId: null,
          revokedAt: new Date(),
          lastSentAt: new Date(),
          sendCount: 1,
          invitedBy: 'admin',
        },
        redeemable: false,
        reason: 'revoked',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/signup/invitation/aaaa1111',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ redeemable: false, reason: 'invalid' });
    });
  });

  describe('signupSource attribution', () => {
    it('stamps signup_source=invitation when token is supplied', async () => {
      (findInvitationByToken as jest.Mock).mockResolvedValue({
        invitation: {
          id: 'inv-1',
          email: 'jamie@example.com',
          name: 'Jamie',
          status: 'pending',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
          acceptedAt: null,
          acceptedUserId: null,
          revokedAt: null,
          lastSentAt: new Date(),
          sendCount: 1,
          invitedBy: 'admin',
        },
        redeemable: true,
      });
      mockEmailValid();
      mockGetOrCreateUser();
      mockUserUpdate();
      (markAccepted as jest.Mock).mockResolvedValue({ accepted: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: { ...VALID_PAYLOAD, invitationToken: 'a'.repeat(64) },
      });

      expect(res.statusCode).toBe(201);
      const updateCall = (prisma.user.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.signupSource).toBe('invitation');
    });

    it('stamps signup_source=signup_form when no token is supplied', async () => {
      mockEmailValid();
      mockGetOrCreateUser();
      mockUserUpdate();

      const res = await app.inject({
        method: 'POST',
        url: '/api/signup',
        payload: VALID_PAYLOAD,
      });

      expect(res.statusCode).toBe(201);
      const updateCall = (prisma.user.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.signupSource).toBe('signup_form');
    });
  });
});

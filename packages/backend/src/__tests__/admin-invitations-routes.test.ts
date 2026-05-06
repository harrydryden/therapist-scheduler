/**
 * Tests for admin signup-invitation routes.
 *
 * Covers auth, create + email, list with status filters, revoke, resend,
 * and the invariant that an existing pending invitation for the same email
 * is auto-revoked when a new one is issued.
 */

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

// Hoist-safe Prisma mock: the factory creates a fresh object on first
// call, then both the route module and the test reach into it via the
// `prisma` export. `$transaction` is a jest.fn that just invokes the
// callback with the same proxy as `tx`, so service-level code that does
// `prisma.$transaction(async tx => tx.signupInvitation.updateMany(...))`
// reads through to the per-test mocks set in beforeEach.
jest.mock('../utils/database', () => {
  const target: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(target, {
    get(t, prop: string | symbol) {
      if (prop === '$transaction') {
        return jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(proxy));
      }
      return t[prop as string];
    },
    set(t, prop: string | symbol, value: unknown) {
      t[prop as string] = value;
      return true;
    },
  });
  return { prisma: proxy };
});

jest.mock('../utils/email-validator', () => ({
  validateEmail: jest.fn().mockResolvedValue({
    isValid: true,
    errors: [],
    warnings: [],
    suggestions: [],
  }),
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn().mockResolvedValue(14),
  getSettingValues: jest.fn().mockResolvedValue(
    new Map([
      ['email.invitationSubject', 'Subject {recipientName}'],
      ['email.invitationBody', 'Hi {recipientName}, link: {invitationUrl}, expires {expiryDate}'],
    ]),
  ),
}));

jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../utils/redis', () => ({
  cacheManager: {
    getString: jest.fn().mockResolvedValue(null),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn(),
    set: jest.fn(),
  },
}));

import Fastify, { FastifyInstance } from 'fastify';
import { adminInvitationRoutes } from '../routes/admin-invitations.routes';
import { emailProcessingService } from '../services/email-processing.service';
import { prisma } from '../utils/database';

// Pull the proxy back out so we can attach mocks per test. Cast through
// unknown because the proxy is otherwise typed as the real PrismaClient.
const mockPrisma = prisma as unknown as Record<string, unknown>;

const WEBHOOK_SECRET = 'test-webhook-secret';

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(adminInvitationRoutes);
  return app;
}

interface InvitationRow {
  id: string;
  email: string;
  name: string | null;
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedUserId: string | null;
  revokedAt: Date | null;
  lastSentAt: Date;
  sendCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function makeRow(overrides: Partial<InvitationRow> = {}): InvitationRow {
  const now = new Date();
  return {
    id: 'inv-1',
    email: 'jamie@example.com',
    name: null,
    tokenHash: 'a'.repeat(64),
    invitedBy: 'admin',
    expiresAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
    acceptedAt: null,
    acceptedUserId: null,
    revokedAt: null,
    lastSentAt: now,
    sendCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('admin invitation routes', () => {
  let app: FastifyInstance;
  let signupInvitation: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    signupInvitation = {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    mockPrisma.signupInvitation = signupInvitation;
    mockPrisma.$queryRaw = jest.fn().mockResolvedValue([
      { total: 0n, pending: 0n, accepted: 0n, revoked: 0n, expired: 0n },
    ]);
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('authentication', () => {
    it('rejects without webhook secret', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/invitations' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects with wrong secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/invitations',
        headers: { 'x-webhook-secret': 'wrong' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/admin/invitations', () => {
    it('creates a row, auto-revokes prior pending invites for the email, and emails the invitee', async () => {
      signupInvitation.create.mockResolvedValue(makeRow());

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invitations',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET, 'content-type': 'application/json' },
        payload: { email: 'jamie@example.com', name: 'Jamie', invitedBy: 'Harry' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.invitation.email).toBe('jamie@example.com');
      expect(body.data.invitation.status).toBe('pending');
      expect(body.data.invitationUrl).toMatch(
        /^https:\/\/backend\.test\/signup\?invite=[a-f0-9]{64}$/,
      );
      expect(body.data.emailSent).toBe(true);

      // updateMany ran inside the transaction to revoke prior pending invites
      expect(signupInvitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            email: 'jamie@example.com',
            acceptedAt: null,
            revokedAt: null,
          }),
          data: { revokedAt: expect.any(Date) },
        }),
      );

      // sendEmail called with rendered subject + body
      expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('honours sendEmail=false (admin shares link manually)', async () => {
      signupInvitation.create.mockResolvedValue(makeRow());

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invitations',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET, 'content-type': 'application/json' },
        payload: { email: 'jamie@example.com', sendEmail: false },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().data.emailSent).toBe(false);
      expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
    });

    it('rejects malformed email at the gate', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invitations',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET, 'content-type': 'application/json' },
        payload: { email: 'not-an-email' },
      });
      expect(res.statusCode).toBe(400);
      expect(signupInvitation.create).not.toHaveBeenCalled();
    });

    it('uses --expiryDays override when provided', async () => {
      signupInvitation.create.mockResolvedValue(makeRow());

      await app.inject({
        method: 'POST',
        url: '/api/admin/invitations',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET, 'content-type': 'application/json' },
        payload: { email: 'jamie@example.com', expiryDays: 30, sendEmail: false },
      });

      const createCall = signupInvitation.create.mock.calls[0][0];
      const ttlMs = createCall.data.expiresAt.getTime() - Date.now();
      // ~30 days, allowing some slack for test execution time
      expect(ttlMs).toBeGreaterThan(29.9 * 24 * 60 * 60 * 1000);
      expect(ttlMs).toBeLessThan(30.1 * 24 * 60 * 60 * 1000);
    });
  });

  describe('GET /api/admin/invitations', () => {
    it('returns paginated list with summary', async () => {
      signupInvitation.findMany.mockResolvedValue([makeRow()]);
      signupInvitation.count.mockResolvedValue(1);
      mockPrisma.$queryRaw = jest.fn().mockResolvedValue([
        { total: 7n, pending: 3n, accepted: 2n, revoked: 1n, expired: 1n },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/invitations',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.items).toHaveLength(1);
      expect(body.data.summary).toEqual({
        total: 7, pending: 3, accepted: 2, revoked: 1, expired: 1,
      });
    });

    it('filters by status=pending', async () => {
      signupInvitation.findMany.mockResolvedValue([]);
      signupInvitation.count.mockResolvedValue(0);

      await app.inject({
        method: 'GET',
        url: '/api/admin/invitations?status=pending',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const where = signupInvitation.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      });
    });
  });

  describe('POST /api/admin/invitations/:id/revoke', () => {
    it('revokes a pending invitation', async () => {
      signupInvitation.findUnique.mockResolvedValue(makeRow());
      signupInvitation.update.mockResolvedValue(makeRow({ revokedAt: new Date() }));

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invitations/inv-1/revoke',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('revoked');
    });

    it('returns 400 when invitation is already accepted', async () => {
      signupInvitation.findUnique.mockResolvedValue(
        makeRow({ acceptedAt: new Date(), acceptedUserId: 'u-1' }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invitations/inv-1/revoke',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for unknown id', async () => {
      signupInvitation.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invitations/missing/revoke',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/admin/invitations/:id/resend', () => {
    it('resends and bumps sendCount', async () => {
      signupInvitation.findUnique.mockResolvedValue(makeRow({ sendCount: 1 }));
      signupInvitation.update.mockResolvedValue(makeRow({ sendCount: 2 }));

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invitations/inv-1/resend',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.invitation.sendCount).toBe(2);
      expect(res.json().data.emailSent).toBe(true);
      expect(emailProcessingService.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('refuses to resend a non-pending invitation', async () => {
      signupInvitation.findUnique.mockResolvedValue(
        makeRow({ revokedAt: new Date() }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invitations/inv-1/resend',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(400);
      expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
    });
  });
});

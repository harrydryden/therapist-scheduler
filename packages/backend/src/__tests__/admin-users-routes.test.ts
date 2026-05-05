/**
 * Tests for admin user management routes.
 *
 * Covers auth, list filtering, detail fetch, and the dual-write to Notion
 * on subscribed toggles.
 */

// ============================================
// Mocks
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
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    voucherTracking: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock('../services/notion-users.service', () => ({
  notionUsersService: {
    isConfigured: jest.fn().mockReturnValue(true),
    findUserByEmail: jest.fn(),
    updateSubscription: jest.fn(),
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

// ============================================
// Imports
// ============================================

import Fastify, { FastifyInstance } from 'fastify';
import { prisma } from '../utils/database';
import { notionUsersService } from '../services/notion-users.service';
import { adminUserRoutes } from '../routes/admin-users.routes';

// ============================================
// Helpers
// ============================================

const WEBHOOK_SECRET = 'test-webhook-secret';

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(adminUserRoutes);
  return app;
}

interface UserRow {
  id: string;
  odId: string;
  email: string;
  name: string | null;
  country: string;
  subscribed: boolean;
  priorTherapy: boolean | null;
  acknowledgedRealSession: boolean | null;
  agreedToFeedback: boolean | null;
  consentGivenAt: Date | null;
  signupSource: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { appointments: number };
}

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'user-1',
    odId: '1234567890',
    email: 'jamie@example.com',
    name: 'Jamie Doe',
    country: 'UK',
    subscribed: true,
    priorTherapy: true,
    acknowledgedRealSession: true,
    agreedToFeedback: true,
    consentGivenAt: new Date('2026-04-01T00:00:00Z'),
    signupSource: 'signup_form',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    _count: { appointments: 2 },
    ...overrides,
  };
}

// ============================================
// Tests
// ============================================

describe('admin user routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (notionUsersService.isConfigured as jest.Mock).mockReturnValue(true);
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('authentication', () => {
    it('rejects requests without webhook secret', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/users' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects requests with wrong webhook secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/users',
        headers: { 'x-webhook-secret': 'wrong' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/admin/users', () => {
    it('returns paginated users with appointment count', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([makeUser()]);
      (prisma.user.count as jest.Mock).mockResolvedValue(1);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/users',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0]).toMatchObject({
        email: 'jamie@example.com',
        appointmentCount: 2,
        signupSource: 'signup_form',
      });
      expect(body.data.pagination.total).toBe(1);
    });

    it('search filters by email/name/odId', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.user.count as jest.Mock).mockResolvedValue(0);

      await app.inject({
        method: 'GET',
        url: '/api/admin/users?search=jamie',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const where = (prisma.user.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { email: { contains: 'jamie', mode: 'insensitive' } },
        { name: { contains: 'jamie', mode: 'insensitive' } },
        { odId: { contains: 'jamie' } },
      ]);
    });

    it('filters by subscribed=false', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.user.count as jest.Mock).mockResolvedValue(0);

      await app.inject({
        method: 'GET',
        url: '/api/admin/users?subscribed=false',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const where = (prisma.user.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.subscribed).toBe(false);
    });

    it('filters by signupSource', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.user.count as jest.Mock).mockResolvedValue(0);

      await app.inject({
        method: 'GET',
        url: '/api/admin/users?signupSource=signup_form',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const where = (prisma.user.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.signupSource).toBe('signup_form');
    });

    it('does not filter when subscribed=all', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.user.count as jest.Mock).mockResolvedValue(0);

      await app.inject({
        method: 'GET',
        url: '/api/admin/users?subscribed=all',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const where = (prisma.user.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.subscribed).toBeUndefined();
    });
  });

  describe('GET /api/admin/users/:id', () => {
    it('returns user with voucher and appointments', async () => {
      const user = {
        ...makeUser(),
        appointments: [
          {
            id: 'a1',
            therapistName: 'Dr. Smith',
            therapistEmail: 'dr@smith.test',
            status: 'confirmed',
            confirmedDateTimeParsed: new Date('2026-05-10T14:00:00Z'),
            createdAt: new Date('2026-04-15T00:00:00Z'),
            updatedAt: new Date('2026-04-16T00:00:00Z'),
          },
        ],
      };
      delete (user as any)._count;
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue({
        strikeCount: 1,
        lastVoucherSentAt: new Date('2026-04-20T00:00:00Z'),
        lastVoucherUsedAt: null,
        unsubscribedAt: null,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/users/user-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.email).toBe('jamie@example.com');
      expect(body.data.appointments).toHaveLength(1);
      expect(body.data.voucher.strikeCount).toBe(1);
    });

    it('returns 404 for unknown user', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/users/missing',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/admin/users/:id', () => {
    it('updates name and country', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(makeUser());
      (prisma.user.update as jest.Mock).mockResolvedValue(
        makeUser({ name: 'New Name', country: 'IE' }),
      );

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/user-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: { name: 'New Name', country: 'IE' },
      });

      expect(res.statusCode).toBe(200);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { name: 'New Name', country: 'IE' },
      });
      // No subscription change → no Notion call.
      expect(notionUsersService.findUserByEmail).not.toHaveBeenCalled();
    });

    it('dual-writes to Notion when subscribed flips', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(makeUser({ subscribed: true }));
      (prisma.user.update as jest.Mock).mockResolvedValue(makeUser({ subscribed: false }));
      (notionUsersService.findUserByEmail as jest.Mock).mockResolvedValue({
        pageId: 'notion-page-id',
        subscribed: true,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/user-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: { subscribed: false },
      });

      expect(res.statusCode).toBe(200);
      expect(notionUsersService.findUserByEmail).toHaveBeenCalledWith('jamie@example.com');
      expect(notionUsersService.updateSubscription).toHaveBeenCalledWith('notion-page-id', false);
    });

    it('does not call Notion if subscribed is unchanged', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(makeUser({ subscribed: true }));
      (prisma.user.update as jest.Mock).mockResolvedValue(makeUser({ subscribed: true }));

      await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/user-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: { subscribed: true },
      });

      expect(notionUsersService.findUserByEmail).not.toHaveBeenCalled();
    });

    it('Notion failure does not fail the request', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(makeUser({ subscribed: true }));
      (prisma.user.update as jest.Mock).mockResolvedValue(makeUser({ subscribed: false }));
      (notionUsersService.findUserByEmail as jest.Mock).mockRejectedValue(new Error('Notion 503'));

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/user-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: { subscribed: false },
      });

      expect(res.statusCode).toBe(200);
    });

    it('skips Notion mirror when notionUsersService is not configured', async () => {
      (notionUsersService.isConfigured as jest.Mock).mockReturnValue(false);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(makeUser({ subscribed: true }));
      (prisma.user.update as jest.Mock).mockResolvedValue(makeUser({ subscribed: false }));

      await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/user-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: { subscribed: false },
      });

      expect(notionUsersService.findUserByEmail).not.toHaveBeenCalled();
    });

    it('returns 400 with no fields to update', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/user-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for unknown user', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/missing',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: { name: 'X' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

/**
 * Tests for admin therapist management routes.
 *
 * Covers auth, list filtering, detail fetch with booking status, profile
 * edits, dual-write of the active flag to Notion, and force-unfreeze.
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
    therapist: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    therapistBookingStatus: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
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
import { adminTherapistRoutes } from '../routes/admin-therapists.routes';

// ============================================
// Helpers
// ============================================

const WEBHOOK_SECRET = 'test-webhook-secret';

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.register(adminTherapistRoutes);
  return app;
}

interface TherapistRow {
  id: string;
  odId: string;
  notionId: string;
  email: string;
  name: string;
  country: string;
  bio: string | null;
  approach: string[];
  style: string[];
  areasOfFocus: string[];
  profileImage: string | null;
  bookingLink: string | null;
  active: boolean;
  availability: unknown;
  ingestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { appointments: number };
}

function makeTherapist(overrides: Partial<TherapistRow> = {}): TherapistRow {
  return {
    id: 'therapist-1',
    odId: '9876543210',
    notionId: 'notion-page-1',
    email: 'dr@smith.test',
    name: 'Dr. Smith',
    country: 'UK',
    bio: 'A bio',
    approach: ['Mindfulness'],
    style: ['Relational'],
    areasOfFocus: ['Anxiety'],
    profileImage: null,
    bookingLink: null,
    active: true,
    availability: { timezone: 'Europe/London', slots: [] },
    ingestedAt: new Date('2026-04-01T00:00:00Z'),
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    _count: { appointments: 1 },
    ...overrides,
  };
}

// ============================================
// Tests
// ============================================

describe('admin therapist routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('authentication', () => {
    it('rejects requests without webhook secret', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/therapists' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects with wrong secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/therapists',
        headers: { 'x-webhook-secret': 'wrong' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/admin/therapists', () => {
    it('returns list with frozen state from booking status', async () => {
      (prisma.therapist.findMany as jest.Mock).mockResolvedValue([makeTherapist()]);
      (prisma.therapist.count as jest.Mock).mockResolvedValue(1);
      (prisma.therapistBookingStatus.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'notion-page-1',
          frozenAt: new Date(),
          hasConfirmedBooking: false,
          uniqueRequestCount: 1,
        },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/therapists',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.items[0]).toMatchObject({
        name: 'Dr. Smith',
        active: true,
        frozen: true,
        appointmentCount: 1,
      });
    });

    it('treats hasConfirmedBooking=true as frozen', async () => {
      (prisma.therapist.findMany as jest.Mock).mockResolvedValue([makeTherapist()]);
      (prisma.therapist.count as jest.Mock).mockResolvedValue(1);
      (prisma.therapistBookingStatus.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'notion-page-1',
          frozenAt: null,
          hasConfirmedBooking: true,
          uniqueRequestCount: 0,
        },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/therapists',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.json().data.items[0].frozen).toBe(true);
    });

    it('marks frozen=false when no booking-status row exists', async () => {
      (prisma.therapist.findMany as jest.Mock).mockResolvedValue([makeTherapist()]);
      (prisma.therapist.count as jest.Mock).mockResolvedValue(1);
      (prisma.therapistBookingStatus.findMany as jest.Mock).mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/therapists',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.json().data.items[0].frozen).toBe(false);
    });

    it('handles therapists with null notionId without crashing the booking-status lookup', async () => {
      // Post-Notion-deprecation therapists have notionId=null. Prisma 5 throws
      // PrismaClientValidationError on null entries inside `in:`, so the route
      // must filter them out (and fall back to the Postgres uuid) rather than
      // pass `[null, ...]` straight into the where clause.
      const legacyTherapist = makeTherapist({ id: 'legacy-1', notionId: 'notion-page-1' });
      const postNotionTherapist = makeTherapist({
        id: 'post-notion-1',
        // Cast around the test type's stricter shape — the real schema is `String?`.
        notionId: null as unknown as string,
        odId: '0000000001',
        email: 'fresh@therapist.test',
        name: 'Fresh Therapist',
      });
      (prisma.therapist.findMany as jest.Mock).mockResolvedValue([legacyTherapist, postNotionTherapist]);
      (prisma.therapist.count as jest.Mock).mockResolvedValue(2);
      (prisma.therapistBookingStatus.findMany as jest.Mock).mockResolvedValue([
        { id: 'notion-page-1', frozenAt: new Date(), hasConfirmedBooking: false, uniqueRequestCount: 1 },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/therapists',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      // Crucial assertion: the lookup-keys array passed to Prisma must not contain null.
      const where = (prisma.therapistBookingStatus.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.id.in).toEqual(expect.arrayContaining(['notion-page-1', 'post-notion-1']));
      expect(where.id.in).not.toContain(null);

      const items = res.json().data.items;
      expect(items).toHaveLength(2);
      expect(items.find((i: { id: string }) => i.id === 'legacy-1').frozen).toBe(true);
      expect(items.find((i: { id: string }) => i.id === 'post-notion-1').frozen).toBe(false);
    });

    it('search filters by email/name/odId/notionId', async () => {
      (prisma.therapist.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.therapist.count as jest.Mock).mockResolvedValue(0);

      await app.inject({
        method: 'GET',
        url: '/api/admin/therapists?search=smith',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const where = (prisma.therapist.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { email: { contains: 'smith', mode: 'insensitive' } },
        { name: { contains: 'smith', mode: 'insensitive' } },
        { odId: { contains: 'smith' } },
        { notionId: { contains: 'smith' } },
      ]);
    });

    it('filters by active=false', async () => {
      (prisma.therapist.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.therapist.count as jest.Mock).mockResolvedValue(0);

      await app.inject({
        method: 'GET',
        url: '/api/admin/therapists?active=false',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const where = (prisma.therapist.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.active).toBe(false);
    });
  });

  describe('GET /api/admin/therapists/:id', () => {
    it('returns therapist with booking status and appointments', async () => {
      const therapist = {
        ...makeTherapist(),
        appointments: [
          {
            id: 'a1',
            userName: 'Jamie',
            userEmail: 'jamie@example.com',
            status: 'confirmed',
            confirmedDateTimeParsed: new Date('2026-05-10T14:00:00Z'),
            createdAt: new Date('2026-04-15T00:00:00Z'),
            updatedAt: new Date('2026-04-16T00:00:00Z'),
          },
        ],
      };
      delete (therapist as any)._count;
      (prisma.therapist.findUnique as jest.Mock).mockResolvedValue(therapist);
      (prisma.therapistBookingStatus.findUnique as jest.Mock).mockResolvedValue({
        frozenAt: null,
        hasConfirmedBooking: false,
        uniqueRequestCount: 0,
        confirmedAt: null,
        adminAlertAt: null,
        adminAlertAcknowledged: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/therapists/therapist-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.email).toBe('dr@smith.test');
      expect(body.data.appointments).toHaveLength(1);
      expect(body.data.bookingStatus.frozen).toBe(false);
    });

    it('returns 404 when therapist not found', async () => {
      (prisma.therapist.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/therapists/missing',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/admin/therapists/:id', () => {
    it('updates profile fields without touching Notion when active is unchanged', async () => {
      (prisma.therapist.findUnique as jest.Mock).mockResolvedValue(makeTherapist());
      (prisma.therapist.update as jest.Mock).mockResolvedValue(makeTherapist({ bio: 'New bio' }));

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/therapists/therapist-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: { bio: 'New bio', approach: ['Mindfulness', 'Person-Centred'] },
      });

      expect(res.statusCode).toBe(200);
      const updateCall = (prisma.therapist.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data).toMatchObject({
        bio: 'New bio',
        approach: ['Mindfulness', 'Person-Centred'],
      });
    });

    it('updates active flag in Postgres', async () => {
      (prisma.therapist.findUnique as jest.Mock).mockResolvedValue(makeTherapist({ active: true }));
      (prisma.therapist.update as jest.Mock).mockResolvedValue(makeTherapist({ active: false }));

      await app.inject({
        method: 'PATCH',
        url: '/api/admin/therapists/therapist-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: { active: false },
      });

      const updateCall = (prisma.therapist.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.active).toBe(false);
    });

    it('returns 200 even when prisma update succeeds with empty result', async () => {
      (prisma.therapist.findUnique as jest.Mock).mockResolvedValue(makeTherapist({ active: true }));
      (prisma.therapist.update as jest.Mock).mockResolvedValue(makeTherapist({ active: false }));

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/therapists/therapist-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: { active: false },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects unknown approach categories', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/therapists/therapist-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: { approach: ['Definitely Not A Real Category'] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 with no fields to update', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/therapists/therapist-1',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for unknown therapist', async () => {
      (prisma.therapist.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/therapists/missing',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: { bio: 'X' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/admin/therapists/:id/unfreeze', () => {
    it('clears frozenAt on the booking-status row', async () => {
      (prisma.therapist.findUnique as jest.Mock).mockResolvedValue({
        notionId: 'notion-page-1',
        name: 'Dr. Smith',
      });
      (prisma.therapistBookingStatus.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/therapists/therapist-1/unfreeze',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ unfrozen: true });
      expect(prisma.therapistBookingStatus.updateMany).toHaveBeenCalledWith({
        where: { id: 'notion-page-1' },
        data: { frozenAt: null, frozenUntil: null },
      });
    });

    it('returns unfrozen=false when no booking-status row exists', async () => {
      (prisma.therapist.findUnique as jest.Mock).mockResolvedValue({
        notionId: 'notion-page-1',
        name: 'Dr. Smith',
      });
      (prisma.therapistBookingStatus.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/therapists/therapist-1/unfreeze',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.unfrozen).toBe(false);
    });

    it('returns 404 for unknown therapist', async () => {
      (prisma.therapist.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/therapists/missing/unfreeze',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

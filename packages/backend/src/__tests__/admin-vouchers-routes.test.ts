/**
 * Tests for admin voucher management routes
 *
 * Covers: listing, get-by-email, issue, reset-strikes, resubscribe, revoke
 * Tests authentication, status computation, Notion sync, and edge cases.
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
    voucherTracking: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(),
}));

jest.mock('../services/email-processing.service', () => ({
  emailProcessingService: {
    sendEmail: jest.fn(),
  },
}));

jest.mock('../services/notion-users.service', () => ({
  notionUsersService: {
    findUserByEmail: jest.fn(),
    updateSubscription: jest.fn(),
  },
}));

jest.mock('../utils/unsubscribe-token', () => ({
  generateUnsubscribeUrl: jest.fn().mockReturnValue('https://backend.test/unsubscribe/token'),
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

import Fastify from 'fastify';
import { prisma } from '../utils/database';
import { getSettingValue } from '../services/settings.service';
import { emailProcessingService } from '../services/email-processing.service';
import { notionUsersService } from '../services/notion-users.service';
import { adminVoucherRoutes } from '../routes/admin-vouchers.routes';
import { generateVoucherToken } from '../utils/voucher-token';

// ============================================
// Helpers
// ============================================

const WEBHOOK_SECRET = 'test-webhook-secret';

function buildApp() {
  const app = Fastify();
  app.register(adminVoucherRoutes);
  return app;
}

function defaultSettings(key: string): unknown {
  const map: Record<string, unknown> = {
    'voucher.expiryDays': 14,
    'voucher.maxStrikes': 3,
    'weeklyMailing.webAppUrl': 'https://app.test',
    'email.weeklyMailingSubject': 'Your session code: {{voucherCode}}',
    'email.weeklyMailingBody': 'Hi {{userName}}, code: {{voucherCode}} expires {{voucherExpiry}}. {{webAppUrl}} {{unsubscribeUrl}}',
  };
  return map[key];
}

/** Create a fake VoucherTracking DB record */
function makeRecord(overrides: Partial<{
  id: string;
  strikeCount: number;
  lastVoucherSentAt: Date | null;
  lastVoucherToken: string | null;
  lastVoucherUsedAt: Date | null;
  reminderSentAt: Date | null;
  unsubscribedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: 'user@example.com',
    strikeCount: 0,
    lastVoucherSentAt: new Date(),
    lastVoucherToken: generateVoucherToken('user@example.com').token,
    lastVoucherUsedAt: null,
    reminderSentAt: null,
    unsubscribedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date(),
    ...overrides,
  };
}

const defaultSummaryRow = [{
  total: 10n,
  active: 3n,
  used: 2n,
  at_risk: 1n,
  unsubscribed: 1n,
}];

// ============================================
// Tests
// ============================================

describe('Admin Voucher Routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    jest.clearAllMocks();
    (getSettingValue as jest.Mock).mockImplementation(defaultSettings);
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // ---- Authentication ----

  describe('authentication', () => {
    it('rejects requests without webhook secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers',
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects requests with wrong webhook secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers',
        headers: { 'x-webhook-secret': 'wrong-secret' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ---- GET /api/admin/vouchers ----

  describe('GET /api/admin/vouchers', () => {
    it('returns paginated list with summary stats', async () => {
      const record = makeRecord();
      (prisma.$queryRaw as jest.Mock).mockResolvedValue(defaultSummaryRow);
      (prisma.voucherTracking.findMany as jest.Mock).mockResolvedValue([record]);
      (prisma.voucherTracking.count as jest.Mock).mockResolvedValue(1);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].email).toBe('user@example.com');
      expect(body.data.summary.total).toBe(10);
      expect(body.data.summary.active).toBe(3);
      expect(body.data.pagination.page).toBe(1);
    });

    it('computes status=active for fresh voucher with token', async () => {
      const record = makeRecord({
        lastVoucherSentAt: new Date(), // just issued
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue(defaultSummaryRow);
      (prisma.voucherTracking.findMany as jest.Mock).mockResolvedValue([record]);
      (prisma.voucherTracking.count as jest.Mock).mockResolvedValue(1);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const item = res.json().data.items[0];
      expect(item.status).toBe('active');
    });

    it('computes status=expired for old voucher', async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const record = makeRecord({
        lastVoucherSentAt: thirtyDaysAgo,
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue(defaultSummaryRow);
      (prisma.voucherTracking.findMany as jest.Mock).mockResolvedValue([record]);
      (prisma.voucherTracking.count as jest.Mock).mockResolvedValue(1);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const item = res.json().data.items[0];
      expect(item.status).toBe('expired');
    });

    it('computes status=used when lastVoucherUsedAt > lastVoucherSentAt', async () => {
      const sentAt = new Date(Date.now() - 60 * 1000); // 1 minute ago
      const usedAt = new Date(); // just now
      const record = makeRecord({
        lastVoucherSentAt: sentAt,
        lastVoucherUsedAt: usedAt,
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue(defaultSummaryRow);
      (prisma.voucherTracking.findMany as jest.Mock).mockResolvedValue([record]);
      (prisma.voucherTracking.count as jest.Mock).mockResolvedValue(1);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const item = res.json().data.items[0];
      expect(item.status).toBe('used');
    });

    it('computes status=unsubscribed when unsubscribedAt is set', async () => {
      const record = makeRecord({
        unsubscribedAt: new Date(),
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue(defaultSummaryRow);
      (prisma.voucherTracking.findMany as jest.Mock).mockResolvedValue([record]);
      (prisma.voucherTracking.count as jest.Mock).mockResolvedValue(1);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers?status=unsubscribed',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const item = res.json().data.items[0];
      expect(item.status).toBe('unsubscribed');
    });

    it('unsubscribed takes priority over used', async () => {
      const record = makeRecord({
        lastVoucherSentAt: new Date(Date.now() - 60_000),
        lastVoucherUsedAt: new Date(),
        unsubscribedAt: new Date(),
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue(defaultSummaryRow);
      (prisma.voucherTracking.findMany as jest.Mock).mockResolvedValue([record]);
      (prisma.voucherTracking.count as jest.Mock).mockResolvedValue(1);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.json().data.items[0].status).toBe('unsubscribed');
    });

    it('post-filters correctly for active status', async () => {
      const activeRecord = makeRecord({ lastVoucherSentAt: new Date() });
      const expiredRecord = makeRecord({
        id: 'old@example.com',
        lastVoucherSentAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue(defaultSummaryRow);
      // When filtering by active, both records come back from DB (pre-filter is loose)
      (prisma.voucherTracking.findMany as jest.Mock).mockResolvedValue([activeRecord, expiredRecord]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers?status=active',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      const body = res.json();
      // Only active record should survive post-filter
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].email).toBe('user@example.com');
      expect(body.data.pagination.total).toBe(1);
    });
  });

  // ---- GET /api/admin/vouchers/:email ----

  describe('GET /api/admin/vouchers/:email', () => {
    it('returns 404 for unknown email', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers/nobody@example.com',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns record with computed status and expiry', async () => {
      const record = makeRecord();
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(record);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers/user@example.com',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.email).toBe('user@example.com');
      expect(data.status).toBe('active');
      expect(data.expiresAt).toBeTruthy();
      expect(data.displayCode).toBeTruthy();
    });

    it('lowercases email parameter', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);

      await app.inject({
        method: 'GET',
        url: '/api/admin/vouchers/USER@Example.COM',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(prisma.voucherTracking.findUnique).toHaveBeenCalledWith({
        where: { id: 'user@example.com' },
      });
    });
  });

  // ---- POST /api/admin/vouchers/issue ----

  describe('POST /api/admin/vouchers/issue', () => {
    it('creates voucher and returns display code', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.voucherTracking.upsert as jest.Mock).mockResolvedValue({});
      (emailProcessingService.sendEmail as jest.Mock).mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/issue',
        headers: {
          'x-webhook-secret': WEBHOOK_SECRET,
          'content-type': 'application/json',
        },
        payload: { email: 'new@example.com', sendEmail: true },
      });

      expect(res.statusCode).toBe(201);
      const data = res.json().data;
      expect(data.email).toBe('new@example.com');
      expect(data.displayCode).toMatch(/^\w+-\w+-\w+$/); // word-word-word format
      expect(data.emailSent).toBe(true);
      expect(prisma.voucherTracking.upsert).toHaveBeenCalled();
    });

    it('returns emailSent=false when email sending fails', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.voucherTracking.upsert as jest.Mock).mockResolvedValue({});
      (emailProcessingService.sendEmail as jest.Mock).mockRejectedValue(new Error('SMTP down'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/issue',
        headers: {
          'x-webhook-secret': WEBHOOK_SECRET,
          'content-type': 'application/json',
        },
        payload: { email: 'user@example.com', sendEmail: true },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().data.emailSent).toBe(false);
      // Voucher was still created despite email failure
      expect(prisma.voucherTracking.upsert).toHaveBeenCalled();
    });

    it('skips email when sendEmail=false', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.voucherTracking.upsert as jest.Mock).mockResolvedValue({});

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/issue',
        headers: {
          'x-webhook-secret': WEBHOOK_SECRET,
          'content-type': 'application/json',
        },
        payload: { email: 'user@example.com', sendEmail: false },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().data.emailSent).toBe(false);
      expect(emailProcessingService.sendEmail).not.toHaveBeenCalled();
    });

    it('re-subscribes in Notion when issuing to previously unsubscribed user', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue({
        unsubscribedAt: new Date(),
      });
      (prisma.voucherTracking.upsert as jest.Mock).mockResolvedValue({});
      (notionUsersService.findUserByEmail as jest.Mock).mockResolvedValue({
        pageId: 'notion-page-123',
        email: 'unsub@example.com',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/issue',
        headers: {
          'x-webhook-secret': WEBHOOK_SECRET,
          'content-type': 'application/json',
        },
        payload: { email: 'unsub@example.com', sendEmail: false },
      });

      expect(res.statusCode).toBe(201);
      expect(notionUsersService.updateSubscription).toHaveBeenCalledWith('notion-page-123', true);
    });

    it('does not call Notion when user was not previously unsubscribed', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue({
        unsubscribedAt: null,
      });
      (prisma.voucherTracking.upsert as jest.Mock).mockResolvedValue({});

      await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/issue',
        headers: {
          'x-webhook-secret': WEBHOOK_SECRET,
          'content-type': 'application/json',
        },
        payload: { email: 'user@example.com', sendEmail: false },
      });

      expect(notionUsersService.findUserByEmail).not.toHaveBeenCalled();
    });

    it('resets strikeCount on upsert update path', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.voucherTracking.upsert as jest.Mock).mockResolvedValue({});

      await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/issue',
        headers: {
          'x-webhook-secret': WEBHOOK_SECRET,
          'content-type': 'application/json',
        },
        payload: { email: 'user@example.com', sendEmail: false },
      });

      const upsertCall = (prisma.voucherTracking.upsert as jest.Mock).mock.calls[0][0];
      expect(upsertCall.update.strikeCount).toBe(0);
      expect(upsertCall.update.unsubscribedAt).toBeNull();
      expect(upsertCall.update.reminderSentAt).toBeNull();
    });
  });

  // ---- POST /api/admin/vouchers/:email/reset-strikes ----

  describe('POST /api/admin/vouchers/:email/reset-strikes', () => {
    it('resets strikes and returns previous count', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(makeRecord({ strikeCount: 2 }));
      (prisma.voucherTracking.update as jest.Mock).mockResolvedValue({});

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/user@example.com/reset-strikes',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.strikeCount).toBe(0);
      expect(data.previousStrikes).toBe(2);
      expect(prisma.voucherTracking.update).toHaveBeenCalledWith({
        where: { id: 'user@example.com' },
        data: { strikeCount: 0 },
      });
    });

    it('returns 404 for unknown email', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/nobody@example.com/reset-strikes',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ---- POST /api/admin/vouchers/:email/resubscribe ----

  describe('POST /api/admin/vouchers/:email/resubscribe', () => {
    it('resubscribes user, resets strikes, issues voucher, and syncs Notion', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
        makeRecord({ unsubscribedAt: new Date(), strikeCount: 3 })
      );
      (prisma.voucherTracking.update as jest.Mock).mockResolvedValue({});
      (notionUsersService.findUserByEmail as jest.Mock).mockResolvedValue({
        pageId: 'notion-page-456',
        email: 'user@example.com',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/user@example.com/resubscribe',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.displayCode).toMatch(/^\w+-\w+-\w+$/);
      expect(data.notionUpdated).toBe(true);

      // Check DB update clears unsubscribedAt and resets strikes
      const updateCall = (prisma.voucherTracking.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.strikeCount).toBe(0);
      expect(updateCall.data.unsubscribedAt).toBeNull();
      expect(updateCall.data.lastVoucherToken).toBeTruthy();

      expect(notionUsersService.updateSubscription).toHaveBeenCalledWith('notion-page-456', true);
    });

    it('returns 400 when user is not unsubscribed', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
        makeRecord({ unsubscribedAt: null })
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/user@example.com/resubscribe',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/not unsubscribed/i);
    });

    it('still succeeds when Notion update fails', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
        makeRecord({ unsubscribedAt: new Date() })
      );
      (prisma.voucherTracking.update as jest.Mock).mockResolvedValue({});
      (notionUsersService.findUserByEmail as jest.Mock).mockRejectedValue(new Error('Notion API error'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/user@example.com/resubscribe',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.notionUpdated).toBe(false);
    });
  });

  // ---- POST /api/admin/vouchers/:email/revoke ----

  describe('POST /api/admin/vouchers/:email/revoke', () => {
    it('clears the voucher token', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
        makeRecord({ lastVoucherToken: 'v1:abc:def:sig' })
      );
      (prisma.voucherTracking.update as jest.Mock).mockResolvedValue({});

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/user@example.com/revoke',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.revoked).toBe(true);
      expect(prisma.voucherTracking.update).toHaveBeenCalledWith({
        where: { id: 'user@example.com' },
        data: { lastVoucherToken: null },
      });
    });

    it('returns 400 when user has no active voucher', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(
        makeRecord({ lastVoucherToken: null })
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/user@example.com/revoke',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/no active voucher/i);
    });

    it('returns 404 for unknown email', async () => {
      (prisma.voucherTracking.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/vouchers/nobody@example.com/revoke',
        headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});

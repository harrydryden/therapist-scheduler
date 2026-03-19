/**
 * Admin Voucher Management Routes
 *
 * Provides endpoints for viewing, issuing, revoking, and managing
 * voucher tracking records used in the weekly mailing voucher system.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';
import { getSettingValue } from '../services/settings.service';
import { generateVoucherToken, generateVoucherUrl, getDisplayCodeFromToken } from '../utils/voucher-token';
import { generateUnsubscribeUrl } from '../utils/unsubscribe-token';
import { renderTemplate } from '../utils/email-templates';
import { emailProcessingService } from '../services/email-processing.service';
import { notionUsersService } from '../services/notion-users.service';
import { config } from '../config';

// Zod schemas
const listVouchersSchema = z.object({
  status: z.enum(['active', 'expired', 'unsubscribed', 'used', 'all']).default('all'),
  search: z.string().max(255).optional(),
  minStrikes: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sortBy: z.enum(['email', 'strikeCount', 'lastVoucherSentAt', 'unsubscribedAt']).default('lastVoucherSentAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const issueVoucherSchema = z.object({
  email: z.string().email().max(255),
  expiryDays: z.number().int().min(1).max(90).optional(),
  sendEmail: z.boolean().default(true),
});

export async function adminVoucherRoutes(fastify: FastifyInstance) {
  // Auth middleware - require webhook secret for admin access
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * GET /api/admin/vouchers
   * List all voucher tracking records with filtering, search, and pagination
   */
  fastify.get('/api/admin/vouchers', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = listVouchersSchema.parse(request.query);
    const { status, search, minStrikes, page, limit, sortBy, sortOrder } = query;

    const expiryDays = await getSettingValue<number>('voucher.expiryDays');
    const maxStrikes = await getSettingValue<number>('voucher.maxStrikes');
    const now = new Date();
    const expiryThreshold = new Date(now.getTime() - expiryDays * 24 * 60 * 60 * 1000);

    // Helper to compute derived status from a record
    const computeStatus = (r: { lastVoucherSentAt: Date | null; lastVoucherUsedAt: Date | null; lastVoucherToken: string | null; unsubscribedAt: Date | null }) => {
      if (r.unsubscribedAt) return 'unsubscribed';
      const isUsed = r.lastVoucherUsedAt && r.lastVoucherSentAt && r.lastVoucherUsedAt > r.lastVoucherSentAt;
      if (isUsed) return 'used';
      const isExpired = r.lastVoucherSentAt ? r.lastVoucherSentAt < expiryThreshold : true;
      if (r.lastVoucherSentAt && !isExpired && r.lastVoucherToken) return 'active';
      return 'expired';
    };

    // Build where clause
    const where: Record<string, unknown> = {};

    if (search) {
      where.id = { contains: search.toLowerCase(), mode: 'insensitive' };
    }

    if (minStrikes !== undefined) {
      where.strikeCount = { gte: minStrikes };
    }

    // Pre-filter statuses that can be determined at the DB level
    if (status === 'unsubscribed') {
      where.unsubscribedAt = { not: null };
    } else if (status === 'used') {
      // Used = lastVoucherUsedAt > lastVoucherSentAt (approximated: has both fields set)
      where.lastVoucherUsedAt = { not: null };
      where.unsubscribedAt = null;
    } else if (status === 'active') {
      where.lastVoucherSentAt = { gte: expiryThreshold };
      where.lastVoucherToken = { not: null };
      where.unsubscribedAt = null;
    } else if (status === 'expired') {
      where.unsubscribedAt = null;
    }

    // For computed statuses (active/expired/used), we need to over-fetch and post-filter
    // to get accurate pagination. Fetch a larger window and slice.
    const needsPostFilter = status === 'active' || status === 'expired' || status === 'used';
    const fetchLimit = needsPostFilter ? limit * 4 : limit; // Over-fetch for post-filtering
    const fetchSkip = needsPostFilter ? 0 : (page - 1) * limit;

    const [records, dbTotal] = await Promise.all([
      prisma.voucherTracking.findMany({
        where,
        orderBy: { [sortBy === 'email' ? 'id' : sortBy]: sortOrder },
        skip: fetchSkip,
        take: needsPostFilter ? undefined : fetchLimit, // Fetch all for post-filter statuses
      }),
      prisma.voucherTracking.count({ where }),
    ]);

    // Compute derived fields and apply post-filtering
    const allItems = records.map((r) => {
      const expiresAt = r.lastVoucherSentAt
        ? new Date(r.lastVoucherSentAt.getTime() + expiryDays * 24 * 60 * 60 * 1000)
        : null;

      return {
        email: r.id,
        displayCode: r.lastVoucherToken ? getDisplayCodeFromToken(r.lastVoucherToken) : null,
        status: computeStatus(r),
        strikeCount: r.strikeCount,
        maxStrikes,
        lastVoucherSentAt: r.lastVoucherSentAt?.toISOString() || null,
        lastVoucherUsedAt: r.lastVoucherUsedAt?.toISOString() || null,
        expiresAt: expiresAt?.toISOString() || null,
        reminderSentAt: r.reminderSentAt?.toISOString() || null,
        unsubscribedAt: r.unsubscribedAt?.toISOString() || null,
        createdAt: r.createdAt.toISOString(),
      };
    });

    // Post-filter for computed statuses, then paginate in memory
    let filtered = allItems;
    if (needsPostFilter) {
      filtered = allItems.filter((item) => item.status === status);
    }

    const filteredTotal = needsPostFilter ? filtered.length : dbTotal;
    const paginatedItems = needsPostFilter
      ? filtered.slice((page - 1) * limit, page * limit)
      : filtered;

    // Compute summary stats using efficient COUNT queries instead of loading all records
    const [totalCount, unsubscribedCount, atRiskCount] = await Promise.all([
      prisma.voucherTracking.count(),
      prisma.voucherTracking.count({ where: { unsubscribedAt: { not: null } } }),
      prisma.voucherTracking.count({ where: { strikeCount: { gte: maxStrikes - 1 }, unsubscribedAt: null } }),
    ]);

    // Active/used counts still need computed status, but use targeted queries
    const recentRecords = await prisma.voucherTracking.findMany({
      where: { unsubscribedAt: null, lastVoucherSentAt: { not: null } },
      select: { lastVoucherSentAt: true, lastVoucherUsedAt: true, lastVoucherToken: true, unsubscribedAt: true },
    });

    let activeCount = 0;
    let usedCount = 0;
    for (const r of recentRecords) {
      const s = computeStatus(r);
      if (s === 'active') activeCount++;
      else if (s === 'used') usedCount++;
    }

    return reply.send({
      success: true,
      data: {
        items: paginatedItems,
        summary: {
          total: totalCount,
          active: activeCount,
          used: usedCount,
          atRisk: atRiskCount,
          unsubscribed: unsubscribedCount,
        },
        pagination: {
          page,
          limit,
          total: filteredTotal,
          totalPages: Math.ceil(filteredTotal / limit),
        },
      },
    });
  });

  /**
   * GET /api/admin/vouchers/:email
   * Get a single voucher tracking record by email
   */
  fastify.get<{ Params: { email: string } }>(
    '/api/admin/vouchers/:email',
    async (request, reply) => {
      const { email } = request.params;
      const emailLower = email.toLowerCase();

      const record = await prisma.voucherTracking.findUnique({ where: { id: emailLower } });
      if (!record) {
        return reply.status(404).send({ success: false, error: 'Voucher tracking record not found' });
      }

      const expiryDays = await getSettingValue<number>('voucher.expiryDays');
      const maxStrikes = await getSettingValue<number>('voucher.maxStrikes');
      const now = new Date();
      const expiryThreshold = new Date(now.getTime() - expiryDays * 24 * 60 * 60 * 1000);

      const isExpired = record.lastVoucherSentAt ? record.lastVoucherSentAt < expiryThreshold : true;
      const isUsed = record.lastVoucherUsedAt && record.lastVoucherSentAt
        ? record.lastVoucherUsedAt > record.lastVoucherSentAt
        : false;

      return reply.send({
        success: true,
        data: {
          email: record.id,
          displayCode: record.lastVoucherToken ? getDisplayCodeFromToken(record.lastVoucherToken) : null,
          status: record.unsubscribedAt ? 'unsubscribed' : isUsed ? 'used' : !isExpired && record.lastVoucherToken ? 'active' : 'expired',
          strikeCount: record.strikeCount,
          maxStrikes,
          lastVoucherSentAt: record.lastVoucherSentAt?.toISOString() || null,
          lastVoucherUsedAt: record.lastVoucherUsedAt?.toISOString() || null,
          expiresAt: record.lastVoucherSentAt
            ? new Date(record.lastVoucherSentAt.getTime() + expiryDays * 24 * 60 * 60 * 1000).toISOString()
            : null,
          reminderSentAt: record.reminderSentAt?.toISOString() || null,
          unsubscribedAt: record.unsubscribedAt?.toISOString() || null,
          createdAt: record.createdAt.toISOString(),
        },
      });
    }
  );

  /**
   * POST /api/admin/vouchers/issue
   * Manually issue a voucher to a specific email address
   */
  fastify.post('/api/admin/vouchers/issue', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = issueVoucherSchema.parse(request.body);
    const emailLower = body.email.toLowerCase();
    const expiryDays = body.expiryDays || await getSettingValue<number>('voucher.expiryDays');

    // Generate voucher
    const webAppUrl = await getSettingValue<string>('weeklyMailing.webAppUrl');
    const voucherResult = generateVoucherUrl(emailLower, webAppUrl, expiryDays);

    // Upsert tracking record - also clear unsubscribedAt so admin-issued vouchers
    // reactivate unsubscribed users without requiring a separate resubscribe step
    const now = new Date();
    await prisma.voucherTracking.upsert({
      where: { id: emailLower },
      create: {
        id: emailLower,
        lastVoucherSentAt: now,
        lastVoucherToken: voucherResult.token,
        strikeCount: 0,
      },
      update: {
        lastVoucherSentAt: now,
        lastVoucherToken: voucherResult.token,
        reminderSentAt: null,
        unsubscribedAt: null,
      },
    });

    // Optionally send email - track success/failure accurately
    let emailSent = false;
    if (body.sendEmail) {
      try {
        const subjectTemplate = await getSettingValue<string>('email.weeklyMailingSubject');
        const bodyTemplate = await getSettingValue<string>('email.weeklyMailingBody');
        const unsubscribeUrl = generateUnsubscribeUrl(emailLower, config.backendUrl);

        const voucherExpiry = voucherResult.expiresAt.toLocaleDateString('en-GB', {
          day: 'numeric', month: 'long', year: 'numeric',
        });

        const subject = renderTemplate(subjectTemplate, {
          userName: emailLower.split('@')[0],
          voucherCode: voucherResult.displayCode,
        });
        const emailBody = renderTemplate(bodyTemplate, {
          userName: emailLower.split('@')[0],
          voucherCode: voucherResult.displayCode,
          voucherExpiry,
          webAppUrl: voucherResult.url,
          unsubscribeUrl,
        });

        await emailProcessingService.sendEmail({ to: emailLower, subject, body: emailBody });
        emailSent = true;
        logger.info({ email: emailLower, displayCode: voucherResult.displayCode }, 'Admin manually issued voucher with email');
      } catch (error) {
        logger.error({ error, email: emailLower }, 'Failed to send voucher email (voucher still created)');
      }
    }

    logger.info({ email: emailLower, displayCode: voucherResult.displayCode }, 'Admin manually issued voucher');

    return reply.status(201).send({
      success: true,
      data: {
        email: emailLower,
        displayCode: voucherResult.displayCode,
        expiresAt: voucherResult.expiresAt.toISOString(),
        emailSent,
      },
    });
  });

  /**
   * POST /api/admin/vouchers/:email/reset-strikes
   * Reset a user's strike count to 0
   */
  fastify.post<{ Params: { email: string } }>(
    '/api/admin/vouchers/:email/reset-strikes',
    async (request, reply) => {
      const emailLower = request.params.email.toLowerCase();

      const record = await prisma.voucherTracking.findUnique({ where: { id: emailLower } });
      if (!record) {
        return reply.status(404).send({ success: false, error: 'Voucher tracking record not found' });
      }

      await prisma.voucherTracking.update({
        where: { id: emailLower },
        data: { strikeCount: 0 },
      });

      logger.info({ email: emailLower, previousStrikes: record.strikeCount }, 'Admin reset voucher strikes');

      return reply.send({
        success: true,
        data: { email: emailLower, strikeCount: 0, previousStrikes: record.strikeCount },
      });
    }
  );

  /**
   * POST /api/admin/vouchers/:email/resubscribe
   * Re-subscribe a user who was auto-unsubscribed, reset strikes, and issue a fresh voucher
   */
  fastify.post<{ Params: { email: string } }>(
    '/api/admin/vouchers/:email/resubscribe',
    async (request, reply) => {
      const emailLower = request.params.email.toLowerCase();

      const record = await prisma.voucherTracking.findUnique({ where: { id: emailLower } });
      if (!record) {
        return reply.status(404).send({ success: false, error: 'Voucher tracking record not found' });
      }

      if (!record.unsubscribedAt) {
        return reply.status(400).send({ success: false, error: 'User is not unsubscribed' });
      }

      // Generate a fresh voucher
      const expiryDays = await getSettingValue<number>('voucher.expiryDays');
      const webAppUrl = await getSettingValue<string>('weeklyMailing.webAppUrl');
      const voucherResult = generateVoucherUrl(emailLower, webAppUrl, expiryDays);

      // Update tracking: clear unsubscribed, reset strikes, set new voucher
      const now = new Date();
      await prisma.voucherTracking.update({
        where: { id: emailLower },
        data: {
          strikeCount: 0,
          unsubscribedAt: null,
          lastVoucherSentAt: now,
          lastVoucherToken: voucherResult.token,
          reminderSentAt: null,
        },
      });

      // Re-subscribe in Notion
      let notionUpdated = false;
      try {
        const notionUser = await notionUsersService.findUserByEmail(emailLower);
        if (notionUser) {
          await notionUsersService.updateSubscription(notionUser.pageId, true);
          notionUpdated = true;
        }
      } catch (error) {
        logger.error({ error, email: emailLower }, 'Failed to update Notion subscription (voucher tracking updated)');
      }

      logger.info({ email: emailLower, notionUpdated }, 'Admin resubscribed user');

      return reply.send({
        success: true,
        data: {
          email: emailLower,
          displayCode: voucherResult.displayCode,
          expiresAt: voucherResult.expiresAt.toISOString(),
          notionUpdated,
        },
      });
    }
  );

  /**
   * POST /api/admin/vouchers/:email/revoke
   * Revoke a user's active voucher (clear the token)
   */
  fastify.post<{ Params: { email: string } }>(
    '/api/admin/vouchers/:email/revoke',
    async (request, reply) => {
      const emailLower = request.params.email.toLowerCase();

      const record = await prisma.voucherTracking.findUnique({ where: { id: emailLower } });
      if (!record) {
        return reply.status(404).send({ success: false, error: 'Voucher tracking record not found' });
      }

      if (!record.lastVoucherToken) {
        return reply.status(400).send({ success: false, error: 'User has no active voucher to revoke' });
      }

      await prisma.voucherTracking.update({
        where: { id: emailLower },
        data: { lastVoucherToken: null },
      });

      logger.info({ email: emailLower }, 'Admin revoked voucher');

      return reply.send({
        success: true,
        data: { email: emailLower, revoked: true },
      });
    }
  );
}

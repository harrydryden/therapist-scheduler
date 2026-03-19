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
import { generateVoucherUrl, getDisplayCodeFromToken } from '../utils/voucher-token';
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

// Helper to format a DB record into the API response shape
function formatRecord(
  r: { id: string; lastVoucherToken: string | null; strikeCount: number; lastVoucherSentAt: Date | null; lastVoucherUsedAt: Date | null; reminderSentAt: Date | null; unsubscribedAt: Date | null; createdAt: Date },
  status: string,
  expiryDays: number,
  maxStrikes: number,
) {
  const expiresAt = r.lastVoucherSentAt
    ? new Date(r.lastVoucherSentAt.getTime() + expiryDays * 24 * 60 * 60 * 1000)
    : null;
  return {
    email: r.id,
    displayCode: r.lastVoucherToken ? getDisplayCodeFromToken(r.lastVoucherToken) : null,
    status,
    strikeCount: r.strikeCount,
    maxStrikes,
    lastVoucherSentAt: r.lastVoucherSentAt?.toISOString() || null,
    lastVoucherUsedAt: r.lastVoucherUsedAt?.toISOString() || null,
    expiresAt: expiresAt?.toISOString() || null,
    reminderSentAt: r.reminderSentAt?.toISOString() || null,
    unsubscribedAt: r.unsubscribedAt?.toISOString() || null,
    createdAt: r.createdAt.toISOString(),
  };
}

// Format raw SQL bigint summary into numbers
function formatSummary(raw: { total: bigint; active: bigint; used: bigint; at_risk: bigint; unsubscribed: bigint }) {
  return {
    total: Number(raw.total),
    active: Number(raw.active),
    used: Number(raw.used),
    atRisk: Number(raw.at_risk),
    unsubscribed: Number(raw.unsubscribed),
  };
}

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
    const expiryThreshold = new Date(Date.now() - expiryDays * 24 * 60 * 60 * 1000);

    // Compute derived status from a record - single source of truth
    const computeStatus = (r: { lastVoucherSentAt: Date | null; lastVoucherUsedAt: Date | null; lastVoucherToken: string | null; unsubscribedAt: Date | null }) => {
      if (r.unsubscribedAt) return 'unsubscribed';
      const isUsed = r.lastVoucherUsedAt && r.lastVoucherSentAt && r.lastVoucherUsedAt > r.lastVoucherSentAt;
      if (isUsed) return 'used';
      const isExpired = r.lastVoucherSentAt ? r.lastVoucherSentAt < expiryThreshold : true;
      if (r.lastVoucherSentAt && !isExpired && r.lastVoucherToken) return 'active';
      return 'expired';
    };

    // Summary stats via single raw SQL query with CASE expressions
    // This avoids loading any records into memory just for counts
    const summaryResult = await prisma.$queryRaw<Array<{
      total: bigint;
      active: bigint;
      used: bigint;
      at_risk: bigint;
      unsubscribed: bigint;
    }>>`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE
          unsubscribed_at IS NULL
          AND last_voucher_sent_at IS NOT NULL
          AND last_voucher_sent_at >= ${expiryThreshold}
          AND last_voucher_token IS NOT NULL
          AND (last_voucher_used_at IS NULL OR last_voucher_used_at <= last_voucher_sent_at)
        ) AS active,
        COUNT(*) FILTER (WHERE
          unsubscribed_at IS NULL
          AND last_voucher_used_at IS NOT NULL
          AND last_voucher_sent_at IS NOT NULL
          AND last_voucher_used_at > last_voucher_sent_at
        ) AS used,
        COUNT(*) FILTER (WHERE
          unsubscribed_at IS NULL
          AND strike_count >= ${maxStrikes - 1}
        ) AS at_risk,
        COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL) AS unsubscribed
      FROM voucher_tracking
    `;
    const summary = summaryResult[0];

    // Build Prisma where clause for search + minStrikes (these are DB-level filters)
    const baseWhere: Record<string, unknown> = {};
    if (search) {
      baseWhere.id = { contains: search.toLowerCase(), mode: 'insensitive' };
    }
    if (minStrikes !== undefined) {
      baseWhere.strikeCount = { gte: minStrikes };
    }

    // For 'all' and 'unsubscribed', we can paginate directly in the DB
    // For computed statuses (active/expired/used), we must post-filter
    const canPaginateInDb = status === 'all' || status === 'unsubscribed';

    if (status === 'unsubscribed') {
      baseWhere.unsubscribedAt = { not: null };
    }

    if (canPaginateInDb) {
      const [records, total] = await Promise.all([
        prisma.voucherTracking.findMany({
          where: baseWhere,
          orderBy: { [sortBy === 'email' ? 'id' : sortBy]: sortOrder },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.voucherTracking.count({ where: baseWhere }),
      ]);

      const items = records.map((r) => formatRecord(r, computeStatus(r), expiryDays, maxStrikes));

      return reply.send({
        success: true,
        data: {
          items,
          summary: formatSummary(summary),
          pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        },
      });
    }

    // Computed status filter: narrow the DB query as much as possible, then post-filter
    const where = { ...baseWhere };
    // Exclude unsubscribed for all computed statuses
    where.unsubscribedAt = null;

    if (status === 'active') {
      // Must have token, sent after threshold
      where.lastVoucherSentAt = { gte: expiryThreshold };
      where.lastVoucherToken = { not: null };
    } else if (status === 'used') {
      where.lastVoucherUsedAt = { not: null };
      where.lastVoucherSentAt = { not: null };
    }
    // 'expired' has no useful DB-level narrowing beyond unsubscribedAt=null

    // Fetch all matching records for this status filter (they need post-computation)
    // Ordered so we can slice for pagination after filtering
    const records = await prisma.voucherTracking.findMany({
      where,
      orderBy: { [sortBy === 'email' ? 'id' : sortBy]: sortOrder },
    });

    // Post-filter to exact computed status
    const filtered = records.filter((r) => computeStatus(r) === status);
    const total = filtered.length;
    const paged = filtered.slice((page - 1) * limit, page * limit);
    const items = paged.map((r) => formatRecord(r, status, expiryDays, maxStrikes));

    return reply.send({
      success: true,
      data: {
        items,
        summary: formatSummary(summary),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
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

    // Check if user was previously unsubscribed (need to re-subscribe in Notion too)
    const existingRecord = await prisma.voucherTracking.findUnique({
      where: { id: emailLower },
      select: { unsubscribedAt: true },
    });
    const wasUnsubscribed = existingRecord?.unsubscribedAt != null;

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
        strikeCount: 0,
      },
    });

    // If user was unsubscribed, re-subscribe in Notion so they get future weekly emails
    if (wasUnsubscribed) {
      try {
        const notionUser = await notionUsersService.findUserByEmail(emailLower);
        if (notionUser) {
          await notionUsersService.updateSubscription(notionUser.pageId, true);
          logger.info({ email: emailLower }, 'Re-subscribed user in Notion via voucher issuance');
        }
      } catch (error) {
        logger.error({ error, email: emailLower }, 'Failed to re-subscribe in Notion (voucher still created)');
      }
    }

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

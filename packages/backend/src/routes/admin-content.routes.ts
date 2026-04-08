/**
 * Admin Content Routes
 *
 * Consolidates admin endpoints for content management:
 *   - Knowledge base CRUD (formerly admin-knowledge.routes.ts)
 *   - Feedback form config, submissions, stats, export
 *     (formerly admin-forms.routes.ts)
 *
 * Both were small, single-domain plugin files. Merging reduces the total
 * admin-route file count without adding coupling — neither section imports
 * anything from the other.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';
import { RATE_LIMITS } from '../constants';
import { knowledgeService } from '../services/knowledge.service';
import { sendSuccess, sendError, Errors } from '../utils/response';
import { getOrCreateFeedbackFormConfig, DEFAULT_QUESTIONS } from '../utils/feedback-form-config';

// Re-export for backward compatibility (feedback-form.routes.ts dynamic import)
export { DEFAULT_QUESTIONS };

// ============================================
// Knowledge Base — Validation Schemas
// ============================================

const KNOWLEDGE_LIMITS = {
  TITLE_MAX_LENGTH: 200,
  CONTENT_MAX_LENGTH: 10000, // 10KB max for knowledge base content
  CONTENT_MIN_LENGTH: 1,
};

const createKnowledgeSchema = z.object({
  title: z.string().max(KNOWLEDGE_LIMITS.TITLE_MAX_LENGTH, `Title must be under ${KNOWLEDGE_LIMITS.TITLE_MAX_LENGTH} characters`).optional(),
  content: z.string()
    .min(KNOWLEDGE_LIMITS.CONTENT_MIN_LENGTH, 'Content is required')
    .max(KNOWLEDGE_LIMITS.CONTENT_MAX_LENGTH, `Content must be under ${KNOWLEDGE_LIMITS.CONTENT_MAX_LENGTH} characters`),
  audience: z.enum(['therapist', 'user', 'both']),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

const updateKnowledgeSchema = z.object({
  title: z.string().max(KNOWLEDGE_LIMITS.TITLE_MAX_LENGTH, `Title must be under ${KNOWLEDGE_LIMITS.TITLE_MAX_LENGTH} characters`).optional().nullable(),
  content: z.string()
    .min(KNOWLEDGE_LIMITS.CONTENT_MIN_LENGTH, 'Content is required')
    .max(KNOWLEDGE_LIMITS.CONTENT_MAX_LENGTH, `Content must be under ${KNOWLEDGE_LIMITS.CONTENT_MAX_LENGTH} characters`)
    .optional(),
  audience: z.enum(['therapist', 'user', 'both']).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

// ============================================
// Feedback Forms — Validation Schemas
// ============================================

const questionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['text', 'scale', 'choice', 'choice_with_text']),
  question: z.string().min(1),
  helperText: z.string().optional(),
  required: z.boolean(),
  prefilled: z.boolean().optional(),
  scaleMin: z.number().optional(),
  scaleMax: z.number().optional(),
  scaleMinLabel: z.string().optional(),
  scaleMaxLabel: z.string().optional(),
  options: z.array(z.string()).optional(),
  followUpPlaceholder: z.string().optional(),
  conditionalOn: z.object({
    questionId: z.string().min(1),
    values: z.array(z.string()).min(1),
  }).optional(),
});

const updateFormConfigSchema = z.object({
  formName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  welcomeTitle: z.string().min(1).optional(),
  welcomeMessage: z.string().min(1).optional(),
  thankYouTitle: z.string().min(1).optional(),
  thankYouMessage: z.string().min(1).optional(),
  questions: z.array(questionSchema).optional(),
  isActive: z.boolean().optional(),
  requiresAuth: z.boolean().optional(),
  requireExplanationFor: z.array(z.string()).optional(),
});

// ============================================
// Routes
// ============================================

export async function adminContentRoutes(fastify: FastifyInstance) {
  // All admin routes require authentication
  fastify.addHook('preHandler', verifyWebhookSecret);

  // --------------------------------------------
  // Knowledge Base
  // --------------------------------------------

  /**
   * GET /api/admin/knowledge
   * List all knowledge entries
   */
  fastify.get('/api/admin/knowledge', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    logger.info({ requestId }, 'Fetching knowledge base entries');

    try {
      const entries = await prisma.knowledgeBase.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });

      return sendSuccess(reply, entries);
    } catch (err) {
      logger.error({ err, requestId }, 'Failed to fetch knowledge entries');
      return Errors.internal(reply, 'Failed to fetch knowledge entries');
    }
  });

  /**
   * POST /api/admin/knowledge
   * Create a new knowledge entry
   */
  fastify.post(
    '/api/admin/knowledge',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      const validation = createKnowledgeSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { title, content, audience, sortOrder } = validation.data;

      try {
        const entry = await prisma.knowledgeBase.create({
          data: {
            title: title || null,
            content,
            audience,
            sortOrder: sortOrder ?? 0,
            active: true,
          },
        });

        knowledgeService.invalidateCache();
        logger.info({ requestId, entryId: entry.id }, 'Created knowledge entry');

        return sendSuccess(reply, entry, { statusCode: 201 });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to create knowledge entry');
        return Errors.internal(reply, 'Failed to create knowledge entry');
      }
    }
  );

  /**
   * PUT /api/admin/knowledge/:id
   * Update an existing knowledge entry
   */
  fastify.put<{ Params: { id: string } }>(
    '/api/admin/knowledge/:id',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const requestId = request.id;

      const validation = updateKnowledgeSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      try {
        const existing = await prisma.knowledgeBase.findUnique({ where: { id } });

        if (!existing) {
          return Errors.notFound(reply, 'Knowledge entry');
        }

        const entry = await prisma.knowledgeBase.update({
          where: { id },
          data: validation.data,
        });

        knowledgeService.invalidateCache();
        logger.info({ requestId, entryId: id }, 'Updated knowledge entry');

        return sendSuccess(reply, entry);
      } catch (err) {
        logger.error({ err, requestId, entryId: id }, 'Failed to update knowledge entry');
        return Errors.internal(reply, 'Failed to update knowledge entry');
      }
    }
  );

  /**
   * DELETE /api/admin/knowledge/:id
   * Delete a knowledge entry
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/knowledge/:id',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const requestId = request.id;

      try {
        const existing = await prisma.knowledgeBase.findUnique({ where: { id } });

        if (!existing) {
          return Errors.notFound(reply, 'Knowledge entry');
        }

        await prisma.knowledgeBase.delete({ where: { id } });

        knowledgeService.invalidateCache();
        logger.info({ requestId, entryId: id }, 'Deleted knowledge entry');

        return sendSuccess(reply, null, { message: 'Knowledge entry deleted' });
      } catch (err) {
        logger.error({ err, requestId, entryId: id }, 'Failed to delete knowledge entry');
        return Errors.internal(reply, 'Failed to delete knowledge entry');
      }
    }
  );

  // --------------------------------------------
  // Feedback Forms — Config
  // --------------------------------------------

  /**
   * GET /api/admin/forms/feedback
   * Get the feedback form configuration
   */
  fastify.get('/api/admin/forms/feedback', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = await getOrCreateFeedbackFormConfig();
      return sendSuccess(reply, config);
    } catch (error) {
      logger.error({ error }, 'Failed to get feedback form config');
      return Errors.internal(reply, 'Failed to load form configuration');
    }
  });

  /**
   * PUT /api/admin/forms/feedback
   * Update the feedback form configuration
   */
  fastify.put('/api/admin/forms/feedback', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const validation = updateFormConfigSchema.safeParse(request.body);

      if (!validation.success) {
        return Errors.badRequest(reply, 'Invalid form configuration', validation.error.issues);
      }

      const updates = validation.data;

      const config = await prisma.feedbackFormConfig.upsert({
        where: { id: 'default' },
        update: {
          ...(updates.formName && { formName: updates.formName }),
          ...(updates.description !== undefined && { description: updates.description }),
          ...(updates.welcomeTitle && { welcomeTitle: updates.welcomeTitle }),
          ...(updates.welcomeMessage && { welcomeMessage: updates.welcomeMessage }),
          ...(updates.thankYouTitle && { thankYouTitle: updates.thankYouTitle }),
          ...(updates.thankYouMessage && { thankYouMessage: updates.thankYouMessage }),
          ...(updates.questions && { questions: updates.questions, questionsVersion: { increment: 1 } }),
          ...(updates.isActive !== undefined && { isActive: updates.isActive }),
          ...(updates.requiresAuth !== undefined && { requiresAuth: updates.requiresAuth }),
          ...(updates.requireExplanationFor && { requireExplanationFor: updates.requireExplanationFor }),
        },
        create: {
          id: 'default',
          formName: updates.formName || 'Therapy Interview Feedback',
          description: updates.description || null,
          welcomeTitle: updates.welcomeTitle || 'Session Feedback',
          welcomeMessage: updates.welcomeMessage || 'Please share your feedback.',
          thankYouTitle: updates.thankYouTitle || 'Thank you!',
          thankYouMessage: updates.thankYouMessage || 'Thanks for your feedback.',
          questions: updates.questions || DEFAULT_QUESTIONS,
          isActive: updates.isActive ?? true,
          requiresAuth: updates.requiresAuth ?? true,
          requireExplanationFor: updates.requireExplanationFor ?? ['No', 'Unsure'],
        },
      });

      logger.info('Feedback form configuration updated');

      return sendSuccess(reply, config);
    } catch (error) {
      logger.error({ error }, 'Failed to update feedback form config');
      return Errors.internal(reply, 'Failed to update form configuration');
    }
  });

  // --------------------------------------------
  // Feedback Forms — Submissions
  // --------------------------------------------

  /**
   * GET /api/admin/forms/feedback/submissions
   * List feedback submissions with pagination and filtering
   */
  fastify.get<{
    Querystring: {
      page?: string;
      limit?: string;
      therapist?: string;
      trackingCode?: string;
      from?: string;
      to?: string;
    };
  }>('/api/admin/forms/feedback/submissions', async (request, reply) => {
    try {
      const { page = '1', limit = '20', therapist, trackingCode, from, to } = request.query;

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const skip = (pageNum - 1) * limitNum;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = {};

      if (therapist) {
        where.therapistName = { contains: therapist, mode: 'insensitive' };
      }

      if (trackingCode) {
        where.trackingCode = trackingCode.toUpperCase();
      }

      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to);
      }

      const [submissions, total] = await Promise.all([
        prisma.feedbackSubmission.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limitNum,
          include: {
            appointment: {
              select: {
                id: true,
                trackingCode: true,
                confirmedDateTime: true,
                status: true,
              },
            },
          },
        }),
        prisma.feedbackSubmission.count({ where }),
      ]);

      return sendSuccess(reply, {
        submissions,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to list feedback submissions');
      return Errors.internal(reply, 'Failed to load submissions');
    }
  });

  /**
   * GET /api/admin/forms/feedback/submissions/:id
   * Get a single feedback submission
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/admin/forms/feedback/submissions/:id',
    async (request, reply) => {
      try {
        const { id } = request.params;

        const submission = await prisma.feedbackSubmission.findUnique({
          where: { id },
          include: {
            appointment: {
              select: {
                id: true,
                userName: true,
                userEmail: true,
                therapistName: true,
                trackingCode: true,
                confirmedDateTime: true,
                status: true,
              },
            },
          },
        });

        if (!submission) {
          return Errors.notFound(reply, 'Submission');
        }

        return sendSuccess(reply, submission);
      } catch (error) {
        logger.error({ error }, 'Failed to get feedback submission');
        return Errors.internal(reply, 'Failed to load submission');
      }
    }
  );

  /**
   * GET /api/admin/forms/feedback/stats
   * Get feedback statistics - dynamically computed from JSONB responses
   */
  fastify.get('/api/admin/forms/feedback/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const formConfig = await prisma.feedbackFormConfig.findUnique({
        where: { id: 'default' },
        select: { questions: true },
      });
      const questions = (formConfig?.questions as unknown as Array<{ id: string; type: string; question: string }>) || [];

      const [totalSubmissions, recentSubmissions, recentResponses] =
        await Promise.all([
          prisma.feedbackSubmission.count(),
          prisma.feedbackSubmission.count({
            where: { createdAt: { gte: thirtyDaysAgo } },
          }),
          prisma.feedbackSubmission.findMany({
            where: { createdAt: { gte: thirtyDaysAgo } },
            select: { responses: true },
          }),
        ]);

      // Compute per-question breakdowns from JSONB responses
      const questionStats: Record<string, Record<string, number>> = {};
      for (const q of questions) {
        if (q.type === 'choice' || q.type === 'choice_with_text') {
          questionStats[q.id] = {};
        }
      }

      for (const sub of recentResponses) {
        const resp = sub.responses as Record<string, string | number>;
        for (const q of questions) {
          if (q.type === 'choice' || q.type === 'choice_with_text') {
            const val = resp[q.id];
            if (typeof val === 'string' && val) {
              const key = val.toLowerCase();
              questionStats[q.id][key] = (questionStats[q.id][key] || 0) + 1;
            }
          }
        }
      }

      return sendSuccess(reply, {
        totalSubmissions,
        recentSubmissions,
        questions: questions.map(q => ({ id: q.id, question: q.question, type: q.type })),
        questionStats,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get feedback stats');
      return Errors.internal(reply, 'Failed to load statistics');
    }
  });

  /**
   * GET /api/admin/forms/feedback/submissions/by-tracking-code/:code
   * Get a feedback submission by tracking code
   */
  fastify.get<{ Params: { code: string } }>(
    '/api/admin/forms/feedback/submissions/by-tracking-code/:code',
    async (request, reply) => {
      try {
        const { code } = request.params;

        const submission = await prisma.feedbackSubmission.findFirst({
          where: { trackingCode: code.toUpperCase() },
          include: {
            appointment: {
              select: {
                id: true,
                userName: true,
                userEmail: true,
                therapistName: true,
                trackingCode: true,
                confirmedDateTime: true,
                status: true,
              },
            },
          },
        });

        if (!submission) {
          const appointment = await prisma.appointmentRequest.findFirst({
            where: { trackingCode: code.toUpperCase() },
            select: {
              id: true,
              userName: true,
              userEmail: true,
              therapistName: true,
              trackingCode: true,
              status: true,
              confirmedDateTime: true,
            },
          });

          return sendError(reply, 404, 'No feedback submission found for this tracking code', {
            appointment: appointment || null,
            hint: appointment
              ? 'The appointment exists but no feedback has been submitted yet'
              : 'No appointment found with this tracking code either',
          });
        }

        return sendSuccess(reply, submission);
      } catch (error) {
        logger.error({ error }, 'Failed to get feedback submission by tracking code');
        return Errors.internal(reply, 'Failed to load submission');
      }
    }
  );

  /**
   * GET /api/admin/forms/feedback/submissions/export
   * Export all feedback submissions as CSV - dynamically built from form questions
   */
  fastify.get('/api/admin/forms/feedback/submissions/export', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const formConfig = await prisma.feedbackFormConfig.findUnique({
        where: { id: 'default' },
        select: { questions: true },
      });
      const questions = (formConfig?.questions as unknown as Array<{ id: string; type: string; question: string }>) || [];

      const submissions = await prisma.feedbackSubmission.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          appointment: {
            select: {
              trackingCode: true,
              confirmedDateTime: true,
            },
          },
        },
      });

      // Build dynamic headers: fixed columns + one column per question (+ _text for choice_with_text)
      const csvHeaders = ['Date', 'Tracking Code', 'Therapist'];
      for (const q of questions) {
        csvHeaders.push(q.question);
        if (q.type === 'choice_with_text') {
          csvHeaders.push(`${q.question} (Detail)`);
        }
      }

      const escapeCsv = (val: string | number | null | undefined): string => {
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const csvRows = submissions.map((s) => {
        const resp = s.responses as Record<string, string | number>;
        const row: (string | number | null)[] = [
          new Date(s.createdAt).toISOString().split('T')[0],
          s.trackingCode,
          s.therapistName,
        ];
        for (const q of questions) {
          row.push(resp[q.id] != null ? resp[q.id] : null);
          if (q.type === 'choice_with_text') {
            row.push(resp[`${q.id}_text`] != null ? resp[`${q.id}_text`] : null);
          }
        }
        return row.map(escapeCsv).join(',');
      });

      const csv = [csvHeaders.map(escapeCsv).join(','), ...csvRows].join('\n');

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="feedback-submissions-${new Date().toISOString().split('T')[0]}.csv"`);
      return reply.send(csv);
    } catch (error) {
      logger.error({ error }, 'Failed to export feedback submissions');
      return Errors.internal(reply, 'Failed to export submissions');
    }
  });

  /**
   * DELETE /api/admin/forms/feedback/submissions
   * Delete all feedback submissions (use with caution!)
   */
  fastify.delete('/api/admin/forms/feedback/submissions', async (request: FastifyRequest, reply: FastifyReply) => {
    // Require explicit confirmation parameter to prevent accidental deletion
    const { confirm } = request.query as { confirm?: string };
    if (confirm !== 'DELETE_ALL') {
      return Errors.badRequest(reply, 'Missing confirmation. Add ?confirm=DELETE_ALL to confirm bulk deletion.');
    }

    try {
      const result = await prisma.feedbackSubmission.deleteMany({});

      logger.warn({ count: result.count }, 'All feedback submissions deleted');

      return sendSuccess(reply, null, {
        message: `Deleted ${result.count} feedback submissions`,
        count: result.count,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to delete feedback submissions');
      return Errors.internal(reply, 'Failed to delete submissions');
    }
  });
}

/**
 * Admin Forms Routes
 *
 * Admin API for managing feedback form configuration.
 *
 * Routes:
 * - GET /api/admin/forms/feedback - Get feedback form config
 * - PUT /api/admin/forms/feedback - Update feedback form config
 * - GET /api/admin/forms/feedback/submissions - List feedback submissions
 * - GET /api/admin/forms/feedback/submissions/:id - Get single submission
 * - GET /api/admin/forms/feedback/stats - Get feedback statistics
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';

// ============================================
// Validation Schemas
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

// Default questions used when creating or migrating the form config
export const DEFAULT_QUESTIONS = [
  {
    id: 'met_goals',
    type: 'choice',
    question: 'Did this session meet your goals?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
  },
  {
    id: 'therapist_asked_goals',
    type: 'choice',
    question: 'Did the therapist ask what your goals were?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
    conditionalOn: { questionId: 'met_goals', values: ['No', 'Unsure'] },
  },
  {
    id: 'goals_detail',
    type: 'text',
    question: 'Which goals, if any, were met, which goals, if any, were not met?',
    required: true,
    conditionalOn: { questionId: 'met_goals', values: ['No', 'Unsure'] },
  },
  {
    id: 'felt_heard',
    type: 'choice',
    question: 'Did you feel heard and understood?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
  },
  {
    id: 'felt_heard_detail',
    type: 'text',
    question: 'Please tell us more about why you felt that way (eg anything your therapist said, did, non verbal cues, etc).',
    required: true,
    conditionalOn: { questionId: 'felt_heard', values: ['No', 'Unsure'] },
  },
  {
    id: 'would_book_again',
    type: 'choice',
    question: 'Would you book another session with this therapist in the future?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
  },
  {
    id: 'would_book_again_detail',
    type: 'text',
    question: 'Please tell us why you felt that way.',
    required: true,
    conditionalOn: { questionId: 'would_book_again', values: ['No', 'Unsure'] },
  },
  {
    id: 'would_recommend',
    type: 'choice',
    question: 'Based on this session, would you recommend this therapist to a close friend?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
  },
  {
    id: 'would_recommend_detail',
    type: 'text',
    question: 'Tell us why you would be hesitant to recommend this therapist to a close friend.',
    required: true,
    conditionalOn: { questionId: 'would_recommend', values: ['No', 'Unsure'] },
  },
];

// ============================================
// Routes
// ============================================

export async function adminFormsRoutes(fastify: FastifyInstance) {
  // All admin routes require authentication
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * GET /api/admin/forms/feedback
   * Get the feedback form configuration
   */
  fastify.get('/api/admin/forms/feedback', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let config = await prisma.feedbackFormConfig.findUnique({
        where: { id: 'default' },
      });

      // If no config exists, create with default questions
      if (!config) {
        config = await prisma.feedbackFormConfig.create({
          data: {
            id: 'default',
            formName: 'Therapy Session Feedback',
            welcomeTitle: 'Session Feedback',
            welcomeMessage:
              'Please take a moment to share your feedback about your therapy session.',
            thankYouTitle: 'Thank you!',
            thankYouMessage: 'Thanks for sharing your feedback - we really appreciate it.',
            questions: DEFAULT_QUESTIONS,
            isActive: true,
            requiresAuth: true,
          },
        });
      }

      // If config has empty questions OR still has the initial seed (questionsVersion 0),
      // replace with the correct default questions
      const questions = config.questions as unknown[];
      const needsDefaults = !questions || !Array.isArray(questions) || questions.length === 0 || (config.questionsVersion ?? 0) < 2;
      if (needsDefaults) {
        config = await prisma.feedbackFormConfig.update({
          where: { id: 'default' },
          data: {
            questions: DEFAULT_QUESTIONS,
            requiresAuth: true,
            questionsVersion: 2,
          },
        });
        logger.info('Populated feedback form config with default questions (v2)');
      }

      return reply.send({ success: true, data: config });
    } catch (error) {
      logger.error({ error }, 'Failed to get feedback form config');
      return reply.status(500).send({ error: 'Failed to load form configuration' });
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
        return reply.status(400).send({
          error: 'Invalid form configuration',
          details: validation.error.issues,
        });
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

      return reply.send({ success: true, data: config });
    } catch (error) {
      logger.error({ error }, 'Failed to update feedback form config');
      return reply.status(500).send({ error: 'Failed to update form configuration' });
    }
  });

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

      // Build where clause
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

      return reply.send({
        success: true,
        data: {
          submissions,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.ceil(total / limitNum),
          },
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to list feedback submissions');
      return reply.status(500).send({ error: 'Failed to load submissions' });
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
          return reply.status(404).send({ error: 'Submission not found' });
        }

        return reply.send({ success: true, data: submission });
      } catch (error) {
        logger.error({ error }, 'Failed to get feedback submission');
        return reply.status(500).send({ error: 'Failed to load submission' });
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

      // Get form config to know what questions exist
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

      return reply.send({ success: true, data: {
        totalSubmissions,
        recentSubmissions,
        questions: questions.map(q => ({ id: q.id, question: q.question, type: q.type })),
        questionStats,
      } });
    } catch (error) {
      logger.error({ error }, 'Failed to get feedback stats');
      return reply.status(500).send({ error: 'Failed to load statistics' });
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
          // Also check if the appointment exists
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

          return reply.status(404).send({
            error: 'No feedback submission found for this tracking code',
            appointment: appointment || null,
            hint: appointment
              ? 'The appointment exists but no feedback has been submitted yet'
              : 'No appointment found with this tracking code either',
          });
        }

        return reply.send({ success: true, data: submission });
      } catch (error) {
        logger.error({ error }, 'Failed to get feedback submission by tracking code');
        return reply.status(500).send({ error: 'Failed to load submission' });
      }
    }
  );

  /**
   * GET /api/admin/forms/feedback/submissions/export
   * Export all feedback submissions as CSV - dynamically built from form questions
   */
  fastify.get('/api/admin/forms/feedback/submissions/export', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Get form config to build CSV headers from current questions
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
      return reply.status(500).send({ error: 'Failed to export submissions' });
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
      return reply.status(400).send({
        error: 'Missing confirmation. Add ?confirm=DELETE_ALL to confirm bulk deletion.',
      });
    }

    try {
      const result = await prisma.feedbackSubmission.deleteMany({});

      logger.warn({ count: result.count }, 'All feedback submissions deleted');

      return reply.send({
        success: true,
        message: `Deleted ${result.count} feedback submissions`,
        count: result.count,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to delete feedback submissions');
      return reply.status(500).send({ error: 'Failed to delete submissions' });
    }
  });
}

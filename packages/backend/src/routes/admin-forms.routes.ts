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
  required: z.boolean(),
  prefilled: z.boolean().optional(),
  scaleMin: z.number().optional(),
  scaleMax: z.number().optional(),
  scaleMinLabel: z.string().optional(),
  scaleMaxLabel: z.string().optional(),
  options: z.array(z.string()).optional(),
  followUpPlaceholder: z.string().optional(),
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
});

// Default questions used when creating or migrating the form config
export const DEFAULT_QUESTIONS = [
  {
    id: 'safety_comfort',
    type: 'scale',
    question: 'How safe and comfortable did you feel?',
    required: true,
    scaleMin: 1,
    scaleMax: 5,
    scaleMinLabel: 'Not at all',
    scaleMaxLabel: 'Very',
  },
  {
    id: 'professional',
    type: 'scale',
    question: 'Did the session feel professionally conducted?',
    required: true,
    scaleMin: 1,
    scaleMax: 5,
    scaleMinLabel: 'Not at all',
    scaleMaxLabel: 'Very',
  },
  {
    id: 'listened_to',
    type: 'scale',
    question: 'Did you feel heard?',
    required: true,
    scaleMin: 1,
    scaleMax: 5,
    scaleMinLabel: 'Not at all',
    scaleMaxLabel: 'Very',
  },
  {
    id: 'understood',
    type: 'scale',
    question: 'Did you feel understood?',
    required: true,
    scaleMin: 1,
    scaleMax: 5,
    scaleMinLabel: 'Not at all',
    scaleMaxLabel: 'Very',
  },
  {
    id: 'session_benefits',
    type: 'text',
    question: 'What did you get out of the session?',
    required: false,
  },
  {
    id: 'improvement_suggestions',
    type: 'text',
    question: 'Is there anything that could have made the session better?',
    required: false,
  },
  {
    id: 'would_book_again',
    type: 'choice_with_text',
    question: 'Would you book another session with this therapist?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
    followUpPlaceholder: 'Tell us more (optional)...',
  },
  {
    id: 'would_recommend',
    type: 'choice_with_text',
    question: 'Would you recommend Spill to someone based on this session?',
    required: true,
    options: ['Yes', 'No', 'Unsure'],
    followUpPlaceholder: 'Tell us more (optional)...',
  },
  {
    id: 'additional_comments',
    type: 'text',
    question: 'Is there anything else we should know?',
    required: false,
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
      const needsDefaults = !questions || !Array.isArray(questions) || questions.length === 0 || config.questionsVersion === 0;
      if (needsDefaults) {
        config = await prisma.feedbackFormConfig.update({
          where: { id: 'default' },
          data: {
            questions: DEFAULT_QUESTIONS,
            requiresAuth: true,
            questionsVersion: 1,
          },
        });
        logger.info('Populated feedback form config with default questions (v1)');
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
      synced?: string;
      therapist?: string;
      trackingCode?: string;
      from?: string;
      to?: string;
    };
  }>('/api/admin/forms/feedback/submissions', async (request, reply) => {
    try {
      const { page = '1', limit = '20', synced, therapist, trackingCode, from, to } = request.query;

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
   * Get feedback statistics
   */
  fastify.get('/api/admin/forms/feedback/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const [totalSubmissions, recentSubmissions, unsyncedCount, avgScores, wouldBookAgainCounts, wouldRecommendCounts] =
        await Promise.all([
          prisma.feedbackSubmission.count(),
          prisma.feedbackSubmission.count({
            where: { createdAt: { gte: thirtyDaysAgo } },
          }),
          prisma.feedbackSubmission.count({
            where: { syncedToNotion: false },
          }),
          prisma.feedbackSubmission.aggregate({
            _avg: {
              safetyScore: true,
              listenedToScore: true,
              professionalScore: true,
              understoodScore: true,
            },
            where: { createdAt: { gte: thirtyDaysAgo } },
          }),
          prisma.feedbackSubmission.groupBy({
            by: ['wouldBookAgain'],
            _count: true,
            where: {
              createdAt: { gte: thirtyDaysAgo },
              wouldBookAgain: { not: null },
            },
          }),
          prisma.feedbackSubmission.groupBy({
            by: ['wouldRecommend'],
            _count: true,
            where: {
              createdAt: { gte: thirtyDaysAgo },
              wouldRecommend: { not: null },
            },
          }),
        ]);

      return reply.send({ success: true, data: {
        totalSubmissions,
        recentSubmissions,
        unsyncedCount,
        averageScores: {
          safety: avgScores._avg.safetyScore?.toFixed(1) || null,
          listenedTo: avgScores._avg.listenedToScore?.toFixed(1) || null,
          professional: avgScores._avg.professionalScore?.toFixed(1) || null,
          understood: avgScores._avg.understoodScore?.toFixed(1) || null,
        },
        wouldBookAgain: wouldBookAgainCounts.reduce(
          (acc, item) => {
            if (item.wouldBookAgain) {
              acc[item.wouldBookAgain] = item._count;
            }
            return acc;
          },
          {} as Record<string, number>
        ),
        wouldRecommend: wouldRecommendCounts.reduce(
          (acc, item) => {
            if (item.wouldRecommend) {
              acc[item.wouldRecommend] = item._count;
            }
            return acc;
          },
          {} as Record<string, number>
        ),
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
   * Export all feedback submissions as CSV
   */
  fastify.get('/api/admin/forms/feedback/submissions/export', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
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

      const csvHeaders = [
        'Date',
        'Tracking Code',
        'Therapist',
        'Safety (1-5)',
        'Professional (1-5)',
        'Heard (1-5)',
        'Understood (1-5)',
        'Session Benefits',
        'Improvements',
        'Book Again',
        'Book Again (Detail)',
        'Recommend',
        'Recommend (Detail)',
        'Additional Comments',
        'Synced to Notion',
      ];

      const escapeCsv = (val: string | number | null | undefined): string => {
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const csvRows = submissions.map((s) => [
        new Date(s.createdAt).toISOString().split('T')[0],
        s.trackingCode,
        s.therapistName,
        s.safetyScore,
        s.professionalScore,
        s.listenedToScore,
        s.understoodScore,
        s.sessionBenefits,
        s.improvementSuggestions,
        s.wouldBookAgain,
        s.wouldBookAgainText,
        s.wouldRecommend,
        s.wouldRecommendText,
        s.additionalComments,
        s.syncedToNotion ? 'Yes' : 'No',
      ].map(escapeCsv).join(','));

      const csv = [csvHeaders.join(','), ...csvRows].join('\n');

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

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';
import { RATE_LIMITS } from '../constants';
import { knowledgeService } from '../services/knowledge.service';

// FIX M8: Add validation limits for content length and title
const KNOWLEDGE_LIMITS = {
  TITLE_MAX_LENGTH: 200,
  CONTENT_MAX_LENGTH: 10000, // 10KB max for knowledge base content
  CONTENT_MIN_LENGTH: 1,
};

// Validation schemas
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

export async function adminKnowledgeRoutes(fastify: FastifyInstance) {
  // Auth middleware - require webhook secret for admin access
  fastify.addHook('preHandler', verifyWebhookSecret);

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

      return reply.send({
        success: true,
        data: entries,
      });
    } catch (err) {
      logger.error({ err, requestId }, 'Failed to fetch knowledge entries');
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch knowledge entries',
      });
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
      return reply.status(400).send({
        success: false,
        error: 'Invalid request body',
        details: validation.error.errors,
      });
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

      return reply.status(201).send({
        success: true,
        data: entry,
      });
    } catch (err) {
      logger.error({ err, requestId }, 'Failed to create knowledge entry');
      return reply.status(500).send({
        success: false,
        error: 'Failed to create knowledge entry',
      });
    }
  });

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
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: validation.error.errors,
        });
      }

      try {
        // Check if entry exists
        const existing = await prisma.knowledgeBase.findUnique({
          where: { id },
        });

        if (!existing) {
          return reply.status(404).send({
            success: false,
            error: 'Knowledge entry not found',
          });
        }

        const entry = await prisma.knowledgeBase.update({
          where: { id },
          data: validation.data,
        });

        knowledgeService.invalidateCache();
        logger.info({ requestId, entryId: id }, 'Updated knowledge entry');

        return reply.send({
          success: true,
          data: entry,
        });
      } catch (err) {
        logger.error({ err, requestId, entryId: id }, 'Failed to update knowledge entry');
        return reply.status(500).send({
          success: false,
          error: 'Failed to update knowledge entry',
        });
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
        // Check if entry exists
        const existing = await prisma.knowledgeBase.findUnique({
          where: { id },
        });

        if (!existing) {
          return reply.status(404).send({
            success: false,
            error: 'Knowledge entry not found',
          });
        }

        await prisma.knowledgeBase.delete({
          where: { id },
        });

        knowledgeService.invalidateCache();
        logger.info({ requestId, entryId: id }, 'Deleted knowledge entry');

        return reply.send({
          success: true,
          message: 'Knowledge entry deleted',
        });
      } catch (err) {
        logger.error({ err, requestId, entryId: id }, 'Failed to delete knowledge entry');
        return reply.status(500).send({
          success: false,
          error: 'Failed to delete knowledge entry',
        });
      }
    }
  );
}

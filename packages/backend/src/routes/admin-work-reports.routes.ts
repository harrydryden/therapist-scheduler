/**
 * Admin Work Reports Routes
 * API endpoints for viewing and managing daily work reports.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { sendSuccess, Errors } from '../utils/response';
import { verifyWebhookSecret } from '../middleware/auth';
import { workReportService } from '../services/work-report.service';

export async function adminWorkReportRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * GET /api/admin/work-reports
   * List work reports with pagination (newest first)
   */
  fastify.get(
    '/api/admin/work-reports',
    async (request: FastifyRequest<{ Querystring: { page?: string; limit?: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Fetching work reports');

      try {
        const page = Math.max(1, parseInt(request.query.page || '1', 10));
        const limit = Math.min(50, Math.max(1, parseInt(request.query.limit || '20', 10)));
        const skip = (page - 1) * limit;

        const [reports, total] = await Promise.all([
          prisma.workReport.findMany({
            orderBy: { periodEnd: 'desc' },
            skip,
            take: limit,
          }),
          prisma.workReport.count(),
        ]);

        return sendSuccess(reply, reports, {
          count: reports.length,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch work reports');
        return Errors.internal(reply, 'Failed to fetch work reports');
      }
    }
  );

  /**
   * GET /api/admin/work-reports/:id
   * Get a single work report by ID
   */
  fastify.get(
    '/api/admin/work-reports/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const requestId = request.id;
      const { id } = request.params;

      try {
        const report = await prisma.workReport.findUnique({
          where: { id },
        });

        if (!report) {
          return Errors.notFound(reply, 'Work report');
        }

        return sendSuccess(reply, report);
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch work report');
        return Errors.internal(reply, 'Failed to fetch work report');
      }
    }
  );

  /**
   * POST /api/admin/work-reports/generate
   * Manually trigger a work report generation (for testing or catch-up)
   */
  fastify.post(
    '/api/admin/work-reports/generate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Manual work report generation triggered');

      try {
        await workReportService.generateAndSendReport();
        return sendSuccess(reply, { generated: true }, { message: 'Work report generated and sent to Slack' });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to generate work report');
        return Errors.internal(reply, 'Failed to generate work report');
      }
    }
  );
}

/**
 * Admin Stats Routes
 * Dashboard summary statistics and metrics.
 * Split from admin-dashboard.routes.ts (FIX #10).
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';

export async function adminStatsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * GET /api/admin/dashboard/stats
   * Get summary statistics for the dashboard
   */
  fastify.get(
    '/api/admin/dashboard/stats',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Fetching dashboard stats');

      try {
        const [statusCounts, recentConfirmed, userStats, totalRequests] = await Promise.all([
          // Count by status
          prisma.appointmentRequest.groupBy({
            by: ['status'],
            _count: { id: true },
          }),
          // Recent confirmed (last 7 days)
          prisma.appointmentRequest.count({
            where: {
              status: 'confirmed',
              confirmedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            },
          }),
          // Top users by booking count
          prisma.appointmentRequest.groupBy({
            by: ['userEmail', 'userName'],
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: 10,
          }),
          // Total requests
          prisma.appointmentRequest.count(),
        ]);

        const stats = {
          byStatus: Object.fromEntries(statusCounts.map((s) => [s.status, s._count.id])),
          confirmedLast7Days: recentConfirmed,
          totalRequests,
          topUsers: userStats.map((u) => ({
            name: u.userName || u.userEmail,
            email: u.userEmail,
            bookingCount: u._count.id,
          })),
        };

        return reply.send({ success: true, data: stats });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch dashboard stats');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch dashboard stats',
        });
      }
    }
  );
}

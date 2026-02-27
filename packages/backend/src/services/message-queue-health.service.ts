/**
 * Message Queue Health & Review Service
 *
 * Provides a unified view across all message delivery systems:
 * - BullMQ email queue
 * - PendingEmail database queue (polling fallback)
 * - Side effect tracker (lifecycle notifications)
 * - Gmail notification retry queue
 * - Write-ahead log (WAL) for DB downtime recovery
 *
 * This service enables admins to:
 * 1. See all stuck/failed messages across all subsystems in one place
 * 2. Monitor queue depths and failure rates
 * 3. Trigger manual retries of stuck items
 * 4. Detect systemic issues (e.g., Gmail API down, DB latency spikes)
 */

import { prisma } from '../utils/database';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { emailQueueService } from './email-queue.service';
import { sideEffectTrackerService } from './side-effect-tracker.service';
import { getBackgroundTaskHealth } from '../utils/background-task';

// WAL key must match the one in email-queue.service.ts
const WAL_KEY = 'email:write-ahead-log';

export interface QueueHealthReport {
  timestamp: string;
  overall: 'healthy' | 'degraded' | 'critical';
  subsystems: {
    emailQueue: {
      status: 'healthy' | 'degraded' | 'unavailable';
      bullmq: {
        available: boolean;
        waiting: number;
        active: number;
        delayed: number;
        failed: number;
      };
      pendingEmails: {
        pending: number;
        failed: number;
        abandoned: number;
        oldestPendingMinutes: number | null;
      };
      writeAheadLog: {
        entries: number;
      };
    };
    sideEffects: {
      status: 'healthy' | 'degraded' | 'critical';
      pending: number;
      failed: number;
      abandoned: number;
      byType: Record<string, { pending: number; failed: number }>;
    };
    gmailNotifications: {
      failedRetryCount: number;
    };
    backgroundTasks: ReturnType<typeof getBackgroundTaskHealth>;
  };
}

export interface StuckMessage {
  id: string;
  subsystem: 'pending_email' | 'side_effect' | 'wal_entry';
  type: string;
  status: string;
  recipient?: string;
  subject?: string;
  appointmentId?: string;
  attempts: number;
  createdAt: string;
  lastAttemptAt?: string;
  errorMessage?: string;
}

class MessageQueueHealthService {
  /**
   * Get a comprehensive health report across all message queues.
   */
  async getHealthReport(): Promise<QueueHealthReport> {
    const [bullmqStats, pendingEmailStats, sideEffectStats, walLength, failedNotifications, bgTaskHealth] =
      await Promise.all([
        this.getBullMQStats(),
        this.getPendingEmailStats(),
        this.getSideEffectStats(),
        this.getWALLength(),
        this.getFailedNotificationCount(),
        Promise.resolve(getBackgroundTaskHealth()),
      ]);

    // Determine email queue status
    let emailQueueStatus: 'healthy' | 'degraded' | 'unavailable' = 'healthy';
    if (!bullmqStats.available && pendingEmailStats.pending > 10) {
      emailQueueStatus = 'degraded';
    }
    if (pendingEmailStats.abandoned > 0 || pendingEmailStats.failed > 5) {
      emailQueueStatus = 'degraded';
    }

    // Determine side effect status
    let sideEffectStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (sideEffectStats.failed > 0) {
      sideEffectStatus = 'degraded';
    }
    if (sideEffectStats.abandoned > 0 || sideEffectStats.failed > 10) {
      sideEffectStatus = 'critical';
    }

    // Overall status
    let overall: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (emailQueueStatus === 'degraded' || sideEffectStatus === 'degraded') {
      overall = 'degraded';
    }
    if (sideEffectStatus === 'critical' || emailQueueStatus === 'unavailable') {
      overall = 'critical';
    }
    if (walLength > 0) {
      overall = 'degraded'; // WAL entries mean DB was down at some point
    }

    return {
      timestamp: new Date().toISOString(),
      overall,
      subsystems: {
        emailQueue: {
          status: emailQueueStatus,
          bullmq: bullmqStats,
          pendingEmails: pendingEmailStats,
          writeAheadLog: { entries: walLength },
        },
        sideEffects: {
          status: sideEffectStatus,
          ...sideEffectStats,
        },
        gmailNotifications: {
          failedRetryCount: failedNotifications,
        },
        backgroundTasks: bgTaskHealth,
      },
    };
  }

  /**
   * Get all stuck/failed messages across all subsystems for admin review.
   */
  async getStuckMessages(limit: number = 50): Promise<StuckMessage[]> {
    const messages: StuckMessage[] = [];

    // 1. Failed/abandoned pending emails
    const stuckEmails = await prisma.pendingEmail.findMany({
      where: {
        status: { in: ['failed', 'abandoned'] },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    for (const email of stuckEmails) {
      messages.push({
        id: email.id,
        subsystem: 'pending_email',
        type: 'outgoing_email',
        status: email.status,
        recipient: email.toEmail,
        subject: email.subject,
        appointmentId: email.appointmentId || undefined,
        attempts: email.retryCount,
        createdAt: email.createdAt.toISOString(),
        lastAttemptAt: email.lastRetryAt?.toISOString(),
        errorMessage: email.errorMessage || undefined,
      });
    }

    // Also include long-pending emails (stuck in 'pending' for > 30 minutes)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const longPendingEmails = await prisma.pendingEmail.findMany({
      where: {
        status: 'pending',
        createdAt: { lt: thirtyMinutesAgo },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(0, limit - messages.length),
    });

    for (const email of longPendingEmails) {
      messages.push({
        id: email.id,
        subsystem: 'pending_email',
        type: 'stuck_pending_email',
        status: 'stuck_pending',
        recipient: email.toEmail,
        subject: email.subject,
        appointmentId: email.appointmentId || undefined,
        attempts: email.retryCount,
        createdAt: email.createdAt.toISOString(),
        lastAttemptAt: email.lastRetryAt?.toISOString(),
        errorMessage: email.errorMessage || undefined,
      });
    }

    // 2. Failed/pending side effects
    const stuckEffects = await prisma.sideEffectLog.findMany({
      where: {
        status: { in: ['failed', 'abandoned'] },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.max(0, limit - messages.length),
    });

    for (const effect of stuckEffects) {
      messages.push({
        id: effect.id,
        subsystem: 'side_effect',
        type: effect.effectType,
        status: effect.status,
        appointmentId: effect.appointmentId,
        attempts: effect.attempts,
        createdAt: effect.createdAt.toISOString(),
        lastAttemptAt: effect.lastAttempt?.toISOString(),
        errorMessage: effect.errorLog || undefined,
      });
    }

    // 3. WAL entries (emails buffered during DB downtime)
    try {
      const walEntries = await redis.lrange(WAL_KEY, 0, Math.max(0, limit - messages.length) - 1);
      for (const entryStr of walEntries) {
        try {
          const entry = JSON.parse(entryStr);
          messages.push({
            id: entry.id,
            subsystem: 'wal_entry',
            type: 'db_downtime_buffered_email',
            status: 'awaiting_recovery',
            recipient: entry.to,
            subject: entry.subject,
            appointmentId: entry.appointmentId,
            attempts: 0,
            createdAt: entry.createdAt,
          });
        } catch {
          // Skip malformed entries
        }
      }
    } catch {
      // Redis unavailable
    }

    // Sort by creation time, oldest first
    messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return messages.slice(0, limit);
  }

  /**
   * Trigger recovery of WAL entries (for admin use).
   */
  async triggerWALRecovery(): Promise<number> {
    return emailQueueService.recoverFromWAL();
  }

  private async getBullMQStats() {
    return emailQueueService.getStats();
  }

  private async getPendingEmailStats() {
    try {
      const [pendingCount, failedCount, abandonedCount, oldestPending] = await Promise.all([
        prisma.pendingEmail.count({ where: { status: 'pending' } }),
        prisma.pendingEmail.count({ where: { status: 'failed' } }),
        prisma.pendingEmail.count({ where: { status: 'abandoned' } }),
        prisma.pendingEmail.findFirst({
          where: { status: 'pending' },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
      ]);

      const oldestPendingMinutes = oldestPending
        ? Math.round((Date.now() - oldestPending.createdAt.getTime()) / 60000)
        : null;

      return {
        pending: pendingCount,
        failed: failedCount,
        abandoned: abandonedCount,
        oldestPendingMinutes,
      };
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch pending email stats');
      return { pending: 0, failed: 0, abandoned: 0, oldestPendingMinutes: null };
    }
  }

  private async getSideEffectStats() {
    try {
      return await sideEffectTrackerService.getStats();
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch side effect stats');
      return { pending: 0, completed: 0, failed: 0, abandoned: 0, byType: {} };
    }
  }

  private async getWALLength(): Promise<number> {
    try {
      return await redis.llen(WAL_KEY);
    } catch {
      return 0;
    }
  }

  private async getFailedNotificationCount(): Promise<number> {
    try {
      return await redis.scard('gmail:failed:set');
    } catch {
      return 0;
    }
  }
}

export const messageQueueHealthService = new MessageQueueHealthService();

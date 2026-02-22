/**
 * Admin Notification Service
 *
 * Centralizes admin alerting for urgent issues requiring human attention:
 * - Thread divergence (critical/high severity)
 * - Conversation stalls (activity but no progress)
 * - Tool execution failures
 * - Therapist booking status alerts
 *
 * This service provides a unified interface for the admin dashboard to
 * retrieve and manage all types of alerts across the system.
 *
 * FIX TODO: Previously, flagged issues were not delivered to admin in a
 * consolidated way. This service resolves that by aggregating all alert types.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import {
  calculateConversationHealth,
  calculateHealthStats,
  type ConversationHealth,
  type HealthSummaryStats,
  type AppointmentForHealth,
  type HealthStatus,
} from './conversation-health.service';

export interface AdminAlert {
  id: string;
  type: 'thread_divergence' | 'conversation_stall' | 'tool_failure' | 'therapist_alert';
  appointmentId?: string;
  therapistId?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  details: string;
  createdAt: Date;
  acknowledged: boolean;
}

class AdminNotificationService {
  /**
   * Get all unacknowledged alerts for admin dashboard
   */
  async getUnacknowledgedAlerts(): Promise<AdminAlert[]> {
    const alerts: AdminAlert[] = [];

    // Fetch all alert types in parallel (independent queries)
    const [divergenceAlerts, stallAlerts, therapistAlerts] = await Promise.all([
      // Thread divergence alerts (FIX R3)
      prisma.appointmentRequest.findMany({
        where: {
          threadDivergedAt: { not: null },
          threadDivergenceAcknowledged: false,
        },
        select: {
          id: true,
          userName: true,
          therapistName: true,
          threadDivergedAt: true,
          threadDivergenceDetails: true,
        },
        orderBy: { threadDivergedAt: 'desc' },
      }),
      // Conversation stall alerts (FIX NEW, T3)
      prisma.appointmentRequest.findMany({
        where: {
          conversationStallAlertAt: { not: null },
          conversationStallAcknowledged: false,
        },
        select: {
          id: true,
          userName: true,
          therapistName: true,
          conversationStallAlertAt: true,
          lastActivityAt: true,
          lastToolExecutedAt: true,
          lastToolExecutionFailed: true,
          lastToolFailureReason: true,
        },
        orderBy: { conversationStallAlertAt: 'desc' },
      }),
      // Therapist booking status alerts
      prisma.therapistBookingStatus.findMany({
        where: {
          adminAlertAt: { not: null },
          adminAlertAcknowledged: false,
        },
        select: {
          id: true,
          therapistName: true,
          adminAlertAt: true,
          uniqueRequestCount: true,
        },
        orderBy: { adminAlertAt: 'desc' },
      }),
    ]);

    for (const apt of divergenceAlerts) {
      let details: Record<string, unknown> = {};
      try {
        if (apt.threadDivergenceDetails) {
          details = JSON.parse(apt.threadDivergenceDetails);
        }
      } catch {
        details = { description: 'Failed to parse divergence details' };
      }

      alerts.push({
        id: `divergence-${apt.id}`,
        type: 'thread_divergence',
        appointmentId: apt.id,
        severity: (details.severity as 'low' | 'medium' | 'high' | 'critical') || 'high',
        title: `Thread divergence: ${apt.userName || 'Unknown'} / ${apt.therapistName}`,
        details: (details.description as string) || 'Email thread divergence detected',
        createdAt: apt.threadDivergedAt!,
        acknowledged: false,
      });
    }

    for (const apt of stallAlerts) {
      // Check if this is due to tool failure
      const isToolFailure = apt.lastToolExecutionFailed;

      let detailText: string;
      if (isToolFailure) {
        detailText = `Tool execution failed: ${apt.lastToolFailureReason || 'Unknown reason'}`;
      } else {
        const lastActivity = apt.lastActivityAt?.toISOString() || 'never';
        const lastTool = apt.lastToolExecutedAt?.toISOString() || 'never';
        detailText = `Last activity: ${lastActivity}, Last tool execution: ${lastTool}`;
      }

      alerts.push({
        id: `stall-${apt.id}`,
        type: isToolFailure ? 'tool_failure' : 'conversation_stall',
        appointmentId: apt.id,
        severity: isToolFailure ? 'high' : 'medium',
        title: isToolFailure
          ? `Tool failure: ${apt.userName || 'Unknown'} / ${apt.therapistName}`
          : `Conversation stalled: ${apt.userName || 'Unknown'} / ${apt.therapistName}`,
        details: detailText,
        createdAt: apt.conversationStallAlertAt!,
        acknowledged: false,
      });
    }

    for (const therapist of therapistAlerts) {
      alerts.push({
        id: `therapist-${therapist.id}`,
        type: 'therapist_alert',
        therapistId: therapist.id,
        severity: 'high',
        title: `Therapist needs attention: ${therapist.therapistName}`,
        details: `${therapist.uniqueRequestCount} pending requests with no progress in 72+ hours`,
        createdAt: therapist.adminAlertAt!,
        acknowledged: false,
      });
    }

    // Sort by creation date, most recent first
    return alerts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Acknowledge an alert by its composite ID
   */
  async acknowledgeAlert(alertId: string): Promise<void> {
    // Parse the composite ID: "type-uuid"
    const dashIndex = alertId.indexOf('-');
    if (dashIndex === -1) {
      throw new Error(`Invalid alert ID format: ${alertId}`);
    }

    const type = alertId.substring(0, dashIndex);
    const id = alertId.substring(dashIndex + 1);

    switch (type) {
      case 'divergence':
        await prisma.appointmentRequest.update({
          where: { id },
          data: { threadDivergenceAcknowledged: true },
        });
        break;
      case 'stall':
        await prisma.appointmentRequest.update({
          where: { id },
          data: { conversationStallAcknowledged: true },
        });
        break;
      case 'therapist':
        await prisma.therapistBookingStatus.update({
          where: { id },
          data: { adminAlertAcknowledged: true },
        });
        break;
      default:
        throw new Error(`Unknown alert type: ${type}`);
    }

    logger.info({ alertId, type, entityId: id }, 'Admin alert acknowledged');
  }

  /**
   * Get count of unacknowledged alerts (for dashboard badge)
   */
  async getAlertCount(): Promise<number> {
    const [divergence, stall, therapist] = await Promise.all([
      prisma.appointmentRequest.count({
        where: { threadDivergedAt: { not: null }, threadDivergenceAcknowledged: false },
      }),
      prisma.appointmentRequest.count({
        where: { conversationStallAlertAt: { not: null }, conversationStallAcknowledged: false },
      }),
      prisma.therapistBookingStatus.count({
        where: { adminAlertAt: { not: null }, adminAlertAcknowledged: false },
      }),
    ]);

    return divergence + stall + therapist;
  }

  /**
   * Get alerts by type
   */
  async getAlertsByType(type: AdminAlert['type']): Promise<AdminAlert[]> {
    const allAlerts = await this.getUnacknowledgedAlerts();
    return allAlerts.filter((alert) => alert.type === type);
  }

  /**
   * Acknowledge all alerts of a specific type
   */
  async acknowledgeAllByType(type: AdminAlert['type']): Promise<number> {
    let count = 0;

    switch (type) {
      case 'thread_divergence':
        const divergenceResult = await prisma.appointmentRequest.updateMany({
          where: { threadDivergedAt: { not: null }, threadDivergenceAcknowledged: false },
          data: { threadDivergenceAcknowledged: true },
        });
        count = divergenceResult.count;
        break;
      case 'conversation_stall':
      case 'tool_failure':
        const stallResult = await prisma.appointmentRequest.updateMany({
          where: { conversationStallAlertAt: { not: null }, conversationStallAcknowledged: false },
          data: { conversationStallAcknowledged: true },
        });
        count = stallResult.count;
        break;
      case 'therapist_alert':
        const therapistResult = await prisma.therapistBookingStatus.updateMany({
          where: { adminAlertAt: { not: null }, adminAlertAcknowledged: false },
          data: { adminAlertAcknowledged: true },
        });
        count = therapistResult.count;
        break;
    }

    logger.info({ type, count }, 'Acknowledged all alerts of type');
    return count;
  }

  /**
   * Get health status for all active conversations
   * Returns health data for dashboard visualization
   */
  async getConversationHealthStatuses(): Promise<{
    conversations: Array<{
      id: string;
      userName: string | null;
      therapistName: string;
      status: string;
      health: ConversationHealth;
    }>;
    stats: HealthSummaryStats;
  }> {
    // Fetch active appointments with fields needed for health calculation
    const appointments = await prisma.appointmentRequest.findMany({
      where: {
        status: { in: ['pending', 'contacted', 'negotiating'] },
      },
      select: {
        id: true,
        userName: true,
        therapistName: true,
        status: true,
        lastActivityAt: true,
        lastToolExecutedAt: true,
        lastToolExecutionFailed: true,
        lastToolFailureReason: true,
        threadDivergedAt: true,
        threadDivergenceDetails: true,
        threadDivergenceAcknowledged: true,
        conversationStallAlertAt: true,
        conversationStallAcknowledged: true,
        humanControlEnabled: true,
        isStale: true,
      },
      orderBy: { lastActivityAt: 'desc' },
    });

    // Calculate health for each conversation
    const conversationsWithHealth = appointments.map((apt) => {
      const healthInput: AppointmentForHealth = {
        id: apt.id,
        status: apt.status,
        lastActivityAt: apt.lastActivityAt,
        lastToolExecutedAt: apt.lastToolExecutedAt,
        lastToolExecutionFailed: apt.lastToolExecutionFailed,
        lastToolFailureReason: apt.lastToolFailureReason,
        threadDivergedAt: apt.threadDivergedAt,
        threadDivergenceDetails: apt.threadDivergenceDetails,
        threadDivergenceAcknowledged: apt.threadDivergenceAcknowledged,
        conversationStallAlertAt: apt.conversationStallAlertAt,
        conversationStallAcknowledged: apt.conversationStallAcknowledged,
        humanControlEnabled: apt.humanControlEnabled,
        isStale: apt.isStale,
      };

      return {
        id: apt.id,
        userName: apt.userName,
        therapistName: apt.therapistName,
        status: apt.status,
        health: calculateConversationHealth(healthInput),
      };
    });

    // Calculate summary statistics
    const healthResults = conversationsWithHealth.map((c) => c.health);
    const stats = calculateHealthStats(healthResults);

    // Sort by health status: red first, then yellow, then green
    const statusOrder: Record<HealthStatus, number> = { red: 0, yellow: 1, green: 2 };
    conversationsWithHealth.sort((a, b) => {
      const orderDiff = statusOrder[a.health.status] - statusOrder[b.health.status];
      if (orderDiff !== 0) return orderDiff;
      // Within same status, sort by score (lower first)
      return a.health.score - b.health.score;
    });

    return {
      conversations: conversationsWithHealth,
      stats,
    };
  }

  /**
   * Get health status for a single appointment
   */
  async getAppointmentHealth(appointmentId: string): Promise<ConversationHealth | null> {
    const apt = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
        lastActivityAt: true,
        lastToolExecutedAt: true,
        lastToolExecutionFailed: true,
        lastToolFailureReason: true,
        threadDivergedAt: true,
        threadDivergenceDetails: true,
        threadDivergenceAcknowledged: true,
        conversationStallAlertAt: true,
        conversationStallAcknowledged: true,
        humanControlEnabled: true,
        isStale: true,
      },
    });

    if (!apt) {
      return null;
    }

    const healthInput: AppointmentForHealth = {
      id: apt.id,
      status: apt.status,
      lastActivityAt: apt.lastActivityAt,
      lastToolExecutedAt: apt.lastToolExecutedAt,
      lastToolExecutionFailed: apt.lastToolExecutionFailed,
      lastToolFailureReason: apt.lastToolFailureReason,
      threadDivergedAt: apt.threadDivergedAt,
      threadDivergenceDetails: apt.threadDivergenceDetails,
      threadDivergenceAcknowledged: apt.threadDivergenceAcknowledged,
      conversationStallAlertAt: apt.conversationStallAlertAt,
      conversationStallAcknowledged: apt.conversationStallAcknowledged,
      humanControlEnabled: apt.humanControlEnabled,
      isStale: apt.isStale,
    };

    return calculateConversationHealth(healthInput);
  }

  /**
   * Get combined dashboard data: alerts + health overview
   * This provides a unified view for the admin dashboard
   */
  async getDashboardOverview(): Promise<{
    alerts: {
      items: AdminAlert[];
      count: number;
    };
    health: {
      stats: HealthSummaryStats;
      criticalCount: number; // Conversations with red health
      warningCount: number; // Conversations with yellow health
    };
  }> {
    const [alerts, healthData] = await Promise.all([
      this.getUnacknowledgedAlerts(),
      this.getConversationHealthStatuses(),
    ]);

    return {
      alerts: {
        items: alerts,
        count: alerts.length,
      },
      health: {
        stats: healthData.stats,
        criticalCount: healthData.stats.red,
        warningCount: healthData.stats.yellow,
      },
    };
  }
}

export const adminNotificationService = new AdminNotificationService();

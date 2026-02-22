/**
 * Therapist Response Time Tracking
 *
 * Tracks and analyzes therapist response times to:
 * - Identify slow responders proactively
 * - Provide metrics for admin dashboard
 * - Trigger follow-up reminders appropriately
 * - Help with therapist matching (prefer faster responders)
 */

import { logger } from './logger';

/**
 * Response time thresholds (in hours)
 */
export const RESPONSE_TIME_THRESHOLDS = {
  FAST: 4,           // Under 4 hours = fast
  NORMAL: 24,        // Under 24 hours = normal
  SLOW: 48,          // Under 48 hours = slow
  VERY_SLOW: 72,     // Under 72 hours = very slow
  UNRESPONSIVE: 120, // Over 5 days = unresponsive
};

/**
 * Response speed category
 */
export type ResponseSpeed =
  | 'fast'         // < 4 hours
  | 'normal'       // 4-24 hours
  | 'slow'         // 24-48 hours
  | 'very_slow'    // 48-72 hours
  | 'unresponsive' // > 72 hours
  | 'pending';     // Still waiting

/**
 * Individual response event
 */
export interface ResponseEvent {
  appointmentId: string;
  therapistEmail: string;
  emailSentAt: Date;
  responseReceivedAt: Date | null;
  emailType: 'initial_outreach' | 'availability_request' | 'confirmation_request' | 'follow_up';
  responseTimeHours: number | null;
}

/**
 * Aggregated therapist stats
 */
export interface TherapistResponseStats {
  therapistEmail: string;
  totalRequests: number;
  totalResponses: number;
  responseRate: number; // 0-1
  averageResponseTimeHours: number | null;
  medianResponseTimeHours: number | null;
  fastestResponseHours: number | null;
  slowestResponseHours: number | null;
  speed: ResponseSpeed;
  lastResponseAt: Date | null;
  pendingRequests: number;
  trend: 'improving' | 'stable' | 'declining' | 'unknown';
}

/**
 * Response time alert
 */
export interface ResponseTimeAlert {
  type: 'slow_response' | 'no_response' | 'pattern_change';
  therapistEmail: string;
  appointmentId?: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  waitingHours: number;
  suggestedAction: string;
}

/**
 * Calculate response time between two timestamps
 */
export function calculateResponseTimeHours(
  sentAt: Date,
  receivedAt: Date
): number {
  const diffMs = receivedAt.getTime() - sentAt.getTime();
  return diffMs / (1000 * 60 * 60);
}

/**
 * Categorize response speed based on hours
 */
export function categorizeResponseSpeed(hours: number | null): ResponseSpeed {
  if (hours === null) return 'pending';
  if (hours < RESPONSE_TIME_THRESHOLDS.FAST) return 'fast';
  if (hours < RESPONSE_TIME_THRESHOLDS.NORMAL) return 'normal';
  if (hours < RESPONSE_TIME_THRESHOLDS.SLOW) return 'slow';
  if (hours < RESPONSE_TIME_THRESHOLDS.VERY_SLOW) return 'very_slow';
  return 'unresponsive';
}

/**
 * Calculate aggregate stats from response events
 */
export function calculateTherapistStats(
  therapistEmail: string,
  events: ResponseEvent[]
): TherapistResponseStats {
  const responseTimes = events
    .filter(e => e.responseTimeHours !== null)
    .map(e => e.responseTimeHours as number);

  const totalRequests = events.length;
  const totalResponses = responseTimes.length;
  const pendingRequests = events.filter(e => e.responseReceivedAt === null).length;

  // Calculate average
  const averageResponseTimeHours = responseTimes.length > 0
    ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
    : null;

  // Calculate median
  let medianResponseTimeHours: number | null = null;
  if (responseTimes.length > 0) {
    const sorted = [...responseTimes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianResponseTimeHours = sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Find fastest and slowest
  const fastestResponseHours = responseTimes.length > 0
    ? Math.min(...responseTimes)
    : null;
  const slowestResponseHours = responseTimes.length > 0
    ? Math.max(...responseTimes)
    : null;

  // Overall speed category based on median (more resistant to outliers)
  const speed = categorizeResponseSpeed(medianResponseTimeHours);

  // Find last response
  const respondedEvents = events.filter(e => e.responseReceivedAt !== null);
  const lastResponseAt = respondedEvents.length > 0
    ? respondedEvents.reduce((latest, e) =>
        e.responseReceivedAt! > latest ? e.responseReceivedAt! : latest,
        respondedEvents[0].responseReceivedAt!
      )
    : null;

  // Calculate trend (compare recent vs older responses)
  const trend = calculateResponseTrend(events);

  return {
    therapistEmail,
    totalRequests,
    totalResponses,
    responseRate: totalRequests > 0 ? totalResponses / totalRequests : 0,
    averageResponseTimeHours,
    medianResponseTimeHours,
    fastestResponseHours,
    slowestResponseHours,
    speed,
    lastResponseAt,
    pendingRequests,
    trend,
  };
}

/**
 * Calculate trend from response history
 */
function calculateResponseTrend(
  events: ResponseEvent[]
): 'improving' | 'stable' | 'declining' | 'unknown' {
  // Need at least 4 responses to determine trend
  const respondedEvents = events
    .filter(e => e.responseTimeHours !== null)
    .sort((a, b) => a.emailSentAt.getTime() - b.emailSentAt.getTime());

  if (respondedEvents.length < 4) {
    return 'unknown';
  }

  // Split into older and newer halves
  const midpoint = Math.floor(respondedEvents.length / 2);
  const olderHalf = respondedEvents.slice(0, midpoint);
  const newerHalf = respondedEvents.slice(midpoint);

  const olderAvg = olderHalf.reduce((sum, e) => sum + (e.responseTimeHours || 0), 0) / olderHalf.length;
  const newerAvg = newerHalf.reduce((sum, e) => sum + (e.responseTimeHours || 0), 0) / newerHalf.length;

  // 20% improvement/decline threshold
  const changeRatio = (newerAvg - olderAvg) / olderAvg;

  if (changeRatio < -0.2) return 'improving'; // Faster = improving
  if (changeRatio > 0.2) return 'declining';  // Slower = declining
  return 'stable';
}

/**
 * Check if a therapist needs a follow-up reminder
 */
export function needsFollowUp(
  emailSentAt: Date,
  currentTime: Date = new Date()
): { needed: boolean; urgency: 'low' | 'medium' | 'high' | 'critical'; hoursWaiting: number } {
  const hoursWaiting = calculateResponseTimeHours(emailSentAt, currentTime);

  if (hoursWaiting < RESPONSE_TIME_THRESHOLDS.NORMAL) {
    return { needed: false, urgency: 'low', hoursWaiting };
  }

  if (hoursWaiting < RESPONSE_TIME_THRESHOLDS.SLOW) {
    return { needed: true, urgency: 'low', hoursWaiting };
  }

  if (hoursWaiting < RESPONSE_TIME_THRESHOLDS.VERY_SLOW) {
    return { needed: true, urgency: 'medium', hoursWaiting };
  }

  if (hoursWaiting < RESPONSE_TIME_THRESHOLDS.UNRESPONSIVE) {
    return { needed: true, urgency: 'high', hoursWaiting };
  }

  return { needed: true, urgency: 'critical', hoursWaiting };
}

/**
 * Generate appropriate follow-up message based on wait time
 */
export function getFollowUpMessage(hoursWaiting: number, therapistName: string): string {
  if (hoursWaiting < RESPONSE_TIME_THRESHOLDS.SLOW) {
    return `Hi ${therapistName}, I wanted to follow up on my previous email about scheduling. When you have a moment, could you let me know your availability?`;
  }

  if (hoursWaiting < RESPONSE_TIME_THRESHOLDS.VERY_SLOW) {
    return `Hi ${therapistName}, I'm following up as I haven't heard back yet regarding scheduling. The user is keen to book a session. Could you please share your available times?`;
  }

  return `Hi ${therapistName}, I've been trying to connect regarding a booking request. If you're currently unavailable to take new clients, please let me know so I can help the user find an alternative.`;
}

/**
 * Check for response time alerts that should be raised
 */
export function checkForAlerts(
  stats: TherapistResponseStats,
  pendingEvents: ResponseEvent[]
): ResponseTimeAlert[] {
  const alerts: ResponseTimeAlert[] = [];
  const now = new Date();

  // Alert for each pending request that's been waiting too long
  for (const event of pendingEvents) {
    if (event.responseReceivedAt !== null) continue;

    const hoursWaiting = calculateResponseTimeHours(event.emailSentAt, now);

    if (hoursWaiting >= RESPONSE_TIME_THRESHOLDS.UNRESPONSIVE) {
      alerts.push({
        type: 'no_response',
        therapistEmail: event.therapistEmail,
        appointmentId: event.appointmentId,
        message: `No response for ${Math.round(hoursWaiting)} hours to ${event.emailType.replace(/_/g, ' ')}`,
        severity: 'critical',
        waitingHours: hoursWaiting,
        suggestedAction: 'Consider alternative therapist or manual outreach',
      });
    } else if (hoursWaiting >= RESPONSE_TIME_THRESHOLDS.VERY_SLOW) {
      alerts.push({
        type: 'slow_response',
        therapistEmail: event.therapistEmail,
        appointmentId: event.appointmentId,
        message: `Waiting ${Math.round(hoursWaiting)} hours for response to ${event.emailType.replace(/_/g, ' ')}`,
        severity: 'warning',
        waitingHours: hoursWaiting,
        suggestedAction: 'Send follow-up reminder',
      });
    }
  }

  // Alert if therapist's response pattern is declining
  if (stats.trend === 'declining' && stats.totalResponses >= 5) {
    alerts.push({
      type: 'pattern_change',
      therapistEmail: stats.therapistEmail,
      message: `Response times are declining. Previous average: faster, recent average: ${Math.round(stats.averageResponseTimeHours || 0)}h`,
      severity: 'info',
      waitingHours: 0,
      suggestedAction: 'Monitor for continued pattern',
    });
  }

  // Alert if response rate is low
  if (stats.responseRate < 0.7 && stats.totalRequests >= 3) {
    alerts.push({
      type: 'pattern_change',
      therapistEmail: stats.therapistEmail,
      message: `Low response rate: ${Math.round(stats.responseRate * 100)}% (${stats.totalResponses}/${stats.totalRequests})`,
      severity: 'warning',
      waitingHours: 0,
      suggestedAction: 'Consider therapist availability status',
    });
  }

  return alerts;
}

/**
 * Get human-readable summary of response stats
 */
export function getStatsSummary(stats: TherapistResponseStats): string {
  const parts: string[] = [];

  parts.push(`**Response Statistics for ${stats.therapistEmail}**`);

  if (stats.totalRequests === 0) {
    parts.push('No booking requests recorded yet.');
    return parts.join('\n');
  }

  parts.push(`Total requests: ${stats.totalRequests}`);
  parts.push(`Response rate: ${Math.round(stats.responseRate * 100)}%`);

  if (stats.averageResponseTimeHours !== null) {
    parts.push(`Average response time: ${formatHours(stats.averageResponseTimeHours)}`);
  }

  if (stats.medianResponseTimeHours !== null) {
    parts.push(`Median response time: ${formatHours(stats.medianResponseTimeHours)}`);
  }

  parts.push(`Response speed: ${stats.speed.replace('_', ' ')}`);

  if (stats.trend !== 'unknown') {
    parts.push(`Trend: ${stats.trend}`);
  }

  if (stats.pendingRequests > 0) {
    parts.push(`**Pending requests: ${stats.pendingRequests}**`);
  }

  return parts.join('\n');
}

/**
 * Format hours into human-readable string
 */
function formatHours(hours: number): string {
  if (hours < 1) {
    return `${Math.round(hours * 60)} minutes`;
  }
  if (hours < 24) {
    return `${Math.round(hours)} hour${hours >= 2 ? 's' : ''}`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = Math.round(hours % 24);
  if (remainingHours === 0) {
    return `${days} day${days > 1 ? 's' : ''}`;
  }
  return `${days} day${days > 1 ? 's' : ''} ${remainingHours}h`;
}

/**
 * Rank therapists by response quality for matching
 */
export function rankTherapistsByResponsiveness(
  therapistStats: TherapistResponseStats[]
): TherapistResponseStats[] {
  return [...therapistStats].sort((a, b) => {
    // First by speed category
    const speedOrder: Record<ResponseSpeed, number> = {
      fast: 0,
      normal: 1,
      slow: 2,
      very_slow: 3,
      unresponsive: 4,
      pending: 5,
    };
    const speedDiff = speedOrder[a.speed] - speedOrder[b.speed];
    if (speedDiff !== 0) return speedDiff;

    // Then by response rate
    const rateDiff = b.responseRate - a.responseRate;
    if (Math.abs(rateDiff) > 0.1) return rateDiff > 0 ? 1 : -1;

    // Then by median response time
    if (a.medianResponseTimeHours !== null && b.medianResponseTimeHours !== null) {
      return a.medianResponseTimeHours - b.medianResponseTimeHours;
    }

    return 0;
  });
}

/**
 * Log response event for tracking
 */
export function logResponseEvent(
  event: ResponseEvent,
  context?: { traceId?: string }
): void {
  const logData = {
    ...context,
    appointmentId: event.appointmentId,
    therapistEmail: event.therapistEmail,
    emailType: event.emailType,
    responseTimeHours: event.responseTimeHours,
    speed: event.responseTimeHours !== null
      ? categorizeResponseSpeed(event.responseTimeHours)
      : 'pending',
  };

  if (event.responseReceivedAt) {
    logger.info(logData, 'Therapist response received');
  } else {
    logger.debug(logData, 'Tracking pending response');
  }
}

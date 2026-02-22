/**
 * Conversation Health Service
 *
 * Calculates health status for conversations based on various indicators:
 * - Time since last activity (stale detection)
 * - Time since last tool execution (stall detection)
 * - Thread divergence issues
 * - Tool execution failures
 * - Human control status
 *
 * Health statuses:
 * - GREEN: Everything within healthy boundaries
 * - YELLOW: Approaching thresholds, needs monitoring
 * - RED: Has issues requiring attention
 */

import { STALE_THRESHOLDS, STALL_DETECTION, APPOINTMENT_STATUS } from '../constants';

/**
 * Health status levels
 */
export type HealthStatus = 'green' | 'yellow' | 'red';

/**
 * Detailed health status with contributing factors
 */
export interface ConversationHealth {
  status: HealthStatus;
  score: number; // 0-100, higher is healthier
  factors: HealthFactor[];
  summary: string;
}

/**
 * Individual factor contributing to health status
 */
export interface HealthFactor {
  name: string;
  status: HealthStatus;
  value: string;
  threshold?: string;
  description: string;
}

/**
 * Health thresholds configuration
 * Yellow thresholds are typically 75% of the red threshold
 */
export const HEALTH_THRESHOLDS = {
  // Inactivity thresholds (hours)
  INACTIVITY: {
    // Red: at stale threshold (48h)
    RED_HOURS: STALE_THRESHOLDS.MARK_STALE_HOURS,
    // Yellow: 75% of stale threshold (36h)
    YELLOW_HOURS: Math.floor(STALE_THRESHOLDS.MARK_STALE_HOURS * 0.75),
  },
  // Stall thresholds (hours since last tool execution)
  STALL: {
    // Red: at stall threshold (24h)
    RED_HOURS: STALL_DETECTION.STALL_THRESHOLD_HOURS,
    // Yellow: 75% of stall threshold (18h)
    YELLOW_HOURS: Math.floor(STALL_DETECTION.STALL_THRESHOLD_HOURS * 0.75),
  },
  // Weights for scoring (sum to 100)
  WEIGHTS: {
    INACTIVITY: 30,
    STALL: 25,
    THREAD_DIVERGENCE: 20,
    TOOL_FAILURE: 15,
    HUMAN_CONTROL: 10,
  },
} as const;

/**
 * Appointment data needed for health calculation
 */
export interface AppointmentForHealth {
  id: string;
  status: string;
  lastActivityAt: Date;
  lastToolExecutedAt: Date | null;
  lastToolExecutionFailed: boolean;
  lastToolFailureReason: string | null;
  threadDivergedAt: Date | null;
  threadDivergenceDetails: string | null;
  threadDivergenceAcknowledged: boolean;
  conversationStallAlertAt: Date | null;
  conversationStallAcknowledged: boolean;
  humanControlEnabled: boolean;
  isStale: boolean;
}

/**
 * Statuses that don't require active conversation monitoring
 * These are either terminal states or post-session stages where no messages are expected
 */
const STATUSES_NOT_REQUIRING_MONITORING: string[] = [
  APPOINTMENT_STATUS.CONFIRMED,      // Booking complete, awaiting session
  APPOINTMENT_STATUS.SESSION_HELD,   // Session done, awaiting feedback
  APPOINTMENT_STATUS.FEEDBACK_REQUESTED, // Feedback sent, awaiting response
  APPOINTMENT_STATUS.COMPLETED,      // Fully complete
  APPOINTMENT_STATUS.CANCELLED,      // Cancelled
];

/**
 * Calculate health status for a single conversation
 */
export function calculateConversationHealth(
  appointment: AppointmentForHealth
): ConversationHealth {
  const factors: HealthFactor[] = [];
  const now = new Date();

  // Skip health check for terminal/post-session statuses
  // These don't require active conversation - no messages expected
  if (STATUSES_NOT_REQUIRING_MONITORING.includes(appointment.status)) {
    return {
      status: 'green',
      score: 100,
      factors: [],
      summary: `Conversation ${appointment.status} - no active monitoring needed`,
    };
  }

  // 1. Inactivity factor
  const inactivityFactor = calculateInactivityFactor(appointment.lastActivityAt, now);
  factors.push(inactivityFactor);

  // 2. Stall factor (tool execution)
  const stallFactor = calculateStallFactor(
    appointment.lastActivityAt,
    appointment.lastToolExecutedAt,
    now
  );
  factors.push(stallFactor);

  // 3. Thread divergence factor
  const divergenceFactor = calculateDivergenceFactor(
    appointment.threadDivergedAt,
    appointment.threadDivergenceAcknowledged
  );
  factors.push(divergenceFactor);

  // 4. Tool failure factor
  const toolFailureFactor = calculateToolFailureFactor(
    appointment.lastToolExecutionFailed,
    appointment.lastToolFailureReason
  );
  factors.push(toolFailureFactor);

  // 5. Human control factor
  const humanControlFactor = calculateHumanControlFactor(appointment.humanControlEnabled);
  factors.push(humanControlFactor);

  // Calculate overall status and score
  const overallStatus = determineOverallStatus(factors);
  const score = calculateHealthScore(factors);
  const summary = generateHealthSummary(factors, overallStatus);

  return {
    status: overallStatus,
    score,
    factors,
    summary,
  };
}

/**
 * Calculate inactivity health factor
 */
function calculateInactivityFactor(lastActivityAt: Date, now: Date): HealthFactor {
  const hoursSinceActivity = (now.getTime() - lastActivityAt.getTime()) / (1000 * 60 * 60);

  let status: HealthStatus;
  if (hoursSinceActivity >= HEALTH_THRESHOLDS.INACTIVITY.RED_HOURS) {
    status = 'red';
  } else if (hoursSinceActivity >= HEALTH_THRESHOLDS.INACTIVITY.YELLOW_HOURS) {
    status = 'yellow';
  } else {
    status = 'green';
  }

  return {
    name: 'Inactivity',
    status,
    value: `${Math.round(hoursSinceActivity)}h since last activity`,
    threshold: `${HEALTH_THRESHOLDS.INACTIVITY.RED_HOURS}h`,
    description:
      status === 'red'
        ? 'Conversation is stale - no activity for extended period'
        : status === 'yellow'
          ? 'Conversation approaching stale threshold'
          : 'Recent activity detected',
  };
}

/**
 * Calculate stall health factor (activity but no tool execution)
 */
function calculateStallFactor(
  lastActivityAt: Date,
  lastToolExecutedAt: Date | null,
  now: Date
): HealthFactor {
  const hoursSinceActivity = (now.getTime() - lastActivityAt.getTime()) / (1000 * 60 * 60);

  // If no recent activity, stall check doesn't apply
  if (hoursSinceActivity >= HEALTH_THRESHOLDS.INACTIVITY.YELLOW_HOURS) {
    return {
      name: 'Progress',
      status: 'green',
      value: 'N/A - no recent activity',
      description: 'Stall check not applicable when inactive',
    };
  }

  // Calculate hours since last tool execution
  let hoursSinceTool: number;
  if (lastToolExecutedAt) {
    hoursSinceTool = (now.getTime() - lastToolExecutedAt.getTime()) / (1000 * 60 * 60);
  } else {
    // Never executed a tool - use activity time as reference
    hoursSinceTool = hoursSinceActivity;
  }

  let status: HealthStatus;
  if (hoursSinceTool >= HEALTH_THRESHOLDS.STALL.RED_HOURS) {
    status = 'red';
  } else if (hoursSinceTool >= HEALTH_THRESHOLDS.STALL.YELLOW_HOURS) {
    status = 'yellow';
  } else {
    status = 'green';
  }

  return {
    name: 'Progress',
    status,
    value: lastToolExecutedAt
      ? `${Math.round(hoursSinceTool)}h since last tool execution`
      : 'No tool executions yet',
    threshold: `${HEALTH_THRESHOLDS.STALL.RED_HOURS}h`,
    description:
      status === 'red'
        ? 'Conversation stalled - activity without progress'
        : status === 'yellow'
          ? 'Progress slowing - approaching stall threshold'
          : 'Making steady progress',
  };
}

/**
 * Calculate thread divergence health factor
 */
function calculateDivergenceFactor(
  threadDivergedAt: Date | null,
  acknowledged: boolean
): HealthFactor {
  if (!threadDivergedAt) {
    return {
      name: 'Thread Integrity',
      status: 'green',
      value: 'No divergence detected',
      description: 'Email thread tracking is healthy',
    };
  }

  if (acknowledged) {
    return {
      name: 'Thread Integrity',
      status: 'yellow',
      value: 'Divergence acknowledged',
      description: 'Thread divergence was detected but has been acknowledged',
    };
  }

  return {
    name: 'Thread Integrity',
    status: 'red',
    value: 'Divergence detected',
    description: 'Email thread divergence requires attention',
  };
}

/**
 * Calculate tool failure health factor
 */
function calculateToolFailureFactor(
  failed: boolean,
  reason: string | null
): HealthFactor {
  if (!failed) {
    return {
      name: 'Tool Execution',
      status: 'green',
      value: 'No failures',
      description: 'Last tool execution succeeded',
    };
  }

  return {
    name: 'Tool Execution',
    status: 'red',
    value: 'Failed',
    description: reason || 'Last tool execution failed',
  };
}

/**
 * Calculate human control health factor
 */
function calculateHumanControlFactor(humanControlEnabled: boolean): HealthFactor {
  if (!humanControlEnabled) {
    return {
      name: 'Automation',
      status: 'green',
      value: 'Automated',
      description: 'Agent is handling conversation automatically',
    };
  }

  // Human control is not inherently bad, but it means human intervention is needed
  return {
    name: 'Automation',
    status: 'yellow',
    value: 'Manual control',
    description: 'Human has taken over - requires manual handling',
  };
}

/**
 * Determine overall status from factors
 * Any red factor = red overall
 * Any yellow factor (with no red) = yellow overall
 */
function determineOverallStatus(factors: HealthFactor[]): HealthStatus {
  const hasRed = factors.some((f) => f.status === 'red');
  if (hasRed) return 'red';

  const hasYellow = factors.some((f) => f.status === 'yellow');
  if (hasYellow) return 'yellow';

  return 'green';
}

/**
 * Calculate numerical health score (0-100)
 */
function calculateHealthScore(factors: HealthFactor[]): number {
  const weights = HEALTH_THRESHOLDS.WEIGHTS;
  const factorWeightMap: Record<string, number> = {
    Inactivity: weights.INACTIVITY,
    Progress: weights.STALL,
    'Thread Integrity': weights.THREAD_DIVERGENCE,
    'Tool Execution': weights.TOOL_FAILURE,
    Automation: weights.HUMAN_CONTROL,
  };

  let totalScore = 0;

  for (const factor of factors) {
    const weight = factorWeightMap[factor.name] || 0;
    const factorScore =
      factor.status === 'green' ? 100 : factor.status === 'yellow' ? 50 : 0;
    totalScore += (factorScore * weight) / 100;
  }

  return Math.round(totalScore);
}

/**
 * Generate human-readable health summary
 */
function generateHealthSummary(factors: HealthFactor[], status: HealthStatus): string {
  const issues = factors.filter((f) => f.status === 'red');
  const warnings = factors.filter((f) => f.status === 'yellow');

  if (status === 'green') {
    return 'Conversation is healthy and progressing normally';
  }

  const parts: string[] = [];

  if (issues.length > 0) {
    const issueNames = issues.map((f) => f.name.toLowerCase()).join(', ');
    parts.push(`Issues: ${issueNames}`);
  }

  if (warnings.length > 0) {
    const warningNames = warnings.map((f) => f.name.toLowerCase()).join(', ');
    parts.push(`Warnings: ${warningNames}`);
  }

  return parts.join('. ');
}

/**
 * Batch calculate health for multiple appointments
 */
export function calculateBatchHealth(
  appointments: AppointmentForHealth[]
): Map<string, ConversationHealth> {
  const healthMap = new Map<string, ConversationHealth>();

  for (const apt of appointments) {
    healthMap.set(apt.id, calculateConversationHealth(apt));
  }

  return healthMap;
}

/**
 * Get health statistics summary
 */
export interface HealthSummaryStats {
  total: number;
  green: number;
  yellow: number;
  red: number;
  averageScore: number;
}

export function calculateHealthStats(healthResults: ConversationHealth[]): HealthSummaryStats {
  const stats: HealthSummaryStats = {
    total: healthResults.length,
    green: 0,
    yellow: 0,
    red: 0,
    averageScore: 0,
  };

  if (healthResults.length === 0) {
    return stats;
  }

  let totalScore = 0;

  for (const health of healthResults) {
    switch (health.status) {
      case 'green':
        stats.green++;
        break;
      case 'yellow':
        stats.yellow++;
        break;
      case 'red':
        stats.red++;
        break;
    }
    totalScore += health.score;
  }

  stats.averageScore = Math.round(totalScore / healthResults.length);

  return stats;
}

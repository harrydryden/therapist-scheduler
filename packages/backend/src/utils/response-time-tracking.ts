/**
 * Therapist Response Time Tracking
 *
 * Tracks and analyzes therapist response times to:
 * - Identify slow responders proactively
 * - Provide metrics for admin dashboard
 * - Trigger follow-up reminders appropriately
 */

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

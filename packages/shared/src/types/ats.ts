/**
 * ATS (Applicant Tracking System) Integration Types
 *
 * These types define the API contract between the ATS system and the
 * therapist-scheduler module. The ATS system:
 *
 * - Pushes therapist data into this module (ingestion)
 * - Creates appointment requests on behalf of users
 * - Reads appointment data, feedback submissions, and form configuration
 * - Receives lifecycle events via webhooks (optional)
 *
 * All dates are ISO 8601 strings. All IDs are UUIDs unless noted otherwise.
 */

import type { AppointmentStatus, ConversationStage, HealthStatus } from './index';
import type { FormConfig, FormQuestion } from './feedback';

// ============================================
// ATS → Scheduler: Therapist Ingestion
// ============================================

/** Therapist data pushed from ATS for ingestion */
export interface ATSTherapistPayload {
  /** ATS-assigned external ID for the therapist (used as correlation key) */
  externalId: string;
  name: string;
  email: string;
  bio?: string;
  approach?: string[];
  style?: string[];
  areasOfFocus?: string[];
  availability?: {
    timezone: string;
    slots: Array<{ day: string; start: string; end: string }>;
  } | null;
  qualifications?: string[];
  profileImageUrl?: string | null;
  active?: boolean;
}

/** Response after therapist ingestion */
export interface ATSTherapistResponse {
  /** Internal therapist ID (UUID) */
  id: string;
  /** 10-digit unique reference ID */
  odId: string;
  /** Notion page ID (if synced) */
  notionId: string | null;
  /** ATS-assigned external ID echoed back */
  externalId: string;
  name: string;
  email: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================
// ATS → Scheduler: Appointment Creation
// ============================================

/** Appointment request pushed from ATS */
export interface ATSAppointmentRequest {
  /** User's name */
  userName: string;
  /** User's email address */
  userEmail: string;
  /** Therapist identifier — accepts internal ID, Notion ID, or ATS external ID */
  therapistId: string;
  /** Optional idempotency key to prevent duplicate creation */
  idempotencyKey?: string;
  /** Optional notes from ATS */
  notes?: string;
}

/** Response after appointment creation from ATS */
export interface ATSAppointmentCreateResponse {
  id: string;
  trackingCode: string;
  status: AppointmentStatus;
  userName: string;
  userEmail: string;
  therapistName: string;
  therapistEmail: string;
  createdAt: string;
}

// ============================================
// Scheduler → ATS: Appointment Data
// ============================================

/** Appointment record as returned to the ATS */
export interface ATSAppointmentRecord {
  id: string;
  trackingCode: string | null;
  status: AppointmentStatus;
  userName: string | null;
  userEmail: string;
  therapistName: string;
  therapistEmail: string;
  therapistNotionId: string;
  confirmedAt: string | null;
  confirmedDateTime: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  isStale: boolean;
  humanControlEnabled: boolean;
  checkpointStage: ConversationStage | null;
  healthStatus: HealthStatus;
  notes: string | null;
  /** Chase follow-up tracking */
  chaseSentAt: string | null;
  chaseSentTo: string | null;
  /** Closure recommendation */
  closureRecommendedAt: string | null;
  closureRecommendedReason: string | null;
  closureRecommendationActioned: boolean;
  reschedulingInProgress: boolean;
}

/** Paginated appointment list response */
export interface ATSAppointmentListResponse {
  appointments: ATSAppointmentRecord[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Filters for listing appointments */
export interface ATSAppointmentFilters {
  /** Filter by status (comma-separated for multiple) */
  status?: string;
  /** Filter by therapist email */
  therapistEmail?: string;
  /** Filter by user email */
  userEmail?: string;
  /** Filter by tracking code */
  trackingCode?: string;
  /** ISO date — only appointments created on or after this date */
  createdAfter?: string;
  /** ISO date — only appointments created on or before this date */
  createdBefore?: string;
  /** ISO date — only appointments updated on or after this date */
  updatedAfter?: string;
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'status' | 'lastActivityAt';
  sortOrder?: 'asc' | 'desc';
}

// ============================================
// Scheduler → ATS: Feedback Data
// ============================================

/** Feedback submission as returned to the ATS */
export interface ATSFeedbackSubmission {
  id: string;
  trackingCode: string | null;
  appointmentId: string | null;
  userEmail: string | null;
  userName: string | null;
  therapistName: string;
  /** Form responses as key-value map (question ID → answer) */
  responses: Record<string, string | number>;
  formVersion: number;
  createdAt: string;
  /** Related appointment details if linked */
  appointment?: {
    id: string;
    status: AppointmentStatus;
    confirmedDateTime: string | null;
    trackingCode: string | null;
  } | null;
}

/** Paginated feedback list response */
export interface ATSFeedbackListResponse {
  submissions: ATSFeedbackSubmission[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Filters for listing feedback submissions */
export interface ATSFeedbackFilters {
  therapistName?: string;
  userEmail?: string;
  trackingCode?: string;
  createdAfter?: string;
  createdBefore?: string;
  page?: number;
  limit?: number;
}

/** Feedback form configuration as returned to the ATS */
export interface ATSFeedbackFormConfig {
  formName: string;
  description: string | null;
  questions: FormQuestion[];
  isActive: boolean;
  questionsVersion: number;
  requireExplanationFor: string[];
}

// ============================================
// Scheduler → ATS: Dashboard Stats
// ============================================

/** Summary statistics for ATS dashboard integration */
export interface ATSDashboardStats {
  totalAppointments: number;
  byStatus: Record<string, number>;
  confirmedLast7Days: number;
  confirmedLast30Days: number;
  averageTimeToConfirmHours: number | null;
  feedbackSubmissions: {
    total: number;
    last30Days: number;
  };
}

// ============================================
// ATS Webhook Events (Scheduler → ATS)
// ============================================

/** Event types that can be sent to ATS via webhooks */
export type ATSEventType =
  | 'appointment.created'
  | 'appointment.status_changed'
  | 'appointment.confirmed'
  | 'appointment.completed'
  | 'appointment.cancelled'
  | 'feedback.submitted'
  | 'therapist.frozen'
  | 'therapist.unfrozen';

/** Webhook event payload sent to ATS */
export interface ATSWebhookEvent {
  eventType: ATSEventType;
  timestamp: string;
  data: ATSAppointmentRecord | ATSFeedbackSubmission | ATSTherapistResponse;
}

// ============================================
// Common ATS API Response Wrapper
// ============================================

/** Standard API response wrapper for all ATS endpoints */
export interface ATSApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  details?: unknown;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

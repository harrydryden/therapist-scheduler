/**
 * Backend TypeScript types.
 *
 * Shared API-contract types (TherapistAvailability, PaginationInfo, etc.)
 * are re-exported from @therapist-scheduler/shared. Backend-internal types
 * (ConversationState, ParsedEmail, etc.) are defined here.
 */

import type { ConversationCheckpoint } from '../utils/conversation-checkpoint';
import type { ConversationFacts } from '../utils/conversation-facts';
import type { ResponseEvent } from '../utils/response-time-tracking';

// ============================================
// Re-export shared types (API contract)
// ============================================

export type {
  AvailabilitySlot,
  AvailabilityException,
  TherapistAvailability,
  PaginationInfo,
  KnowledgeAudience,
} from '@therapist-scheduler/shared';

// ============================================
// Backend-internal conversation types
// ============================================

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'admin';
  content: string;
  timestamp?: string;
}

export interface ResponseTracking {
  lastEmailSentToTherapist?: string;
  pendingSince?: string | null;
  lastResponseAt?: string;
  emailType?: 'initial_outreach' | 'availability_request' | 'confirmation_request' | 'follow_up';
  events?: ResponseEvent[];
  [key: string]: unknown;
}

export interface ConversationState {
  systemPrompt: string;
  messages: ConversationMessage[];
  checkpoint?: ConversationCheckpoint;
  facts?: ConversationFacts;
  responseTracking?: ResponseTracking;
}

// ============================================
// Backend-internal API response types
// (Discriminated union pattern for internal use)
// ============================================

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: string;
  details?: unknown;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface PaginatedResponse<T> extends ApiSuccessResponse<T> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ============================================
// Backend-internal appointment types
// (Use Date objects internally; serialized to string in API responses)
// ============================================

import { AppointmentStatus } from '../constants';

export interface AppointmentListItem {
  id: string;
  userName: string | null;
  userEmail: string;
  therapistName: string;
  therapistEmail: string;
  therapistNotionId: string;
  status: AppointmentStatus;
  messageCount: number;
  confirmedAt: Date | null;
  confirmedDateTime: string | null;
  createdAt: Date;
  updatedAt: Date;
  humanControlEnabled: boolean;
  humanControlTakenBy: string | null;
}

export interface AppointmentDetail extends Omit<AppointmentListItem, 'messageCount'> {
  conversation: ConversationState | null;
  therapistAvailability: import('@therapist-scheduler/shared').TherapistAvailability | null;
  notes: string | null;
  gmailThreadId: string | null;
  humanControlTakenAt: Date | null;
  humanControlReason: string | null;
}

// ============================================
// Backend-internal email types
// ============================================

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface ParsedEmail {
  from: string;
  to: string;
  subject: string;
  body: string;
  threadId: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
}

// ============================================
// Backend-internal knowledge base types
// (Use Date objects internally; serialized to string in API responses)
// ============================================

export interface KnowledgeEntry {
  id: string;
  title: string | null;
  content: string;
  audience: import('@therapist-scheduler/shared').KnowledgeAudience;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Shared API contract types for therapist-scheduler.
 *
 * These types represent the JSON wire format exchanged between frontend and backend.
 * Dates are serialized as ISO 8601 strings (not Date objects).
 */

// ============================================
// Therapist & Availability
// ============================================

export interface AvailabilitySlot {
  day: string;
  start: string;
  end: string;
}

export interface AvailabilityException {
  date: string;
  available: boolean;
}

export interface TherapistAvailability {
  timezone: string;
  slots: AvailabilitySlot[];
  exceptions?: AvailabilityException[];
}

export interface Therapist {
  id: string;
  name: string;
  bio: string;
  approach: string[];
  style: string[];
  areasOfFocus: string[];
  profileImage: string | null;
  availabilitySummary: string;
  // Note: email is NOT returned from public API for privacy reasons
  availability: TherapistAvailability | null;
  active: boolean;
}

export interface TherapistDetail extends Therapist {
  acceptingBookings?: boolean;
}

// ============================================
// Appointment Request
// ============================================

export interface AppointmentRequest {
  userName: string;
  userEmail: string;
  therapistNotionId: string;
  therapistName?: string;
  therapistAvailability?: TherapistAvailability | null;
}

// ============================================
// API Response
// ============================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  count?: number;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ============================================
// Status & Stage Enums
// ============================================

export type AppointmentStatus =
  | 'pending'
  | 'contacted'
  | 'negotiating'
  | 'confirmed'
  | 'session_held'
  | 'feedback_requested'
  | 'completed'
  | 'cancelled';

export const APPOINTMENT_STATUS = {
  PENDING: 'pending' as AppointmentStatus,
  CONTACTED: 'contacted' as AppointmentStatus,
  NEGOTIATING: 'negotiating' as AppointmentStatus,
  CONFIRMED: 'confirmed' as AppointmentStatus,
  SESSION_HELD: 'session_held' as AppointmentStatus,
  FEEDBACK_REQUESTED: 'feedback_requested' as AppointmentStatus,
  COMPLETED: 'completed' as AppointmentStatus,
  CANCELLED: 'cancelled' as AppointmentStatus,
} as const;

export type ConversationStage =
  | 'initial_contact'
  | 'awaiting_therapist_availability'
  | 'awaiting_user_slot_selection'
  | 'awaiting_therapist_confirmation'
  | 'awaiting_meeting_link'
  | 'confirmed'
  | 'rescheduling'
  | 'cancelled'
  | 'stalled';

export type HealthStatus = 'green' | 'yellow' | 'red';

// ============================================
// Appointment List & Detail
// ============================================

export interface AppointmentListItem {
  id: string;
  trackingCode: string | null;
  userName: string | null;
  userEmail: string;
  therapistName: string;
  therapistEmail: string;
  therapistNotionId: string;
  status: AppointmentStatus;
  messageCount: number;
  confirmedAt: string | null;
  confirmedDateTime: string | null;
  createdAt: string;
  updatedAt: string;
  humanControlEnabled: boolean;
  humanControlTakenBy: string | null;
  lastActivityAt: string;
  isStale: boolean;
  // Checkpoint data
  checkpointStage: ConversationStage | null;
  checkpointProgress: number;
  // Health data
  healthStatus: HealthStatus;
  healthScore: number;
  isStalled: boolean;
  hasThreadDivergence: boolean;
  hasToolFailure: boolean;
}

export interface AppointmentDetail extends Omit<AppointmentListItem, 'messageCount'> {
  conversation: {
    latestMessages: Array<{
      role: 'user' | 'assistant' | 'admin';
      content: string;
      senderType: 'client' | 'therapist' | 'agent' | 'admin';
    }>;
    totalMessageCount: number;
  } | null;
  therapistAvailability: TherapistAvailability | null;
  notes: string | null;
  gmailThreadId: string | null;
  therapistGmailThreadId: string | null;
  humanControlTakenAt: string | null;
  humanControlReason: string | null;
}

export interface AppointmentFilters {
  status?: string;
  therapistId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'status';
  sortOrder?: 'asc' | 'desc';
}

export interface UpdateAppointmentRequest {
  status?: AppointmentStatus;
  confirmedDateTime?: string | null;
  adminId: string;
  reason?: string;
}

export interface DashboardStats {
  byStatus: Record<string, number>;
  confirmedLast7Days: number;
  totalRequests: number;
  topUsers: Array<{
    name: string;
    email: string;
    bookingCount: number;
  }>;
}

// ============================================
// Human Control
// ============================================

export interface TakeControlRequest {
  adminId: string;
  reason?: string;
}

export interface SendMessageRequest {
  to: string;
  subject: string;
  body: string;
  adminId: string;
}

// ============================================
// Knowledge Base
// ============================================

export type KnowledgeAudience = 'therapist' | 'user' | 'both';

export interface KnowledgeEntry {
  id: string;
  title: string | null;
  content: string;
  audience: KnowledgeAudience;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKnowledgeRequest {
  title?: string;
  content: string;
  audience: KnowledgeAudience;
}

export interface UpdateKnowledgeRequest {
  title?: string | null;
  content?: string;
  audience?: KnowledgeAudience;
  active?: boolean;
  sortOrder?: number;
}

// ============================================
// System Settings
// ============================================

export type SettingValueType = 'number' | 'boolean' | 'string' | 'json';
export type SettingCategory = 'frontend' | 'general' | 'stale' | 'postBooking' | 'agent' | 'retention' | 'emailTemplates' | 'weeklyMailing' | 'notifications';

export interface SystemSetting {
  key: string;
  value: string | number | boolean;
  category: SettingCategory;
  label: string;
  description: string | null;
  valueType: SettingValueType;
  minValue: number | null;
  maxValue: number | null;
  defaultValue: string | number | boolean;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SettingsResponse {
  settings: SystemSetting[];
  grouped: Record<SettingCategory, SystemSetting[]>;
  categories: SettingCategory[];
}

export interface UpdateSettingRequest {
  value: string | number | boolean;
  adminId: string;
}

export interface BulkUpdateSettingsRequest {
  settings: Array<{ key: string; value: string | number | boolean }>;
  adminId: string;
}

// ============================================
// Therapist Ingestion (CV extraction)
// ============================================

export interface CategoryWithEvidence {
  type: string;
  evidence: string;
  reasoning: string;
}

export interface ExtractedTherapistProfile {
  name: string;
  email: string;
  bio: string;
  approach: CategoryWithEvidence[];
  style: CategoryWithEvidence[];
  areasOfFocus: CategoryWithEvidence[];
  availability?: TherapistAvailability | null;
  qualifications?: string[];
  yearsExperience?: number;
}

export interface IngestionPreviewResponse {
  extractedProfile: ExtractedTherapistProfile;
  rawTextLength: number;
  additionalInfoProvided: boolean;
}

export interface IngestionCreateResponse {
  therapistId: string;
  notionUrl: string;
  extractedProfile: {
    name: string;
    email: string;
    approach: CategoryWithEvidence[];
    style: CategoryWithEvidence[];
    areasOfFocus: CategoryWithEvidence[];
    bio: string;
  };
  adminNotesApplied: {
    hadAdditionalInfo: boolean;
    hadOverrideEmail: boolean;
    hadOverrideApproach: boolean;
    hadOverrideStyle: boolean;
    hadOverrideAreasOfFocus: boolean;
    hadOverrideAvailability: boolean;
  };
}

export interface AdminNotes {
  additionalInfo?: string;
  overrideEmail?: string;
  overrideApproach?: string[];
  overrideStyle?: string[];
  overrideAreasOfFocus?: string[];
  overrideAvailability?: TherapistAvailability;
  notes?: string;
}

// ============================================
// Admin Appointment Management
// ============================================

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  odId: string;
}

export interface AdminTherapist {
  id: string;
  notionId: string;
  email: string;
  name: string;
  odId: string;
}

export type AdminAppointmentStage = 'confirmed' | 'session_held' | 'feedback_requested';

export interface CreateAdminAppointmentRequest {
  userEmail: string;
  userName: string;
  therapistNotionId: string;
  stage: AdminAppointmentStage;
  confirmedDateTime: string;
  adminId: string;
  notes?: string;
}

export interface CreateAdminAppointmentResponse {
  id: string;
  trackingCode: string;
  status: string;
  confirmedDateTime: string;
}

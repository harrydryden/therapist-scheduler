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
  // Nullable since the Notion deprecation: therapists ingested via the
  // signup form (or imported without a Notion mirror) may not have a bio
  // until an admin fills one in. Render-side code must handle null.
  bio: string | null;
  approach: string[];
  style: string[];
  areasOfFocus: string[];
  profileImage: string | null;
  availabilitySummary: string;
  // Note: email is NOT returned from public API for privacy reasons
  availability: TherapistAvailability | null;
  active: boolean;
  /** External booking page URL (e.g. Calendly). When set, users can book directly. */
  bookingLink: string | null;
  /**
   * Country code where the therapist is based (e.g. "UK", "IE", "US").
   * Used to display a flag emoji on the card and to drive timezone handling
   * in agent communications. Defaults to "UK" for legacy records.
   */
  country: string;
}

export interface TherapistDetail extends Therapist {
  acceptingBookings?: boolean;
}

// ============================================
// Appointment Request
// ============================================

export type BookingMethod = 'agent_negotiated' | 'direct_link';

export interface AppointmentRequest {
  userName: string;
  userEmail: string;
  therapistHandle: string;
  /** HMAC-signed voucher token from weekly promotional email (auto-applied via URL or manually entered) */
  voucherToken?: string;
  /** How the user intends to book: via agent negotiation (default) or direct booking link */
  bookingMethod?: BookingMethod;
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
  | 'stalled'
  | 'chased'
  | 'closure_recommended';

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
  therapistHandle: string;
  status: AppointmentStatus;
  messageCount: number;
  confirmedAt: string | null;
  confirmedDateTime: string | null;
  confirmedDateTimeParsed: string | null;
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
  // Chase & closure recommendation
  chaseSentAt: string | null;
  chaseSentTo: string | null;
  closureRecommendedAt: string | null;
  closureRecommendedReason: string | null;
  closureRecommendationActioned: boolean;
  reschedulingInProgress: boolean;
  /**
   * Snippet of the most recent conversation message, surfaced on the
   * dashboard list rows. Server pulls this from conversationState via a
   * Postgres JSONB path expression so the full blob isn't loaded; null
   * when the conversation has no messages yet (e.g. brand-new
   * appointment) or when the content is empty after trimming.
   */
  lastMessagePreview: {
    /**
     * 'agent' for the AI assistant, 'admin' for in-band admin notes,
     * 'inbound' for any client- or therapist-originated message
     * (the conversation log doesn't distinguish those at the role layer).
     */
    role: 'agent' | 'inbound' | 'admin';
    /** First ~240 characters of the message content, whitespace-collapsed. */
    snippet: string;
  } | null;
}

export interface AppointmentSummary {
  /** One-line description of current stage */
  stage: string;
  /** What the system is waiting for / what should happen next */
  nextAction: string;
  /** Key facts: proposed times, selected time, confirmed time, etc. */
  keyFacts: string[];
  /** Total messages in the conversation */
  messageCount: number;
  /** ISO timestamp of last activity (compute relative time client-side) */
  lastActivityAt: string | null;
  /** Warning flags (stalled, chased, closure recommended, etc.) */
  flags: string[];
}

export interface AppointmentDetail extends Omit<AppointmentListItem,
  | 'messageCount'
  | 'checkpointStage' | 'checkpointProgress'
  | 'healthStatus' | 'healthScore' | 'isStalled' | 'hasThreadDivergence' | 'hasToolFailure'
> {
  summary: AppointmentSummary | null;
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
export type SettingCategory = 'frontend' | 'general' | 'postBooking' | 'agent' | 'retention' | 'emailTemplates' | 'weeklyMailing' | 'notifications';

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
  allowedValues?: string[];
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
  /** Country code (UK, IE, US, CA, ES, DE, FR, PT, AU, NZ, ZA). */
  country?: string;
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
  therapistHandle: string;
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

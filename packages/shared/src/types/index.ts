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

/**
 * POST /api/appointments/request — the request was accepted and scheduling
 * has started. Returned (HTTP 201) only when the requester already proved
 * they own the address, i.e. the request carried a valid voucher token that
 * was emailed to that same address.
 */
export interface BookingAcceptedResponse {
  verificationRequired: false;
  appointmentRequestId: string;
  status: AppointmentStatus;
  message: string;
}

/**
 * POST /api/appointments/request — nothing happens until the requester
 * clicks the confirmation link we emailed (HTTP 202). Deliberately carries
 * no appointment id: the same response is returned when the address already
 * has a request with this therapist, so the endpoint can't be used to learn
 * whether someone else has booked.
 */
export interface BookingVerificationPendingResponse {
  verificationRequired: true;
  status: 'awaiting_verification';
  /** The address the confirmation link was sent to (echoed for the UI). */
  email: string;
  /** How long the confirmation link stays valid. */
  expiresInHours: number;
  /** Typo suggestion for the address, e.g. "jamie@gmail.com", or null. */
  suggestedEmail: string | null;
  message: string;
}

export type AppointmentRequestResponse = BookingAcceptedResponse | BookingVerificationPendingResponse;

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
  /**
   * Short imperative "what the admin should do or wait for" string,
   * computed server-side via `deriveNextAction`. Shared with the
   * appointment detail summary so the dashboard row and the detail
   * panel never disagree about the recommended next step.
   */
  nextAction: string;
  /**
   * False while a public booking waits for the requester to click the
   * confirmation link we emailed. Nothing (agent, therapist email, in-session
   * status) happens for the request until then.
   */
  emailVerified: boolean;
}

/**
 * One entry of an appointment's conversation log, shaped for display in the
 * admin detail drawer (GET /api/admin/dashboard/appointments/:id).
 */
export interface ConversationMessageView {
  /** 'agent' = the AI assistant, 'admin' = in-band admin/system notes, 'inbound' = client or therapist email. */
  role: 'agent' | 'inbound' | 'admin';
  /** Display text. Inbound entries are reduced to the new email itself (quoted thread context stripped). */
  text: string;
  /**
   * ISO timestamp when the log entry records one. The conversation log does
   * not store per-message times today, so this is usually null.
   */
  timestamp: string | null;
  /** True when `text` was shortened for display. */
  truncated: boolean;
}

/**
 * Triage reason surfaced on the appointment detail panel when an
 * appointment is in the "Needs Attention" tile. Each red health
 * factor (plus the closure-recommended signal) maps to one of
 * these, with a concrete suggested next step for the admin.
 *
 * Empty array means the appointment is healthy.
 */
export interface AttentionReason {
  kind:
    | 'inactivity'
    | 'stall'
    | 'thread_divergence'
    | 'tool_failure'
    | 'human_control'
    | 'closure_recommended';
  title: string;
  detail: string;
  suggestion: string;
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
  /**
   * Structured triage reasons explaining WHY this appointment is in
   * Needs Attention, each paired with a suggested next step. Empty
   * array when the appointment is healthy.
   */
  attentionReasons: AttentionReason[];
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
  /** The most recent conversation log entries (up to 20), oldest first. */
  recentMessages: ConversationMessageView[];
  /** Total entries in the log (recentMessages may be a suffix of it). */
  totalMessages: number;
}

/**
 * Query for GET /api/admin/dashboard/appointments. Every filter is applied
 * server-side, so tiles and lists see the whole table rather than one page.
 */
export interface AppointmentFilters {
  /** One status, or several comma-separated ('pending,contacted'), or 'all'. */
  status?: string;
  therapistId?: string;
  dateFrom?: string;
  dateTo?: string;
  /** true = only appointments under human control; false = only automated. */
  humanControl?: boolean;
  /** Only appointments whose computed conversation health matches. */
  health?: HealthStatus;
  /** Free-text search: tracking code (SPL…), client email/name, therapist name. */
  q?: string;
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'status' | 'lastActivityAt';
  sortOrder?: 'asc' | 'desc';
}

export interface UpdateAppointmentRequest {
  status?: AppointmentStatus;
  confirmedDateTime?: string | null;
  adminId: string;
  reason?: string;
  /**
   * Only meaningful when `status === 'cancelled'`. Lets the admin
   * attribute the cancellation to therapist or client, which drives
   * different email copy (apology + voucher to the user when the
   * therapist initiated; apology + reassurance to the therapist
   * when the user initiated). Omitted = 'admin' (neutral copy).
   */
  cancelledBy?: 'admin' | 'client' | 'therapist';
}

export interface DashboardStats {
  byStatus: Record<string, number>;
  confirmedLast7Days: number;
  totalRequests: number;
  /** Pre-booking appointments whose computed health is red (the "Needs Attention" tile). */
  needsAttention: number;
  /** Appointments currently under human control (the "Human Control" tile). */
  humanControl: number;
  /** Public bookings still waiting for the requester to confirm their email. */
  awaitingVerification: number;
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
  /** Legacy Notion page ID; null for therapists created after Notion (e.g. PDF ingestion). */
  notionId: string | null;
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

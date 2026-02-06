export interface TherapistAvailability {
  timezone: string;
  slots: Array<{
    day: string;
    start: string;
    end: string;
  }>;
  exceptions?: Array<{
    date: string;
    available: boolean;
  }>;
}

export interface Therapist {
  id: string;
  name: string;
  bio: string;
  // Categorization system
  approach: string[];
  style: string[];
  areasOfFocus: string[];
  profileImage: string | null;
  availabilitySummary: string;
  // Note: email is NOT returned from public API for privacy reasons
  availability: TherapistAvailability | null;
  active: boolean;
}

// TherapistDetail includes booking availability status
export interface TherapistDetail extends Therapist {
  acceptingBookings?: boolean;
}

export interface AppointmentRequest {
  userName: string;
  userEmail: string;
  therapistNotionId: string;
  // therapistEmail is NOT sent from frontend - looked up from Notion on backend
  therapistName?: string; // Optional, backend fetches from Notion
  therapistAvailability?: TherapistAvailability | null; // Optional, backend fetches from Notion
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  count?: number;
}

// Admin types for therapist ingestion
export interface ExtractedTherapistProfile {
  name: string;
  email: string;
  bio: string;
  // Categorization system
  approach: string[];
  style: string[];
  areasOfFocus: string[];
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
    approach: string[];
    style: string[];
    areasOfFocus: string[];
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
  // Category overrides
  overrideApproach?: string[];
  overrideStyle?: string[];
  overrideAreasOfFocus?: string[];
  overrideAvailability?: TherapistAvailability;
  notes?: string;
}

// Admin Dashboard types
export interface AppointmentListItem {
  id: string;
  userName: string | null;
  userEmail: string;
  therapistName: string;
  therapistEmail: string;
  therapistNotionId: string;
  status: 'pending' | 'contacted' | 'negotiating' | 'confirmed' | 'cancelled';
  messageCount: number;
  confirmedAt: string | null;
  confirmedDateTime: string | null;
  createdAt: string;
  updatedAt: string;
  humanControlEnabled: boolean;
  humanControlTakenBy: string | null;
  lastActivityAt: string;
  isStale: boolean;
}

export interface AppointmentDetail extends Omit<AppointmentListItem, 'messageCount'> {
  conversation: {
    systemPrompt: string;
    messages: Array<{
      role: 'user' | 'assistant' | 'admin';
      content: string;
    }>;
  } | null;
  therapistAvailability: TherapistAvailability | null;
  notes: string | null;
  gmailThreadId: string | null;
  therapistGmailThreadId: string | null;
  humanControlTakenAt: string | null;
  humanControlReason: string | null;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface DashboardStats {
  byStatus: Record<string, number>;
  confirmedLast7Days: number;
  totalRequests: number;
  topTherapists: Array<{
    name: string;
    notionId: string;
    bookingCount: number;
  }>;
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

// Human control types
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

// Knowledge Base types
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

// System Settings types
export type SettingValueType = 'number' | 'boolean' | 'string' | 'json';
export type SettingCategory = 'general' | 'stale' | 'postBooking' | 'agent' | 'retention';

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

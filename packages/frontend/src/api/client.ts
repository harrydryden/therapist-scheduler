import type {
  Therapist,
  TherapistDetail,
  AppointmentRequest,
  ApiResponse,
  IngestionPreviewResponse,
  IngestionCreateResponse,
  AdminNotes,
  AppointmentListItem,
  AppointmentDetail,
  PaginationInfo,
  DashboardStats,
  AppointmentFilters,
  TakeControlRequest,
  SendMessageRequest,
  UpdateAppointmentRequest,
  KnowledgeEntry,
  CreateKnowledgeRequest,
  UpdateKnowledgeRequest,
  SettingsResponse,
  SystemSetting,
  UpdateSettingRequest,
  BulkUpdateSettingsRequest,
  AdminUser,
  AdminTherapist,
  CreateAdminAppointmentRequest,
  CreateAdminAppointmentResponse,
} from '../types';
import { API_BASE, getAdminSecret, clearAdminSecret } from '../config/env';
import { HEADERS, TIMEOUTS } from '../config/constants';

// Custom error class to carry API error details
export class ApiError extends Error {
  code?: string;
  details?: {
    maxAllowed?: number;
    activeCount?: number;
    activeTherapists?: string[];
    [key: string]: unknown;
  };

  constructor(message: string, code?: string, details?: ApiError['details']) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Error class for authentication failures (401, 429 auth lockout).
 * Used to signal that the admin secret is wrong or the IP is locked out,
 * so React Query and retry logic can skip retries.
 */
export class AuthError extends Error {
  status: number;
  retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * Fetch with timeout using AbortController
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = TIMEOUTS.DEFAULT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request timed out. Please try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Exponential backoff for retries
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);

      // Never retry auth failures - these won't succeed on retry
      if (response.status === 401 || response.status === 403) {
        return response;
      }

      // If rate limited (429), check if it's an auth lockout before retrying
      if (response.status === 429) {
        // Clone the response to peek at the body without consuming it
        const cloned = response.clone();
        try {
          const body = await cloned.json();
          // Auth lockout responses should not be retried
          if (body?.error?.includes?.('authentication')) {
            return response;
          }
        } catch {
          // If we can't parse the body, fall through to normal 429 handling
        }

        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(1000 * Math.pow(2, attempt), 10000); // Max 10 seconds

        if (attempt < maxRetries - 1) {
          await sleep(waitTime);
          continue;
        }
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error');

      // Only retry on network errors, not on other errors
      if (attempt < maxRetries - 1 && error instanceof TypeError) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 5000));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

/**
 * Safely parse JSON response, handling non-JSON error pages
 */
async function safeParseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // If server returned non-JSON (e.g., HTML error page), create a structured error
    if (!response.ok) {
      return { error: `Server error (${response.status}): ${response.statusText}` };
    }
    throw new Error('Invalid response format from server');
  }
}

/**
 * FIX M3: Request deduplication to prevent concurrent duplicate requests
 * Stores pending promises by request key to coalesce identical concurrent requests
 */
const pendingRequests = new Map<string, Promise<unknown>>();

function getRequestKey(method: string, endpoint: string): string {
  // For GET requests, use method:endpoint to deduplicate
  // For mutations (POST, PUT, DELETE), return empty to skip deduplication
  if (method === 'GET') {
    return `GET:${endpoint}`;
  }
  // For mutations, we don't deduplicate - each should be sent
  return '';
}

async function fetchWithDedup<T>(
  endpoint: string,
  options: RequestInit & { timeoutMs?: number } = {},
  fetchFn: () => Promise<T>
): Promise<T> {
  const method = options.method || 'GET';
  const key = getRequestKey(method, endpoint);

  // Only deduplicate GET requests
  if (!key) {
    return fetchFn();
  }

  // If there's already a pending request for this key, return its promise
  const pending = pendingRequests.get(key);
  if (pending) {
    return pending as Promise<T>;
  }

  // Create new request and store its promise
  const promise = fetchFn().finally(() => {
    // Clean up after request completes
    pendingRequests.delete(key);
  });

  pendingRequests.set(key, promise);
  return promise;
}

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<ApiResponse<T>> {
  // FIX M3: Use request deduplication for GET requests
  return fetchWithDedup<ApiResponse<T>>(endpoint, options, async () => {
    const response = await fetchWithRetry(
      `${API_BASE}${endpoint}`,
      {
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
        ...options,
      },
      TIMEOUTS.DEFAULT_MS
    );

    const data = await safeParseJson(response) as Record<string, unknown>;

    if (!response.ok) {
      throw new ApiError(
        (data.error as string) || 'An error occurred',
        data.code as string | undefined,
        data.details as ApiError['details']
      );
    }

    return data as unknown as ApiResponse<T>;
  });
}

export async function getTherapists(): Promise<Therapist[]> {
  const response = await fetchApi<Therapist[]>('/therapists');
  return response.data || [];
}

export async function getTherapist(id: string): Promise<TherapistDetail> {
  const response = await fetchApi<TherapistDetail>(`/therapists/${id}`);
  if (!response.data) {
    throw new Error('Therapist not found');
  }
  return response.data;
}

export async function submitAppointmentRequest(request: AppointmentRequest): Promise<{ appointmentRequestId: string }> {
  const response = await fetchApi<{ appointmentRequestId: string; status: string; message: string }>(
    '/appointments/request',
    {
      method: 'POST',
      body: JSON.stringify(request),
    }
  );

  if (!response.data) {
    throw new Error('Failed to submit appointment request');
  }

  return response.data;
}

// Admin API functions for therapist ingestion

export async function previewTherapistCV(file: File | null, additionalInfo: string): Promise<IngestionPreviewResponse> {
  const formData = new FormData();
  if (file) {
    formData.append('file', file);
  }
  if (additionalInfo) {
    formData.append('additionalInfo', additionalInfo);
  }

  const response = await fetchWithTimeout(
    `${API_BASE}/ingestion/therapist-cv/preview`,
    {
      method: 'POST',
      body: formData,
      headers: {
        [HEADERS.WEBHOOK_SECRET]: getAdminSecret(),
      },
    },
    TIMEOUTS.LONG_MS
  );

  const data = await safeParseJson(response) as Record<string, unknown>;

  if (!response.ok) {
    throw new Error((data.error as string) || 'Failed to preview CV');
  }

  return data.data as IngestionPreviewResponse;
}

export async function createTherapistFromCV(file: File | null, adminNotes: AdminNotes): Promise<IngestionCreateResponse> {
  const formData = new FormData();
  if (file) {
    formData.append('file', file);
  }

  if (adminNotes.additionalInfo) {
    formData.append('additionalInfo', adminNotes.additionalInfo);
  }
  if (adminNotes.overrideEmail) {
    formData.append('overrideEmail', adminNotes.overrideEmail);
  }
  // Category overrides
  if (adminNotes.overrideApproach) {
    formData.append('overrideApproach', JSON.stringify(adminNotes.overrideApproach));
  }
  if (adminNotes.overrideStyle) {
    formData.append('overrideStyle', JSON.stringify(adminNotes.overrideStyle));
  }
  if (adminNotes.overrideAreasOfFocus) {
    formData.append('overrideAreasOfFocus', JSON.stringify(adminNotes.overrideAreasOfFocus));
  }
  if (adminNotes.overrideAvailability) {
    formData.append('overrideAvailability', JSON.stringify(adminNotes.overrideAvailability));
  }
  if (adminNotes.notes) {
    formData.append('notes', adminNotes.notes);
  }

  const response = await fetchWithTimeout(
    `${API_BASE}/ingestion/therapist-cv`,
    {
      method: 'POST',
      body: formData,
      headers: {
        [HEADERS.WEBHOOK_SECRET]: getAdminSecret(),
      },
    },
    TIMEOUTS.LONG_MS
  );

  const data = await safeParseJson(response) as Record<string, unknown>;

  if (!response.ok) {
    throw new Error((data.error as string) || 'Failed to create therapist');
  }

  return data.data as IngestionCreateResponse;
}

// Admin Dashboard API functions
//
// FIX #3: Admin secret is now read from sessionStorage at runtime via getAdminSecret(),
// instead of being baked into the production JS bundle from VITE_ADMIN_SECRET.
// The AdminLayout prompts the admin to enter the secret on first visit.
// TODO: Implement proper session-based authentication for admin routes:
// 1. Add /admin/login endpoint with password/OAuth
// 2. Use httpOnly cookies for session tokens
// 3. Remove x-webhook-secret header from frontend

export async function fetchAdminApi<T>(endpoint: string, options?: RequestInit): Promise<ApiResponse<T> & { pagination?: PaginationInfo; total?: number }> {
  // FIX M3: Use request deduplication for GET requests
  return fetchWithDedup<ApiResponse<T> & { pagination?: PaginationInfo; total?: number }>(
    endpoint,
    options,
    async () => {
      const method = options?.method || 'GET';
      // Use retry logic for GET requests (safe to retry), direct fetch for mutations
      const fetchFn = method === 'GET' ? fetchWithRetry : fetchWithTimeout;
      const response = await fetchFn(
        `${API_BASE}${endpoint}`,
        {
          headers: {
            'Content-Type': 'application/json',
            [HEADERS.WEBHOOK_SECRET]: getAdminSecret(),
            ...options?.headers,
          },
          ...options,
        },
        TIMEOUTS.DEFAULT_MS
      );

      const data = await safeParseJson(response) as Record<string, unknown>;

      // Handle auth failures: clear stored secret and throw AuthError
      // so React Query stops retrying and AdminLayout shows login screen
      if (response.status === 401 || response.status === 403) {
        clearAdminSecret();
        window.dispatchEvent(new Event('admin-auth-failed'));
        throw new AuthError(
          (data.error as string) || 'Authentication failed. Please re-enter your admin secret.',
          response.status
        );
      }

      if (response.status === 429) {
        const errorMsg = (data.error as string) || '';
        if (errorMsg.toLowerCase().includes('authentication')) {
          // Auth lockout - clear secret so user can re-enter after lockout expires
          clearAdminSecret();
          window.dispatchEvent(new Event('admin-auth-failed'));
          const retryAfter = response.headers.get('Retry-After');
          throw new AuthError(
            errorMsg || 'Too many failed attempts. Please try again later.',
            429,
            retryAfter ? parseInt(retryAfter, 10) : undefined
          );
        }
      }

      if (!response.ok) {
        throw new Error((data.error as string) || 'An error occurred');
      }

      return data as unknown as ApiResponse<T> & { pagination?: PaginationInfo; total?: number };
    }
  );
}

export async function getAppointments(filters: AppointmentFilters = {}): Promise<{
  data: AppointmentListItem[];
  pagination: PaginationInfo;
}> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      params.append(key, String(value));
    }
  });

  const queryString = params.toString();
  const response = await fetchAdminApi<AppointmentListItem[]>(
    `/admin/dashboard/appointments${queryString ? `?${queryString}` : ''}`
  );

  return {
    data: response.data || [],
    pagination: response.pagination || { page: 1, limit: 20, total: 0, totalPages: 0 },
  };
}

export async function getAppointmentDetail(id: string): Promise<AppointmentDetail> {
  const response = await fetchAdminApi<AppointmentDetail>(`/admin/dashboard/appointments/${id}`);
  if (!response.data) {
    throw new Error('Appointment not found');
  }
  return response.data;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const response = await fetchAdminApi<DashboardStats>('/admin/dashboard/stats');
  if (!response.data) {
    throw new Error('Failed to fetch stats');
  }
  return response.data;
}

// Human control API functions

export async function takeControl(
  appointmentId: string,
  data: TakeControlRequest
): Promise<{ humanControlEnabled: boolean; humanControlTakenBy: string; humanControlTakenAt: string }> {
  const response = await fetchAdminApi<{
    humanControlEnabled: boolean;
    humanControlTakenBy: string;
    humanControlTakenAt: string;
  }>(`/admin/dashboard/appointments/${appointmentId}/take-control`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!response.data) {
    throw new Error('Failed to take control');
  }
  return response.data;
}

export async function releaseControl(
  appointmentId: string
): Promise<{ humanControlEnabled: boolean }> {
  const response = await fetchAdminApi<{ humanControlEnabled: boolean }>(
    `/admin/dashboard/appointments/${appointmentId}/release-control`,
    {
      method: 'POST',
      body: JSON.stringify({}), // Empty body to satisfy Content-Type: application/json
    }
  );
  if (!response.data) {
    throw new Error('Failed to release control');
  }
  return response.data;
}

export async function sendAdminMessage(
  appointmentId: string,
  data: SendMessageRequest
): Promise<{ messageId: string; sentAt: string }> {
  const response = await fetchAdminApi<{ messageId: string; sentAt: string }>(
    `/admin/dashboard/appointments/${appointmentId}/send-message`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  );
  if (!response.data) {
    throw new Error('Failed to send message');
  }
  return response.data;
}

export async function deleteAppointment(
  appointmentId: string,
  data: { adminId: string; reason?: string; forceDeleteConfirmed?: boolean }
): Promise<{ id: string; message: string }> {
  const response = await fetchAdminApi<{ id: string; message: string }>(
    `/admin/dashboard/appointments/${appointmentId}`,
    {
      method: 'DELETE',
      body: JSON.stringify(data),
    }
  );
  if (!response.data) {
    throw new Error('Failed to delete appointment');
  }
  return response.data;
}

export async function updateAppointment(
  appointmentId: string,
  data: UpdateAppointmentRequest
): Promise<{
  id: string;
  status: string;
  confirmedDateTime: string | null;
  confirmedAt: string | null;
  updatedAt: string;
  previousStatus?: string;
  warning?: string;
}> {
  const response = await fetchAdminApi<{
    id: string;
    status: string;
    confirmedDateTime: string | null;
    confirmedAt: string | null;
    updatedAt: string;
    previousStatus?: string;
    warning?: string;
  }>(`/admin/dashboard/appointments/${appointmentId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  if (!response.data) {
    throw new Error('Failed to update appointment');
  }
  return response.data;
}

// Knowledge Base API functions

export async function getKnowledgeEntries(): Promise<KnowledgeEntry[]> {
  const response = await fetchAdminApi<KnowledgeEntry[]>('/admin/knowledge');
  return response.data || [];
}

export async function createKnowledgeEntry(
  data: CreateKnowledgeRequest
): Promise<KnowledgeEntry> {
  const response = await fetchAdminApi<KnowledgeEntry>('/admin/knowledge', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!response.data) {
    throw new Error('Failed to create knowledge entry');
  }
  return response.data;
}

export async function updateKnowledgeEntry(
  id: string,
  data: UpdateKnowledgeRequest
): Promise<KnowledgeEntry> {
  const response = await fetchAdminApi<KnowledgeEntry>(`/admin/knowledge/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  if (!response.data) {
    throw new Error('Failed to update knowledge entry');
  }
  return response.data;
}

export async function deleteKnowledgeEntry(id: string): Promise<void> {
  await fetchAdminApi<void>(`/admin/knowledge/${id}`, {
    method: 'DELETE',
  });
}

// System Settings API functions

export async function getSettings(): Promise<SettingsResponse> {
  const response = await fetchAdminApi<SettingsResponse>('/admin/settings');
  if (!response.data) {
    throw new Error('Failed to fetch settings');
  }
  return response.data;
}

export async function getSetting(key: string): Promise<SystemSetting> {
  const response = await fetchAdminApi<SystemSetting>(`/admin/settings/${key}`);
  if (!response.data) {
    throw new Error('Failed to fetch setting');
  }
  return response.data;
}

export async function updateSetting(
  key: string,
  data: UpdateSettingRequest
): Promise<{ key: string; value: string | number | boolean; updatedAt: string }> {
  const response = await fetchAdminApi<{ key: string; value: string | number | boolean; updatedAt: string }>(
    `/admin/settings/${key}`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    }
  );
  if (!response.data) {
    throw new Error('Failed to update setting');
  }
  return response.data;
}

export async function bulkUpdateSettings(
  data: BulkUpdateSettingsRequest
): Promise<{ updated: number }> {
  const response = await fetchAdminApi<{ updated: number }>('/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  if (!response.data) {
    throw new Error('Failed to update settings');
  }
  return response.data;
}

export async function resetSetting(
  key: string
): Promise<{ key: string; value: string | number | boolean; isDefault: boolean }> {
  const response = await fetchAdminApi<{ key: string; value: string | number | boolean; isDefault: boolean }>(
    `/admin/settings/${key}/reset`,
    {
      method: 'POST',
    }
  );
  if (!response.data) {
    throw new Error('Failed to reset setting');
  }
  return response.data;
}

// Public Frontend Settings (no auth required)
export interface FrontendSettings {
  'frontend.therapistPageIntro': string;
}

export async function getFrontendSettings(): Promise<FrontendSettings> {
  const response = await fetchApi<FrontendSettings>('/settings/frontend');
  if (!response.data) {
    throw new Error('Failed to fetch frontend settings');
  }
  return response.data;
}

// Admin Appointments Management API functions

export async function getAdminUsers(): Promise<AdminUser[]> {
  const response = await fetchAdminApi<AdminUser[]>('/admin/appointments/users');
  return response.data || [];
}

export async function getAdminTherapists(): Promise<AdminTherapist[]> {
  const response = await fetchAdminApi<AdminTherapist[]>('/admin/appointments/therapists');
  return response.data || [];
}

export async function getAllAppointments(filters: {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: string;
} = {}): Promise<{
  data: AppointmentListItem[];
  pagination: PaginationInfo;
}> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      params.append(key, String(value));
    }
  });

  const queryString = params.toString();
  const response = await fetchAdminApi<AppointmentListItem[]>(
    `/admin/appointments/all${queryString ? `?${queryString}` : ''}`
  );

  return {
    data: response.data || [],
    pagination: response.pagination || { page: 1, limit: 20, total: 0, totalPages: 0 },
  };
}

export async function createAdminAppointment(
  data: CreateAdminAppointmentRequest
): Promise<CreateAdminAppointmentResponse> {
  const response = await fetchAdminApi<CreateAdminAppointmentResponse>(
    '/admin/appointments/create',
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  );
  if (!response.data) {
    throw new Error('Failed to create appointment');
  }
  return response.data;
}

// Slack Diagnostics API functions

export interface SlackStatus {
  enabled: boolean;
  webhookConfigured: boolean;
  circuitBreaker: {
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    failures: number;
    successes: number;
    lastFailure: string | null;
    lastSuccess: string | null;
    totalRequests: number;
    rejectedRequests: number;
  };
  queue: {
    inMemory: number;
    oldestAge?: number;
  };
  backgroundTasks: Record<string, {
    total: number;
    success: number;
    failed: number;
    timedOut: number;
    recentErrors: Array<{ timestamp: string; error: string }>;
  }>;
}

export async function getSlackStatus(): Promise<SlackStatus> {
  const response = await fetchAdminApi<SlackStatus>('/admin/slack/status');
  if (!response.data) {
    throw new Error('Failed to fetch Slack status');
  }
  return response.data;
}

export async function sendSlackTest(): Promise<{ message: string; sent: boolean }> {
  const response = await fetchAdminApi<{ message: string; sent: boolean }>(
    '/admin/slack/test',
    { method: 'POST' }
  );
  if (!response.data) {
    throw new Error('Failed to send test notification');
  }
  return response.data;
}

export async function resetSlackCircuit(): Promise<{
  message: string;
  before: { state: string; failures: number };
  after: { state: string; failures: number };
}> {
  const response = await fetchAdminApi<{
    message: string;
    before: { state: string; failures: number };
    after: { state: string; failures: number };
  }>('/admin/slack/reset', { method: 'POST' });
  if (!response.data) {
    throw new Error('Failed to reset circuit breaker');
  }
  return response.data;
}

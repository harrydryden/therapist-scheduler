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
  KnowledgeEntry,
  CreateKnowledgeRequest,
  UpdateKnowledgeRequest,
} from '../types';
import { API_BASE, ADMIN_SECRET } from '../config/env';
import { HEADERS, TIMEOUTS } from '../config/constants';

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(
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

      // If rate limited (429), use exponential backoff
      if (response.status === 429) {
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
async function safeParseJson(response: Response): Promise<any> {
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

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<ApiResponse<T>> {
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

  const data = await safeParseJson(response);

  if (!response.ok) {
    throw new Error(data.error || 'An error occurred');
  }

  return data;
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

export async function previewTherapistCV(file: File, additionalInfo: string): Promise<IngestionPreviewResponse> {
  const formData = new FormData();
  formData.append('file', file);
  if (additionalInfo) {
    formData.append('additionalInfo', additionalInfo);
  }

  const response = await fetchWithTimeout(
    `${API_BASE}/ingestion/therapist-cv/preview`,
    {
      method: 'POST',
      body: formData,
      headers: {
        [HEADERS.WEBHOOK_SECRET]: ADMIN_SECRET,
      },
    },
    TIMEOUTS.LONG_MS
  );

  const data = await safeParseJson(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to preview CV');
  }

  return data.data;
}

export async function createTherapistFromCV(file: File, adminNotes: AdminNotes): Promise<IngestionCreateResponse> {
  const formData = new FormData();
  formData.append('file', file);

  if (adminNotes.additionalInfo) {
    formData.append('additionalInfo', adminNotes.additionalInfo);
  }
  if (adminNotes.overrideEmail) {
    formData.append('overrideEmail', adminNotes.overrideEmail);
  }
  if (adminNotes.overrideSpecialisms) {
    formData.append('overrideSpecialisms', JSON.stringify(adminNotes.overrideSpecialisms));
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
        [HEADERS.WEBHOOK_SECRET]: ADMIN_SECRET,
      },
    },
    TIMEOUTS.LONG_MS
  );

  const data = await safeParseJson(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create therapist');
  }

  return data.data;
}

// Admin Dashboard API functions
//
// SECURITY NOTE: This webhook secret is exposed in the frontend build.
// TODO: Implement proper session-based authentication for admin routes:
// 1. Add /admin/login endpoint with password/OAuth
// 2. Use httpOnly cookies for session tokens
// 3. Remove x-webhook-secret header from frontend
// For now, this provides basic protection for internal tools.

async function fetchAdminApi<T>(endpoint: string, options?: RequestInit): Promise<ApiResponse<T> & { pagination?: PaginationInfo; total?: number }> {
  const response = await fetchWithTimeout(
    `${API_BASE}${endpoint}`,
    {
      headers: {
        'Content-Type': 'application/json',
        [HEADERS.WEBHOOK_SECRET]: ADMIN_SECRET,
        ...options?.headers,
      },
      ...options,
    },
    TIMEOUTS.DEFAULT_MS
  );

  const data = await safeParseJson(response);

  if (!response.ok) {
    throw new Error(data.error || 'An error occurred');
  }

  return data;
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

export async function clearConversation(
  appointmentId: string,
  data: { adminId: string; reason?: string }
): Promise<{ id: string; status: string; message: string }> {
  const response = await fetchAdminApi<{ id: string; status: string; message: string }>(
    `/admin/dashboard/appointments/${appointmentId}/clear-conversation`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  );
  if (!response.data) {
    throw new Error('Failed to clear conversation');
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

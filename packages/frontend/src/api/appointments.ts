import type {
  AppointmentListItem,
  AppointmentDetail,
  PaginationInfo,
  DashboardStats,
  AppointmentFilters,
  TakeControlRequest,
  SendMessageRequest,
  UpdateAppointmentRequest,
  AdminUser,
  AdminTherapist,
  CreateAdminAppointmentRequest,
  CreateAdminAppointmentResponse,
} from '../types';
import { fetchAdminApi, unwrap, EMPTY_PAGINATION } from './core';
import { TIMEOUTS } from '../config/constants';

function buildQueryString(filters: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '' && value !== null) {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export async function getAppointments(filters: AppointmentFilters = {}): Promise<{
  data: AppointmentListItem[];
  pagination: PaginationInfo;
}> {
  const response = await fetchAdminApi<AppointmentListItem[]>(
    `/admin/dashboard/appointments${buildQueryString(filters)}`
  );

  return {
    data: Array.isArray(response?.data) ? response.data : [],
    pagination: response.pagination || EMPTY_PAGINATION,
  };
}

export async function getAppointmentDetail(id: string): Promise<AppointmentDetail> {
  return unwrap(
    await fetchAdminApi<AppointmentDetail>(`/admin/dashboard/appointments/${id}`),
    'appointment'
  );
}

export async function getDashboardStats(): Promise<DashboardStats> {
  return unwrap(
    await fetchAdminApi<DashboardStats>('/admin/dashboard/stats'),
    'dashboard stats'
  );
}

// Human control API functions

export async function takeControl(
  appointmentId: string,
  data: TakeControlRequest
): Promise<{ humanControlEnabled: boolean; humanControlTakenBy: string; humanControlTakenAt: string }> {
  return unwrap(
    await fetchAdminApi<{
      humanControlEnabled: boolean;
      humanControlTakenBy: string;
      humanControlTakenAt: string;
    }>(`/admin/dashboard/appointments/${appointmentId}/take-control`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    'take control'
  );
}

export async function releaseControl(
  appointmentId: string
): Promise<{ humanControlEnabled: boolean }> {
  return unwrap(
    await fetchAdminApi<{ humanControlEnabled: boolean }>(
      `/admin/dashboard/appointments/${appointmentId}/release-control`,
      {
        method: 'POST',
        body: JSON.stringify({}), // Empty body to satisfy Content-Type: application/json
      }
    ),
    'release control'
  );
}

export async function sendAdminMessage(
  appointmentId: string,
  data: SendMessageRequest
): Promise<{ messageId: string; sentAt: string }> {
  return unwrap(
    await fetchAdminApi<{ messageId: string; sentAt: string }>(
      `/admin/dashboard/appointments/${appointmentId}/send-message`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    ),
    'admin message'
  );
}

export async function deleteAppointment(
  appointmentId: string,
  data: { adminId: string; reason?: string; forceDeleteConfirmed?: boolean }
): Promise<{ id: string; message: string }> {
  return unwrap(
    await fetchAdminApi<{ id: string; message: string }>(
      `/admin/dashboard/appointments/${appointmentId}`,
      {
        method: 'DELETE',
        body: JSON.stringify(data),
      }
    ),
    'appointment deletion'
  );
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
  return unwrap(
    await fetchAdminApi<{
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
    }),
    'appointment update'
  );
}

// Thread reprocessing API

export interface ThreadMessagePreview {
  messageId: string;
  from: string;
  subject: string;
  date: string;
  status: 'processed' | 'unprocessed';
  snippet: string;
  /** Last processing error recorded by the scanner, if any. Only set for unprocessed messages. */
  lastError?: string;
  /**
   * Why this message was marked processed. Only set for processed messages.
   * Values: successfully-processed, unparseable, bounce, own-email,
   * weekly-mailing-reply, unmatched-abandoned, divergence-blocked-abandoned,
   * processing-failed-abandoned, legacy.
   */
  processedContext?: string;
}

export interface ReprocessPreviewResult {
  appointmentId: string;
  userName: string;
  therapistName: string;
  dryRun: true;
  threads: Array<{ threadId: string; type: string; messages: ThreadMessagePreview[] }>;
  totalMessages: number;
  unprocessedCount: number;
  message: string;
}

export interface ReprocessThreadResult {
  appointmentId: string;
  userName: string;
  therapistName: string;
  threads: Array<{ threadId: string; type: string; cleared: number; reprocessed: number }>;
  totalCleared: number;
  totalReprocessed: number;
  message: string;
}

export async function previewReprocessThread(
  appointmentId: string
): Promise<ReprocessPreviewResult> {
  return unwrap(
    await fetchAdminApi<ReprocessPreviewResult>(
      `/admin/dashboard/appointments/${appointmentId}/reprocess-thread`,
      {
        method: 'POST',
        body: JSON.stringify({ dryRun: true }),
      },
      TIMEOUTS.LONG_MS
    ),
    'thread preview'
  );
}

export async function reprocessThread(
  appointmentId: string,
  forceMessageIds?: string[]
): Promise<ReprocessThreadResult> {
  return unwrap(
    await fetchAdminApi<ReprocessThreadResult>(
      `/admin/dashboard/appointments/${appointmentId}/reprocess-thread`,
      {
        method: 'POST',
        body: JSON.stringify(forceMessageIds ? { forceMessageIds } : {}),
      },
      TIMEOUTS.LONG_MS
    ),
    'thread reprocess'
  );
}

// Admin Appointments Management API functions

export async function getAdminUsers(): Promise<AdminUser[]> {
  const response = await fetchAdminApi<AdminUser[]>('/admin/appointments/users');
  return Array.isArray(response?.data) ? response.data : [];
}

export async function getAdminTherapists(): Promise<AdminTherapist[]> {
  const response = await fetchAdminApi<AdminTherapist[]>('/admin/appointments/therapists');
  return Array.isArray(response?.data) ? response.data : [];
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
  const response = await fetchAdminApi<{ items: AppointmentListItem[]; pagination: PaginationInfo }>(
    `/admin/appointments/all${buildQueryString(filters)}`
  );

  return {
    data: Array.isArray(response?.data?.items) ? response.data.items : [],
    pagination: response?.data?.pagination || EMPTY_PAGINATION,
  };
}

export async function updateAdminAppointment(
  appointmentId: string,
  data: { status?: string; confirmedDateTime?: string | null; adminId: string; reason?: string }
): Promise<{
  id: string;
  status: string;
  confirmedDateTime: string | null;
  confirmedDateTimeParsed: string | null;
  confirmedAt: string | null;
  updatedAt: string;
  previousStatus?: string;
  warning?: string;
}> {
  return unwrap(
    await fetchAdminApi<{
      id: string;
      status: string;
      confirmedDateTime: string | null;
      confirmedDateTimeParsed: string | null;
      confirmedAt: string | null;
      updatedAt: string;
      previousStatus?: string;
      warning?: string;
    }>(`/admin/appointments/${appointmentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    'appointment update'
  );
}

export async function createAdminAppointment(
  data: CreateAdminAppointmentRequest
): Promise<CreateAdminAppointmentResponse> {
  return unwrap(
    await fetchAdminApi<CreateAdminAppointmentResponse>(
      '/admin/appointments/create',
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    ),
    'appointment creation'
  );
}

export async function actionClosure(
  appointmentId: string,
  action: 'cancel' | 'dismiss'
): Promise<{ success: boolean; action: string }> {
  return unwrap(
    await fetchAdminApi<{ success: boolean; action: string }>(
      `/admin/dashboard/appointments/${appointmentId}/action-closure`,
      {
        method: 'POST',
        body: JSON.stringify({ action }),
      }
    ),
    'closure action'
  );
}
